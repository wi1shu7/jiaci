/**
 * 间隔重复调度（需求 3.2.4）：FSRS（open-spaced-repetition 的开源算法，npm 包 ts-fsrs）。纯函数，不依赖数据库。
 * 模型为每个词维护 stability（记忆稳定性，天）与 difficulty（难度 1–10），按「目标记忆保持率」（默认 90%）安排下次复习；
 * 迟到的复习按实际间隔计算。四种打分映射：认识 → Good，模糊 → Again；已掌握 / 重新记 / 移出是状态操作，不进入模型。
 * 模糊后进入短期学习或重学；认出后按目标保持率安排长期复习，达到 master_interval（默认 60 天）后转为已掌握。
 * 关闭随机扰动，结果可预测、可测试。
 */
import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type FSRS } from "ts-fsrs";
import { LEARNING_STEP_MINUTES, RELEARNING_STEP_MINUTES } from "./study-queue";

export type ProgressStatus = "new" | "learning" | "mastered" | "removed";
export type RateResult = "know" | "fuzzy" | "master" | "reset" | "remove";

export interface ProgressState {
  /** 当前安排的间隔天数；0 表示新词或短期重学 */
  interval: number;
  /** 记忆稳定性（天）与难度（1–10）；新词为 null */
  stability: number | null;
  difficulty: number | null;
  reps: number;
  lapses: number;
  status: ProgressStatus;
  fsrsState: State;
  dueAt: string | null;
  /** YYYY-MM-DD，null 表示未安排 */
  dueDate: string | null;
  /** 最近一次打分的日期 YYYY-MM-DD，用于计算实际间隔 */
  lastReview: string | null;
}

export const NEW_PROGRESS: ProgressState = { interval: 0, stability: null, difficulty: null, reps: 0, lapses: 0, status: "new", fsrsState: State.New, dueAt: null, dueDate: null, lastReview: null };
export const DEFAULT_RETENTION = 0.9;
export const DEFAULT_MASTER_INTERVAL = 60;

/** 可在 system_config 调的参数：目标保持率、已掌握阈值、个性化权重（官方优化器拟合的 w 数组） */
export type SchedulerOptions = { retention?: number; masterInterval?: number; w?: readonly number[] };

export interface RateOutcome {
  progress: ProgressState;
  /** 写入 study_log 的 next_interval：0 = 短期重排，-1 = 不再出现 */
  nextInterval: number;
  /** 本轮还有短期重学步骤 */
  requeueToday: boolean;
  becameMastered: boolean;
}

const engines = new Map<string, FSRS>();
function engine(o: SchedulerOptions): FSRS {
  const retention = o.retention ?? DEFAULT_RETENTION;
  const key = `${retention}|${o.w?.join(",") ?? ""}`;
  let f = engines.get(key);
  if (!f) {
    f = fsrs(generatorParameters({
      request_retention: retention, maximum_interval: 365, enable_fuzz: false, enable_short_term: true,
      learning_steps: [`${LEARNING_STEP_MINUTES}m`], relearning_steps: [`${RELEARNING_STEP_MINUTES}m`],
      ...(o.w?.length ? { w: [...o.w] } : {}),
    }));
    engines.set(key, f);
  }
  return f;
}

