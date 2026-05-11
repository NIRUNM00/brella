import type { DecisionRecord } from "../types/bddd.js";

/**
 * Wilson Score 置信区间下限
 * 
 * 参考：https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval
 * 
 * 公式：
 *   score = (p + z²/(2n) - z·√((p(1-p) + z²/(4n))/n)) / (1 + z²/n)
 * 
 * @param ups   接受次数
 * @param downs 拒绝次数
 * @param z     z-score (1.96 ≈ 95% 置信度)
 */
export function wilsonLowerBound(
  ups: number,
  downs: number,
  z: number = 1.96,
): number {
  const n = ups + downs;
  if (n === 0) return 0.5; // 无数据时保守中值

  const p = ups / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const inner = (p * (1 - p) + z2 / (4 * n)) / n;

  // 处理极端比例：p=0 或 p=1 时 sqrt 可能数值不稳
  if (inner <= 0) {
    return (p + z2 / (2 * n)) / denominator;
  }

  const score = (p + z2 / (2 * n) - z * Math.sqrt(inner)) / denominator;
  return Math.max(0, Math.min(1, score));
}

/**
 * 从决策记录列表计算 Wilson Score
 */
export function computeWilsonScore(
  records: DecisionRecord[],
  z: number = 1.96,
): { ups: number; downs: number; score: number; confidence: number } {
  let ups = 0;
  let downs = 0;
  for (const r of records) {
    if (r.action === "accept") ups++;
    else if (r.action === "reject") downs++;
  }
  return {
    ups,
    downs,
    score: wilsonLowerBound(ups, downs, z),
    confidence: ups + downs,
  };
}

/**
 * 排序函数：按 Wilson Score 降序
 */
export function sortByWilsonScore<T extends { score: number }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => b.score - a.score);
}
