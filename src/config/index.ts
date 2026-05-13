/**
 * Brella Config — 统一的配置加载模块
 *
 * 加载优先级（从高到低）:
 *   1. CLI 参数（--db, --port）
 *   2. 环境变量（BRELLA_DB_PATH / DB_PATH, BRELLA_PORT / PORT, BRELLA_CONFIG）
 *   3. 配置文件 ~/.brellarc / ./.brellarc（JSON 或 YAML）
 *   4. 默认值
 *
 * 用法:
 *   import { config } from "./config/index.js";
 *   config.dbPath       // 数据库路径
 *   config.port         // HTTP 端口号
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// ---------- 类型定义 ----------

export interface BrellaConfig {
  /** SQLite 数据库文件路径 */
  dbPath: string;
  /** API 服务端口号 */
  port: number;
  /** 配置文件路径（用于 CLI 报告） */
  configSource: string;
}

export interface BrellaConfigOverrides {
  dbPath?: string;
  port?: number;
}

// ---------- Config 单例 ----------

let instance: BrellaConfig | null = null;
let pendingOverrides: BrellaConfigOverrides = {};

/**
 * 设置配置覆盖（通常由 CLI 的 --db / --port 调用）
 * 必须在第一次 getConfig() 之前调用才生效
 */
export function setConfigOverrides(overrides: BrellaConfigOverrides): void {
  if (instance) {
    // 已经初始化过，直接覆盖现有实例
    if (overrides.dbPath !== undefined) instance.dbPath = overrides.dbPath;
    if (overrides.port !== undefined) instance.port = overrides.port;
    instance.configSource = "cli-override";
  } else {
    pendingOverrides = { ...pendingOverrides, ...overrides };
  }
}

// ---------- 默认值 ----------

const DEFAULT_DB_PATH = resolve(process.cwd(), "brella.db");
const DEFAULT_PORT = 8898;

// ---------- 配置文件搜索 ----------

interface ConfigFileContent {
  dbPath?: string;
  port?: number;
  database?: { path?: string };
  server?: { port?: number };
}

function tryLoadConfigFile(): { config: ConfigFileContent; source: string } | null {
  const candidates = [
    resolve(process.cwd(), ".brellarc"),
    resolve(process.cwd(), ".brellarc.json"),
    resolve(homedir(), ".brellarc"),
    resolve(homedir(), ".brellarc.json"),
  ];

  // Also check BRELLA_CONFIG env var
  const envPath = process.env["BRELLA_CONFIG"];
  if (envPath) {
    candidates.unshift(resolve(envPath));
  }

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      const raw = readFileSync(filePath, "utf-8").trim();
      // Try JSON
      if (raw.startsWith("{")) {
        return { config: JSON.parse(raw), source: filePath };
      }
      // Try YAML (simple key: value parser)
      if (raw.includes(":")) {
        const parsed: ConfigFileContent = {};
        for (const line of raw.split("\n")) {
          const [key, ...rest] = line.split(":");
          if (!key || rest.length === 0) continue;
          const value = rest.join(":").trim();
          const k = key.trim();
          if (k === "db_path" || k === "dbPath") parsed.dbPath = value;
          if (k === "port") parsed.port = parseInt(value, 10) || DEFAULT_PORT;
        }
        return { config: parsed, source: filePath };
      }
    } catch {
      // Silently skip unreadable config files
    }
  }

  return null;
}

/**
 * 加载并缓存配置。后续调用直接返回缓存。
 */
export function getConfig(): BrellaConfig {
  if (instance) return instance;

  // 1) 环境变量（BRELLA_* 前缀优先，兼容旧名 DB_PATH / PORT）
  const envDbPath = process.env["BRELLA_DB_PATH"] || process.env["DB_PATH"] || undefined;
  const envPort = process.env["BRELLA_PORT"]
    ? parseInt(process.env["BRELLA_PORT"], 10)
    : process.env["PORT"]
      ? parseInt(process.env["PORT"], 10)
      : undefined;

  // 2) 配置文件
  const fileConfig = tryLoadConfigFile();

  // 3) 构建配置（env 覆盖文件，pendingOverrides 覆盖 env）
  const dbPath =
    pendingOverrides.dbPath ??
    envDbPath ??
    fileConfig?.config.dbPath ??
    fileConfig?.config.database?.path ??
    DEFAULT_DB_PATH;

  const port =
    pendingOverrides.port ??
    envPort ??
    fileConfig?.config.port ??
    fileConfig?.config.server?.port ??
    DEFAULT_PORT;

  instance = {
    dbPath,
    port,
    configSource: pendingOverrides.dbPath
      ? "cli-override"
      : process.env["BRELLA_DB_PATH"]
        ? "env:BRELLA_DB_PATH"
        : envDbPath
          ? "env:DB_PATH"
          : fileConfig
          ? fileConfig.source
          : "default",
  };

  return instance;
}

/**
 * 重置配置（主要用于测试）
 */
export function resetConfig(): void {
  instance = null;
  pendingOverrides = {};
}
