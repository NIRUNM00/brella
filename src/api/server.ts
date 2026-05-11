#!/usr/bin/env node

import express from "express";
import cors from "cors";
import { createRouter } from "./routes.js";

export function createServer(port: number = 8898) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  app.use("/v1", createRouter());

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

// 直接运行时启动服务器
const port = parseInt(process.env.PORT || "8898", 10);
const app = createServer(port);
app.listen(port, "0.0.0.0", () => {
  console.log(`🌂 Brella API v0.1.0-alpha running on http://0.0.0.0:${port}`);
});
