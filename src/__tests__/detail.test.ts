import { describe, it, expect } from "vitest";
import { queryDetail } from "../engine/detail.js";
import type { ImageMeta, DetectionResult, DetailQuery, DecisionRecord } from "../types/bddd.js";
import { Layer } from "../types/bddd.js";

function makeMeta(seed: number, filename: string, batchTag = "test-batch"): ImageMeta {
  return {
    path: `/tmp/${filename}`,
    filename,
    size: 1024,
    width: 512,
    height: 512,
    seed,
    prompt: "test prompt",
    cfg: 7.0,
    model: "test-model",
    batchTag,
  };
}

function makeDetection(seed: number, layer: Layer = Layer.Desired): DetectionResult {
  return {
    image: makeMeta(seed, `img_${seed}.png`),
    handAnomaly: 0,
    faceAnomaly: 0,
    compositionScore: 0.8,
    exposureScore: 0.8,
    layer,
    confidence: 0.9,
  };
}

describe("queryDetail", () => {
  const seedMap = new Map<number, DetectionResult>();
  const fileMap = new Map<string, ImageMeta>();
  const emptyHistory = new Map<number, DecisionRecord[]>();

  beforeAll(() => {
    // Seed 42
    const d42 = makeDetection(42, Layer.Desired);
    seedMap.set(42, d42);
    fileMap.set("img_42.png", d42.image);

    // Seed 77
    const d77 = makeDetection(77, Layer.Bad);
    seedMap.set(77, d77);
    fileMap.set("img_77.png", d77.image);

    // Seed with history
    const d99 = makeDetection(99, Layer.Dubious);
    seedMap.set(99, d99);
    fileMap.set("img_99.png", d99.image);

    // Variant batch tag set
    const d55 = makeDetection(55, Layer.Desired);
    d55.image.batchTag = "v1";
    seedMap.set(55, d55);
    fileMap.set("img_55.png", d55.image);
  });

  const history = new Map<number, DecisionRecord[]>();
  history.set(99, [
    { seed: 99, prompt: "test", model: "", action: "accept", note: "", createdAt: "1" },
  ]);

  const index = { images: fileMap, detections: seedMap, history };

  it("finds by seed", () => {
    const query: DetailQuery = { seed: 42, batchId: "test" };
    const result = queryDetail(query, index);
    expect(result.images.length).toBe(1);
    expect(result.images[0].meta.seed).toBe(42);
  });

  it("finds by filename", () => {
    const query: DetailQuery = { filename: "img_77.png", batchId: "test" };
    const result = queryDetail(query, index);
    expect(result.images.length).toBe(1);
    expect(result.images[0].meta.seed).toBe(77);
  });

  it("finds by variant tag", () => {
    const query: DetailQuery = { variantTag: "v1", batchId: "test" };
    const result = queryDetail(query, index);
    expect(result.images.length).toBe(1);
    expect(result.images[0].meta.seed).toBe(55);
  });

  it("returns history when available", () => {
    const query: DetailQuery = { seed: 99, batchId: "test" };
    const result = queryDetail(query, index);
    expect(result.images.length).toBe(1);
    expect(result.images[0].history).toBeDefined();
    expect(result.images[0].history!.length).toBe(1);
  });

  it("returns empty for unknown seed", () => {
    const query: DetailQuery = { seed: 9999, batchId: "test" };
    const result = queryDetail(query, index);
    expect(result.images.length).toBe(0);
  });

  it("avoids duplicate results when seed and filename match same image", () => {
    const query: DetailQuery = { seed: 42, filename: "img_42.png", batchId: "test" };
    const result = queryDetail(query, index);
    expect(result.images.length).toBe(1);
  });
});
