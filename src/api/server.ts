#!/usr/bin/env node

import express from "express";
import cors from "cors";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRouter } from "./routes.js";
import { getConfig, setConfigOverrides } from "../config/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "public");

/**
 * 创建 Brella API 服务器
 *
 * @param port       HTTP 端口号（默认从 config 获取）
 * @param dbPath     可选的数据库路径（覆盖 config）
 */
export function createServer(port?: number, dbPath?: string) {
  // 如果有传入 dbPath，覆写 config
  if (dbPath) {
    setConfigOverrides({ dbPath });
  }

  // 端口仍允许手动传入，否则走 config
  const actualPort = port ?? getConfig().port;

  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // routes.ts 内部调用 getDb() → 自动走 config，无需传参
  app.use("/v1", createRouter());

  // Static dashboard
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (_req, res) => {
    res.sendFile(resolve(PUBLIC_DIR, "index.html"));
  });

  // 404 fallback
  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[brella-api]", err);
    res.status(500).json({ error: err.message || "internal error" });
  });

  return app;
}

// 直接运行时启动服务器（解析 CLI 参数 — 支持 --port, --db, --config）
interface CliArgs { port?: number; db?: string; config?: string }
function parseCliArgs(): CliArgs {
  const args: CliArgs = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if ((a === "--port" || a === "-p") && i + 1 < process.argv.length) args.port = parseInt(process.argv[++i], 10);
    if ((a === "--db" || a === "-d") && i + 1 < process.argv.length) args.db = process.argv[++i];
    if ((a === "--config" || a === "-c") && i + 1 < process.argv.length) {
      process.env["BRELLA_CONFIG"] = process.argv[++i];
    }
  }
  return args;
}
const cli = parseCliArgs();
if (cli.config) process.env["BRELLA_CONFIG"] = cli.config;
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("BRELLA_")) console.error(`[brella] env ${k}=${v}`);
}
const cfg = getConfig();
const port = cli.port ?? cfg.port;
const app = createServer(cli.port, cli.db);
app.listen(port, "0.0.0.0", () => {
  console.log(`🌂 Brella API v0.1.0-alpha running on http://0.0.0.0:${port}`);
  console.log(`   DB: ${cli.db ?? cfg.dbPath}`);
  console.log(`   config: ${cfg.configSource}`);
});
