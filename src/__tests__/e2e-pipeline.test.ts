import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getDb, closeDb } from "../db/connection.js";
import { generateBriefing } from "../engine/briefing.js";
import { queryDetail } from "../engine/detail.js";
import {
  recordDecision,
  getDecisionHistory,
  getWilsonTopN,
} from "../engine/decision.js";
import {
  setArchetype,
  getArchetype,
  listArchetypes,
  searchArchetypes,
} from "../engine/archetypes.js";
import { Layer, LAYER_ORDER } from "../types/bddd.js";
import type { ImageMeta, DetectionResult, DecisionRecord } from "../types/bddd.js";
import { wilsonLowerBound } from "../scoring/wilson.js";
import { createHash } from "node:crypto";

// ---------- Test DB ----------
const TEST_DB = join(tmpdir(), `brella-e2e-${Date.now()}.db`);

// ---------- Helpers ----------

/**
 * Write a minimal valid 1x1 RGB PNG file.
 * Uses raw deflate (stored block, no compression) + proper CRC32.
 */
function createFakePng(path: string, r = 128, g = 128, b = 128): void {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // CRC32 table
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let v = n;
    for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
    crcTable[n] = v;
  }
  function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function pngChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type, "ascii");
    const crcV = Buffer.alloc(4);
    crcV.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
    return Buffer.concat([len, typeB, data, crcV]);
  }

  // IHDR: 1x1, 8-bit RGB
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  // IDAT: stored deflate block (no compression) for 4 bytes: filter(0) + R+G+B
  const pixelData = Buffer.from([0, r, g, b]);
  const plen = pixelData.length; // 4
  const nlen = (~plen) & 0xffff; // bitwise NOT, 16-bit
  const hdr = Buffer.alloc(5);
  hdr.writeUInt8(1, 0);        // BFINAL=1, BTYPE=00 (stored)
  hdr.writeUInt16LE(plen, 1);
  hdr.writeUInt16LE(nlen, 3);
  const idat = Buffer.concat([hdr, pixelData]);

  writeFileSync(path, Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

function buildImageMeta(img: { path: string; seed: number; prompt: string; model: string }): ImageMeta {
  const s = statSync(img.path);
  return {
    path: img.path,
    filename: img.path.split("/").pop() ?? "unknown",
    size: s.size,
    width: 1024,
    height: 1024,
    seed: img.seed,
    prompt: img.prompt,
    cfg: 7.0,
    model: img.model,
    batchTag: BATCH_TAG,
  };
}

// ---------- Test Fixtures ----------

interface TestImage {
  path: string;
  seed: number;
  prompt: string;
  model: string;
}

let tempDir: string;
const IMAGES: TestImage[] = [];
const BATCH_TAG = "e2e-test-batch-v1";

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "brella-e2e-imgs-"));
  mkdirSync(join(tempDir, "sub"), { recursive: true });

  const variants = [
    { prompt: "a cat wearing a hat", seed: 1001, model: "JuggernautXL" },
    { prompt: "a cat wearing a hat", seed: 1002, model: "RealisticVision" },
    { prompt: "sunset over mountains", seed: 2001, model: "JuggernautXL" },
    { prompt: "sunset over mountains", seed: 2002, model: "RealisticVision" },
    { prompt: "cyberpunk street",     seed: 3001, model: "JuggernautXL" },
    { prompt: "portrait of a warrior", seed: 4001, model: "JuggernautXL" },
    { prompt: "a cat wearing a hat",   seed: 1003, model: "JuggernautXL", subdir: "sub" },
  ];

  for (const v of variants) {
    const dir = v.subdir ? join(tempDir, v.subdir) : tempDir;
    const filename = `${v.seed}_${v.model.replace(/[^a-z]/gi, "")}.png`;
    const path = join(dir, filename);
    createFakePng(path, (v.seed * 7) % 256, (v.seed * 11) % 256, (v.seed * 13) % 256);
    IMAGES.push({ path, seed: v.seed, prompt: v.prompt, model: v.model });
  }
});

