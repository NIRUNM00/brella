import { describe, it, expect } from "vitest";
import { wilsonLowerBound, computeWilsonScore, sortByWilsonScore } from "../scoring/wilson.js";
import type { DecisionRecord } from "../types/bddd.js";

describe("wilsonLowerBound", () => {
  it("returns 0.5 for no data (ups=0, downs=0)", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0.5);
  });

  it("returns > 0.5 when ups > downs", () => {
    const score = wilsonLowerBound(10, 2);
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("returns < 0.5 when downs > ups", () => {
    const score = wilsonLowerBound(2, 10);
    expect(score).toBeLessThan(0.5);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("is higher with more data (same ratio)", () => {
    const scoreFew = wilsonLowerBound(5, 5);
    const scoreMany = wilsonLowerBound(50, 50);
    // More data at same ratio = narrower CI = higher lower bound
    expect(scoreMany).toBeGreaterThan(scoreFew);
  });

  it("handles extreme p=1 (all ups)", () => {
    const score = wilsonLowerBound(100, 0);
    expect(score).toBeGreaterThan(0.95);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("handles extreme p=0 (all downs)", () => {
    const score = wilsonLowerBound(0, 100);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThan(0.05);
  });

  it("respects custom z-score (smaller z = narrower CI = higher bound)", () => {
    const z1 = wilsonLowerBound(10, 5, 1.0);
    const z2 = wilsonLowerBound(10, 5, 2.0);
    expect(z1).toBeGreaterThan(z2);
  });
});

describe("computeWilsonScore", () => {
  function makeRecord(action: "accept" | "reject" | "skip"): DecisionRecord {
    return { seed: 42, prompt: "test", model: "", action, note: "", createdAt: "2025-01-01" };
  }

  it("computes score from accept-only records", () => {
    const records = Array.from({ length: 20 }, () => makeRecord("accept"));
    const result = computeWilsonScore(records);
    expect(result.ups).toBe(20);
    expect(result.downs).toBe(0);
    expect(result.score).toBeGreaterThan(0.8);
  });

  it("computes score from reject-only records", () => {
    const records = [makeRecord("reject"), makeRecord("reject"), makeRecord("reject")];
    const result = computeWilsonScore(records);
    expect(result.ups).toBe(0);
    expect(result.downs).toBe(3);
    expect(result.score).toBeLessThan(0.4);
  });

  it("ignores skip actions", () => {
    const records = [
      makeRecord("accept"),
      makeRecord("skip"),
      makeRecord("reject"),
      makeRecord("skip"),
    ];
    const result = computeWilsonScore(records);
    expect(result.ups).toBe(1);
    expect(result.downs).toBe(1);
  });

  it("returns 0.5 for empty records", () => {
    const result = computeWilsonScore([]);
    expect(result.score).toBe(0.5);
    expect(result.confidence).toBe(0);
  });
});

describe("sortByWilsonScore", () => {
  it("sorts items descending by score", () => {
    const items = [
      { name: "low", score: 0.3 },
      { name: "high", score: 0.9 },
      { name: "mid", score: 0.6 },
    ];
    const sorted = sortByWilsonScore(items);
    expect(sorted.map((i) => i.name)).toEqual(["high", "mid", "low"]);
  });

  it("does not mutate original array", () => {
    const items = [{ score: 0.5 }, { score: 0.8 }];
    const copy = [...items];
    sortByWilsonScore(items);
    expect(items).toEqual(copy);
  });

  it("handles empty array", () => {
    expect(sortByWilsonScore([])).toEqual([]);
  });
});
