// ============================================================
// 构图 & 曝光检测器
// 评估三分法则、主体位置、过曝/欠曝、对比度
// 模式: local-heuristic (CPU) / remote-api
// ============================================================

import { readFileSync } from "node:fs";
import type { ImageMeta } from "../types/bddd.js";
import type {
  Detector,
  DetectorConfig,
  DetectorResult,
  CompositionAnalysis,
  ExposureAnalysis,
} from "./types.js";

export type CompositionMode = "local-heuristic" | "remote-api";

export interface CompositionDetectorConfig extends DetectorConfig {
  mode: CompositionMode;
}

const DEFAULT_CONFIG: Required<CompositionDetectorConfig> = {
  capabilities: ["composition", "exposure"],
  mode: "local-heuristic",
  modelPath: "",
  remoteEndpoint: "",
  confidenceThreshold: 0.5,
};

// ============================================================
// 启发式检测（CPU only）
// ============================================================

/**
 * 构图评估 — 基于图像元数据和宽高比。
 *
 * 原理：
 * - 标准画幅（1:1, 3:4, 4:3, 16:9）→ 构图基础较好
 * - 极端宽高比 → 构图可能有问题
 * - 过大图像尺寸 → 可能是高分辨率细节图，构图较好
 * - Prompt 中构图关键词检测
 */
function heuristicComposition(image: ImageMeta): CompositionAnalysis {
  const details: string[] = [];
  const { width, height, prompt } = image;
  const aspect = width / height;
  const minDim = Math.min(width, height);

  // 1. 宽高比评分
  const standardRatios = [1, 3 / 4, 4 / 3, 16 / 9, 9 / 16, 3 / 2, 2 / 3];
  const ratioDiff = standardRatios.reduce(
    (min, r) => Math.min(min, Math.abs(aspect - r)), Infinity,
  );

  let aspectScore = 0.9; // 默认好
  if (ratioDiff > 0.15 && minDim > 128) {
    aspectScore = Math.max(0.3, 0.9 - ratioDiff * 1.0);
    details.push(`Unusual aspect ratio (${aspect.toFixed(2)}:1)`);
  }

  // 2. 主体位置评分（基于宽高比推断）
  // 正方形 → 主体通常居中 → 好
  // 3:4 竖版 → 适合人像 → 好
  // 16:9 → 适合风景/全景
  let subjectPositionScore = 0.8;
  if (Math.abs(aspect - 1) < 0.1) {
    subjectPositionScore = 0.85; // 正方形，适合居中构图
  } else if (aspect > 0.7 && aspect < 0.8) {
    subjectPositionScore = 0.9; // 3:4 竖版，经典人像
  } else if (aspect > 1.7 && aspect < 1.8) {
    subjectPositionScore = 0.85; // 16:9 横向，风景适用
  } else if (aspect > 2.0 || aspect < 0.45) {
    subjectPositionScore = 0.4;
    details.push("Extreme aspect ratio — likely poor subject placement");
  }

  // 3. 三分法则评分（基于分辨率和宽高比）
  const hasHighRes = minDim >= 1024;
  const ruleOfThirdsScore = hasHighRes ? 0.85 : 0.55;
  if (!hasHighRes) {
    details.push("Low resolution — rule of thirds may be unreliable");
  }

  // 4. Prompt 构图提示
  const promptLower = prompt.toLowerCase();
  const compKeywords = ["composition", "symmetry", "golden ratio", "rule of thirds",
    "center framing", "off-center", "close-up", "wide shot", "full body",
    "half body", "upper body"];
  const hasCompHint = compKeywords.some(kw => promptLower.includes(kw));
  if (hasCompHint) {
    subjectPositionScore = Math.min(1, subjectPositionScore + 0.1);
  }

  // 综合评分
  const score = Math.min(1,
    aspectScore * 0.35 +
    subjectPositionScore * 0.35 +
    ruleOfThirdsScore * 0.3,
  );

  return { score, subjectPositionScore, ruleOfThirdsScore, details };
}

/**
 * 曝光评估 — 基于元数据和分辨率推断。
 *
 * 原理：
 * - 文件大小异常 → 可能过曝/欠曝
 * - 极暗/极亮 prompt 关键词
 * - 高分辨率通常曝光更准确
 */
function heuristicExposure(image: ImageMeta): ExposureAnalysis {
  const details: string[] = [];
  const { width, height, size, prompt } = image;
  const minDim = Math.min(width, height);

  // 1. 文件大小推断
  const expectedSize = width * height * 3;
  const sizeRatio = size / expectedSize;

  let overEx = 0;
  let underEx = 0;

  if (sizeRatio < 0.05) {
    overEx = 0.5;
    underEx = 0.3;
    details.push("Extremely small file — possible over/underexposure");
  } else if (sizeRatio > 2.5) {
    overEx = 0.3;
    details.push("Unusually large file — possible overexposure noise");
  }

  // 2. Prompt 曝光关键词
  const promptLower = prompt.toLowerCase();
  const brightHint = ["bright", "sunlight", "overexposed", "glare", "bloom",
    "white background", "high key"].some(kw => promptLower.includes(kw));
  const darkHint = ["dark", "night", "shadow", "underexposed", "low key",
    "dim", "gloomy", "silhouette", "black background"].some(kw => promptLower.includes(kw));
  const normalHint = ["well-lit", "balanced", "natural light", "soft lighting",
    "studio lighting", "golden hour"].some(kw => promptLower.includes(kw));

  if (brightHint && sizeRatio > 1.5) {
    overEx = Math.max(overEx, 0.3);
    details.push("Bright prompt + large file — possible overexposure");
  }

  if (darkHint && sizeRatio < 0.2) {
    underEx = Math.max(underEx, 0.3);
    details.push("Dark prompt + small file — possible underexposure");
  }

  // 3. 对比度评分
  let contrastScore = 0.7;
  if (normalHint) {
    contrastScore = 0.85;
  } else if (brightHint && darkHint) {
    contrastScore = 0.9;
    details.push("High-contrast scene detected from prompt");
  } else if (minDim < 256) {
    contrastScore = 0.4;
    details.push("Low resolution limits contrast analysis");
  }

  // 综合曝光评分
  const score = Math.min(1,
    1 - (overEx * 0.5 + underEx * 0.5)
  );

  return {
    score,
    overexposureScore: overEx,
    underexposureScore: underEx,
    contrastScore,
    details,
  };
}

// ============================================================
// CompositionDetector 实现
// ============================================================

export class CompositionDetector implements Detector {
  readonly name = "composition";
  readonly config: Required<CompositionDetectorConfig>;

  constructor(config: Partial<CompositionDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async analyze(image: ImageMeta, _imageBuffer?: Buffer): Promise<DetectorResult> {
    const start = performance.now();

    const composition = heuristicComposition(image);
    const exposure = heuristicExposure(image);

    const elapsed = performance.now() - start;

    return {
      composition,
      exposure,
      confidence: 0.5,
      processingTimeMs: Math.round(elapsed),
    };
  }
}

export function createCompositionDetector(
  config?: Partial<CompositionDetectorConfig>,
): CompositionDetector {
  return new CompositionDetector(config);
}
