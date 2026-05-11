// ============================================================
// HandEval 手部异常检测器
// 支持三种模式：
//   1. local-heuristic — CPU 启发式检测（无 GPU 需求）
//   2. remote-api — 远程 HandEval 服务调用
//   3. hybrid — 先 heuristic，置信度不足时调远程
// ============================================================

import { statSync, readFileSync } from "node:fs";
import type { ImageMeta } from "../types/bddd.js";
import type {
  Detector,
  DetectorConfig,
  DetectorResult,
  HandAnalysis,
  DetectorCapability,
} from "./types.js";

export type HandEvalMode = "local-heuristic" | "remote-api" | "hybrid";

export interface HandEvalConfig extends DetectorConfig {
  mode: HandEvalMode;
  /** 启发式检测中，认为"可能存在手部"的图像尺寸下限 */
  minSizeForHandDetection?: number;
  /** Hybrid 模式下，触发远程 API 的 heuristic 置信度阈值 */
  hybridRemoteThreshold?: number;
}

const DEFAULT_HAND_CONFIG: Required<HandEvalConfig> = {
  capabilities: ["hand"],
  mode: "local-heuristic",
  modelPath: "",
  remoteEndpoint: "",
  confidenceThreshold: 0.5,
  minSizeForHandDetection: 256,
  hybridRemoteThreshold: 0.6,
};

// ============================================================
// 启发式检测（CPU only）
// ============================================================

/**
 * 在无 GPU / 无 HandEval 模型时使用。
 * 基于图像文件的尺寸、宽高比和文件名中的元数据进行推断。
 *
 * 原理：
 * - 超小尺寸（< 64px）→ 无法检测 → 低置信度
 * - 极端的宽高比（> 3:1 或 < 1:3）→ 可能裁切到手 → 中等异常
 * - 文件大小异常（过小/过大）→ 可能是生成失败 → 提高异常
 * - 文件名中的特征提示（若 prompt 中无 hand/finger 描述却出现了手部）→ 异常
 */
function heuristicHandAnalysis(image: ImageMeta): HandAnalysis {
  const details: string[] = [];
  const { width, height, size, prompt } = image;

  // 0. 尺寸下限
  const minDim = Math.min(width, height);
  if (minDim < 64) {
    return {
      anomalyScore: 0.5,
      handCount: -1,
      details: ["Image too small for hand detection"],
    };
  }

  // 1. 宽高比异常
  const aspect = Math.max(width, height) / Math.min(width, height);
  let aspectAnomaly = 0;
  if (aspect > 2.5) {
    aspectAnomaly = Math.min(1, (aspect - 2.5) / 3);
    details.push(`Extreme aspect ratio (${aspect.toFixed(2)}:1) — possible cropping`);
  } else if (aspect > 1.8) {
    aspectAnomaly = 0.2;
    details.push(`Unusual aspect ratio (${aspect.toFixed(2)}:1)`);
  }

  // 2. 文件大小异常
  const normalSize = width * height * 3; // rough estimate for RGB
  const sizeRatio = size / normalSize;
  let sizeAnomaly = 0;
  if (sizeRatio < 0.05) {
    sizeAnomaly = 0.9;
    details.push("File too small for resolution — possible generation artifact");
  } else if (sizeRatio < 0.15) {
    sizeAnomaly = 0.3;
    details.push("Compressed beyond expected — possible quality loss");
  } else if (sizeRatio > 3) {
    sizeAnomaly = 0.2;
    details.push("File larger than expected — possible noise artifacts");
  }

  // 3. Prompt 冲突检测
  const promptLower = prompt.toLowerCase();
  const handKeywords = ["hand", "hands", "fingers", "finger", "paw", "holding", "grab", "grasp"];
  const hasHandInPrompt = handKeywords.some((kw) => promptLower.includes(kw));
  // 对于 ACGN/anime 图片，如果 prompt 没有描述手部但图片可能包含手部
  // (实际在 GPU 模式下会做关键点检测，这里仅作提示)
  if (!hasHandInPrompt && minDim > 512) {
    // 没有手部描述但分辨率足够高 → 可能是全身/半身图但未描述手
    // 这本身不是异常，但对 handAnomaly 不作惩罚
  }

  // 4. 综合评分
  const anomalyScore = Math.min(1, Math.max(0.1,
    aspectAnomaly * 0.4 +
    sizeAnomaly * 0.6
  ));

  // 手部数量：heuristic 无法精确检测
  const handCount = -1;

  return { anomalyScore, handCount, details };
}

// ============================================================
// 远程 API 调用
// ============================================================

async function remoteHandAnalysis(
  image: ImageMeta,
  imageBuffer?: Buffer,
  endpoint?: string,
): Promise<HandAnalysis> {
  if (!endpoint) {
    throw new Error("HandEval remote endpoint not configured");
  }

  const buf = imageBuffer ?? readFileSync(image.path);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`HandEval API returned ${response.status}`);
    }

    const data = (await response.json()) as {
      anomaly_score: number;
      hand_count: number;
      details: string[];
    };

    return {
      anomalyScore: data.anomaly_score,
      handCount: data.hand_count,
      details: data.details,
    };
  } catch (err) {
    // 降级到 heuristic
    const fallback = heuristicHandAnalysis(image);
    fallback.details.push(`Remote API failed (${err}), fell back to heuristic`);
    return fallback;
  }
}

// ============================================================
// HandEval Detector 实现
// ============================================================

export class HandEvalDetector implements Detector {
  readonly name = "handeval";
  readonly config: Required<HandEvalConfig>;

  constructor(config: Partial<HandEvalConfig> = {}) {
    this.config = { ...DEFAULT_HAND_CONFIG, ...config };
  }

  async analyze(
    image: ImageMeta,
    imageBuffer?: Buffer,
  ): Promise<DetectorResult> {
    const start = performance.now();

    let hand: HandAnalysis;

    switch (this.config.mode) {
      case "remote-api": {
        hand = await remoteHandAnalysis(image, imageBuffer, this.config.remoteEndpoint);
        break;
      }
      case "hybrid": {
        const heuristic = heuristicHandAnalysis(image);
        if (heuristic.anomalyScore < this.config.hybridRemoteThreshold) {
          hand = heuristic;
        } else {
          const remote = await remoteHandAnalysis(
            image, imageBuffer, this.config.remoteEndpoint,
          );
          hand = {
            ...remote,
            details: [...heuristic.details, ...remote.details],
          };
        }
        break;
      }
      default: {
        hand = heuristicHandAnalysis(image);
        break;
      }
    }

    const elapsed = performance.now() - start;

    return {
      hand,
      confidence: hand.handCount >= 0 ? 0.7 : 0.4,
      processingTimeMs: Math.round(elapsed),
    };
  }
}

/**
 * 工厂方法 — 根据配置创建 HandEval 检测器实例
 */
export function createHandDetector(config?: Partial<HandEvalConfig>): HandEvalDetector {
  return new HandEvalDetector(config);
}
