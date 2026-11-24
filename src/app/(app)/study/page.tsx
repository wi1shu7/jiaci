"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import WordDetail from "@/components/WordDetail";
import RateBar from "@/components/RateBar";
import PomodoroButton from "@/components/Pomodoro";
import { IconSpeaker, IconTap, IconX } from "@/components/Icons";
import { useToast } from "@/components/Toast";
import { api, localToday } from "@/lib/client/api";
import { flushPendingRates, isRetriableRateError, readPendingRates, stashPendingRate } from "@/lib/client/pending-rates";
import { useMe } from "@/lib/client/useMe";
import { onWordChanged } from "@/lib/client/word-events";
import { useUser } from "@/components/UserContext";
import { preloadAudio, speakSequence, speakSentence, speakWord, stopSpeaking, voiceKeyOf } from "@/lib/client/speech";
import { LEARNING_STEP_MINUTES, RELEARNING_STEP_MINUTES, splitStudyQueue } from "@/lib/study-queue";
import type { QueueItem as Item, WordDetail as Detail } from "@/lib/study";
import type { RateResult } from "@/lib/scheduler";
import "./study.css";

type TodayResp = { items: Item[]; hasBook: boolean; bookId: string | null };
const RESULT_TAG: Record<string, [string, string]> = { know: ["tag-result-know", "认识"], fuzzy: ["tag-review", "模糊"], master: ["tag-result-master", "已掌握"], reset: ["tag-result-reset", "重新记"], remove: ["tag-none", "移出"] };

