import { createHash } from "node:crypto";
import { getDb } from "../db/connection.js";

// ---------- Types ----------

export interface ArchetypeEntry {
  id: number;
  promptHash: string;
  prompt: string;
  archetype: string;
  preferredSeeds: number[];
  rejectedSeeds: number[];
  totalJudgments: number;
  lastUpdated: string;
}

export interface ArchetypeSummary {
  archetype: string;
  count: number;
  totalJudgments: number;
}

// ---------- Helpers ----------

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function parseSeedJson(json: string): number[] {
  try {
    return JSON.parse(json) as number[];
  } catch {
    return [];
  }
}

function rowToEntry(row: any): ArchetypeEntry {
  return {
    id: row.id,
    promptHash: row.prompt_hash,
    prompt: row.prompt,
    archetype: row.archetype,
    preferredSeeds: parseSeedJson(row.preferred_seeds),
    rejectedSeeds: parseSeedJson(row.rejected_seeds),
    totalJudgments: row.total_judgments,
    lastUpdated: row.last_updated,
  };
}

// ---------- CRUD ----------

/**
 * Get the archetype entry for a prompt (by text — fuzzy match first, then hash)
 */
export function getArchetype(prompt: string): ArchetypeEntry | null {
  const db = getDb();

  // Try exact text match first
  let row = db
    .prepare("SELECT * FROM prompt_archetypes WHERE prompt = ?")
    .get(prompt) as any;

  // Fall back to hash match
  if (!row) {
    const pHash = hashPrompt(prompt);
    row = db
      .prepare("SELECT * FROM prompt_archetypes WHERE prompt_hash = ?")
      .get(pHash) as any;
  }

  return row ? rowToEntry(row) : null;
}

/**
 * Create or update the archetype label for a prompt
 */
export function setArchetype(prompt: string, archetype: string): ArchetypeEntry {
  const db = getDb();
  const pHash = hashPrompt(prompt);

  db.prepare(
    `INSERT INTO prompt_archetypes (prompt_hash, prompt, archetype, last_updated)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(prompt_hash) DO UPDATE SET
       archetype = excluded.archetype,
       last_updated = datetime('now')`,
  ).run(pHash, prompt, archetype);

  const row = db
    .prepare("SELECT * FROM prompt_archetypes WHERE prompt_hash = ?")
    .get(pHash) as any;
  return rowToEntry(row);
}

/**
 * List all archetype categories with prompt counts
 */
export function listArchetypes(): ArchetypeSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT archetype, COUNT(*) as count, COALESCE(SUM(total_judgments), 0) as totalJudgments
       FROM prompt_archetypes
       WHERE archetype != ''
       GROUP BY archetype
       ORDER BY totalJudgments DESC`,
    )
    .all() as any[];

  return rows.map((r: any) => ({
    archetype: r.archetype,
    count: r.count,
    totalJudgments: r.totalJudgments,
  }));
}

/**
 * Search archetypes by prompt text or archetype name
 */
export function searchArchetypes(query: string): ArchetypeEntry[] {
  const db = getDb();
  const like = `%${query}%`;

  const rows = db
    .prepare(
      `SELECT * FROM prompt_archetypes
       WHERE prompt LIKE ? OR archetype LIKE ?
       ORDER BY total_judgments DESC
       LIMIT 50`,
    )
    .all(like, like) as any[];

  return rows.map(rowToEntry);
}

/**
 * Get all archetypes (paginated)
 */
export function getAllArchetypes(limit: number = 100): ArchetypeEntry[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM prompt_archetypes
       ORDER BY total_judgments DESC
       LIMIT ?`,
    )
    .all(limit) as any[];

  return rows.map(rowToEntry);
}

// ---------- Decision Association ----------

/**
 * Read current seed list, append if not duplicate, write back.
 */
function addSeedIfNew(seed: number, jsonArray: string): string {
  const seeds = parseSeedJson(jsonArray);
  if (!seeds.includes(seed)) {
    seeds.push(seed);
  }
  return JSON.stringify(seeds);
}

/**
 * After a decision is recorded, update the corresponding archetype entry:
 * - Creates entry if missing
 * - Adds seed to preferred_seeds (accept) or rejected_seeds (reject)
 * - Increments total_judgments
 */
export function associateDecision(
  prompt: string,
  seed: number,
  action: "accept" | "reject" | "skip",
): void {
  const db = getDb();
  const pHash = hashPrompt(prompt);

  // Ensure entry exists
  db.prepare(
    `INSERT OR IGNORE INTO prompt_archetypes (prompt_hash, prompt, last_updated)
     VALUES (?, ?, datetime('now'))`,
  ).run(pHash, prompt);

  if (action === "accept") {
    const row = db
      .prepare("SELECT preferred_seeds FROM prompt_archetypes WHERE prompt_hash = ?")
      .get(pHash) as any;
    const updated = addSeedIfNew(seed, row.preferred_seeds);

    db.prepare(
      `UPDATE prompt_archetypes
       SET preferred_seeds = ?,
           total_judgments = total_judgments + 1,
           last_updated = datetime('now')
       WHERE prompt_hash = ?`,
    ).run(updated, pHash);
  } else if (action === "reject") {
    const row = db
      .prepare("SELECT rejected_seeds FROM prompt_archetypes WHERE prompt_hash = ?")
      .get(pHash) as any;
    const updated = addSeedIfNew(seed, row.rejected_seeds);

    db.prepare(
      `UPDATE prompt_archetypes
       SET rejected_seeds = ?,
           total_judgments = total_judgments + 1,
           last_updated = datetime('now')
       WHERE prompt_hash = ?`,
    ).run(updated, pHash);
  } else {
    // skip: just increment count
    db.prepare(
      `UPDATE prompt_archetypes
       SET total_judgments = total_judgments + 1,
           last_updated = datetime('now')
       WHERE prompt_hash = ?`,
    ).run(pHash);
  }
}
