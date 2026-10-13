/**
 * 退避算法的单测。
 *
 * 这是整个连接层最值得被测的一段：**它是一条能算出来的曲线**，却决定了
 * 「网关在重启，多久能自己活过来」和「网关刚活过来，会不会被同时回来的连接再打一遍」。
 * 抽成纯函数 + 注入随机源之后，这些断言全部是确定性的。
 */
import { describe, expect, it } from 'vitest';
import contract from '../protocol/constants.json';
import { backoffCeiling, backoffDelay } from '../src/plugins/backoff';

/** 生产参数直接取自契约，测的就是线上跑的那组数 */
const PROD = {
  baseDelayMs: contract.client.reconnect.baseDelayMs,
  maxDelayMs: contract.client.reconnect.maxDelayMs,
  jitterRatio: contract.client.reconnect.jitterRatio,
};

const rand = (v: number) => () => v;

describe('backoffCeiling —— 指数增长 + 封顶', () => {
  it('第 0/1/3 次分别是 1s / 2s / 8s（base × 2^attempt）', () => {
    expect(backoffCeiling(0, PROD)).toBe(1_000);
    expect(backoffCeiling(1, PROD)).toBe(2_000);
    expect(backoffCeiling(3, PROD)).toBe(8_000);
  });

  it('封顶在 maxDelayMs，不会无限涨下去', () => {
    expect(backoffCeiling(5, PROD)).toBe(30_000);
    expect(backoffCeiling(30, PROD)).toBe(30_000);
  });

  it('负数 attempt 按第 0 次算（防御：不会出现比 base 还短的延迟）', () => {
    expect(backoffCeiling(-3, PROD)).toBe(1_000);
  });
});

describe('backoffDelay —— 抖动', () => {
  it('jitterRatio = 0 时就是指数上限（完全确定）', () => {
    const noJitter = { ...PROD, jitterRatio: 0 };
    expect(backoffDelay(2, noJitter)).toBe(4_000);
    expect(backoffDelay(9, noJitter)).toBe(30_000);
  });

  it('half-jitter：delay ∈ [exp/2, exp]，两个端点都能取到', () => {
    expect(backoffDelay(0, { ...PROD, random: rand(0) })).toBe(500);
    expect(backoffDelay(0, { ...PROD, random: rand(1) })).toBe(1_000);
    expect(backoffDelay(2, { ...PROD, random: rand(0.5) })).toBe(3_000);
  });

  it('抖动**只提前、不推迟**：任何随机值都不会超过封顶', () => {
    for (const r of [0, 0.1, 0.5, 0.9, 0.999, 1]) {
      for (let attempt = 0; attempt <= 20; attempt += 1) {
        const delay = backoffDelay(attempt, { ...PROD, random: rand(r) });
        expect(delay).toBeLessThanOrEqual(PROD.maxDelayMs);
        expect(delay).toBeGreaterThanOrEqual(500);
      }
    }
  });

  it('单调不减：等得越久越久（同一随机源下不会出现"第 3 次比第 2 次短"）', () => {
    const cfg = { ...PROD, random: rand(0.5) };
    let prev = 0;
    for (let attempt = 0; attempt <= 10; attempt += 1) {
      const delay = backoffDelay(attempt, cfg);
      expect(delay).toBeGreaterThanOrEqual(prev);
      prev = delay;
    }
  });

  it('jitterRatio 越界会被夹到 [0,1]（不会算出负延迟）', () => {
    const delay = backoffDelay(0, { ...PROD, jitterRatio: 5, random: rand(0) });
    expect(delay).toBe(0);
    expect(backoffDelay(0, { ...PROD, jitterRatio: -1, random: rand(0) })).toBe(1_000);
  });

  it('现实口径：第一次重试等 0.5~1s，而不是整整 1s —— 这就是"防惊群"的代价', () => {
    // 记下来是免得文档写成"倒计时 1s→2s→4s…"：那说的是指数上限，不是实际等待
    const lows = backoffDelay(0, { ...PROD, random: rand(0) });
    const highs = backoffDelay(0, { ...PROD, random: rand(1) });
    expect([lows, highs]).toEqual([500, 1_000]);
  });
});
