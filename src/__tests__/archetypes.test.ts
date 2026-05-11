import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, getDb } from "../db/connection.js";
import {
  setArchetype,
  getArchetype,
  listArchetypes,
  searchArchetypes,
  associateDecision,
} from "../engine/archetypes.js";

let tmpDir: string;

function freshDb() {
  closeDb();
  const dbPath = join(tmpDir, `test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  return getDb(dbPath);
}

describe("archetypes CRUD", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "brella-test-"));
  });

  afterEach(() => {
    closeDb();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("setArchetype creates a new entry", () => {
    freshDb();
    const entry = setArchetype("a cat in a hat", "character");
    expect(entry.archetype).toBe("character");
    expect(entry.prompt).toBe("a cat in a hat");
    expect(entry.promptHash).toBeTruthy();
    expect(entry.totalJudgments).toBe(0);
  });

  it("setArchetype updates existing entry", () => {
    freshDb();
    setArchetype("a cat in a hat", "character");
    const updated = setArchetype("a cat in a hat", "landscape");
    expect(updated.archetype).toBe("landscape");
  });

  it("getArchetype retrieves by prompt text", () => {
    freshDb();
    setArchetype("a dog in a park", "animal");
    const entry = getArchetype("a dog in a park");
    expect(entry).not.toBeNull();
    expect(entry!.archetype).toBe("animal");
  });

  it("getArchetype returns null for unknown prompt", () => {
    freshDb();
    const entry = getArchetype("nonexistent prompt");
    expect(entry).toBeNull();
  });

  it("listArchetypes groups by archetype label", () => {
    freshDb();
    setArchetype("cat on roof", "character");
    setArchetype("dog on grass", "character");
    setArchetype("sunset mountain", "landscape");
    const summaries = listArchetypes();
    expect(summaries.length).toBe(2);
    const charSummary = summaries.find((s) => s.archetype === "character");
    expect(charSummary).toBeDefined();
    expect(charSummary!.count).toBe(2);
  });

  it("searchArchetypes finds by prompt text", () => {
    freshDb();
    setArchetype("a red car on highway", "vehicle");
    setArchetype("a blue sky", "landscape");
    const results = searchArchetypes("car");
    expect(results.length).toBe(1);
    expect(results[0].archetype).toBe("vehicle");
  });
});

describe("associateDecision", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "brella-test-"));
  });

  afterEach(() => {
    closeDb();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates entry on first accept", () => {
    freshDb();
    associateDecision("test prompt", 12345, "accept");
    const entry = getArchetype("test prompt");
    expect(entry).not.toBeNull();
    expect(entry!.totalJudgments).toBe(1);
    expect(entry!.preferredSeeds).toContain(12345);
  });

  it("adds seed to preferred on accept", () => {
    freshDb();
    associateDecision("test prompt", 1, "accept");
    associateDecision("test prompt", 2, "accept");
    associateDecision("test prompt", 1, "accept"); // duplicate — should be ignored
    const entry = getArchetype("test prompt");
    expect(entry!.preferredSeeds).toEqual([1, 2]);
    expect(entry!.totalJudgments).toBe(3);
  });

  it("adds seed to rejected on reject", () => {
    freshDb();
    associateDecision("test prompt", 42, "reject");
    associateDecision("test prompt", 99, "reject");
    const entry = getArchetype("test prompt");
    expect(entry!.rejectedSeeds).toContain(42);
    expect(entry!.rejectedSeeds).toContain(99);
    expect(entry!.preferredSeeds).toEqual([]);
  });

  it("only increments count on skip", () => {
    freshDb();
    associateDecision("test prompt", 55, "skip");
    associateDecision("test prompt", 66, "skip");
    const entry = getArchetype("test prompt");
    expect(entry!.totalJudgments).toBe(2);
    expect(entry!.preferredSeeds).toEqual([]);
    expect(entry!.rejectedSeeds).toEqual([]);
  });
});
