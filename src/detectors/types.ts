// ============================================================
// Phase 3 — 检测器接口定义
// 所有检测器统一实现 Detector 接口
// ============================================================

import type { ImageMeta, DetectionResult } from "../types/bddd.js";

// ---------- 检测结果（各维度原始输出） ----------

export interface HandAnalysis {
  /** 手部异常评分 0-1，越高越可能崩手 */
  anomalyScore: number;
  /** 检测到的手部数量（-1=无法检测） */
  handCount: number;
  /** 具体发现 */
  details: string[];
}

export interface FaceAnalysis {
  /** 面部异常评分 0-1 */
  anomalyScore: number;
  /** 检测到的人脸数量 */
  faceCount: number;
  /** 五官扭曲度 0-1 */
  distortionScore: number;
  /** 具体发现 */
  details: string[];
}

export interface CompositionAnalysis {
  /** 构图评分 0-1 */
  score: number;
  /** 主体位置评分 0-1 */
  subjectPositionScore: number;
  /** 三分法则/构图法则符合度 0-1 */
  ruleOfThirdsScore: number;
  /** 具体发现 */
  details: string[];
}

export interface ExposureAnalysis {
  /** 曝光评分 0-1 */
  score: number;
  /** 过曝程度 0-1 */
  overexposureScore: number;
  /** 欠曝程度 0-1 */
  underexposureScore: number;
  /** 对比度 0-1 */
  contrastScore: number;
  /** 具体发现 */
  details: string[];
}

// ---------- 检测器接口 ----------

export type DetectorCapability = "hand" | "face" | "composition" | "exposure" | "full";

export interface DetectorConfig {
  /** 检测能力 */
  capabilities: DetectorCapability[];
  /** 模型路径（若有本地模型） */
  modelPath?: string;
  /** 远程 API 端点（若有） */
  remoteEndpoint?: string;
  /** 置信度阈值 */
  confidenceThreshold?: number;
}

export interface DetectorResult {
  hand?: HandAnalysis;
  face?: FaceAnalysis;
  composition?: CompositionAnalysis;
  exposure?: ExposureAnalysis;
  confidence: number;
  processingTimeMs: number;
}

/**
 * 检测器接口 — 所有检测器必须实现
 */
export interface Detector {
  /** 检测器名称 */
  readonly name: string;
  /** 检测器配置 */
  readonly config: DetectorConfig;

  /**
   * 对单张图片执行检测
   * @param image 图像元数据
   * @param imageBuffer 图像二进制数据（可选，缺省时从 path 读取）
   */
  analyze(image: ImageMeta, imageBuffer?: Buffer): Promise<DetectorResult>;
}

// ---------- 管线选项 ----------

export interface PipelineOptions {
  /** 启用哪些检测器（默认全部） */
  detectors?: DetectorCapability[];
  /** HandAnomaly 阈值（超过此值 → Bad） */
  handThresholdBad?: number;    // default 0.5
  faceThresholdBad?: number;    // default 0.6
  /** 构图评分阈值（低于此值 → Dubious） */
  compositionThresholdDubious?: number; // default 0.5
  /** 曝光评分阈值 */
  exposureThresholdDubious?: number;   // default 0.3
  /** 最低置信度 */
  minConfidence?: number;
}

export const DEFAULT_PIPELINE_OPTIONS: Required<PipelineOptions> = {
  detectors: ["hand", "face", "composition", "exposure"],
  handThresholdBad: 0.5,
  faceThresholdBad: 0.6,
  compositionThresholdDubious: 0.5,
  exposureThresholdDubious: 0.3,
  minConfidence: 0.5,
};

// ---------- 分类结果 ----------

export interface ClassifiedResult {
  image: ImageMeta;
  detection: DetectionResult;
  /** 完整的检测原始数据 */
  raw: DetectorResult;
  /** 各维度的触发原因 */
  reasons: string[];
}
