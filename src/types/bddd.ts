// ============================================================
// B→D→D 协议核心类型定义
// Briefing → Detail → Decision
// ============================================================

// ---------- 图像元数据 ----------

export interface ImageMeta {
  /** 文件绝对路径 */
  path: string;
  /** 文件名 (含扩展名) */
  filename: string;
  /** 文件大小 (bytes) */
  size: number;
  /** 宽度 px */
  width: number;
  /** 高度 px */
  height: number;
  /** 生成种子 */
  seed: number;
  /** 完整 prompt */
  prompt: string;
  /** CFG scale */
  cfg: number;
  /** 模型名称 */
  model: string;
  /** ComfyUI 工作流名称 (若有) */
  workflow?: string;
  /** 批次标识 (prompt缩写_模型名_序号) */
  batchTag?: string;
}

// ---------- 三层分类 ----------

export enum Layer {
  Bad = "bad",
  Dubious = "dubious",
  Desired = "desired",
}

export const LAYER_LABELS: Record<Layer, string> = {
  [Layer.Bad]: "Bad — 结构缺陷，自动淘汰",
  [Layer.Dubious]: "Dubious — 构图/光线/风格有疑问",
  [Layer.Desired]: "Desired — 无缺陷，构图可用",
};

export const LAYER_ORDER: Layer[] = [
  Layer.Bad,
  Layer.Dubious,
  Layer.Desired,
];

// ---------- 检测结果 ----------

export interface DetectionResult {
  image: ImageMeta;
  handAnomaly: number;     // 0-1, 越高越可能崩手
  faceAnomaly: number;     // 0-1
  compositionScore: number; // 0-1, 构图评分
  exposureScore: number;   // 0-1, 曝光评分
  layer: Layer;
  confidence: number;      // 0-1
}

// ---------- Briefing ----------

export interface LayerSummary {
  layer: Layer;
  count: number;
  images: ImageMeta[];
  /** Wilson Score 排序后的 Dubious 列表 (仅 Dubious 层有) */
  rankedImages?: Array<{ image: ImageMeta; score: number }>;
}

export interface Briefing {
  /** 批次标识 */
  batchId: string;
  /** 总图数 */
  total: number;
  /** 各层统计 */
  layers: Record<Layer, LayerSummary>;
  /** 一句概况 */
  summary: string;
  createdAt: string; // ISO timestamp
}

// ---------- Detail ----------

export interface DetailQuery {
  batchId: string;
  /** 按种子或文件名精确查找 */
  seed?: number;
  filename?: string;
  /** 拉取某个 variant 的所有种子 */
  variantTag?: string;
}

export interface DetailResponse {
  batchId: string;
  images: Array<{
    meta: ImageMeta;
    detection: DetectionResult;
    /** 历史决策记录 (若有) */
    history?: DecisionRecord[];
  }>;
}

// ---------- Decision ----------

export type DecisionAction = "accept" | "reject" | "skip";

export interface DecisionRecord {
  seed: number;
  prompt: string;
  model: string;
  action: DecisionAction;
  /** 用户备注 (可选) */
  note?: string;
  /** 批次标识 */
  batchTag?: string;
  createdAt: string;
}

export interface DecisionResult {
  batchId: string;
  accepted: number;
  rejected: number;
  skipped: number;
  records: DecisionRecord[];
}

// ---------- 批量配置 ----------

export interface BatchConfig {
  /** 目录路径 */
  dir: string;
  /** 批量标识 */
  tag?: string;
  /** Wilson Score α 参数 (默认 0.05) */
  wilsonAlpha?: number;
  /** Dubious 层最大展示数 (默认 20) */
  maxDubiousDisplay?: number;
}
