// ============================================================
// Phase 3 — 三层分类管线
// 将各维度检测结果映射到 Bad / Dubious / Desired
// ============================================================

import type { ImageMeta } from "../types/bddd.js";
import { Layer } from "../types/bddd.js";
import type { DetectionResult } from "../types/bddd.js";
import type {
  Detector,
  DetectorResult,
  DetectorCapability,
  PipelineOptions,
  ClassifiedResult,
} from "../detectors/types.js";
import { DEFAULT_PIPELINE_OPTIONS } from "../detectors/types.js";
import { HandEvalDetector } from "../detectors/handeval.js";
import { FaceDetector } from "../detectors/face.js";
import { CompositionDetector } from "../detectors/composition.js";

// ============================================================
// 管线引擎
// ============================================================

export class ClassificationPipeline {
  private detectors: Map<DetectorCapability, Detector> = new Map();
  private options: Required<PipelineOptions>;

  constructor(options?: PipelineOptions) {
    this.options = { ...DEFAULT_PIPELINE_OPTIONS, ...options };
  }

  /**
   * 注册检测器（覆盖默认）
   */
  registerDetector(capability: DetectorCapability, detector: Detector): void {
    this.detectors.set(capability, detector);
  }

  /**
   * 确保默认检测器已加载
   */
  private ensureDetectors(): void {
    if (!this.detectors.has("hand")) {
      this.detectors.set("hand", new HandEvalDetector());
    }
    if (!this.detectors.has("face")) {
      this.detectors.set("face", new FaceDetector());
    }
    if (!this.detectors.has("composition") && !this.detectors.has("exposure")) {
      this.detectors.set("composition", new CompositionDetector());
    }
  }

  // ============================================================
  // 核心：单图分类
  // ============================================================

  /**
   * 对单张图片执行全管线检测并分类
   */
  async classifyOne(image: ImageMeta): Promise<ClassifiedResult> {
    this.ensureDetectors();

    const raw: DetectorResult = {
      confidence: 0,
      processingTimeMs: 0,
    };

    const capabilities = this.options.detectors;

    // 并行运行所有启用的检测器
    const results = await Promise.all(
      capabilities.map(async (cap) => {
        const detector = this.detectors.get(cap);
        if (!detector) return null;
        return await detector.analyze(image);
      }),
    );

    // 合并结果
    for (const result of results) {
      if (!result) continue;
      if (result.hand) raw.hand = result.hand;
      if (result.face) raw.face = result.face;
      if (result.composition) raw.composition = result.composition;
      if (result.exposure) raw.exposure = result.exposure;
      raw.confidence = Math.max(raw.confidence, result.confidence);
      raw.processingTimeMs += result.processingTimeMs;
    }

    // Fallback: if no detector produced any output, use neutral defaults
    if (!raw.hand && !raw.face && !raw.composition && !raw.exposure) {
      raw.confidence = 0.1;
      raw.hand = { anomalyScore: 0, handCount: -1, details: ["All detectors returned no output"] };
      raw.face = { anomalyScore: 0, faceCount: -1, distortionScore: 0, details: [] };
      raw.composition = { score: 0.5, subjectPositionScore: 0.5, ruleOfThirdsScore: 0.5, details: [] };
      raw.exposure = { score: 0.5, overexposureScore: 0, underexposureScore: 0, contrastScore: 0.5, details: [] };
    }

    // 分类决策
    const detection = this.classify(image, raw);
    const reasons = this.getReasons(raw);

    return { image, detection, raw, reasons };
  }

  // ============================================================
  // 批量分类
  // ============================================================

  /**
   * 批量分类（并行）
   */
  async classifyBatch(images: ImageMeta[]): Promise<ClassifiedResult[]> {
    return await Promise.all(
      images.map((img) => this.classifyOne(img)),
    );
  }

  // ============================================================
  // 分类逻辑
  // ============================================================

  /**
   * 根据检测结果 → 三层分类
   */
  classify(image: ImageMeta, raw: DetectorResult): DetectionResult {
    const { hand, face, composition, exposure } = raw;

    // 提取各维度分数（缺省时给中性值）
    const handScore = hand?.anomalyScore ?? 0.15;
    const faceScore = face?.anomalyScore ?? 0.15;
    const compScore = composition?.score ?? 0.75;
    const expScore = exposure?.score ?? 0.75;

    // 一票否决制：手部/面部严重异常 → Bad
    const isHandBad = handScore >= this.options.handThresholdBad;
    const isFaceBad = faceScore >= this.options.faceThresholdBad;

    if (isHandBad || isFaceBad) {
      return {
        image,
        handAnomaly: handScore,
        faceAnomaly: faceScore,
        compositionScore: compScore,
        exposureScore: expScore,
        layer: Layer.Bad,
        confidence: raw.confidence || 0.5,
      };
    }

    // Dubious 层：构图/曝光不达标
    const isCompDubious = compScore < this.options.compositionThresholdDubious;
    const isExpDubious = expScore < this.options.exposureThresholdDubious;

    if (isCompDubious || isExpDubious) {
      return {
        image,
        handAnomaly: handScore,
        faceAnomaly: faceScore,
        compositionScore: compScore,
        exposureScore: expScore,
        layer: Layer.Dubious,
        confidence: raw.confidence || 0.4,
      };
    }

    // 默认 → Desired
    const avgScore = (compScore + expScore + (1 - handScore) + (1 - faceScore)) / 4;
    const confidence = Math.min(0.95, 0.3 + avgScore * 0.7);

    return {
      image,
      handAnomaly: handScore,
      faceAnomaly: faceScore,
      compositionScore: compScore,
      exposureScore: expScore,
      layer: Layer.Desired,
      confidence: Math.max(raw.confidence, confidence),
    };
  }

  /**
   * 生成人类可读的分类原因
   */
  private getReasons(raw: DetectorResult): string[] {
    const reasons: string[] = [];

    if (raw.hand && raw.hand.anomalyScore >= this.options.handThresholdBad * 0.5) {
      reasons.push(`Hand anomaly: ${(raw.hand.anomalyScore * 100).toFixed(0)}%`);
    }
    if (raw.face && raw.face.anomalyScore >= this.options.faceThresholdBad * 0.5) {
      reasons.push(`Face anomaly: ${(raw.face.anomalyScore * 100).toFixed(0)}%`);
    }
    if (raw.composition && raw.composition.score < this.options.compositionThresholdDubious + 0.2) {
      reasons.push(`Composition: ${(raw.composition.score * 100).toFixed(0)}%`);
    }
    if (raw.exposure && raw.exposure.score < this.options.exposureThresholdDubious + 0.2) {
      reasons.push(`Exposure: ${(raw.exposure.score * 100).toFixed(0)}%`);
    }

    if (reasons.length === 0) {
      reasons.push("No anomalies detected");
    }

    return reasons;
  }
}

/**
 * 工厂方法 — 创建默认管线
 */
export function createPipeline(options?: PipelineOptions): ClassificationPipeline {
  return new ClassificationPipeline(options);
}
