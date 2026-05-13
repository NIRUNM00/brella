import type { DecisionAction, DecisionRecord, DecisionResult } from "../types/bddd.js";
import { getDb } from "../db/connection.js";
import { wilsonLowerBound } from "../scoring/wilson.js";
import { associateDecision } from "./archetypes.js";

export interface DecisionInput {
  seed: number;
  prompt: string;
  model?: string;
  action: DecisionAction;
  note?: string;
  batchTag?: string;
}

/**
 * 记录一条决策到 SQLite
 */
export function recordDecision(input: DecisionInput): DecisionRecord {
  const db = getDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO seed_preferences (seed, prompt, model, action, note, batch_tag, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const model = input.model ?? "";
  const note = input.note ?? "";
  const batchTag = input.batchTag ?? "";

  stmt.run(input.seed, input.prompt, model, input.action, note, batchTag, now);

  // 更新 Wilson Score
  updateWilsonScore(input.seed, input.prompt, model);

  // 更新 Archetype 关联
  associateDecision(input.prompt, input.seed, input.action);

  return {
    seed: input.seed,
    prompt: input.prompt,
    model,
    action: input.action,
    note,
    createdAt: now,
  };
}

/**
 * 批量记录决策
 */
export function recordDecisions(inputs: DecisionInput[]): DecisionResult {
  const records: DecisionRecord[] = [];
  for (const inp of inputs) {
    records.push(recordDecision(inp));
  }

  const accepted = records.filter((r) => r.action === "accept").length;
  const rejected = records.filter((r) => r.action === "reject").length;
  const skipped = records.filter((r) => r.action === "skip").length;

  return { batchId: "", accepted, rejected, skipped, records };
}

/**
 * 查询某 seed 的历史决策
 */
export function getDecisionHistory(
  seed: number,
  prompt?: string,
): DecisionRecord[] {
  const db = getDb();
  let rows: any[];
  if (prompt) {
    rows = db
      .prepare(
        "SELECT * FROM seed_preferences WHERE seed = ? AND prompt = ? ORDER BY created_at DESC, id DESC",
      )
      .all(seed, prompt);
  } else {
    rows = db
      .prepare(
        "SELECT * FROM seed_preferences WHERE seed = ? ORDER BY created_at DESC, id DESC",
      )
      .all(seed);
  }
  return rows.map(asDecisionRecord);
}

/**
 * 获取 Wilson Score Top N
 */
export function getWilsonTopN(n: number = 10): Array<{
  seed: number;
  prompt: string;
  score: number;
  ups: number;
  downs: number;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT seed, prompt, score, ups, downs FROM wilson_scores ORDER BY score DESC LIMIT ?",
    )
    .all(n) as any[];
  return rows.map((r: any) => ({
    seed: r.seed,
    prompt: r.prompt,
    score: r.score,
    ups: r.ups,
    downs: r.downs,
  }));
}

// ---------- Batch Queries ----------

export interface BatchStats {
  batchTag: string;
  total: number;
  accepted: number;
  rejected: number;
  skipped: number;
  uniqueSeeds: number;
}

/**
 * Get all decisions for a batch tag
 */
export function getDecisionsByBatchTag(batchTag: string): DecisionRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM seed_preferences WHERE batch_tag = ? ORDER BY created_at DESC",
    )
    .all(batchTag) as any[];
  return rows.map(asDecisionRecord);
}

/**
 * Get all decisions for a model
 */
export function getDecisionsByModel(model: string): DecisionRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM seed_preferences WHERE model = ? ORDER BY created_at DESC",
    )
    .all(model) as any[];
  return rows.map(asDecisionRecord);
}

/**
 * Get all decisions filtered by action
 */
export function getDecisionsByAction(
  action: "accept" | "reject" | "skip",
): DecisionRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM seed_preferences WHERE action = ? ORDER BY created_at DESC",
    )
    .all(action) as any[];
  return rows.map(asDecisionRecord);
}

/**
 * Get aggregated stats for a batch
 */
export function getBatchStats(batchTag: string): BatchStats | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
        batch_tag,
        COUNT(*) as total,
        SUM(CASE WHEN action = 'accept' THEN 1 ELSE 0 END) as accepted,
        SUM(CASE WHEN action = 'reject' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN action = 'skip' THEN 1 ELSE 0 END) as skipped,
        COUNT(DISTINCT seed) as uniqueSeeds
      FROM seed_preferences
      WHERE batch_tag = ?
      GROUP BY batch_tag`,
    )
    .get(batchTag) as any;

  if (!row) return null;
  return {
    batchTag: row.batch_tag,
    total: row.total,
    accepted: row.accepted,
    rejected: row.rejected,
    skipped: row.skipped,
    uniqueSeeds: row.uniqueSeeds,
  };
}

/**
 * List all batch tags with stats
 */
export function listBatchTags(): BatchStats[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
        batch_tag,
        COUNT(*) as total,
        SUM(CASE WHEN action = 'accept' THEN 1 ELSE 0 END) as accepted,
        SUM(CASE WHEN action = 'reject' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN action = 'skip' THEN 1 ELSE 0 END) as skipped,
        COUNT(DISTINCT seed) as uniqueSeeds
      FROM seed_preferences
      WHERE batch_tag != ''
      GROUP BY batch_tag
      ORDER BY MAX(created_at) DESC`,
    )
    .all() as any[];

  return rows.map((r: any) => ({
    batchTag: r.batch_tag,
    total: r.total,
    accepted: r.accepted,
    rejected: r.rejected,
    skipped: r.skipped,
    uniqueSeeds: r.uniqueSeeds,
  }));
}

