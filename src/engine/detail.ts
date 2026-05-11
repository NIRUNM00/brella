import type { ImageMeta, DetectionResult, DetailQuery, DetailResponse, DecisionRecord } from "../types/bddd.js";

/**
 * 从内存索引中检索 Detail
 */
export function queryDetail(
  query: DetailQuery,
  index: {
    images: Map<string, ImageMeta>;  // key: filename
    detections: Map<number, DetectionResult>; // key: seed
    history?: Map<number, DecisionRecord[]>;
  },
): DetailResponse {
  const matched: Array<{
    meta: ImageMeta;
    detection: DetectionResult;
    history?: DecisionRecord[];
  }> = [];

  // 精确匹配 seed
  if (query.seed !== undefined) {
    const det = index.detections.get(query.seed);
    if (det) {
      matched.push({
        meta: det.image,
        detection: det,
        history: index.history?.get(query.seed),
      });
    }
  }

  // 精确匹配 filename
  if (query.filename) {
    const meta = index.images.get(query.filename);
    if (meta) {
      const det = index.detections.get(meta.seed);
      if (det && (query.seed === undefined || det.image.seed !== query.seed)) {
        // Avoid duplicate if seed already matched same image
        if (!matched.some((m) => m.meta.seed === meta.seed)) {
          matched.push({
            meta,
            detection: det,
            history: index.history?.get(meta.seed),
          });
        }
      }
    }
  }

  // variantTag 模糊匹配 (batchTag)
  if (query.variantTag) {
    for (const [seed, det] of index.detections) {
      if (det.image.batchTag === query.variantTag) {
        if (!matched.some((m) => m.meta.seed === seed)) {
          matched.push({
            meta: det.image,
            detection: det,
            history: index.history?.get(seed),
          });
        }
      }
    }
  }

  return {
    batchId: query.batchId,
    images: matched,
  };
}
