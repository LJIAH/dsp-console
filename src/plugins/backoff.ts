/**
 * 退避算法 —— 抽成**纯函数**，因为它是这套连接里最该被单测钉住的一段：
 * 「第几次失败等多久」是一条可以算出来的曲线，不该藏在插件的闭包里。
 *
 * 形状：指数增长 + 封顶 + 抖动（jitter）。
 *   - 指数：1s → 2s → 4s …，让"网关正在重启"这类短故障能自动恢复；
 *   - 封顶：到 maxDelayMs 就不再涨，避免第 10 次重试要等 17 分钟；
 *   - 抖动：让多个客户端的重试**错开**。没有它，网关一恢复就会被
 *     同时回来的几十个连接打第二遍（惊群）。
 *
 * 抖动方向刻意是「只提前、不推迟」：delay ∈ [exp × (1 − ratio), exp]。
 * ratio = 0.5 时就是经典的 half-jitter —— 上限仍然是封顶值 30s，
 * 而不是"封顶 30s，实际等到 45s"。
 */

export interface BackoffConfig {
  /** 首次重试的基准延迟（ms） */
  baseDelayMs: number;
  /** 延迟上限（ms） */
  maxDelayMs: number;
  /**
   * 抖动比例 ∈ [0, 1]：0 = 不退避纯指数（测试友好），0.5 = half-jitter。
   * 超过范围的取值会被夹到 [0, 1]，避免算出负延迟。
   */
  jitterRatio?: number;
  /** 随机源（测试注入用，默认 Math.random） */
  random?: () => number;
}

/**
 * 第 attempt 次失败后的**指数上限**（未加抖动）：`base × 2^attempt`，封顶 `maxDelayMs`。
 * attempt 从 0 开始：第 1 次重试等 base，第 2 次等 2×base……
 */
export function backoffCeiling(attempt: number, config: BackoffConfig): number {
  const exp = config.baseDelayMs * 2 ** Math.max(0, attempt);
  return Math.min(exp, config.maxDelayMs);
}

/**
 * 第 attempt 次失败后的**实际等待时间**（带抖动）。
 * 传入 `random` 就能完全确定化 —— 这正是它能被单测的原因。
 */
export function backoffDelay(attempt: number, config: BackoffConfig): number {
  const ceiling = backoffCeiling(attempt, config);
  const ratio = Math.min(1, Math.max(0, config.jitterRatio ?? 0));
  if (ratio === 0) return ceiling;
  const rand = (config.random ?? Math.random)();
  return ceiling * (1 - ratio + ratio * rand);
}
