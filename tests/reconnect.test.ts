/**
 * 重连插件的单测：用 MockWebSocket + fake timers 把「退避序列」摆到台面上。
 *
 * 这一组测的是「插件的接线」——纯函数算得对不对由 `backoff.test.ts` 负责，
 * 这里负责的是：**断线之后到底排了什么、排了几次、什么情况下不排**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreEvents, WSCore } from '../src/core/ws-core';
import type { CoreState } from '../src/core/ws-core';
import { reconnectPlugin } from '../src/plugins/reconnect';
import { createSocketHarness } from './helpers/mock-websocket';

interface Scheduled {
  attempt: number;
  delay: number;
  nextRetryAt: number;
}

const BASE_CONFIG = {
  baseDelay: 1_000,
  maxDelay: 30_000,
  noRetryCodes: [1008, 4001, 4002],
};

function setup(config: Record<string, unknown> = {}) {
  const harness = createSocketHarness();
  const core = new WSCore({ url: 'ws://test/ws', createSocket: harness.createSocket });
  const scheduled: Scheduled[] = [];
  const giveups: { reason: string; code?: number; attempts?: number }[] = [];
  /** 事实状态只有内核里有（插件拿的是 ctx.getState）；测试从状态迁移事件观察它 */
  const states: CoreState[] = [];
  core.use(reconnectPlugin(), { ...BASE_CONFIG, ...config });
  core.on('reconnect:scheduled', (e) => scheduled.push(e as Scheduled));
  core.on('reconnect:giveup', (e) => giveups.push(e));
  core.on(CoreEvents.StateChange, (e) => states.push((e as { to: CoreState }).to));
  return { core, harness, scheduled, giveups, states };
}

