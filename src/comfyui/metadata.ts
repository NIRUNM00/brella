// ============================================================
// Phase 4 — PNG 元数据读取器
// 从 ComfyUI 生成的 PNG 文件中读取嵌入的 prompt/workflow 信息
// PNG tEXt 块解析，无外部依赖（纯 Node.js Buffer）
// ============================================================

import { openSync, readSync, statSync, closeSync, existsSync } from "node:fs";
import type { ImageMeta } from "../types/bddd.js";

// ---------- 低层 PNG tEXt 块解析 ----------

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TEXT_CHUNK_TYPE = Buffer.from("tEXt");

interface PngTextChunk {
  key: string;
  value: string;
}

/**
 * 读取 PNG 文件中的所有 tEXt 文本块
 * ComfyUI 将 prompt 和 workflow 存储为 tEXt 块
 * 格式：4字节长度 + 4字节类型 + 数据 + 4字节CRC
 */
export function readPngTextChunks(filePath: string): PngTextChunk[] {
  const chunks: PngTextChunk[] = [];

  const fd = openSync(filePath, "r");
  try {
    // 验证 PNG 签名
    const sig = Buffer.alloc(8);
    readSync(fd, sig, 0, 8, 0);
    if (!sig.equals(PNG_SIGNATURE)) {
      throw new Error(`Not a valid PNG file: ${filePath}`);
    }

    let offset = 8; // skip signature

    while (true) {
      // 读取块长度 (4 bytes, big-endian)
      const lenBuf = Buffer.alloc(4);
      const bytesRead = readSync(fd, lenBuf, 0, 4, offset);
      if (bytesRead < 4) break;
      const chunkLength = lenBuf.readUInt32BE(0);
      offset += 4;

      // 读取块类型 (4 bytes)
      const typeBuf = Buffer.alloc(4);
      readSync(fd, typeBuf, 0, 4, offset);
      offset += 4;

      // 如果是 IEND，结束
      if (typeBuf.toString("ascii") === "IEND") break;

      // 读取块数据
      const dataBuf = Buffer.alloc(chunkLength);
      if (chunkLength > 0) {
        readSync(fd, dataBuf, 0, chunkLength, offset);
      }
      offset += chunkLength;

      // 跳过 CRC (4 bytes)
      offset += 4;

      // 如果是 tEXt 块，解析
      if (typeBuf.equals(TEXT_CHUNK_TYPE) && chunkLength > 0) {
        // tEXt 数据格式: key\0value (null 分隔)
        const nullIndex = dataBuf.indexOf(0);
        if (nullIndex > 0) {
          const key = dataBuf.subarray(0, nullIndex).toString("ascii");
          const value = dataBuf.subarray(nullIndex + 1).toString("utf8");
          chunks.push({ key, value });
        }
      }
    }
  } finally {
    closeSync(fd);
  }

  return chunks;
}

// ---------- ComfyUI 元数据解析 ----------

export interface ComfyUIMetadata {
  /** 完整 prompt JSON（包含正面/负面提示词、模型、种子等） */
  promptJson?: Record<string, any>;
  /** 工作流 JSON */
  workflowJson?: Record<string, any>;
  /** 原始 tEXt 块 */
  rawChunks: PngTextChunk[];
}

/**
 * 从 PNG 文件中提取 ComfyUI 元数据
 */
export function readComfyUIMetadata(filePath: string): ComfyUIMetadata {
  const chunks = readPngTextChunks(filePath);
  const result: ComfyUIMetadata = { rawChunks: chunks };

  for (const chunk of chunks) {
    if (chunk.key === "prompt") {
      try {
        result.promptJson = JSON.parse(chunk.value);
      } catch {
        // 无法解析的 prompt 块，保留原始字符串
      }
    }
    if (chunk.key === "workflow") {
      try {
        result.workflowJson = JSON.parse(chunk.value);
      } catch {
        // 无法解析的工作流块
      }
    }
  }

  return result;
}

// ---------- 从 ComfyUI 元数据提取 ImageMeta ----------

interface PromptNode {
  class_type?: string;
  inputs?: Record<string, any>;
}

/**
 * 从 ComfyUI 的 prompt JSON 中查找关键参数
 *
 * ComfyUI prompt JSON 格式：
 * {
 *   "6": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "..." } },
 *   "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "..." } },
 *   ...
 * }
 */
export function parseMetaToImageMeta(
  filePath: string,
  metadata: ComfyUIMetadata,
): Partial<ImageMeta> {
  const meta: Partial<ImageMeta> = {
    path: filePath,
    filename: filePath.split("/").pop() ?? "unknown",
  };

  try {
    const stats = statSync(filePath);
    meta.size = stats.size;
  } catch { /* ignore */ }

  if (!metadata.promptJson) return meta;

  const nodes = metadata.promptJson as Record<string, PromptNode>;

  // 查找种子（可能有多个节点有 seed 参数）
  let seed: number | undefined;
  let prompt = "";
  let model = "";
  let cfg = 7.0;

  for (const [, node] of Object.entries(nodes)) {
    if (!node.inputs) continue;

    // 模型加载器
    if (node.class_type === "CheckpointLoaderSimple" && node.inputs.ckpt_name) {
      model = String(node.inputs.ckpt_name);
    }

    // 种子（KSampler 等节点）
    if (node.inputs.seed !== undefined && node.inputs.seed !== null) {
      seed = Number(node.inputs.seed);
    }

    // 正面提示词（CLIPTextEncode 节点）
    if (node.class_type === "CLIPTextEncode" && node.inputs.text) {
      const text = String(node.inputs.text);
      if (text.length > prompt.length) {
        prompt = text;
      }
    }

    // CFG
    if (node.inputs.cfg !== undefined && node.inputs.cfg !== null) {
      cfg = Number(node.inputs.cfg);
    }

    // 尺寸
    if (meta.width === undefined && node.inputs.width !== undefined) {
      meta.width = Number(node.inputs.width);
    }
    if (meta.height === undefined && node.inputs.height !== undefined) {
      meta.height = Number(node.inputs.height);
    }
  }

  if (seed !== undefined) meta.seed = seed;
  if (prompt) meta.prompt = prompt;
  if (model) meta.model = model;
  meta.cfg = cfg;

  return meta;
}

/**
 * 一行调用：从 PNG 文件路径提取 ImageMeta
 */
export function readImageMeta(filePath: string): Partial<ImageMeta> {
  const metadata = readComfyUIMetadata(filePath);
  return parseMetaToImageMeta(filePath, metadata);
}

/**
 * 批量读取 PNG 元数据
 */
export function readImageMetas(filePaths: string[]): Partial<ImageMeta>[] {
  return filePaths.map((p) => {
    try {
      return readImageMeta(p);
    } catch (err) {
      return {
        path: p,
        filename: p.split("/").pop() ?? "unknown",
        size: 0,
      } as Partial<ImageMeta>;
    }
  });
}
