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
    console.log(chalk.dim("  (引擎开发中，敬请期待)"));
  });

// ---------- brief: 查看简报 ----------
program
  .command("brief")
  .description("查看最新简报")
  .option("-i, --id <batchId>", "指定批次 ID")
  .action(async (opts) => {
    console.log(chalk.cyan("📋 Brella — 简报"));
    console.log(chalk.dim("  (简报引擎开发中)"));
  });

// ---------- detail: 查看详情 ----------
program
  .command("detail")
  .description("查看某张/某组图像的详细检测信息")
  .argument("<identifier>", "种子号或文件名")
  .option("-b, --batch <batchId>", "所属批次")
  .action(async (ident, opts) => {
    console.log(chalk.cyan("🔍 Brella — 详情"));
    console.log(`  标识: ${ident}`);
    console.log(chalk.dim("  (详情引擎开发中)"));
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
    console.log(`  种子 ${seed} → ${action}`);
    console.log(chalk.dim("  (决策引擎开发中)"));
  });

// ---------- stats: 统计 ----------
program
  .command("stats")
  .description("查看记忆统计 / Wilson Score 排名")
  .option("--top <n>", "显示前 N 名", parseInt, 10)
  .action(async (opts) => {
    console.log(chalk.cyan("📊 Brella — 统计"));
    console.log(chalk.dim("  (统计引擎开发中)"));
  });

// ---------- init: 初始化数据库 ----------
program
  .command("init")
  .description("初始化 Brella 数据库")
  .action(async () => {
    console.log(chalk.cyan("🔧 Brella — 初始化"));
    console.log(chalk.dim("  (数据库模块开发中)"));
  });

program.parse();
