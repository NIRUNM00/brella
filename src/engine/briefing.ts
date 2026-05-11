import type { ImageMeta, DetectionResult, Briefing, Layer, LayerSummary } from "../types/bddd.js";
import { Layer as L, LAYER_ORDER } from "../types/bddd.js";
import { sortByWilsonScore, computeWilsonScore } from "../scoring/wilson.js";
import type { DecisionRecord } from "../types/bddd.js";

export interface BriefingOptions {
  batchTag?: string;
  wilsonAlpha?: number;
  /** 历史决策记录，用于 Wilson Score 排序 Dubious 层 */
  history?: Map<number, DecisionRecord[]>;
}

/**
 * 从检测结果列表生成 Briefing
 */
export function generateBriefing(
  results: DetectionResult[],
  options: BriefingOptions = {},
): Briefing {
  const { batchTag = "auto", history = new Map(), wilsonAlpha = 0.05 } = options;

  const layers: Record<Layer, LayerSummary> = {
    [L.Bad]: { layer: L.Bad, count: 0, images: [] },
    [L.Dubious]: { layer: L.Dubious, count: 0, images: [] },
    [L.Desired]: { layer: L.Desired, count: 0, images: [] },
  };

  for (const r of results) {
    layers[r.layer].count++;
    layers[r.layer].images.push(r.image);
  }

  // Dubious 层：按 Wilson Score 排序
  if (layers[L.Dubious].count > 0) {
    const ranked = layers[L.Dubious].images.map((img) => {
      const records = history.get(img.seed) ?? [];
      const ws = computeWilsonScore(records, /*z*/ 1.96);
      return { image: img, score: ws.score };
    });
    layers[L.Dubious].rankedImages = sortByWilsonScore(ranked);
  }

  const total = results.length;

  // 生成一句概况（中文）
  const summary = buildSummary(total, layers);

  return {
    batchId: batchTag === "auto" ? `batch_${Date.now()}` : batchTag,
    total,
    layers,
    summary,
    createdAt: new Date().toISOString(),
  };
}

function buildSummary(total: number, layers: Record<Layer, LayerSummary>): string {
  const parts: string[] = [];
  parts.push(`本批共 ${total} 张`);

  if (layers[L.Bad].count > 0) {
    parts.push(`Bad ${layers[L.Bad].count} 张（崩手/崩脸/结构缺陷）`);
  }
  if (layers[L.Dubious].count > 0) {
    parts.push(`Dubious ${layers[L.Dubious].count} 张（构图/光线有疑问）`);
  }
  if (layers[L.Desired].count > 0) {
    parts.push(`Desired ${layers[L.Desired].count} 张（无缺陷）`);
  }

  return parts.join("，");
}
