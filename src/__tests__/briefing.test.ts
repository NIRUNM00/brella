import { describe, it, expect } from "vitest";
import { generateBriefing } from "../engine/briefing.js";
import type { DetectionResult, DecisionRecord } from "../types/bddd.js";
import { Layer } from "../types/bddd.js";

function makeDetection(
  seed: number,
  layer: Layer,
  handAnomaly = 0,
  faceAnomaly = 0,
  batchTag = "test",
): DetectionResult {
  return {
    image: {
      path: `/tmp/test_${seed}.png`,
      filename: `test_${seed}.png`,
      size: 1024,
      width: 512,
      height: 512,
      seed,
      prompt: "test prompt",
      cfg: 7.0,
      model: "test-model",
      batchTag,
    },
    handAnomaly,
    faceAnomaly,
    compositionScore: 0.7,
    exposureScore: 0.7,
    layer,
    confidence: 0.8,
  };
}

describe("generateBriefing", () => {
  it("distributes results into layers", () => {
    const results = [
      makeDetection(1, Layer.Bad),
      makeDetection(2, Layer.Bad),
      makeDetection(3, Layer.Dubious),
      makeDetection(4, Layer.Desired),
      makeDetection(5, Layer.Desired),
    ];
    const briefing = generateBriefing(results, { batchTag: "test" });
    expect(briefing.total).toBe(5);
    expect(briefing.layers[Layer.Bad].count).toBe(2);
    expect(briefing.layers[Layer.Dubious].count).toBe(1);
    expect(briefing.layers[Layer.Desired].count).toBe(2);
    expect(briefing.batchId).toBe("test");
    expect(briefing.createdAt).toBeTruthy();
  });

  it("generates a summary string", () => {
    const results = [
      makeDetection(1, Layer.Bad),
      makeDetection(2, Layer.Desired),
      makeDetection(3, Layer.Desired),
    ];
    const briefing = generateBriefing(results);
    expect(briefing.summary).toBeTruthy();
    expect(briefing.summary.length).toBeGreaterThan(10);
  });

  it("ranks Dubious layer by Wilson score when history exists", () => {
    const results = [
      makeDetection(10, Layer.Dubious),
      makeDetection(20, Layer.Dubious),
    ];

    // History: seed 10 has more accepts, seed 20 has more rejects
    const history = new Map<number, DecisionRecord[]>();
    history.set(10, [
      { seed: 10, prompt: "test", model: "", action: "accept", note: "", createdAt: "1" },
      { seed: 10, prompt: "test", model: "", action: "accept", note: "", createdAt: "2" },
    ]);
    history.set(20, [
      { seed: 20, prompt: "test", model: "", action: "reject", note: "", createdAt: "1" },
      { seed: 20, prompt: "test", model: "", action: "reject", note: "", createdAt: "2" },
    ]);

    const briefing = generateBriefing(results, { history, batchTag: "rank-test" });
    const ranked = briefing.layers[Layer.Dubious].rankedImages;
    expect(ranked).toBeDefined();
    expect(ranked!.length).toBe(2);
    // Higher Wilson score first
    expect(ranked![0].image.seed).toBe(10);
    expect(ranked![0].score).toBeGreaterThan(ranked![1].score);
  });

  it("handles empty results", () => {
    const briefing = generateBriefing([]);
    expect(briefing.total).toBe(0);
    for (const l of [Layer.Bad, Layer.Dubious, Layer.Desired]) {
      expect(briefing.layers[l].count).toBe(0);
    }
  });

  it("auto-generates batch ID when tag is auto/not provided", () => {
    const briefing = generateBriefing([makeDetection(1, Layer.Desired)]);
    expect(briefing.batchId.length).toBeGreaterThan(5);
  });
});