export function addDays(today: string, n: number): string {
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dayOf = (d: string) => new Date(d + "T00:00:00Z");
const daysBetween = (a: string, b: string) => Math.round((dayOf(b).getTime() - dayOf(a).getTime()) / 86_400_000);
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** 用客户端学习日计算 FSRS 的日间隔，短期步骤再映射到实际时刻。 */
function toCard(p: ProgressState, today: string): Card {
  if (p.status === "new" || !p.reps || p.stability == null) return createEmptyCard(dayOf(today));
  // 最近打分日期可能晚于「今天」（客户端本地日期领先服务器 UTC 日期，或换了时区），按同一天算，避免负的间隔
  const lastRaw = p.lastReview ?? (p.dueDate ? addDays(p.dueDate, -p.interval) : today);
  const last = daysBetween(lastRaw, today) < 0 ? today : lastRaw;
  return {
    due: dayOf(p.dueDate ?? today), stability: p.stability, difficulty: p.difficulty ?? 5,
    elapsed_days: Math.max(0, daysBetween(last, today)), scheduled_days: p.interval, learning_steps: 0,
    reps: p.reps, lapses: p.lapses, state: p.fsrsState, last_review: dayOf(last),
  };
}
/**
 * 学习次数与遗忘次数取「模型给的」与「已累计 + 1」的较大者：
 * 「重新记」会把卡片清成新卡，模型的 reps 从 0 重新数，直接采用会让详情页的次数跳回去（审计 F028）。
 */
const counters = (p: ProgressState, c: Card, lapse: boolean) => ({
  reps: Math.max(c.reps, p.reps + 1),
  lapses: Math.max(c.lapses, p.lapses + (lapse ? 1 : 0)),
});

export function applyRating(p: ProgressState, result: RateResult, today: string, o: SchedulerOptions = {}, now = dayOf(today)): RateOutcome {
  const master = o.masterInterval ?? DEFAULT_MASTER_INTERVAL;
  switch (result) {
    case "know": {
      const model = engine(o);
      const card = model.next(toCard(p, today), dayOf(today), Rating.Good).card;
      const firstGraduation = p.fsrsState === State.Learning && p.lastReview === today;
      const stability = firstGraduation ? Math.max(card.stability, model.parameters.w[1]) : card.stability;
      const interval = Math.max(1, firstGraduation ? Math.min(card.scheduled_days, model.next_interval(stability, 0)) : card.scheduled_days);
      const mastered = interval >= master;
      return {
        progress: {
          interval, stability, difficulty: card.difficulty, ...counters(p, card, false),
          status: mastered ? "mastered" : "learning", fsrsState: State.Review,
          dueAt: null, dueDate: mastered ? null : addDays(today, interval), lastReview: today,
        },
        nextInterval: mastered ? -1 : interval, requeueToday: false, becameMastered: mastered,
      };
    }
    case "fuzzy": {
      const modelDay = dayOf(today);
      const card = engine(o).next(toCard(p, today), modelDay, Rating.Again).card;
      const delay = card.due.getTime() - modelDay.getTime();
      return {
        progress: {
          interval: 0, stability: card.stability, difficulty: card.difficulty, ...counters(p, card, true),
          status: "learning", fsrsState: card.state,
          dueAt: new Date(now.getTime() + delay).toISOString(), dueDate: today, lastReview: today,
        },
        nextInterval: 0, requeueToday: true, becameMastered: false,
      };
    }
    case "master":
      return { progress: { ...p, status: "mastered", interval: Math.max(p.interval, master), stability: Math.max(p.stability ?? 0, master), fsrsState: State.Review, dueAt: null, dueDate: null, lastReview: today }, nextInterval: -1, requeueToday: false, becameMastered: true };
    case "reset":
      return { progress: { ...NEW_PROGRESS, reps: p.reps, lapses: p.lapses, dueDate: today, lastReview: today }, nextInterval: 0, requeueToday: true, becameMastered: false };
    case "remove":
      return { progress: { ...p, status: "removed", dueAt: null, dueDate: null }, nextInterval: -1, requeueToday: false, becameMastered: false };
  }
}

/** 「认识 / 已掌握」算今天学过；模糊、重新记、移出都不算 */
export const isDone = (r: RateResult) => r === "know" || r === "master";
/**
 * 今天学过的词 = 今天**最后一条**记录是认识 / 已掌握的词（logs 须按打分时间升序）。
 * 认识之后又「重新记」的词已经清成新卡，要能重新进今天的队列、也要能再打认识；
 * 只要「今天有过一条认识」就算学过的话，这种词会在队列与单词列表的「加进度」两边都被拦下——
 * 列表里明明是「未开始」，拖到「加进度」却提示今天学过。
 */
export function doneTodayIds(logs: Array<{ wordId: string; result: RateResult }>): Set<string> {
  const last = new Map<string, RateResult>();
  for (const l of logs) last.set(l.wordId, l.result);
  return new Set([...last].filter(([, r]) => isDone(r)).map(([id]) => id));
}

/** 打分按钮上预先显示的文案（按今天计算，迟到的复习会体现在天数里） */
export function rateLabels(p: ProgressState, o: SchedulerOptions = {}, today = todayUtc()): { know: string; fuzzy: string } {
  const now = new Date();
  const know = applyRating(p, "know", today, o, now);
  const fuzzy = applyRating(p, "fuzzy", today, o, now);
  const label = (outcome: RateOutcome) => outcome.nextInterval === -1
    ? "已掌握"
    : outcome.nextInterval > 0
      ? `${outcome.nextInterval} 天后`
      : `${(Date.parse(outcome.progress.dueAt!) - now.getTime()) / 60_000} 分钟后`;
  return { know: label(know), fuzzy: label(fuzzy) };
}

/** 当前记忆保持率 0–1（新词 / 未安排为 null），供后续「掌握度」展示 */
export function retrievability(p: ProgressState, o: SchedulerOptions = {}, today = todayUtc()): number | null {
  if (p.status !== "learning" || p.stability == null) return null;
  return engine(o).get_retrievability(toCard(p, today), dayOf(today), false);
}
