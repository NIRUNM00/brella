#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));

const program = new Command();

program
  .name("brella")
  .description("AI 出片策展 Agent — 筛选、记忆、决策")
  .version(pkg.version);

// ---------- curate: 加载目录 → 分层简报 ----------
program
  .command("curate")
  .description("加载图像目录，生成 Bad/Dubious/Desired 分层简报")
  .argument("<directory>", "图像目录路径")
  .option("-t, --tag <tag>", "批次标识")
  .option("-a, --alpha <alpha>", "Wilson Score α 参数", parseFloat, 0.05)
  .action(async (dir, opts) => {
    console.log(chalk.cyan("🫂 Brella — 开始策展"));
    console.log(`  目录: ${dir}`);
    console.log(`  批次: ${opts.tag ?? "auto"}`);
    console.log(`  alpha: ${opts.alpha}`);

    // Scan directory for images
    const { readdirSync, statSync } = await import("node:fs");
    const { extname, resolve } = await import("node:path");
    const files = readdirSync(dir)
      .filter((f: string) => [".png", ".jpg", ".jpeg", ".webp"].includes(extname(f).toLowerCase()))
      .map((f: string) => resolve(dir, f));

    console.log(chalk.dim(`  发现 ${files.length} 张图像`));
    if (files.length === 0) {
      console.log(chalk.yellow("  目录中未找到图像文件"));
      return;
    }

    // Placeholder: run detection (stub)
    const { generateBriefing } = await import("./engine/briefing.js");
    const { Layer } = await import("./types/bddd.js");
    const stubResults = files.map((path: string) => ({
      image: {
        path,
        filename: path.split("/").pop() ?? "unknown",
        size: statSync(path).size,
        width: 0,
        height: 0,
        seed: 0,
        prompt: "",
        cfg: 7.0,
        model: "",
        batchTag: opts.tag ?? "auto",
      },
      handAnomaly: 0,
      faceAnomaly: 0,
      compositionScore: 0.7,
      exposureScore: 0.7,
      layer: Layer.Desired,
      confidence: 0.5,
    }));

    const briefing = generateBriefing(stubResults, {
      batchTag: opts.tag,
      wilsonAlpha: opts.alpha,
    });

    console.log("");
    console.log(chalk.bold("📋 简报"));
    console.log(`  Batch: ${briefing.batchId}`);
    console.log(`  ${briefing.summary}`);
    console.log(chalk.dim(`  ${briefing.createdAt}`));
  });

// ---------- brief: 查看简报 ----------
program
  .command("brief")
  .description("查看最新简报")
  .option("-i, --id <batchId>", "指定批次 ID")
  .action(async (opts) => {
    console.log(chalk.cyan("📋 Brella — 简报"));
    const { getDb } = await import("./db/connection.js");
    const db = getDb();
    if (opts.id) {
      console.log(`  批次: ${opts.id}`);
      console.log(chalk.dim("  简报详情待实现 (WIP)"));
    } else {
      // Show latest stats
      const totalDecisions = (db.prepare("SELECT COUNT(*) as c FROM seed_preferences").get() as any).c;
      const topSeeds = db.prepare("SELECT seed, score FROM wilson_scores ORDER BY score DESC LIMIT 5").all() as any[];
      console.log(`  已记录决策: ${totalDecisions} 条`);
      if (topSeeds.length > 0) {
        console.log(chalk.dim("  高分种子:"));
        for (const s of topSeeds) {
          console.log(`    seed ${s.seed}: ${(s.score * 100).toFixed(1)}%`);
        }
      }
    }
  });

// ---------- detail: 查看详情 ----------
program
  .command("detail")
  .description("查看某张/某组图像的详细检测信息")
  .argument("<identifier>", "种子号或文件名")
  .option("-b, --batch <batchId>", "所属批次")
  .action(async (ident, opts) => {
    console.log(chalk.cyan("🔍 Brella — 详情"));
    const identifier = parseInt(ident);
    if (isNaN(identifier)) {
      console.log(chalk.yellow("  请输入种子号 (数字)"));
      return;
    }
    const { getDb } = await import("./db/connection.js");
    const db = getDb();
    const rows = db.prepare(
      "SELECT * FROM seed_preferences WHERE seed = ? ORDER BY created_at DESC"
    ).all(identifier) as any[];
    if (rows.length === 0) {
      console.log(chalk.yellow(`  种子 ${identifier} 暂无决策记录`));
    } else {
      console.log(chalk.bold(`  种子 ${identifier} — ${rows.length} 条记录`));
      for (const r of rows) {
        const actionColor = r.action === "accept" ? chalk.green : r.action === "reject" ? chalk.red : chalk.gray;
        console.log(`    ${actionColor(r.action.padEnd(8))} ${r.created_at} ${r.note ? "— " + r.note : ""}`);
      }
    }
  });

// ---------- decide: 记录决策 ----------
program
  .command("decide")
  .description("记录决策: accept / reject / skip")
  .argument("<seed>", "种子号", parseInt)
  .argument("<action>", "决策 (accept/reject/skip)")
  .option("-p, --prompt <prompt>", "关联 prompt")
  .option("-n, --note <note>", "备注")
  .action(async (seed, action, opts) => {
    const valid = ["accept", "reject", "skip"];
    if (!valid.includes(action)) {
      console.error(chalk.red(`无效决策: ${action}，需为 accept / reject / skip`));
      process.exit(1);
    }
    console.log(chalk.cyan("✍️  Brella — 记录决策"));
    const { recordDecision } = await import("./engine/decision.js");
    const rec = recordDecision({
      seed,
      prompt: opts.prompt ?? "unknown",
      action: action as "accept" | "reject" | "skip",
      note: opts.note,
    });
    console.log(`  种子 ${rec.seed} → ${chalk.green(rec.action)} (${rec.createdAt})`);
    console.log(chalk.dim(`  已记录至数据库`));
  });

// ---------- stats: 统计 ----------
program
  .command("stats")
  .description("查看记忆统计 / Wilson Score 排名")
  .option("--top <n>", "显示前 N 名", parseInt, 10)
  .action(async (opts) => {
    console.log(chalk.cyan("📊 Brella — 统计"));
    const { getWilsonTopN } = await import("./engine/decision.js");
    const { getDb } = await import("./db/connection.js");
    const db = getDb();
    console.log(chalk.dim(`  数据库: ${db.name}`));
    const top = getWilsonTopN(opts.top);
    if (top.length === 0) {
      console.log(chalk.yellow("  暂无评分数据，跑一次 brella decide 来生成"));
    } else {
      console.log(chalk.bold(`\nWilson Score Top ${opts.top}:`));
      for (const t of top) {
        const bar = "█".repeat(Math.round(t.score * 20));
        console.log(`  seed ${String(t.seed).padStart(8)} | ${(t.score * 100).toFixed(1)}% ${bar} (${t.ups}👍/${t.downs}👎)`);
      }
    }
  });

// ---------- init: 初始化数据库 ----------
program
  .command("init")
  .description("初始化 Brella 数据库")
  .action(async () => {
    console.log(chalk.cyan("🔧 Brella — 初始化"));
    const { getDb } = await import("./db/connection.js");
    const db = getDb();
    console.log(chalk.green(`  ✅ 数据库已初始化: ${db.name}`));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as any[];
    console.log(chalk.dim(`  表: ${tables.map((t: any) => t.name).join(", ")}`));
  });

program.parse();
