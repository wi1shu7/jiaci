export type StudyQueueItem = { kind: "new" | "review" | "relearn"; dueAt: string | null };

export const LEARNING_STEP_MINUTES = 1;
export const RELEARNING_STEP_MINUTES = 10;

function dueTime(item: StudyQueueItem) {
  return Date.parse(item.dueAt ?? "") || 0;
}

export function splitStudyQueue<T extends StudyQueueItem>(items: readonly T[], now: number, { learnAhead = false } = {}) {
  const readyRelearn: T[] = [];
  const ready: T[] = [];
  const pending: T[] = [];
  for (const item of items) {
    if (item.kind !== "relearn") ready.push(item);
    else if (dueTime(item) > now) pending.push(item);
    else readyRelearn.push(item);
  }
  const byDueTime = (left: T, right: T) => dueTime(left) - dueTime(right);
  readyRelearn.sort(byDueTime);
  pending.sort(byDueTime);
  if (learnAhead && !readyRelearn.length && !ready.length) return { ready: pending.slice(0, 1), pending: pending.slice(1) };
  return { ready: [...readyRelearn, ...ready], pending };
}
