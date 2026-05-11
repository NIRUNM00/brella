import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, getDb } from "../db/connection.js";
import {
  recordDecision,
  recordDecisions,
  getDecisionHistory,
  getWilsonTopN,
  getDecisionsByBatchTag,
  getDecisionsByModel,
  getDecisionsByAction,
  getBatchStats,
  listBatchTags,
} from "../engine/decision.js";
import { getArchetype } from "../engine/archetypes.js";

let tmpDir: string;

function freshDb() {
  closeDb();
  const dbPath = join(tmpDir, `test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  return getDb(dbPath);
}

describe("decision recording", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "brella-test-"));
  });

  afterEach(() => {
    closeDb();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recordDecision saves to DB and returns record", () => {
    freshDb();
    const rec = recordDecision({ seed: 42, prompt: "test prompt", action: "accept", note: "good one" });
    expect(rec.seed).toBe(42);
    expect(rec.action).toBe("accept");
    expect(rec.note).toBe("good one");
    expect(rec.createdAt).toBeTruthy();
  });

  it("recordDecision auto-associates with archetype", () => {
    freshDb();
    recordDecision({ seed: 42, prompt: "cat on roof", action: "accept", batchTag: "batch1" });
    const archetype = getArchetype("cat on roof");
    expect(archetype).not.toBeNull();
    expect(archetype!.preferredSeeds).toContain(42);
  });

  it("getDecisionHistory returns chronologically", () => {
    freshDb();
    recordDecision({ seed: 1, prompt: "p1", action: "accept" });
    recordDecision({ seed: 1, prompt: "p1", action: "reject" });
    recordDecision({ seed: 1, prompt: "p1", action: "accept" });
    const history = getDecisionHistory(1);
    expect(history.length).toBe(3);
    // Most recent first
    expect(history[0].action).toBe("accept");
  });

  it("getDecisionHistory filters by prompt", () => {
    freshDb();
    recordDecision({ seed: 1, prompt: "p1", action: "accept" });
    recordDecision({ seed: 1, prompt: "p2", action: "reject" });
    const history = getDecisionHistory(1, "p1");
    expect(history.length).toBe(1);
    expect(history[0].prompt).toBe("p1");
  });

  it("recordDecisions handles batch", () => {
    freshDb();
    const result = recordDecisions([
      { seed: 1, prompt: "p1", action: "accept", batchTag: "b1" },
      { seed: 2, prompt: "p1", action: "reject", batchTag: "b1" },
      { seed: 3, prompt: "p1", action: "skip", batchTag: "b1" },
    ]);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.records.length).toBe(3);
  });
});

describe("batch queries", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "brella-test-"));
    freshDb();
    recordDecisions([
      { seed: 1, prompt: "p1", action: "accept", batchTag: "batchA", model: "m1" },
      { seed: 2, prompt: "p1", action: "reject", batchTag: "batchA", model: "m1" },
      { seed: 3, prompt: "p2", action: "accept", batchTag: "batchB", model: "m2" },
      { seed: 4, prompt: "p2", action: "skip", batchTag: "batchB", model: "m2" },
    ]);
  });

  afterEach(() => {
    closeDb();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getDecisionsByBatchTag returns filtered", () => {
    const rows = getDecisionsByBatchTag("batchA");
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.batchTag === "batchA")).toBe(true);
  });

  it("getDecisionsByModel returns filtered", () => {
    const rows = getDecisionsByModel("m1");
    expect(rows.length).toBe(2);
  });

  it("getDecisionsByAction returns filtered", () => {
    const accepts = getDecisionsByAction("accept");
    expect(accepts.length).toBe(2);
    const skips = getDecisionsByAction("skip");
    expect(skips.length).toBe(1);
  });

  it("getBatchStats returns aggregated stats", () => {
    const stats = getBatchStats("batchA");
    expect(stats).not.toBeNull();
    expect(stats!.total).toBe(2);
    expect(stats!.accepted).toBe(1);
    expect(stats!.rejected).toBe(1);
    expect(stats!.skipped).toBe(0);
    expect(stats!.uniqueSeeds).toBe(2);
  });

  it("getBatchStats returns null for unknown batch", () => {
    const stats = getBatchStats("nonexistent");
    expect(stats).toBeNull();
  });

  it("listBatchTags returns all batches", () => {
    const batches = listBatchTags();
    expect(batches.length).toBe(2);
    const batchA = batches.find((b) => b.batchTag === "batchA");
    expect(batchA).toBeDefined();
    expect(batchA!.accepted).toBe(1);
  });
});

describe("wilson scores", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "brella-test-"));
    freshDb();
  });

  afterEach(() => {
    closeDb();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getWilsonTopN returns ranked seeds", () => {
    // Accept seed1 many times (high score), reject seed2 many times (low score)
    recordDecisions([
      { seed: 1, prompt: "p1", action: "accept" },
      { seed: 1, prompt: "p1", action: "accept" },
      { seed: 1, prompt: "p1", action: "accept" },
      { seed: 2, prompt: "p2", action: "reject" },
      { seed: 2, prompt: "p2", action: "reject" },
      { seed: 2, prompt: "p2", action: "reject" },
    ]);

    const top = getWilsonTopN(5);
    expect(top.length).toBe(2);
    // seed1 should rank higher than seed2
    expect(top[0].seed).toBe(1);
    expect(top[0].score).toBeGreaterThan(top[1].score);
  });
});