/** 学习卡片页（需求 3.2.2）：正面 → 点击显示答案（单词详情）→ 底部打分 → 下一个 */
function Study() {
  const router = useRouter();
  const params = useSearchParams();
  const extra = params.get("extra") === "1";
  const { settings, loading: meLoading } = useMe();
  const userId = useUser()?.id;
  const { toast } = useToast();
  const [{ ready: queue, pending: pendingRelearn }, setQueue] = useState<{ ready: Item[]; pending: Item[] }>({ ready: [], pending: [] });
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [screen, setScreen] = useState<"front" | "answer">("front");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "nobook" | "error">("loading");
  const [detailErr, setDetailErr] = useState("");
  const [frontHistory, setFrontHistory] = useState<Detail["history"]>([]);
  const [frontExamples, setFrontExamples] = useState<string[]>([]);
  const alive = useRef(true);
  const [busy, setBusy] = useState(false);
  const cache = useRef(new Map<string, Detail>());
  const counts = useRef({ know: 0, all: 0, newN: 0, reviewN: 0 });
  const cur = queue[0];
  const curRef = useRef(cur);
  curRef.current = cur;

  // 队列拉出来时的当前词库：打分与答案页的详情都按它的进度作用域算（需求 3.3.6 独立进度）
  const bookRef = useRef<string | null>(null);
  const fetchDetail = useCallback(async (spelling: string) => {
    const hit = cache.current.get(spelling);
    if (hit) return hit;
    const d = await api<Detail>(`/api/words/${encodeURIComponent(spelling)}?date=${localToday()}${bookRef.current ? `&book=${bookRef.current}` : ""}`);
    cache.current.set(spelling, d);
    return d;
  }, []);

  useEffect(() => {
    let active = true;
    setStatus("loading");
    const load = async () => {
      if (userId) await flushPendingRates(userId);
      if (!active) return;
      const r = await api<TodayResp>(`${extra ? "/api/study/extra" : "/api/study/today"}?date=${localToday()}`);
      if (!active) return;
      if (!r.hasBook) { setStatus("nobook"); return; }
      bookRef.current = r.bookId;
      if (!r.items.length) { setStatus("empty"); return; }
      cache.current.clear();
      setQueue(splitStudyQueue(r.items, Date.now(), { learnAhead: true })); setTotal(r.items.length); setDone(0);
      setScreen("front"); setDetail(null); setDetailErr(""); setStatus("ready");
      const newN = r.items.filter((item) => item.kind === "new").length;
      counts.current = { know: 0, all: 0, newN, reviewN: r.items.length - newN };
    };
    void load().catch((e) => { if (active) { setStatus("error"); toast((e as Error).message); } });
    return () => { active = false; };
  }, [extra, toast, userId]);

  // 在详情浮层里改了某个词的状态：缓存的详情已经过时，丢掉，下次要用时重新取
  useEffect(() => onWordChanged((s) => { cache.current.delete(s); }), []);

  // 离开学习页时停止朗读，并挡住在途请求的回调（审计 F039 / F046）
  useEffect(() => { alive.current = true; return () => { alive.current = false; stopSpeaking(); }; }, []);

  // 正面卡片的学习记录与例句：详情预取回来后要刷新，不能只在渲染时读一次缓存（审计 F038）。
  // 例句队列只带前几条（省载荷，见 lib/study.ts 的 QUEUE_EXAMPLES），其余从预取的详情里取
  useEffect(() => {
    if (!cur) { setFrontHistory([]); setFrontExamples([]); return; }
    let on = true;
    const hit = cache.current.get(cur.spelling);
    setFrontHistory(hit?.history ?? []);
    setFrontExamples(cur.examples.length ? cur.examples : hit?.view.examples.map((e) => e.en) ?? []);
    fetchDetail(cur.spelling).then((d) => {
      if (!on) return;
      setFrontHistory(d.history);
      if (!cur.examples.length) setFrontExamples(d.view.examples.map((e) => e.en));
    }).catch(() => {});
    return () => { on = false; };
  }, [cur, fetchDetail]);

  // 预取下一批详情，切换无延迟（需求 4.2）
  useEffect(() => {
    queue.slice(0, 4).forEach((it) => { fetchDetail(it.spelling).catch(() => {}); });
  }, [queue, fetchDetail]);

  // 正面出现时自动发音
  useEffect(() => {
    if (screen === "front" && cur && settings.autoPlay && !meLoading) speakWord(cur.spelling, voiceKeyOf(settings.accent, settings.voice));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.wordId, screen, meLoading]);

  // 正面出现时预取本词例句与下一个词的单词音频，显示答案后自动朗读不用等
  useEffect(() => {
    if (screen !== "front" || !cur || meLoading) return;
    const nextItem = queue[1];
    preloadAudio(nextItem ? [nextItem.spelling] : [], frontExamples, voiceKeyOf(settings.accent, settings.voice));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.wordId, screen, meLoading, frontExamples, queue]);

  const showAnswer = useCallback(async () => {
    if (screen !== "front" || !cur) return;
    const forWord = cur.spelling;
    setScreen("answer"); setDetailErr(""); window.scrollTo(0, 0);
    try {
      const d = await fetchDetail(forWord);
      // 切到下一张卡后旧请求才回来的，丢掉（审计 F041）
      if (!alive.current || forWord !== curRef.current?.spelling) return;
      setDetail(d);
      // 只读第一个例句，与独立详情页一致；例句顺序由接口每次随机（需求 3.2.5）
      if (settings.autoReadDetail) speakSequence(d.spelling, d.view.examples.slice(0, 1).map((e) => e.en), voiceKeyOf(settings.accent, settings.voice));
    } catch (e) {
      if (alive.current) setDetailErr((e as Error).message || "加载失败");
    }
  }, [screen, cur, fetchDetail, settings]);

  const next = useCallback((requeue: boolean, item: Item, r: RateResult, dueAt: string | null) => {
    const remaining = [...queue.slice(1), ...pendingRelearn];
    if (requeue) {
      const kind = dueAt ? "relearn" : r === "reset" ? "new" : item.kind;
      remaining.push({ ...item, kind, dueAt });
    }
    const staged = splitStudyQueue(remaining, Date.now(), { learnAhead: true });
    const newDone = requeue ? done : done + 1;
    if (!alive.current) return;
    stopSpeaking();
    setQueue(staged); setDone(newDone); setDetail(null); setDetailErr(""); setScreen("front");
    if (!remaining.length) {
      const rate = counts.current.all ? Math.round((counts.current.know / counts.current.all) * 100) + "%" : "—";
      router.replace(`/study/done?new=${counts.current.newN}&review=${counts.current.reviewN}&rate=${encodeURIComponent(rate)}${extra ? "&extra=1" : ""}`);
      return;
    }
    window.scrollTo(0, 0);
  }, [queue, pendingRelearn, done, router, extra]);

  const rate = useCallback(async (r: RateResult) => {
    if (screen !== "answer" || !cur || busy) return;
    setBusy(true);
    // 带上词库：离线补交时当前词库可能已经换了，打分要落在这条队列所属的那本上
    const ratedAt = Date.now();
    const body = { wordId: cur.wordId, result: r, date: localToday(), clientTs: `${cur.wordId}-${ratedAt}`, wordbookId: bookRef.current ?? undefined, ratedAt, cardDueAt: cur.dueAt ?? undefined };
    let requeue = false;
    let dueAt: string | null = null;
    let counted = true;
    try {
      if (userId && readPendingRates(userId).length) {
        await flushPendingRates(userId);
        if (readPendingRates(userId).length) throw new Error("还有打分等待同步");
      }
      const res = await api<{ nextInterval: number; requeueToday: boolean; progress?: { dueAt?: string | null }; duplicate?: boolean; skipped?: string | null }>("/api/study/rate", { method: "POST", json: body });
      requeue = res.requeueToday;
      dueAt = res.progress?.dueAt ?? null;
      counted = !res.duplicate && !res.skipped;
      // 队列可能是别处操作前拉的：该词已被移出 / 标为已掌握时服务端不再改状态，这里只提示一句（审计 F176）
      toast(res.skipped === "stale" ? "这条打分比其它设备上的记录旧，已记入历史但不改变复习安排"
        : res.skipped === "removed" ? "该词已移出学习，本次打分未记录"
        : res.skipped === "mastered" ? "该词已是已掌握，本次打分未记录"
        : res.skipped === "pending" ? "重学安排已更新"
        : r === "master" ? "已标记为已掌握，不再出现"
        : r === "reset" ? "已重新记，稍后重新学习"
        : requeue ? "已加入短期重学"
        : res.nextInterval === -1 ? "间隔已达上限，自动转为已掌握"
        : `下次复习：${res.nextInterval} 天后`);
    } catch (e) {
      // 只有网络不可用 / 服务端 5xx 才暂存重试；4xx 是永久错误，暂存下来只会每次进学习页反复重放（审计 F042）
      const retriable = isRetriableRateError(e);
      if (!retriable || !userId) { toast(`没有保存成功：${(e as Error).message}`); return; }
      stashPendingRate(userId, body);
      requeue = r === "reset" || r === "fuzzy";
      if (requeue) {
        const fsrsState = detail?.progress.fsrsState ?? 0;
        const minutes = r === "fuzzy" && fsrsState >= 2 ? RELEARNING_STEP_MINUTES : LEARNING_STEP_MINUTES;
        dueAt = new Date(ratedAt + minutes * 60_000).toISOString();
      }
      toast("网络不可用，打分已暂存，恢复后自动同步");
    } finally { setBusy(false); }
    if (counted) {
      counts.current.all++;
      if (r === "know" || r === "master") counts.current.know++;
    }
    cache.current.delete(cur.spelling);
    next(requeue, cur, r, dueAt);
  }, [screen, cur, busy, toast, next, detail, userId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; if (/INPUT|TEXTAREA/.test(t.tagName) || document.querySelector(".modal-backdrop.open")) return;
      if (e.key === " " && cur) { e.preventDefault(); speakWord(cur.spelling, voiceKeyOf(settings.accent, settings.voice)); }
      if (screen === "front" && (e.key === "Enter" || e.key === "ArrowDown")) showAnswer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cur, screen, showAnswer, settings.accent, settings.voice]);

  if (status === "loading") return <main className="study-wrap"><p className="muted center" style={{ padding: 40 }}>正在准备今天的单词…</p></main>;
  if (status === "error") return <main className="study-wrap center" style={{ padding: 40 }}><p>今天的单词没能加载出来</p><button className="btn btn-primary" onClick={() => location.reload()}>重新加载</button><Link className="btn btn-ghost" href="/home">返回首页</Link></main>;
  if (status === "nobook") return <main className="study-wrap center" style={{ padding: 40 }}><p>还没有选择词库</p><Link className="btn btn-primary" href="/wordbooks">去选择词库</Link></main>;
  if (status === "empty") return <main className="study-wrap center" style={{ padding: 40 }}><p>今天没有待学的词了</p><Link className="btn btn-primary" href="/home">返回首页</Link></main>;
  if (!cur) return null;

  return (
    <>
      <div className="study-top">
        <Link className="btn btn-icon sm btn-ghost" href="/home" aria-label="退出学习" title="退出学习（进度已自动保存）"><IconX /></Link>
        <div className="progress"><i style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
        <PomodoroButton compact />
        <div className="count">{done}/{total}</div>
      </div>
      {screen === "front" ? (
        <FrontCard item={cur} accent={settings.accent} voice={settings.voice} onReveal={showAnswer} history={frontHistory} examples={frontExamples} />
      ) : (
        <div id="answer"><main className="page narrow" style={{ paddingTop: 8 }}>
          {detailErr ? <div className="center" style={{ padding: 24 }}><p className="muted">{detailErr}</p><button className="btn btn-secondary" onClick={() => { setDetailErr(""); setScreen("front"); }}>返回卡片</button></div>
            : !detail ? <p className="muted">加载中…</p> : <WordDetail detail={detail} settings={settings} onNoteChange={(note) => { const d = { ...detail, note }; setDetail(d); cache.current.set(d.spelling, d); }}
                onReload={async () => { cache.current.delete(detail.spelling); const d = await fetchDetail(detail.spelling); if (alive.current && curRef.current?.spelling === d.spelling) setDetail(d); }} />}
        </main></div>
      )}
      {screen === "answer" && detail && <RateBar labels={detail.labels} mastered={detail.status === "mastered"} removed={detail.progress.status === "removed"} onRate={rate} disabled={busy} />}
      <div className="kbd-hint">{screen === "front" ? <><kbd>Enter</kbd> 显示答案 &nbsp; <kbd>空格</kbd> 发音</> : <><kbd>1</kbd> 认识 &nbsp; <kbd>2</kbd> 模糊 &nbsp; <kbd>3</kbd> 已掌握 &nbsp; <kbd>4</kbd> 重新记 &nbsp; <kbd>空格</kbd> 发音</>}</div>
    </>
  );
}

