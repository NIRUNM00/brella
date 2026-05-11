import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { closeDb, getDb } from "../db/connection.js";
import { setArchetype, getArchetype, listArchetypes, searchArchetypes } from "../engine/archetypes.js";

let tmpDir: string;

function freshDb() {
  closeDb();
  tmpDir = mkdtempSync(join(tmpdir(), "brella-archetype-cli-test-"));
  const dbPath = join(tmpDir, `test_${Date.now()}.db`);
  return getDb(dbPath);
}

describe("archetype CLI integration (via engine functions)", () => {
  afterEach(() => {
    closeDb();
    if (tmpDir && existsSync(tmpDir)) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("set → get round-trip", () => {
    freshDb();
    const entry = setArchetype("a cat on a roof", "animal");
    expect(entry.archetype).toBe("animal");

    const fetched = getArchetype("a cat on a roof");
    expect(fetched).not.toBeNull();
    expect(fetched!.archetype).toBe("animal");
  });

  it("get returns null for unknown prompt", () => {
    freshDb();
    const entry = getArchetype("totally unknown prompt xyz");
    expect(entry).toBeNull();
  });

  it("list returns all unique categories", () => {
    freshDb();
    setArchetype("portrait of a girl", "portrait");
    setArchetype("city skyline", "landscape");
    setArchetype("sunset over ocean", "landscape");

    const results = listArchetypes();
    expect(results.length).toBe(2); // portrait + landscape (deduped)
    const portrait = results.find((r) => r.archetype === "portrait");
    const landscape = results.find((r) => r.archetype === "landscape");
    expect(portrait).toBeDefined();
    expect(landscape).toBeDefined();
    expect(portrait!.count).toBe(1);
    expect(landscape!.count).toBe(2);
  });

  it("search by archetype name", () => {
    freshDb();
    setArchetype("a cat on a roof", "animal");
    setArchetype("dog in park", "animal");

    const results = searchArchetypes("animal");
    expect(results.length).toBe(2);
    expect(results.every((r) => r.archetype === "animal")).toBe(true);
  });

  it("search by prompt text", () => {
    freshDb();
    setArchetype("sunset landscape", "landscape");
    setArchetype("portrait of a girl", "portrait");

    const results = searchArchetypes("sunset");
    expect(results.length).toBe(1);
    expect(results[0].archetype).toBe("landscape");
  });

  it("recordDecision with archetype relationship (via associateDecision)", async () => {
    freshDb();
    // Record decision through decision engine
    const { recordDecision } = await import("../engine/decision.js");

    // This should auto-associate via associateDecision called inside recordDecision
    recordDecision({ seed: 777, prompt: "a cat on a roof", action: "accept" });

    // Now set the archetype
    setArchetype("a cat on a roof", "animal");

    // Check the archetype has the seed association
    const entry = getArchetype("a cat on a roof");
    expect(entry).not.toBeNull();
    expect(entry!.preferredSeeds).toContain(777);
    expect(entry!.archetype).toBe("animal");
  });

  it("search returns empty for non-matching query", () => {
    freshDb();
    setArchetype("anything", "test");
    const results = searchArchetypes("nonexistent_query_xyz");
    expect(results.length).toBe(0);
  });

  it("set updates existing archetype label", () => {
    freshDb();
    setArchetype("same prompt", "old-label");
    setArchetype("same prompt", "new-label");

    const entry = getArchetype("same prompt");
    expect(entry!.archetype).toBe("new-label");
  });
});