beforeEach(() => {
  vi.useFakeTimers();
  // 抖动确定化：Math.random = 0.5 → delay = ceiling × 0.75（否则断言只能写成区间）
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('退避重连', () => {
  it('断线后按 1s→2s→4s…（带 50% 抖动）排队重连，createSocket 会换一条新连接', () => {
    const { core, harness, scheduled, states } = setup();
    core.start();
    expect(states.at(-1)).toBe('connecting');

    harness.current().acceptOpen();
    expect(states.at(-1)).toBe('open');

    harness.current().drop(1006);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.attempt).toBe(1);
    expect(scheduled[0]!.delay).toBe(750); // ceiling(0)=1000 × 0.75

    vi.advanceTimersByTime(750);
    expect(harness.sockets).toHaveLength(2); // 新的 socket 已建出来

    // 没连上就又断了：退避翻倍
    harness.current().drop(1006);
    expect(scheduled[1]!.delay).toBe(1_500); // ceiling(1)=2000 × 0.75

    vi.advanceTimersByTime(1_500);
    harness.current().drop(1006);
    expect(scheduled[2]!.delay).toBe(3_000); // ceiling(2)=4000 × 0.75
  });

  it('退避封顶在 30s：连续失败不会把延迟涨到天上去', () => {
    const { core, harness, scheduled } = setup();
    core.start();
    for (let i = 0; i < 8; i += 1) {
      harness.current().drop(1006);
      vi.advanceTimersByTime(Math.min(30_000, 750 * 2 ** i));
    }
    expect(scheduled.at(-1)!.delay).toBe(22_500); // ceiling 封顶 30000 × 0.75
    expect(scheduled.every((s) => s.delay <= 30_000)).toBe(true);
  });

  it('连接成功后重试计数归零（下一次断线又从 1s 档重新开始）', () => {
    const { core, harness, scheduled } = setup();
    core.start();
    harness.current().drop(1006);
    vi.advanceTimersByTime(750);
    harness.current().acceptOpen(); // 这次连上了
    harness.current().drop(1006);
    expect(scheduled.at(-1)!.attempt).toBe(1);
    expect(scheduled.at(-1)!.delay).toBe(750);
  });

  it('提示性事件带 nextRetryAt（UI 的倒计时就用它）', () => {
    const { core, harness, scheduled } = setup();
    core.start();
    harness.current().acceptOpen();
    harness.current().drop(1006);
    expect(scheduled[0]!.nextRetryAt).toBe(Date.now() + 750);
  });
});

describe('不该重连的两种情况', () => {
  it('关闭码在 noRetryCodes 里（1008 策略违规）→ 直接放弃，不再排连接', () => {
    const { core, harness, giveups, scheduled } = setup();
    core.start();
    harness.current().acceptOpen();
    harness.current().drop(1008, 'policy violation');

    expect(giveups).toEqual([{ reason: 'no-retry-code', code: 1008 }]);
    expect(scheduled).toHaveLength(0);
    vi.advanceTimersByTime(60_000);
    expect(harness.sockets).toHaveLength(1);
  });

  it('用户主动关闭 → 不重连（这就是"主动断开 vs 服务端踢"的落点）', () => {
    const { core, harness, scheduled, states } = setup();
    core.start();
    harness.current().acceptOpen();
    core.close();

    expect(harness.current().closeCalls[0]!.code).toBe(1000);
    vi.advanceTimersByTime(60_000);
    expect(scheduled).toHaveLength(0);
    expect(harness.sockets).toHaveLength(1);
    expect(states.at(-1)).toBe('closed');
  });

  it('重试次数用尽 → giveup（reason = max-attempts）', () => {
    const { core, harness, giveups } = setup({ maxReconnectAttempts: 2 });
    core.start();
    harness.current().drop(1006);
    vi.advanceTimersByTime(750);
    harness.current().drop(1006);
    vi.advanceTimersByTime(1_500);
    harness.current().drop(1006);

    expect(giveups).toEqual([{ reason: 'max-attempts', attempts: 2 }]);
    expect(harness.sockets).toHaveLength(3);
  });

  it('主动关闭之后再 start() 还能连回来（"主动断开"不是永久拉黑）', () => {
    const { core, harness, states } = setup();
    core.start();
    harness.current().acceptOpen();
    core.close();
    core.start();
    expect(harness.sockets).toHaveLength(2);
    harness.current().acceptOpen();
    expect(states.at(-1)).toBe('open');
  });
});

describe('shared.isReopen —— 下游插件（可靠重发 / 快照对齐）依赖的那个值', () => {
  it('首连时是 false，重连成功时是 true', () => {
    const { core, harness } = setup();
    const opened: { isReopen: boolean }[] = [];
    core.on('reconnect:opened', (e) => opened.push(e as { isReopen: boolean }));

    core.start();
    harness.current().acceptOpen();
    expect(opened[0]!.isReopen).toBe(false);
    expect(core.shared.isReopen).toBe(false);

    harness.current().drop(1006);
    vi.advanceTimersByTime(750);
    harness.current().acceptOpen();
    expect(opened[1]!.isReopen).toBe(true);
    expect(core.shared.isReopen).toBe(true);
  });

  it('连接断开时立即复位为 false（别让旧值骗到重连之后的插件）', () => {
    const { core, harness } = setup();
    core.start();
    harness.current().acceptOpen();
    harness.current().drop(1006);
    vi.advanceTimersByTime(750);
    harness.current().acceptOpen();
    expect(core.shared.isReopen).toBe(true);
    harness.current().drop(1006);
    expect(core.shared.isReopen).toBe(false);
  });
});

describe('getReconnectInfo（面板显示的那几个数字）', () => {
  it('给出 attempts / delay / nextRetryAt / givenUp', () => {
    const { core, harness } = setup();
    core.start();
    harness.current().acceptOpen();
    const info = (core as unknown as { getReconnectInfo: () => Record<string, number | boolean> })
      .getReconnectInfo;
    expect(typeof info).toBe('function');

    harness.current().drop(1006);
    const snapshot = info();
    expect(snapshot.attempt).toBe(1);
    expect(snapshot.delay).toBe(750);
    expect(snapshot.givenUp).toBe(false);
  });
});
