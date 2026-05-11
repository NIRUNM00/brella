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
    const { getDb } = await import("./db/connection.js");
    const db = getDb();

    // Parse identifier: try as seed number first
    const identifier = parseInt(ident);
    if (!isNaN(identifier)) {
      // Query by seed
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
    } else {
      // Query by filename (from image_metadata)
      const metas = db.prepare(
        "SELECT * FROM image_metadata WHERE file_path LIKE ?"
      ).all(`%${ident}%`) as any[];
      if (metas.length === 0) {
        console.log(chalk.yellow(`  未找到文件 "${ident}" 的元数据`));
      } else {
        for (const meta of metas) {
          console.log(chalk.bold(`\n  ${meta.file_path.split("/").pop()}`));
          console.log(`    prompt: ${meta.prompt}`);
          console.log(`    seed: ${meta.seed}  model: ${meta.model}  cfg: ${meta.cfg}`);
          console.log(`    batch: ${meta.batch_tag}  ${meta.width}x${meta.height}`);

          // Also show decision history for this seed
          const decisions = db.prepare(
            "SELECT * FROM seed_preferences WHERE seed = ? ORDER BY created_at DESC"
          ).all(meta.seed) as any[];
          if (decisions.length > 0) {
            console.log(chalk.dim(`    决策历史 (${decisions.length} 条):`));
            for (const d of decisions) {
              const ac = d.action === "accept" ? chalk.green : d.action === "reject" ? chalk.red : chalk.gray;
              console.log(`      ${ac(d.action.padEnd(8))} ${d.created_at} ${d.note ? "— " + d.note : ""}`);
            }
          } else {
            console.log(chalk.dim("    暂无决策记录"));
          }
        }
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
  .option("-a, --archetype <label>", "关联原型标签（自动标记）")
  .action(async (seed, action, opts) => {
    const valid = ["accept", "reject", "skip"];
    if (!valid.includes(action)) {
      console.error(chalk.red(`无效决策: ${action}，需为 accept / reject / skip`));
      process.exit(1);
    }
    console.log(chalk.cyan("✍️  Brella — 记录决策"));

    // Auto-tag archetype if provided
    if (opts.archetype && opts.prompt) {
      const { setArchetype } = await import("./engine/archetypes.js");
      setArchetype(opts.prompt, opts.archetype);
      console.log(chalk.dim(`  原型关联: ${opts.archetype}`));
    }

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

// ---------- archetype: 原型管理 ----------
const archetype = program
  .command("archetype")
  .description("管理 Prompt 原型分类（设置/查询/列表/搜索）");

archetype
  .command("set")
  .description("设置/更新 prompt 的原型标签")
  .argument("<prompt>", "prompt 文本")
  .argument("<label>", "原型标签名（如 portrait, landscape, nsfw 等）")
  .action(async (prompt, label) => {
    console.log(chalk.cyan("🏷️  Brella — 设置原型"));
    const { setArchetype } = await import("./engine/archetypes.js");
    const entry = setArchetype(prompt, label);
    console.log(`  prompt: ${chalk.dim(entry.prompt.slice(0, 60))}${entry.prompt.length > 60 ? "…" : ""}`);
    console.log(`  原型标签: ${chalk.bold(entry.archetype)}`);
    console.log(chalk.dim(`  已更新 (${entry.lastUpdated})`));
  });

archetype
  .command("get")
  .description("查询某 prompt 的原型信息")
  .argument("<prompt>", "prompt 文本")
  .action(async (prompt) => {
    console.log(chalk.cyan("🔎 Brella — 查询原型"));
    const { getArchetype } = await import("./engine/archetypes.js");
    const entry = getArchetype(prompt);
    if (!entry) {
      console.log(chalk.yellow("  该 prompt 尚无原型记录"));
      return;
    }
    console.log(`  prompt: ${chalk.dim(entry.prompt.slice(0, 60))}${entry.prompt.length > 60 ? "…" : ""}`);
    console.log(`  原型标签: ${chalk.bold(entry.archetype || chalk.dim("(未标记)"))}`);
    console.log(`  ✅ 偏好种子 (${entry.preferredSeeds.length}): ${entry.preferredSeeds.length > 0 ? entry.preferredSeeds.join(", ") : chalk.dim("无")}`);
    console.log(`  ❌ 拒绝种子 (${entry.rejectedSeeds.length}): ${entry.rejectedSeeds.length > 0 ? entry.rejectedSeeds.join(", ") : chalk.dim("无")}`);
    console.log(`  总判断: ${entry.totalJudgments}`);
    console.log(chalk.dim(`  最后更新: ${entry.lastUpdated}`));
  });

archetype
  .command("list")
  .description("列出所有原型分类及统计")
  .action(async () => {
    console.log(chalk.cyan("📋 Brella — 原型列表"));
    const { listArchetypes, getAllArchetypes } = await import("./engine/archetypes.js");
    const summaries = listArchetypes();
    if (summaries.length === 0) {
      console.log(chalk.yellow("  暂无原型分类"));
      return;
    }
    console.log(chalk.dim(`  ${summaries.length} 个分类:`));
    for (const s of summaries) {
      console.log(`  ${chalk.bold(s.archetype.padEnd(20))} ${s.count} prompts, ${s.totalJudgments} 次判断`);
    }
    console.log("");
    const all = getAllArchetypes(100);
    console.log(chalk.dim("  最近标记:"));
    for (const a of all) {
      const label = a.archetype || chalk.dim("(未标记)");
      console.log(`    ${String(label).padEnd(20)} ${a.prompt.slice(0, 50)}${a.prompt.length > 50 ? "…" : ""}`);
    }
  });

archetype
  .command("search")
  .description("搜索 prompt 或原型标签")
  .argument("<query>", "搜索关键词")
  .action(async (query) => {
    console.log(chalk.cyan("🔍 Brella — 搜索原型"));
    const { searchArchetypes } = await import("./engine/archetypes.js");
    const results = searchArchetypes(query);
    if (results.length === 0) {
      console.log(chalk.yellow(`  未找到匹配 "${query}" 的原型`));
      return;
    }
    console.log(chalk.dim(`  找到 ${results.length} 条结果:`));
    for (const r of results) {
      const label = r.archetype || chalk.dim("(未标记)");
      console.log(`  ${chalk.bold(label)}  ${r.prompt.slice(0, 60)}${r.prompt.length > 60 ? "…" : ""}  🧩 ${r.totalJudgments}次判断`);
    }
  });

// ---------- classify: 单图检测（JSON 输出，供 ComfyUI 节点调用） ----------
program
  .command("classify")
  .description("对单张图像执行全管线检测，输出 JSON 分类结果（供 ComfyUI 节点使用）")
  .argument("<imagePath>", "图像文件路径")
  .option("--pretty", "格式化 JSON 输出（默认压缩）")
  .option("--hand-threshold <n>", "手部异常阈值", parseFloat, 0.5)
  .option("--face-threshold <n>", "面部异常阈值", parseFloat, 0.6)
  .option("--comp-threshold <n>", "构图评分布疑阈值", parseFloat, 0.5)
  .option("--exp-threshold <n>", "曝光评分布疑阈值", parseFloat, 0.3)
  .action(async (imagePath, opts) => {
    const { existsSync, statSync } = await import("node:fs");

    // 验证文件存在
    if (!existsSync(imagePath)) {
      console.error(JSON.stringify({ error: `File not found: ${imagePath}` }));
      process.exit(1);
    }

    // 验证是图像文件
    const ext = imagePath.split(".").pop()?.toLowerCase();
    if (!["png", "jpg", "jpeg", "webp"].includes(ext ?? "")) {
      console.error(JSON.stringify({ error: `Unsupported image format: ${ext}` }));
      process.exit(1);
    }

    try {
      // 读取 PNG 元数据（尽可能多的信息；非 PNG 格式提供基本信息）
      const stats = statSync(imagePath);
      let imageMeta: any = {
        path: imagePath,
        filename: imagePath.split("/").pop() ?? "unknown",
        size: stats.size,
        width: 0,
        height: 0,
        seed: 0,
        prompt: "",
        cfg: 7.0,
        model: "",
      };

      if (ext === "png") {
        const { readImageMeta } = await import("./comfyui/metadata.js");
        const pngMeta = readImageMeta(imagePath);
        imageMeta = { ...imageMeta, ...pngMeta };
      }

      // 运行检测管线
      const { ClassificationPipeline } = await import("./pipeline/classify.js");

      const pipeline = new ClassificationPipeline({
        handThresholdBad: opts.handThreshold,
        faceThresholdBad: opts.faceThreshold,
        compositionThresholdDubious: opts.compThreshold,
        exposureThresholdDubious: opts.expThreshold,
      });

      const result = await pipeline.classifyOne(imageMeta);

      const output = {
        file: imagePath,
        filename: result.image.filename,
        seed: result.image.seed,
        prompt: result.image.prompt?.slice(0, 200) ?? "",
        model: result.image.model,
        layer: result.detection.layer,
        confidence: result.detection.confidence,
        scores: {
          handAnomaly: result.detection.handAnomaly,
          faceAnomaly: result.detection.faceAnomaly,
          compositionScore: result.detection.compositionScore,
          exposureScore: result.detection.exposureScore,
        },
        reasons: result.reasons,
        processingTimeMs: result.raw.processingTimeMs,
      };

      console.log(JSON.stringify(output, null, opts.pretty ? 2 : undefined));
    } catch (err: any) {
      console.error(JSON.stringify({
        error: err.message ?? String(err),
        file: imagePath,
      }));
      process.exit(1);
    }
  });

program.parse();
