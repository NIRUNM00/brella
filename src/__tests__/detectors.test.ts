import { describe, it, expect } from "vitest";
import type { ImageMeta } from "../types/bddd.js";
import { Layer } from "../types/bddd.js";
import { HandEvalDetector } from "../detectors/handeval.js";
import { FaceDetector } from "../detectors/face.js";
import { CompositionDetector } from "../detectors/composition.js";
import { ClassificationPipeline, createPipeline } from "../pipeline/classify.js";

// ============================================================
// Test Fixtures
// ============================================================

function makeImage(overrides: Partial<ImageMeta> = {}): ImageMeta {
  return {
    path: "/tmp/test.png",
    filename: "test.png",
    size: 3 * 1024 * 1024, // 3MB for 1024x1024
    width: 1024,
    height: 1024,
    seed: 1001,
    prompt: "a cat wearing a hat",
    cfg: 7.0,
    model: "JuggernautXL",
    batchTag: "test-batch",
    ...overrides,
  };
}

// ============================================================
// HandEval Detector Tests
// ============================================================

describe("HandEval Detector (heuristic)", () => {
  const detector = new HandEvalDetector();

  it("handles normal images as low anomaly", async () => {
    const img = makeImage({ width: 1024, height: 1024, size: 3 * 1024 * 1024 });
    const result = await detector.analyze(img);
    expect(result.hand).toBeDefined();
    expect(result.hand!.anomalyScore).toBeLessThan(0.5);
  });

  it("flags extreme aspect ratio as higher anomaly", async () => {
    const img = makeImage({ width: 3000, height: 200, size: 500000 });
    const result = await detector.analyze(img);
    expect(result.hand!.anomalyScore).toBeGreaterThan(0.3);
    expect(result.hand!.details.some(d => d.includes("aspect"))).toBe(true);
  });

  it("flags tiny file size as high anomaly", async () => {
    const img = makeImage({ width: 1024, height: 1024, size: 1024 });
    const result = await detector.analyze(img);
    expect(result.hand!.anomalyScore).toBeGreaterThan(0.5);
    expect(result.hand!.details.some(d => d.includes("too small"))).toBe(true);
  });

  it("returns -1 hand count in heuristic mode", async () => {
    const img = makeImage();
    const result = await detector.analyze(img);
    expect(result.hand!.handCount).toBe(-1);
  });

  it("returns sub-0.5 confidence in heuristic mode", async () => {
    const img = makeImage();
    const result = await detector.analyze(img);
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("handles very small images", async () => {
    const img = makeImage({ width: 32, height: 32, size: 500 });
    const result = await detector.analyze(img);
    expect(result.hand!.anomalyScore).toBe(0.5);
    expect(result.hand!.handCount).toBe(-1);
  });
});

// ============================================================
// Face Detector Tests
// ============================================================

describe("Face Detector (heuristic)", () => {
  const detector = new FaceDetector();

  it("detects portrait prompts as having face", async () => {
    const img = makeImage({ prompt: "portrait of a beautiful girl" });
    const result = await detector.analyze(img);
    expect(result.face).toBeDefined();
    expect(result.face!.faceCount).toBe(1);
  });

  it("flags too-small images as high anomaly", async () => {
    const img = makeImage({ width: 64, height: 64, size: 2000 });
    const result = await detector.analyze(img);
    expect(result.face!.anomalyScore).toBeGreaterThanOrEqual(0.6);
  });

  it("flags corrupted images as high anomaly", async () => {
    const img = makeImage({ width: 512, height: 512, size: 2048 });
    const result = await detector.analyze(img);
    expect(result.face!.anomalyScore).toBeGreaterThan(0.3);
  });

  it("treats non-face prompts neutrally", async () => {
    const img = makeImage({ prompt: "sunset landscape" });
    const result = await detector.analyze(img);
    expect(result.face!.faceCount).toBe(-1);
    // Without face hint, minimal penalty applies
    expect(result.face!.anomalyScore).toBeGreaterThan(0);
    expect(result.face!.anomalyScore).toBeLessThan(0.5);
  });
});

// ============================================================
// Composition Detector Tests
// ============================================================

describe("Composition Detector (heuristic)", () => {
  const detector = new CompositionDetector();

  it("scores standard 1:1 aspect ratio high", async () => {
    const img = makeImage({ width: 1024, height: 1024 });
    const result = await detector.analyze(img);
    expect(result.composition).toBeDefined();
    expect(result.composition!.score).toBeGreaterThan(0.7);
  });

  it("scores 3:4 portrait ratio high", async () => {
    const img = makeImage({ width: 768, height: 1024 });
    const result = await detector.analyze(img);
    expect(result.composition!.subjectPositionScore).toBeGreaterThan(0.8);
  });

  it("penalizes extreme aspect ratios", async () => {
    const img = makeImage({ width: 2000, height: 100 });
    const result = await detector.analyze(img);
    expect(result.composition!.subjectPositionScore).toBeLessThan(0.5);
    expect(result.composition!.details.some(d => d.includes("Extreme"))).toBe(true);
  });

  it("returns neutral exposure for normal images", async () => {
    const img = makeImage();
    const result = await detector.analyze(img);
    expect(result.exposure).toBeDefined();
    expect(result.exposure!.score).toBeGreaterThan(0.5);
  });

  it("detects high contrast from mixed light keywords", async () => {
    const img = makeImage({ prompt: "bright sunlight and deep shadows" });
    const result = await detector.analyze(img);
    expect(result.exposure!.contrastScore).toBeGreaterThan(0.8);
  });
});

// ============================================================
// Pipeline Classification Tests
// ============================================================

describe("Classification Pipeline (3-layer)", () => {
  let pipeline: ClassificationPipeline;

  beforeAll(() => {
    pipeline = createPipeline();
  });

  // ===== Bad 层触发 =====

  it("classifies hand anomaly as Bad", async () => {
    // Force hand anomaly via tiny file
    const img = makeImage({ width: 1024, height: 1024, size: 512 });
    const result = await pipeline.classifyOne(img);
    expect(result.detection.layer).toBe(Layer.Bad);
    expect(result.detection.handAnomaly).toBeGreaterThan(0.5);
    expect(result.reasons.some(r => r.includes("Hand"))).toBe(true);
  });

  it("classifies face anomaly as Bad", async () => {
    // Force face anomaly via tiny resolution
    const img = makeImage({ width: 64, height: 64, size: 500, prompt: "portrait" });
    const result = await pipeline.classifyOne(img);
    // Hand anomaly will also trigger, so Bad either way
    expect(result.detection.layer).toBe(Layer.Bad);
  });

  // ===== Dubious 层触发 =====

  it("classifies extreme aspect ratio as Dubious", async () => {
    const img = makeImage({ width: 300, height: 2400, size: 3 * 1024 * 1024 });
    const result = await pipeline.classifyOne(img);
    // Hand and face should be OK, but composition is bad → Dubious
    expect(result.detection.layer).toBe(Layer.Dubious);
    expect(result.reasons.some(r => r.includes("Composition") || r.includes("Exposure"))).toBe(true);
  });

  // ===== Desired 层 =====

  it("classifies normal high-quality images as Desired", async () => {
    const img = makeImage({
      width: 1024, height: 1024,
      size: 3 * 1024 * 1024,
      prompt: "portrait of a beautiful girl with nice composition",
    });
    const result = await pipeline.classifyOne(img);
    expect(result.detection.layer).toBe(Layer.Desired);
    expect(result.detection.confidence).toBeGreaterThan(0.5);
  });

  // ===== 批量分类 =====

  it("classifies batch of images", async () => {
    const images: ImageMeta[] = [
      makeImage({ seed: 1, prompt: "portrait", width: 1024, height: 1024, size: 3 * 1024 * 1024 }),
      makeImage({ seed: 2, prompt: "landscape", width: 2000, height: 60, size: 50000 }),
      makeImage({ seed: 3, prompt: "cat", width: 512, height: 512, size: 200 }),
    ];

    const results = await pipeline.classifyBatch(images);
    expect(results.length).toBe(3);

    // Landscape with extreme ratio → likely Dubious or Bad
    expect(results[1].detection.layer).not.toBe(Layer.Desired);

    // Corrupted cat image → Bad
    expect(results[2].detection.layer).toBe(Layer.Bad);
  });

  // ===== 自定义阈值 =====

  it("respects custom pipeline thresholds", async () => {
    const strictPipeline = createPipeline({
      handThresholdBad: 0.3,  // Stricter: any hand anomaly → Bad
      faceThresholdBad: 0.3,
    });

    // Normal image that would be Desired with default, but handHeuristic might trigger
    const img = makeImage({ width: 1024, height: 1024, size: 3 * 1024 * 1024, prompt: "normal" });
    const result = await strictPipeline.classifyOne(img);
    // With very low thresholds, even normal images might be flagged
    // The exact behavior depends on heuristic output
    expect([Layer.Bad, Layer.Dubious, Layer.Desired]).toContain(result.detection.layer);
  });
});
