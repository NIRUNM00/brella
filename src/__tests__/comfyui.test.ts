// ============================================================
// Phase 4 — ComfyUI 测试
// PNG 元数据读取 + brella classify CLI
// ============================================================

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

import {
  readPngTextChunks,
  readComfyUIMetadata,
  readImageMeta,
} from "../comfyui/metadata.js";

// ============================================================
// 测试用 PN 生成（带 tEXt 块）
// ============================================================

/**
 * 生成一个带有 tEXt 文本块的最小 PNG 文件
 * PNG 格式：
 *   - 8 字节签名
 *   - IHDR 块 (必须, 图像头)
 *   - tEXt 块 (文本元数据, key\0value)
 *   - IDAT 块 (必须, 图像数据 — 最小 1x1)
 *   - IEND 块
 */
function createTestPng(
  filePath: string,
  textChunks: Array<{ key: string; value: string }>,
): void {
  const crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc32Table[i] = c;
  }

  function crc32(data: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      c = crc32Table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type: string, data: Buffer): Buffer {
    const typeBuf = Buffer.from(type, "ascii");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length);
    const crcData = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(crcData));
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: 1x1 RGBA
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);  // width
  ihdr.writeUInt32BE(1, 1);  // height
  ihdr[8] = 8;               // bit depth
  ihdr[9] = 6;               // color type (RGBA)
  ihdr[10] = 0;              // compression
  ihdr[11] = 0;              // filter
  ihdr[12] = 0;              // interlace

  // IDAT: 1x1 RGBA pixel (raw deflate)
  // Raw deflate: 0x78 0x01 (no compression) + stored block
  const rawPixel = Buffer.from([0, 255, 0, 0, 255]); // filter byte 0 + RGBA red
  const deflated = Buffer.alloc(rawPixel.length + 6);
  deflated[0] = 0x78;  // CMF
  deflated[1] = 0x01;  // FLG
  deflated[2] = 0x01;  // BFINAL + BTYPE (stored)
  deflated.writeUInt16LE(rawPixel.length, 3); // LEN
  deflated.writeUInt16LE(~rawPixel.length & 0xFFFF, 5); // NLEN
  rawPixel.copy(deflated, 7);
  // Adler32
  let a1 = 1, a2 = 0;
  for (let i = 0; i < rawPixel.length; i++) {
    a1 = (a1 + rawPixel[i]) % 65521;
    a2 = (a2 + a1) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE((a2 << 16) | a1, 0);
  Buffer.concat([deflated, adler]);

  const chunks: Buffer[] = [signature, makeChunk("IHDR", ihdr)];

  // tEXt 块
  for (const { key, value } of textChunks) {
    const textData = Buffer.concat([
      Buffer.from(key, "ascii"),
      Buffer.from([0]),
      Buffer.from(value, "utf8"),
    ]);
    chunks.push(makeChunk("tEXt", textData));
  }

  // IDAT (minimal)
  const idatData = Buffer.alloc(8);
  idatData[0] = 0x78; idatData[1] = 0x01;
  idatData[2] = 0x01;
  idatData.writeUInt16LE(5, 3);
  idatData.writeUInt16LE(~5 & 0xFFFF, 5);
  // Extend for actual data
  const fullIdat = Buffer.alloc(idatData.length + 6);
  idatData.copy(fullIdat);
  rawPixel.copy(fullIdat, 8);
  const adler2 = Buffer.alloc(4);
  let a1_2 = 1, a2_2 = 0;
  for (let i = 0; i < rawPixel.length; i++) {
    a1_2 = (a1_2 + rawPixel[i]) % 65521;
    a2_2 = (a2_2 + a1_2) % 65521;
  }
  adler2.writeUInt32BE((a2_2 << 16) | a1_2);
  const finalIdat = Buffer.concat([fullIdat, adler2]);
  chunks.push(makeChunk("IDAT", finalIdat));

  chunks.push(makeChunk("IEND", Buffer.alloc(0)));

  writeFileSync(filePath, Buffer.concat(chunks));
}

// ============================================================
// ComfyUI 风格的 prompt JSON
// ============================================================

const MOCK_PROMPT_JSON = JSON.stringify({
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 7777777,
      steps: 30,
      cfg: 7.0,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1.0,
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0],
    },
  },
  "4": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "noobai-XL-v1.0.safetensors" },
  },
  "6": {
    class_type: "CLIPTextEncode",
    inputs: {
      text: "1girl, anime style, masterpiece, best quality",
    },
  },
  "7": {
    class_type: "CLIPTextEncode",
    inputs: {
      text: "nsfw, lowres, bad anatomy",
    },
  },
  "9": {
    class_type: "EmptyLatentImage",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
});

const MOCK_WORKFLOW_JSON = JSON.stringify({
  last_node_id: 9,
  last_link_id: 8,
  nodes: [],
  links: [],
  groups: [],
  config: {},
  version: 0.4,
});

// ============================================================
// 测试
// ============================================================

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "brella-comfyui-test-"));
});

