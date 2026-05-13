import { Router, Request, Response } from "express";
import { statSync, readdirSync } from "node:fs";
import { extname, join, basename } from "node:path";
import { ClassificationPipeline } from "../pipeline/classify.js";
import {
  recordDecision,
  recordDecisions,
  getWilsonTopN,
  getDecisionHistory,
  listBatchTags,
  getModelRankings,
  getOverallSummary,
  getDecisionsByAction,
  getDecisionsByBatchTag,
  getDecisionsByModel,
} from "../engine/decision.js";
import type { ImageMeta } from "../types/bddd.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);

/** 从请求参数构造 ImageMeta（补全缺失字段的默认值） */
function buildMeta(body: Record<string, any>): ImageMeta | null {
  if (!body.path) return null;
  return {
    path: body.path,
    filename: basename(body.path),
    width: Number(body.width ?? 0),
    height: Number(body.height ?? 0),
    size: body.size ?? (() => {
      try { return statSync(body.path).size; } catch { return 0; }
    })(),
    seed: Number(body.seed ?? 0),
    prompt: body.prompt ?? "",
    cfg: Number(body.cfg ?? 7.0),
    model: body.model ?? "",
    batchTag: body.batch_tag ?? body.batchTag ?? undefined,
  };
}

export function createRouter() {
  const router = Router();
  const pipeline = new ClassificationPipeline();

  // ---------- GET /v1/health ----------
  router.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", version: "0.1.0-alpha" });
  });

  // ---------- POST /v1/classify ----------
  // 单图检测。接受完整 ImageMeta 或 { image_path, prompt } 自动补全
  router.post("/classify", async (req: Request, res: Response) => {
    try {
      let meta: ImageMeta;

      if (req.body.path) {
        const built = buildMeta(req.body);
        if (!built) return res.status(400).json({ error: "Invalid image path" });
        meta = built;
      } else if (req.body.image_path) {
        const p = req.body.image_path;
        try {
          const st = statSync(p);
          meta = {
            path: p,
            filename: basename(p),
            width: Number(req.body.width ?? 0),
            height: Number(req.body.height ?? 0),
            size: st.size,
            seed: Number(req.body.seed ?? 0),
            prompt: req.body.prompt ?? "",
            cfg: Number(req.body.cfg ?? 7.0),
            model: req.body.model ?? "",
            batchTag: req.body.batch_tag ?? undefined,
          };
        } catch {
          return res.status(404).json({ error: `File not found: ${p}` });
        }
      } else {
        return res.status(400).json({
          error: "Provide path (ImageMeta) or image_path",
        });
      }

      const result = await pipeline.classifyOne(meta);
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ---------- POST /v1/curate ----------
  // 目录批量策展
  router.post("/curate", async (req: Request, res: Response) => {
    try {
      const { directory, batch_tag } = req.body;
      if (!directory) {
        return res.status(400).json({ error: "directory is required" });
      }

      let files: string[];
      try {
        files = readdirSync(directory)
          .filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
          .sort();
      } catch {
        return res.status(404).json({ error: `Directory not found: ${directory}` });
      }

      const images: ImageMeta[] = files.map((f) => {
        const p = join(directory, f);
        let st;
        try { st = statSync(p); } catch { st = { size: 0 }; }
        return {
          path: p,
          filename: f,
          width: 0,
          height: 0,
          size: (st as any).size || 0,
          seed: 0,
          prompt: batch_tag || "",
          cfg: 7.0,
          model: "",
        };
      });

      const results = await pipeline.classifyBatch(images);

      res.json({
        total: results.length,
        bad: results.filter((r) => r.detection.layer === "bad"),
        dubious: results.filter((r) => r.detection.layer === "dubious"),
        desired: results.filter((r) => r.detection.layer === "desired"),
        batch_tag: batch_tag || null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ---------- POST /v1/decide ----------
  router.post("/decide", (req: Request, res: Response) => {
    try {
      const { seed, prompt, action, model, note, batch_tag } = req.body;

      if (seed === undefined || !prompt || !action) {
        return res.status(400).json({
          error: "seed, prompt, and action are required",
        });
      }

      if (!["accept", "reject", "skip"].includes(action)) {
        return res.status(400).json({
          error: "action must be accept, reject, or skip",
        });
      }

      const record = recordDecision({
        seed: Number(seed),
        prompt,
        action,
        model: model || undefined,
        note: note || undefined,
        batchTag: batch_tag || undefined,
      });

      res.json({ success: true, record });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ---------- GET /v1/stats ----------
  router.get("/stats", (req: Request, res: Response) => {
    try {
      const limit = parseInt(String(req.query.limit || "20"), 10);
      const rankings = getWilsonTopN(limit);
      res.json({ rankings, total: rankings.length });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ---------- GET /v1/history ----------
  router.get("/history", (req: Request, res: Response) => {
    try {
      const seed = parseInt(String(req.query.seed || "0"), 10);
      const promptStr = req.query.prompt as string | undefined;
      if (!seed) return res.status(400).json({ error: "seed is required" });
      const history = getDecisionHistory(seed, promptStr);
      res.json({ seed, history, total: history.length });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ---------- GET /v1/batches ----------
  router.get("/batches", (_req: Request, res: Response) => {
    try {
      const tags = listBatchTags();
      res.json({ batches: tags });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ---------- GET /v1/summary ----------
  // 全局概览统计（总决策、采纳率、模型数、最佳模型等）
  router.get("/summary", (_req: Request, res: Response) => {
    try {
      const summary = getOverallSummary();
      res.json(summary);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ---------- POST /v1/decide/batch ----------
  // 批量决策。接受 decisions 数组，每个元素含 seed, prompt, action, model, batch_tag
  router.post("/decide/batch", (req: Request, res: Response) => {
    try {
      const { decisions } = req.body;
      if (!Array.isArray(decisions) || decisions.length === 0) {
        return res.status(400).json({ error: "decisions array is required" });
      }

      const inputs = decisions.map((d: any, i: number) => {
        if (d.seed === undefined || !d.prompt || !d.action) {
          throw new Error(`Item ${i}: seed, prompt, and action are required`);
        }
        if (!["accept", "reject", "skip"].includes(d.action)) {
          throw new Error(`Item ${i}: action must be accept, reject, or skip`);
        }
        return {
          seed: Number(d.seed),
          prompt: d.prompt,
          action: d.action,
          model: d.model || undefined,
          note: d.note || undefined,
          batchTag: d.batch_tag || d.batchTag || undefined,
        };
      });

      const result = recordDecisions(inputs);
      res.json({ success: true, total: inputs.length, result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ---------- GET /v1/export ----------
  // 导出决策。?format=json|csv&action=accept|reject|skip&batch=xxx&model=xxx
  router.get("/export", (req: Request, res: Response) => {
    try {
      const format = (req.query.format as string) || "json";
      const action = req.query.action as string | undefined;
      const batchTag = req.query.batch as string | undefined;
      const model = req.query.model as string | undefined;

      let records: any[];
      if (action && ["accept", "reject", "skip"].includes(action)) {
        records = getDecisionsByAction(action as "accept" | "reject" | "skip");
      } else if (batchTag) {
        records = getDecisionsByBatchTag(batchTag);
      } else if (model) {
        records = getDecisionsByModel(model);
      } else {
        // Get all — use getDecisionsByAction as a full table scan workaround
        // or use a dedicated getAllDecisions if available
        records = getDecisionsByAction("accept")
          .concat(getDecisionsByAction("reject"))
          .concat(getDecisionsByAction("skip"));
      }

      if (format === "csv") {
        const header = "seed,prompt,action,model,note,batch_tag,created_at\n";
        const rows = records.map((r) =>
          [
            r.seed,
            `"${(r.prompt || "").replace(/"/g, '""')}"`,
            r.action,
            `"${(r.model || "").replace(/"/g, '""')}"`,
            `"${(r.note || "").replace(/"/g, '""')}"`,
            `"${(r.batchTag || "").replace(/"/g, '""')}"`,
            r.createdAt,
          ].join(",")
        ).join("\n");
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="brella-export-${Date.now()}.csv"`);
        return res.send(header + rows);
      }

      res.json({ total: records.length, records });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ---------- GET /v1/stats/by-batch ----------
  // 按批次统计 — 复用 listBatchTags() 已提供的聚合数据
  router.get("/stats/by-batch", (_req: Request, res: Response) => {
    try {
      const batches = listBatchTags();
      res.json({ batches, total: batches.length });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ---------- GET /v1/stats/models ----------
  // 按模型聚合的 Wilson 排名，可选 ?prompt=XXX 过滤到某个目录
  router.get("/stats/models", (req: Request, res: Response) => {
    try {
      const prompt = req.query.prompt as string | undefined;
      const rankings = getModelRankings(prompt || undefined);
      res.json({ rankings, total: rankings.length });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