afterAll(() => {
  closeDb();
  try { rmSync(TEST_DB, { force: true }); } catch { /* ignore */ }
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ============================================================
// Phase 2-5: End-to-End Pipeline Integration
// ============================================================

describe("Phase 2-5: E2E Pipeline Integration", () => {

  // ===== 2-5-1: Init =====
  it("initializes database with all required tables", () => {
    const db = getDb(TEST_DB);
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as any[];
    const names = rows.map((r: any) => r.name);

    expect(names).toContain("seed_preferences");
    expect(names).toContain("prompt_archetypes");
    expect(names).toContain("image_metadata");
    expect(names).toContain("wilson_scores");
  });

  // ===== 2-5-2: Curate Pipeline =====
  it("scans directory and generates briefing across all 3 layers", () => {
    // Scan (same logic as CLI curate command)
    const files = readdirSync(tempDir, { recursive: true })
      .filter((f: string) => [".png", ".jpg", ".jpeg", ".webp"].includes(extname(f).toLowerCase()))
      .map((f: string) => resolve(tempDir, f));

    expect(files.length).toBe(7);
    expect(files.some((f: string) => f.includes("/sub/"))).toBe(true);

    // Build detection results with layered classification
    const results: DetectionResult[] = files.map((path: string) => {
      const img = IMAGES.find(i => i.path === path) ?? { path, seed: 0, prompt: "", model: "" };
      const meta = img.seed > 0 ? buildImageMeta(img as TestImage) : {
        path, filename: path.split("/").pop() ?? "unknown",
        size: statSync(path).size, width: 0, height: 0,
        seed: 0, prompt: "", cfg: 7.0, model: "", batchTag: BATCH_TAG,
      };

      const layer = meta.seed % 3 === 0 ? Layer.Bad
        : meta.seed % 3 === 1 ? Layer.Dubious
        : Layer.Desired;

      return {
        image: meta,
        handAnomaly:    meta.seed % 3 === 0 ? 0.85 : 0.05,
        faceAnomaly:    meta.seed % 3 === 0 ? 0.75 : 0.02,
        compositionScore: meta.seed % 3 === 2 ? 0.85 : 0.55,
        exposureScore:  0.7,
        layer,
        confidence: 0.8,
      };
    });

    const briefing = generateBriefing(results, { batchTag: BATCH_TAG, wilsonAlpha: 0.05 });

    expect(briefing.batchId).toBe(BATCH_TAG);
    expect(briefing.total).toBe(7);

    const sum = LAYER_ORDER.reduce((s, l) => s + briefing.layers[l].count, 0);
    expect(sum).toBe(7);

    // All 3 layers should be populated (7 images, mod-3 → ~2-3 per layer)
    expect(briefing.layers[Layer.Bad].count).toBeGreaterThanOrEqual(1);
    expect(briefing.layers[Layer.Dubious].count).toBeGreaterThanOrEqual(1);
    expect(briefing.layers[Layer.Desired].count).toBeGreaterThanOrEqual(1);
  });

  // ===== 2-5-3: Decision → Archetype → Wilson =====
  it("records decisions, auto-associates archetypes, updates Wilson scores", () => {
    // Multiple decisions across prompts/models
    recordDecision({ seed: 1001, prompt: "a cat wearing a hat", model: "JuggernautXL", action: "accept", note: "great paws", batchTag: BATCH_TAG });
    recordDecision({ seed: 1002, prompt: "a cat wearing a hat", model: "RealisticVision", action: "reject", note: "bad anatomy", batchTag: BATCH_TAG });
    recordDecision({ seed: 2001, prompt: "sunset over mountains", model: "JuggernautXL", action: "accept", batchTag: BATCH_TAG });
    recordDecision({ seed: 3001, prompt: "cyberpunk street", model: "JuggernautXL", action: "reject", batchTag: BATCH_TAG });
    recordDecision({ seed: 4001, prompt: "portrait of a warrior", model: "JuggernautXL", action: "skip", batchTag: BATCH_TAG });

    // History query
    expect(getDecisionHistory(1001).length).toBe(1);
    expect(getDecisionHistory(9999).length).toBe(0);

    // Archetype seeds auto-aggregated
    const cat = getArchetype("a cat wearing a hat");
    expect(cat!.totalJudgments).toBe(2);
    expect(cat!.preferredSeeds).toContain(1001);
    expect(cat!.rejectedSeeds).toContain(1002);

    const sunset = getArchetype("sunset over mountains");
    expect(sunset!.totalJudgments).toBe(1);
    expect(sunset!.preferredSeeds).toContain(2001);

    // Wilson scores
    const top = getWilsonTopN(10);
    expect(top.length).toBeGreaterThanOrEqual(4);

    const s2001 = top.find(t => t.seed === 2001)!;
    expect(s2001.ups).toBe(1);
    expect(s2001.downs).toBe(0);
    expect(s2001.score).toBeGreaterThan(0);

    const s3001 = top.find(t => t.seed === 3001)!;
    expect(s3001.score).toBeLessThan(0.5);
  });

  // ===== 2-5-4: Archetype CRUD =====
  it("supports full archetype CRUD — set, get, list, search, update", () => {
    setArchetype("a cat wearing a hat", "animal");
    setArchetype("sunset over mountains", "landscape");
    setArchetype("cyberpunk street", "urban");
    setArchetype("portrait of a warrior", "portrait");

    // Get by exact text
    const got = getArchetype("a cat wearing a hat");
    expect(got!.archetype).toBe("animal");
    expect(got!.preferredSeeds).toContain(1001);

    // Get by exact prompt text (primary lookup path)
    expect(got).not.toBeNull();
    expect(got!.promptHash).toBeTruthy();
    // The hash is deterministic — same prompt always produces same hash
    const expectedHash = createHash("sha256").update("a cat wearing a hat").digest("hex");
    expect(got!.promptHash).toBe(expectedHash);

    // Non-existent prompt
    expect(getArchetype("something completely different")).toBeNull();

    // List all archetypes
    const list = listArchetypes();
    expect(list.length).toBe(4);

    const animal = list.find(l => l.archetype === "animal")!;
    expect(animal.count).toBe(1);
    expect(animal.totalJudgments).toBe(2);

    // Search
    expect(searchArchetypes("cat").length).toBe(1);
    expect(searchArchetypes("landscape").length).toBe(1);
    expect(searchArchetypes("port").length).toBe(1);
    expect(searchArchetypes("zzz_notfound").length).toBe(0);

    // Update label
    setArchetype("a cat wearing a hat", "feline");
    expect(getArchetype("a cat wearing a hat")!.archetype).toBe("feline");
    // Seeds preserved across label change
    expect(getArchetype("a cat wearing a hat")!.preferredSeeds).toContain(1001);
  });

  // ===== 2-5-5: Cross-Batch Memory =====
  it("preserves and merges decisions across batches", () => {
    // Same seed+prompt in new batch
    recordDecision({
      seed: 1001, prompt: "a cat wearing a hat", model: "JuggernautXL",
      action: "accept", note: "second look, still good", batchTag: "e2e-review-v2",
    });

    // History accumulates across batches
    expect(getDecisionHistory(1001).length).toBe(2);

    // Wilson score updated with 2nd accept
    const s1001 = getWilsonTopN(10).find(t => t.seed === 1001)!;
    expect(s1001.ups).toBe(2);
    expect(s1001.score).toBeCloseTo(wilsonLowerBound(2, 0), 4);

    // Archetype entry updated
    const cat = getArchetype("a cat wearing a hat");
    expect(cat!.totalJudgments).toBe(3);
    expect(cat!.preferredSeeds).toContain(1001);
    expect(cat!.rejectedSeeds).toContain(1002);

    // Seed 1001 should be ranked higher than seed 2001 now
    const top = getWilsonTopN(10);
    const idx1001 = top.findIndex(t => t.seed === 1001);
    const idx2001 = top.findIndex(t => t.seed === 2001);
    expect(idx1001).toBeLessThan(idx2001); // higher rank = lower index
  });

  // ===== 2-5-6: Detail Query =====
  it("queries image details by seed, filename, and variant tag", () => {
    // Build in-memory index (same structure as curate command)
    const images = new Map<string, ImageMeta>();
    const detections = new Map<number, DetectionResult>();
    const historyMap = new Map<number, DecisionRecord[]>();

    for (const img of IMAGES) {
      const meta = buildImageMeta(img);
      images.set(meta.filename, meta);
      detections.set(img.seed, {
        image: meta,
        handAnomaly: 0.1, faceAnomaly: 0.05,
        compositionScore: 0.8, exposureScore: 0.7,
        layer: Layer.Desired, confidence: 0.9,
      });
    }
    historyMap.set(1001, getDecisionHistory(1001));

    // By seed
    const r1 = queryDetail({ batchId: BATCH_TAG, seed: 1001 }, { images, detections, history: historyMap });
    expect(r1.images.length).toBe(1);
    expect(r1.images[0].meta.seed).toBe(1001);
    expect(r1.images[0].history!.length).toBe(2);

    // By filename
    const r2 = queryDetail({ batchId: BATCH_TAG, filename: "1001_JuggernautXL.png" }, { images, detections });
    expect(r2.images.length).toBe(1);

    // By variant tag (batchTag)
    const r3 = queryDetail({ batchId: BATCH_TAG, variantTag: BATCH_TAG }, { images, detections });
    expect(r3.images.length).toBe(IMAGES.length);

    // Non-existent seed
    const r4 = queryDetail({ batchId: BATCH_TAG, seed: 99999 }, { images, detections });
    expect(r4.images.length).toBe(0);
  });

  // ===== 2-5-7: Wilson Score Ranking =====
  it("produces correct Wilson Score ranking — 2 accepts > 1 accept > 1 reject", () => {
    const topN = getWilsonTopN(10);

    // Descending order
    for (let i = 1; i < topN.length; i++) {
      expect(topN[i - 1].score).toBeGreaterThanOrEqual(topN[i].score);
    }

    // seed 1001 = 2 accepts (highest), seed 2001 = 1 accept (middle), seed 3001 = 1 reject (lowest)
    const s1001 = topN.find(t => t.seed === 1001)!;
    const s2001 = topN.find(t => t.seed === 2001)!;
    const s3001 = topN.find(t => t.seed === 3001)!;

    expect(s1001.score).toBeGreaterThan(s2001.score);
    expect(s2001.score).toBeGreaterThan(s3001.score);

    // Verify Wilson formula correctness
    expect(s1001.score).toBeCloseTo(wilsonLowerBound(2, 0), 4);
    expect(s3001.score).toBeCloseTo(wilsonLowerBound(0, 1), 4);
  });
});
