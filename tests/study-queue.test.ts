import { describe, expect, it } from "vitest";
import { splitStudyQueue } from "../src/lib/study-queue";

const now = Date.parse("2026-11-24T12:00:00.000Z");

describe("study queue lanes", () => {
  it("places relearning cards that are due ahead of the remaining session", () => {
    const result = splitStudyQueue([
      { wordId: "new", kind: "new", dueAt: null },
      { wordId: "review", kind: "review", dueAt: null },
      { wordId: "later", kind: "relearn", dueAt: "2026-11-24T12:10:00.000Z" },
      { wordId: "due", kind: "relearn", dueAt: "2026-11-24T11:59:00.000Z" },
    ], now);

    expect(result.ready.map((item) => item.wordId)).toEqual(["due", "new", "review"]);
    expect(result.pending.map((item) => item.wordId)).toEqual(["later"]);
  });

  it("inserts cards at the next transition, in due order, and preserves the base order", () => {
    const items = [
      { wordId: "later", kind: "relearn" as const, dueAt: "2026-11-24T12:10:00.000Z" },
      { wordId: "due", kind: "relearn" as const, dueAt: "2026-11-24T12:01:00.000Z" },
      { wordId: "first", kind: "relearn" as const, dueAt: "2026-11-24T12:00:55.000Z" },
      { wordId: "review", kind: "review" as const, dueAt: null },
      { wordId: "new", kind: "new" as const, dueAt: null },
    ];

    expect(splitStudyQueue(items, now + 60_000)).toEqual({ ready: [items[2], items[1], items[3], items[4]], pending: [items[0]] });
  });

  it("learns the earliest pending card ahead only after the other cards are finished", () => {
    const first = { wordId: "first", kind: "relearn" as const, dueAt: "2026-11-24T12:01:00.000Z" };
    const later = { wordId: "later", kind: "relearn" as const, dueAt: "2026-11-24T12:10:00.000Z" };
    const next = { wordId: "next", kind: "new" as const, dueAt: null };
    const halfway = now + 40_000;
    const options = { learnAhead: true };

    expect(splitStudyQueue([later, first, next], halfway, options)).toEqual({ ready: [next], pending: [first, later] });
    expect(splitStudyQueue([later, first], halfway, options)).toEqual({ ready: [first], pending: [later] });
    expect(splitStudyQueue([later, first], halfway)).toEqual({ ready: [], pending: [first, later] });
  });
});