function FrontCard({ item, accent, voice, onReveal, history, examples }: { item: Item; accent: "us" | "uk"; voice: "female" | "male"; onReveal: () => void; history: Array<{ r: string }>; examples: string[] }) {
  const vk = voiceKeyOf(accent, voice);
  return (
    <div className="front" onClick={onReveal}>
      <div className="front-top">
        <span className={`kind tag ${item.kind === "new" ? "tag-new" : "tag-review"}`}>{item.kind === "new" ? "新词" : item.kind === "relearn" ? "重学" : "复习"}</span>
        <div className="spelling-lg">{item.display ?? item.spelling}</div>
        <div className="phonetic-row"><span>{item.phonetic ? (accent === "uk" ? item.phonetic.uk : item.phonetic.us) : "—"}</span><button className="btn btn-icon sm btn-soft" type="button" aria-label="发音" onClick={(e) => { e.stopPropagation(); speakWord(item.spelling, vk); }}><IconSpeaker /></button></div>
      </div>
      <div className="front-hint"><div className="pulse"><IconTap /></div>请回忆单词发音和释义<br />点击屏幕显示答案</div>
      <div className="front-record"><h4>学习记录</h4>{history.length ? <div className="hist-compact"><div className="hist-scroll">{history.map((h, i) => <span key={i} className={`tag ${RESULT_TAG[h.r]?.[0] ?? ""}`}>{RESULT_TAG[h.r]?.[1] ?? h.r}</span>)}</div></div> : <div className="hist-empty">还没有学习记录</div>}</div>
      {examples.length > 0 && <div className="front-examples"><h4>例句</h4>
        {examples.slice(0, 3).map((en, i) => (
          <div className="example" key={i}>
            <div className="ex-body"><div className="en"><span className="num">{i + 1}.</span>{en}</div></div>
            <button className="btn btn-icon sm btn-ghost ex-speak" type="button" aria-label="朗读例句" onClick={(ev) => { ev.stopPropagation(); speakSentence(en, vk); }}><IconSpeaker /></button>
          </div>
        ))}
      </div>}
    </div>
  );
}

export default function StudyPage() {
  return <Suspense><Study /></Suspense>;
}
