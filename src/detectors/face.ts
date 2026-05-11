// ============================================================
// 面部结构检测器
// 检测面部扭曲、五官比例异常、多脸/无脸等
// 模式: local-heuristic (CPU) / remote-api
// ============================================================

import { readFileSync } from "node:fs";
import type { ImageMeta } from "../types/bddd.js";
import type {
  Detector,
  DetectorConfig,
  DetectorResult,
  FaceAnalysis,
} from "./types.js";

export type FaceMode = "local-heuristic" | "remote-api";

export interface FaceDetectorConfig extends DetectorConfig {
  mode: FaceMode;
  /** 认为"可能包含面部"的最小分辨率 */
  minFaceResolution?: number;
}

const DEFAULT_FACE_CONFIG: Required<FaceDetectorConfig> = {
  capabilities: ["face"],
  mode: "local-heuristic",
  modelPath: "",
  remoteEndpoint: "",
  confidenceThreshold: 0.5,
  minFaceResolution: 128,
};

// ============================================================
// 启发式面部检测（CPU only）
// ============================================================

/**
 * 基于元数据的启发式面部检测。
 *
 * 原理：
 * - 极低分辨率 (< minRes) → 面部无法检测 → 中异常
 * - 人像/半身/特写的分辨率暗示（宽高比接近 3:4 或 4:3 且分辨率足够）
 * - 极端的宽高比（如 16:9 横向全景）→ 不太可能是面部特写
 * - 文件过小 → 生成可能有问题 → 异常
 */
function heuristicFaceAnalysis(
  image: ImageMeta,
  minResolution: number,
): FaceAnalysis {
  const details: string[] = [];
  const { width, height, size, prompt } = image;
  const minDim = Math.min(width, height);

  // 1. 分辨率检查
  if (minDim < minResolution) {
    return {
      anomalyScore: 0.6,
      faceCount: -1,
      distortionScore: 0.3,
      details: ["Resolution too low for face detection"],
    };
  }

  // 2. 宽高比推断面部可能性
  const aspect = width / height;
  const isLandscape = aspect > 1.3;

  let aspectAnomaly = 0;
  if (isLandscape && minDim < 512) {
    aspectAnomaly = 0.15;
    details.push("Landscape crop, low face probability");
  }

  // 3. 文件大小与分辨率比异常
  const expectedSize = width * height * 3;
  const sizeRatio = size / expectedSize;

  let sizeAnomaly = 0;
  if (sizeRatio < 0.05) {
    sizeAnomaly = 0.7;
    details.push("File size far below expected — possible corruption");
  } else if (sizeRatio < 0.15) {
    sizeAnomaly = 0.3;
    details.push("Higher compression than expected");
  }

  // 4. Prompt 关键词提示
  const promptLower = prompt.toLowerCase();
  const faceKeywords = ["face", "portrait", "close-up", "closeup", "headshot",
    "selfie", "facial", "face shot"];
  const hasFaceHint = faceKeywords.some((kw) => promptLower.includes(kw));

  if (hasFaceHint && minDim < 256) {
    aspectAnomaly = Math.max(aspectAnomaly, 0.5);
    details.push("Prompt suggests face but resolution is low");
  }

  // 5. 综合评分
  const anomalyScore = Math.min(1,
    aspectAnomaly * 0.3 +
    sizeAnomaly * 0.5 +
    (hasFaceHint ? 0 : 0.05),
  );

  const faceCount = hasFaceHint ? 1 : -1;
  const distortionScore = Math.min(1, sizeAnomaly * 0.8 + (aspectAnomaly > 0.4 ? 0.3 : 0));

  return {
    anomalyScore,
    faceCount,
    distortionScore,
    details,
  };
}

// ============================================================
// 远程 API 调用
// ============================================================

async function remoteFaceAnalysis(
  image: ImageMeta,
  imageBuffer?: Buffer,
  endpoint?: string,
): Promise<FaceAnalysis> {
  if (!endpoint) {
    throw new Error("Face detector remote endpoint not configured");
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
      throw new Error(`Face API returned ${response.status}`);
    }

    const data = (await response.json()) as {
      anomaly_score: number;
      face_count: number;
      distortion_score: number;
      details: string[];
    };

    return {
      anomalyScore: data.anomaly_score,
      faceCount: data.face_count,
      distortionScore: data.distortion_score,
      details: data.details,
    };
  } catch (err) {
    const fb = heuristicFaceAnalysis(image, 128);
    fb.details.push(`Remote API failed (${err}), fell back to heuristic`);
    return fb;
  }
}

// ============================================================
// FaceDetector 实现
// ============================================================

export class FaceDetector implements Detector {
  readonly name = "face";
  readonly config: Required<FaceDetectorConfig>;

  constructor(config: Partial<FaceDetectorConfig> = {}) {
    this.config = { ...DEFAULT_FACE_CONFIG, ...config };
  }

  async analyze(
    image: ImageMeta,
    imageBuffer?: Buffer,
  ): Promise<DetectorResult> {
    const start = performance.now();
    let face: FaceAnalysis;

    switch (this.config.mode) {
      case "remote-api": {
        face = await remoteFaceAnalysis(image, imageBuffer, this.config.remoteEndpoint);
        break;
      }
      default: {
        face = heuristicFaceAnalysis(image, this.config.minFaceResolution);
        break;
      }
    }

    const elapsed = performance.now() - start;
    const confidence = face.faceCount >= 0 ? 0.6 : 0.35;

    return {
      face,
      confidence,
      processingTimeMs: Math.round(elapsed),
    };
  }
}

export function createFaceDetector(config?: Partial<FaceDetectorConfig>): FaceDetector {
  return new FaceDetector(config);
}
