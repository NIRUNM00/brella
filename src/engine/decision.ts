import type { DecisionAction, DecisionRecord, DecisionResult } from "../types/bddd.js";
import { getDb } from "../db/connection.js";
import { wilsonLowerBound } from "../scoring/wilson.js";

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
        "SELECT * FROM seed_preferences WHERE seed = ? AND prompt = ? ORDER BY created_at DESC",
      )
      .all(seed, prompt);
  } else {
    rows = db
      .prepare(
        "SELECT * FROM seed_preferences WHERE seed = ? ORDER BY created_at DESC",
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

function asDecisionRecord(row: any): DecisionRecord {
  return {
    seed: row.seed,
    prompt: row.prompt,
    model: row.model ?? "",
    action: row.action as DecisionAction,
    note: row.note ?? "",
    createdAt: row.created_at,
  };
}
