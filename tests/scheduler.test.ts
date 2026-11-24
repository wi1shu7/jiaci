import { describe, it, expect } from "vitest";
import { State } from "ts-fsrs";
import { addDays, applyRating, doneTodayIds, NEW_PROGRESS, rateLabels, retrievability, DEFAULT_MASTER_INTERVAL, DEFAULT_RETENTION, type ProgressState } from "../src/lib/scheduler";

const T = "2026-09-05";
/** 按到期日连续打「认识」，返回每次的间隔 */
function knowUntilMastered(o = {}, max = 12) {
  let p: ProgressState = { ...NEW_PROGRESS }, today = T;
  const seen: number[] = [];
  for (let i = 0; i < max && p.status !== "mastered"; i++) {
    const r = applyRating(p, "know", today, o); p = r.progress; seen.push(r.nextInterval);
    if (p.dueDate) today = p.dueDate;
  }
  return { p, seen };
}

describe("FSRS 调度", () => {
  it("新词认识后直接安排长期复习", () => {
    const r = applyRating(NEW_PROGRESS, "know", T);
    expect(r.progress.status).toBe("learning");
    expect(r.progress).toMatchObject({ fsrsState: State.Review, dueAt: null });
    expect(r.requeueToday).toBe(false);
    expect(r.progress.interval).toBeGreaterThanOrEqual(1);
    expect(r.progress.interval).toBeLessThanOrEqual(30);
    expect(r.progress.dueDate).toBe(addDays(T, r.progress.interval));
    expect(r.progress).toMatchObject({ reps: 1, lapses: 0, lastReview: T });
    expect(r.progress.stability).toBeGreaterThan(0);
    expect(r.progress.difficulty).toBeGreaterThan(0);
    expect(r.nextInterval).toBe(r.progress.interval);
  });
  it("连续认识：间隔递增，达到 60 天自动已掌握", () => {
    const { p, seen } = knowUntilMastered();
    expect(p.status).toBe("mastered");
    expect(p.dueDate).toBeNull();
    expect(seen.at(-1)).toBe(-1);
    const days = seen.slice(0, -1);
    for (let i = 1; i < days.length; i++) expect(days[i]).toBeGreaterThan(days[i - 1]);
    expect(days.length).toBeGreaterThanOrEqual(3);
    expect(days.length).toBeLessThanOrEqual(8);
  });
  it("已掌握阈值可配：30 天更早掌握；目标保持率调低间隔更长", () => {
    // 用 < 而不是 ≤：阈值参数被忽略时两边相等，≤ 发现不了（审计 F159）
    expect(knowUntilMastered({ masterInterval: 30 }).seen.length).toBeLessThan(knowUntilMastered().seen.length);
    expect(knowUntilMastered({ masterInterval: 30 }).p.interval).toBeGreaterThanOrEqual(30);
    const p = applyRating(NEW_PROGRESS, "know", T).progress;
    const on = applyRating(p, "know", p.dueDate!, { retention: 0.9 }).progress.interval;
    const loose = applyRating(p, "know", p.dueDate!, { retention: 0.8 }).progress.interval;
    expect(loose).toBeGreaterThan(on);
  });
  it("模糊的新词稍后重学，并能在当天结束学习步", () => {
    const now = new Date("2026-09-05T12:00:00.000Z");
    const r = applyRating(NEW_PROGRESS, "fuzzy", T, {}, now);
    expect(r.requeueToday).toBe(true);
    expect(r.nextInterval).toBe(0);
    expect(r.progress).toMatchObject({ interval: 0, status: "learning", fsrsState: State.Learning, dueDate: T, reps: 1 });
    expect(Date.parse(r.progress.dueAt!)).toBe(now.getTime() + 60_000);
    const k = applyRating(r.progress, "know", T, {}, new Date(r.progress.dueAt!));
    expect(k.requeueToday).toBe(false);
    expect(k.progress).toMatchObject({ fsrsState: State.Review, interval: 1, dueAt: null, dueDate: addDays(T, 1) });
    expect(k.progress.stability!).toBeGreaterThan(r.progress.stability!);
    expect(retrievability(k.progress, {}, k.progress.dueDate!)!).toBeGreaterThanOrEqual(DEFAULT_RETENTION);
  });
  it("短期学习由到期时间驱动；连续忘记重新安排下次步骤", () => {
    const now = new Date("2026-09-05T12:00:00.000Z");
    const first = applyRating(NEW_PROGRESS, "fuzzy", T, {}, now).progress;
    const second = applyRating(first, "fuzzy", T, {}, new Date(first.dueAt!)).progress;
    expect(Date.parse(second.dueAt!)).toBe(Date.parse(first.dueAt!) + 60_000);
    expect(second.fsrsState).toBe(State.Learning);
  });
  it("学习步毕业之后每次到期的预测保持率都不低于目标值", () => {
    let p = applyRating(applyRating(NEW_PROGRESS, "fuzzy", T).progress, "know", T).progress;
    const seen: number[] = [];
    for (let i = 0; i < 8 && p.status === "learning"; i++) {
      seen.push(retrievability(p, {}, p.dueDate!)!);
      p = applyRating(p, "know", p.dueDate!).progress;
    }
    expect(seen.length).toBeGreaterThan(3);
    // 间隔取整会让保持率在目标值上下各差一点，允许 1 个百分点
    for (const r of seen) expect(r).toBeGreaterThan(DEFAULT_RETENTION - 0.01);
  });
  it("隔天完成短期重学时，FSRS 按实际跨天间隔计算", () => {
    const nextDay = applyRating(applyRating(NEW_PROGRESS, "fuzzy", T).progress, "know", addDays(T, 1)).progress;
    expect(nextDay.fsrsState).toBe(State.Review);
    expect(nextDay.interval).toBeGreaterThan(1);
  });
  it("模糊：长间隔的词 → 遗忘次数 +1，稳定性下降，比认识安排得近", () => {
    const mature = knowUntilMastered({ masterInterval: 1000 }, 4).p;   // 打 4 次认识
    expect(mature.interval).toBeGreaterThan(3);
    const day = mature.dueDate!;
    const f = applyRating(mature, "fuzzy", day);
    const k = applyRating(mature, "know", day);
    expect(f.requeueToday).toBe(true);
    expect(f.progress.lapses).toBe(mature.lapses + 1);
    expect(f.progress.stability!).toBeLessThan(mature.stability!);
    expect(f.progress.interval).toBeLessThan(k.progress.interval);
    expect(f.progress.fsrsState).toBe(State.Relearning);
    expect(Date.parse(f.progress.dueAt!) - Date.parse(`${day}T00:00:00.000Z`)).toBe(10 * 60_000);
    const relearned = applyRating(f.progress, "know", day, {}, new Date(f.progress.dueAt!));
    expect(relearned.progress).toMatchObject({ fsrsState: State.Review, dueAt: null });
    expect(relearned.nextInterval).toBeGreaterThan(0);
  });
  it("迟到的复习按实际间隔给信用：晚 20 天再认识，下次间隔更长", () => {
    const p = knowUntilMastered({ masterInterval: 1000 }, 3).p;
    const onTime = applyRating(p, "know", p.dueDate!, { masterInterval: 1000 }).progress.interval;
    const late = applyRating(p, "know", addDays(p.dueDate!, 20), { masterInterval: 1000 }).progress.interval;
    expect(late).toBeGreaterThan(onTime);
  });
  it("已掌握 / 重新记 / 移出", () => {
    const p: ProgressState = { ...NEW_PROGRESS, interval: 7, stability: 7, difficulty: 5, reps: 4, lapses: 1, status: "learning", fsrsState: State.Review, dueDate: "2026-09-12", lastReview: T };
    expect(applyRating(p, "master", T).progress).toMatchObject({ status: "mastered", dueDate: null, interval: DEFAULT_MASTER_INTERVAL, stability: DEFAULT_MASTER_INTERVAL });
    const reset = applyRating(p, "reset", T);
    expect(reset.progress).toMatchObject({ status: "new", interval: 0, stability: null, difficulty: null, reps: 4, lapses: 1, dueDate: T });
    expect(reset.requeueToday).toBe(true);
    expect(applyRating(p, "remove", T).progress).toMatchObject({ status: "removed", dueDate: null });
    // 重新记之后再认识：按新词起步
    // 重新记保留的次数不能被下一次打分清零（审计 F028）
    const afterReset = applyRating(reset.progress, "know", T).progress;
    expect(afterReset.reps).toBeGreaterThanOrEqual(5);
    expect(afterReset.lapses).toBeGreaterThanOrEqual(1);
    expect(applyRating(afterReset, "fuzzy", T).progress.lapses).toBeGreaterThanOrEqual(2);
    const again = applyRating(reset.progress, "know", T).progress;
    expect(again.interval).toBe(applyRating(NEW_PROGRESS, "know", T).progress.interval);
  });
  it("今天学过的词按最后一条记录算：认识后又重新记的不算", () => {
    const done = doneTodayIds([
      { wordId: "a", result: "know" },
      { wordId: "b", result: "know" }, { wordId: "b", result: "reset" },
      { wordId: "c", result: "fuzzy" }, { wordId: "c", result: "know" },
      { wordId: "d", result: "master" }, { wordId: "d", result: "remove" },
      { wordId: "e", result: "fuzzy" },
      { wordId: "f", result: "know" }, { wordId: "f", result: "reset" }, { wordId: "f", result: "know" },
    ]);
    expect([...done].sort()).toEqual(["a", "c", "f"]);
  });
  it("按钮文案与保持率", () => {
    const l = rateLabels(NEW_PROGRESS, {}, T);
    expect(l.fuzzy).toBe("1 分钟后");
    expect(l.know).toMatch(/^\d+ 天后$/);
    const mature = knowUntilMastered({ masterInterval: 1000 }, 5).p;
    expect(rateLabels(mature, {}, mature.dueDate!).know).toBe("已掌握");
    expect(rateLabels(mature, {}, mature.dueDate!).fuzzy).toBe("10 分钟后");
    expect(retrievability(NEW_PROGRESS)).toBeNull();
    const r = retrievability(mature, {}, mature.dueDate!);
    expect(r).toBeGreaterThan(0.8); expect(r).toBeLessThanOrEqual(1);
  });
  it("最近打分日期晚于今天（客户端日期领先）也不抛错，按同一天算", () => {
    const p = applyRating(NEW_PROGRESS, "know", "2026-09-08").progress;
    expect(() => rateLabels(p, {}, "2026-09-07")).not.toThrow();
    expect(applyRating(p, "know", "2026-09-07").progress.interval).toBeGreaterThanOrEqual(1);
  });
  it("结果确定（关闭随机扰动）", () => {
    expect(applyRating(NEW_PROGRESS, "know", T)).toEqual(applyRating(NEW_PROGRESS, "know", T));
  });
});