describe("PNG tEXt 块读取", () => {
  it("应该从 PNG 中提取 tEXt 文本块", () => {
    const pngPath = join(tempDir, "test_text.png");
    createTestPng(pngPath, [
      { key: "prompt", value: '{"test": true}' },
      { key: "workflow", value: '{"version": 0.4}' },
    ]);

    const chunks = readPngTextChunks(pngPath);
    expect(chunks.length).toBe(2);
    expect(chunks[0].key).toBe("prompt");
    expect(chunks[0].value).toBe('{"test": true}');
    expect(chunks[1].key).toBe("workflow");
    expect(chunks[1].value).toBe('{"version": 0.4}');
  });

  it("应该处理没有 tEXt 块的 PNG", () => {
    const pngPath = join(tempDir, "test_no_text.png");
    createTestPng(pngPath, []);

    const chunks = readPngTextChunks(pngPath);
    expect(chunks.length).toBe(0);
  });

  it("应该处理多个 tEXt 块", () => {
    const pngPath = join(tempDir, "test_multi.png");
    createTestPng(pngPath, [
      { key: "prompt", value: '{"a": 1}' },
      { key: "workflow", value: '{"v": 2}' },
      { key: "custom_data", value: "hello" },
    ]);

    const chunks = readPngTextChunks(pngPath);
    expect(chunks.length).toBe(3);
    expect(chunks[2].key).toBe("custom_data");
    expect(chunks[2].value).toBe("hello");
  });
});

describe("ComfyUI 元数据解析", () => {
  it("应该从模拟 PNG 中解析出 prompt 和 workflow JSON", () => {
    const pngPath = join(tempDir, "test_comfyui.png");
    createTestPng(pngPath, [
      { key: "prompt", value: MOCK_PROMPT_JSON },
      { key: "workflow", value: MOCK_WORKFLOW_JSON },
    ]);

    const meta = readComfyUIMetadata(pngPath);
    expect(meta.promptJson).toBeDefined();
    expect(meta.workflowJson).toBeDefined();
    expect(meta.promptJson!["3"].class_type).toBe("KSampler");
    expect(meta.workflowJson!["version"]).toBe(0.4);
  });

  it("应该处理只有 prompt 没有 workflow 的 PNG", () => {
    const pngPath = join(tempDir, "test_prompt_only.png");
    createTestPng(pngPath, [
      { key: "prompt", value: MOCK_PROMPT_JSON },
    ]);

    const meta = readComfyUIMetadata(pngPath);
    expect(meta.promptJson).toBeDefined();
    expect(meta.workflowJson).toBeUndefined();
    expect(meta.rawChunks.length).toBe(1);
  });
});

describe("ImageMeta 提取", () => {
  it("应该从 ComfyUI 元数据中提取关键参数", () => {
    const pngPath = join(tempDir, "test_meta.png");
    createTestPng(pngPath, [
      { key: "prompt", value: MOCK_PROMPT_JSON },
    ]);

    const meta = readImageMeta(pngPath);
    expect(meta.path).toBe(pngPath);
    expect(meta.seed).toBe(7777777);
    expect(meta.prompt).toContain("1girl");
    expect(meta.model).toContain("noobai");
    expect(meta.cfg).toBe(7.0);
  });

  it("应该在没有 prompt 块时返回基本文件信息", () => {
    const pngPath = join(tempDir, "test_bare.png");
    createTestPng(pngPath, []);

    const meta = readImageMeta(pngPath);
    expect(meta.path).toBe(pngPath);
    expect(meta.filename).toBe("test_bare.png");
    expect(meta.size).toBeGreaterThan(0);
    // 无 prompt 块时，关键字段应为默认值
    expect(meta.seed).toBeUndefined();
  });
});

describe("brella classify CLI", () => {
  const cliPath = resolve(__dirname, "../../dist/cli.js");

  it("应该对 PNG 图像输出有效的 JSON 分类结果", () => {
    // 跳过如果 CLI 文件不存在
    if (!existsSync(cliPath)) return;

    // 创建测试 PNG（快速的 2x2 红图，足够触发检测）
    const pngPath = join(tempDir, "cli_test.png");
    createTestPng(pngPath, [
      { key: "prompt", value: '{"3":{"class_type":"KSampler","inputs":{"seed":12345,"cfg":7.0,"steps":30}},"4":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"test.safetensors"}},"6":{"class_type":"CLIPTextEncode","inputs":{"text":"test prompt"}}}' },
    ]);

    const stdout = execSync(
      `node ${cliPath} classify ${pngPath} --pretty`,
      { timeout: 30000 },
    ).toString().trim();

    const result = JSON.parse(stdout);
    expect(result.file).toBe(pngPath);
    expect(result.seed).toBe(12345);
    expect(result.model).toContain("test.safetensors");
    expect(["bad", "dubious", "desired"]).toContain(result.layer);
    expect(result.scores).toBeDefined();
    expect(typeof result.scores.handAnomaly).toBe("number");
    expect(typeof result.scores.compositionScore).toBe("number");
  });

  it("应该对不存在的文件返回错误", () => {
    if (!existsSync(cliPath)) return;

    try {
      execSync(
        `node ${cliPath} classify /tmp/nonexistent_image_xyz.png`,
        { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
      );
      // Should have thrown
      expect(true).toBe(false);
    } catch (e: any) {
      const stderr = e.stderr?.toString() ?? "";
      const stdout = e.stdout?.toString() ?? "";
      const combined = stdout + stderr;
      expect(combined).toContain("not found") || expect(combined).toContain("File not found");
    }
  });
});