function updateWilsonScore(seed: number, prompt: string, model: string): void {
  const db = getDb();
  const stats = db
    .prepare(
      `SELECT
        SUM(CASE WHEN action = 'accept' THEN 1 ELSE 0 END) as ups,
        SUM(CASE WHEN action = 'reject' THEN 1 ELSE 0 END) as downs
      FROM seed_preferences WHERE seed = ? AND prompt = ?`,
    )
    .get(seed, prompt) as any;

  const ups = stats.ups ?? 0;
  const downs = stats.downs ?? 0;
  const score = wilsonLowerBound(ups, downs);
  const confidence = ups + downs;

  db.prepare(
    `INSERT INTO wilson_scores (seed, prompt, model, ups, downs, score, confidence, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(seed, prompt, model) DO UPDATE SET
       ups = excluded.ups,
       downs = excluded.downs,
       score = excluded.score,
       confidence = excluded.confidence,
       updated_at = datetime('now')`,
  ).run(seed, prompt, model, ups, downs, score, confidence);
}

// ---------- Per-model Wilson ranking ----------

export interface ModelRanking {
  model: string;
  ups: number;
  downs: number;
  score: number;
  confidence: number;
  seedCount: number;
}

/**
 * Get per-model Wilson rankings, optionally filtered by prompt
 */
export function getModelRankings(promptFilter?: string): ModelRanking[] {
  const db = getDb();

  const query = promptFilter
    ? `SELECT model,
         SUM(CASE WHEN action = 'accept' THEN 1 ELSE 0 END) as ups,
         SUM(CASE WHEN action = 'reject' THEN 1 ELSE 0 END) as downs,
         COUNT(DISTINCT seed) as seedCount
       FROM seed_preferences
       WHERE model != '' AND prompt = ?
       GROUP BY model`
    : `SELECT model,
         SUM(CASE WHEN action = 'accept' THEN 1 ELSE 0 END) as ups,
         SUM(CASE WHEN action = 'reject' THEN 1 ELSE 0 END) as downs,
         COUNT(DISTINCT seed) as seedCount
       FROM seed_preferences
       WHERE model != ''
       GROUP BY model`;

  const rows = promptFilter
    ? db.prepare(query).all(promptFilter) as any[]
    : db.prepare(query).all() as any[];

  const rankings = rows.map((r: any) => ({
    model: r.model,
    ups: r.ups || 0,
    downs: r.downs || 0,
    score: wilsonLowerBound(r.ups || 0, r.downs || 0),
    confidence: (r.ups || 0) + (r.downs || 0),
    seedCount: r.seedCount || 0,
  }));

  // Sort by Wilson score descending
  rankings.sort((a, b) => b.score - a.score);
  return rankings;
}

// ---------- Overall summary ----------

export interface OverallSummary {
  totalDecisions: number;
  totalAccepted: number;
  totalRejected: number;
  totalSkipped: number;
  acceptRate: number | null;
  modelCount: number;
  modelNames: string[];
  topModel: string | null;
  topModelScore: number | null;
}

/**
 * Get overall statistics summary
 */
export function getOverallSummary(): OverallSummary {
  const db = getDb();

  const totalRow = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN action = 'accept' THEN 1 ELSE 0 END) as accepted,
      SUM(CASE WHEN action = 'reject' THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN action = 'skip' THEN 1 ELSE 0 END) as skipped
    FROM seed_preferences
  `).get() as any;

  const modelNames = (db.prepare(`
    SELECT DISTINCT model FROM seed_preferences WHERE model != '' ORDER BY model
  `).all() as any[]).map((r: any) => r.model).filter(Boolean);

  // Wilson per model to find top
  const modelStats = modelNames.map(name => {
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN action = 'accept' THEN 1 ELSE 0 END) as ups,
        SUM(CASE WHEN action = 'reject' THEN 1 ELSE 0 END) as downs
      FROM seed_preferences WHERE model = ?
    `).get(name) as any;
    return { name, ups: row.ups || 0, downs: row.downs || 0 };
  });

  const withScore = modelStats.map(m => ({
    ...m,
    score: wilsonLowerBound(m.ups, m.downs),
  }));
  withScore.sort((a, b) => b.score - a.score);

  return {
    totalDecisions: totalRow.total,
    totalAccepted: totalRow.accepted,
    totalRejected: totalRow.rejected,
    totalSkipped: totalRow.skipped,
    acceptRate: totalRow.total > 0 ? totalRow.accepted / totalRow.total : null,
    modelCount: modelNames.length,
    modelNames,
    topModel: withScore.length > 0 ? withScore[0].name : null,
    topModelScore: withScore.length > 0 ? withScore[0].score : null,
  };
}

function asDecisionRecord(row: any): DecisionRecord {
  return {
    seed: row.seed,
    prompt: row.prompt,
    model: row.model ?? "",
    action: row.action as DecisionAction,
    note: row.note ?? "",
    batchTag: row.batch_tag ?? "",
    createdAt: row.created_at,
  };
}
