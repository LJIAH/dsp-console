/**
 * 可靠指令插件的单测：seq + ack + 超时重发 + 重连重发。
 *
 * 这里测的是「指令的结局」四种情况，它们对应的正是现场最常被问到的四个问题：
 *   ① 设备不回 ack 会怎样？（超时重发，**同一个 seq**）
 *   ② 重发几次之后呢？（command:failed，Promise reject —— UI 据此回滚乐观值）
 *   ③ 设备明确拒绝呢？（不重发，直接 reject，带上错误码）
 *   ④ 断线时发的指令呢？（挂着，重连后原样重发）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WSCore } from '../src/core/ws-core';
import { reconnectPlugin } from '../src/plugins/reconnect';
import { CommandRejectedError, reliablePlugin } from '../src/plugins/reliable';
import { cmd } from '../src/protocol';
import type { AckPayload } from '../src/protocol';
import { createSocketHarness } from './helpers/mock-websocket';

const ACK_TIMEOUT = 100;

function setup(config: Record<string, unknown> = {}, withReconnect = false) {
  const harness = createSocketHarness();
  const core = new WSCore({ url: 'ws://test/ws', createSocket: harness.createSocket });
  if (withReconnect) {
    core.use(reconnectPlugin(), { baseDelay: 1_000, maxDelay: 30_000, noRetryCodes: [] });
  }
  core.use(reliablePlugin(), { ackTimeout: ACK_TIMEOUT, maxRetry: 3, ...config });
  return { core, harness };
}

/** 立刻挂上结算处理，免得"测试自己制造 unhandled rejection" */
function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

const gainCommand = (seq: number) => cmd.setGain(seq, 'dev-001', 1, 3.5);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('超时重发（设备不回 ack）', () => {
  it('超时后用**同一个 seq** 重发，3 次之后失败并 reject', async () => {
    const { core, harness } = setup();
    const failures: unknown[] = [];
    const pendings: { pending: number }[] = [];
    core.on('command:failed', (e) => failures.push(e));
    core.on('command:pending', (e) => pendings.push(e as { pending: number }));

    core.start();
    harness.current().acceptOpen();

    const result = settle(core.sendCommand(gainCommand));
    const socket = harness.current();
    const seqs = () => socket.sentFrames().map((f) => f.seq);

    expect(seqs()).toEqual([1]); // 首次发出

    vi.advanceTimersByTime(ACK_TIMEOUT);
    expect(seqs()).toEqual([1, 1]); // 重发：seq 不变（设备端据此幂等去重）
    vi.advanceTimersByTime(ACK_TIMEOUT);
    vi.advanceTimersByTime(ACK_TIMEOUT);
    expect(seqs()).toEqual([1, 1, 1, 1]); // 首次 + 3 次重发

    vi.advanceTimersByTime(ACK_TIMEOUT); // 第 4 次超时：重试次数用尽
    const outcome = await result;
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: Error }).error.message).toMatch(/重试 3 次仍无 ack/);
    expect(failures).toEqual([{ seq: 1, retry: 3, reason: 'retry-exhausted' }]);
    expect(pendings.map((p) => p.pending)).toEqual([1, 0]); // 在途指令数：进去一个、出来一个
  });

  it('seq 单调递增，两条指令互不干扰', async () => {
    const { core, harness } = setup();
    core.start();
    harness.current().acceptOpen();

    const first = settle(core.sendCommand(gainCommand));
    const second = settle(core.sendCommand((seq) => cmd.setMuted(seq, 'dev-001', 2, true)));
    harness.current().deliverJson({
      version: 1,
      type: 'ack',
      ts: Date.now(),
      payload: { seq: 2, ok: true, applied: 1 },
    });

    const secondOutcome = await second;
    expect(secondOutcome.ok && (secondOutcome.value as AckPayload).seq).toBe(2);

    harness.current().deliverJson({
      version: 1,
      type: 'ack',
      ts: Date.now(),
      payload: { seq: 1, ok: true, applied: 3.5 },
    });
    const firstOutcome = await first;
    expect(firstOutcome.ok && (firstOutcome.value as AckPayload).applied).toBe(3.5);
    expect(
      harness
        .current()
        .sentFrames()
        .map((f) => f.seq),
    ).toEqual([1, 2]);
  });

  it('迟到 / 重复的 ack 被消费掉但不会误伤别的指令', async () => {
    const { core, harness } = setup();
    core.start();
    harness.current().acceptOpen();

    const result = settle(core.sendCommand(gainCommand));
    harness.current().deliverJson({
      version: 1,
      type: 'ack',
      ts: Date.now(),
      payload: { seq: 99, ok: true }, // 谁都不是的 ack
    });
    harness.current().deliverJson({
      version: 1,
      type: 'ack',
      ts: Date.now(),
      payload: { seq: 1, ok: true, applied: 3.5 }, // 真正的 ack
    });
    expect((await result).ok).toBe(true);
  });
});

describe('设备明确拒绝（ack.ok = false）', () => {
  it('立刻 reject（CommandRejectedError，带错误码），且**不重发**', async () => {
    const { core, harness } = setup();
    core.start();
    harness.current().acceptOpen();

    const result = settle(core.sendCommand(gainCommand));
    harness.current().deliverJson({
      version: 1,
      type: 'ack',
      ts: Date.now(),
      payload: { seq: 1, ok: false, code: 1002, msg: 'device/channel not found', retryable: false },
    });

    const outcome = await result;
    expect(outcome.ok).toBe(false);
    const error = (outcome as { error: CommandRejectedError }).error;
    expect(error).toBeInstanceOf(CommandRejectedError);
    expect(error.ack.code).toBe(1002);
    expect(error.message).toBe('device/channel not found');

    vi.advanceTimersByTime(ACK_TIMEOUT * 10);
    expect(harness.current().sentFrames()).toHaveLength(1); // 重发没有意义
  });
});

describe('重连重发（ack 状态未知的指令）', () => {
  it('断线期间挂住，重连成功后用同一个 seq 原样重发', async () => {
    const { core, harness } = setup({ ackTimeout: 5_000 }, true);
    const resends: { seq: number }[] = [];
    core.on('command:resend', (e) => resends.push(e as { seq: number }));

    core.start();
    harness.current().acceptOpen();
    const result = settle(core.sendCommand(gainCommand));

    harness.current().drop(1006);
    vi.advanceTimersByTime(750); // 退避（ceiling 1000 × 0.75）
    expect(harness.sockets).toHaveLength(2);

    harness.current().acceptOpen(); // 重连成功
    expect(resends).toEqual([{ seq: 1 }]);
    expect(
      harness
        .current()
        .sentFrames()
        .map((f) => f.seq),
    ).toEqual([1]);

    harness.current().deliverJson({
      version: 1,
      type: 'ack',
      ts: Date.now(),
      payload: { seq: 1, ok: true, applied: 3.5 },
    });
    expect((await result).ok).toBe(true);
  });

  it('首连（不是重连）不会重复发一份历史指令', () => {
    const { core, harness } = setup({}, true);
    core.start();
    harness.current().acceptOpen();
    core.sendCommand(gainCommand);
    // 再 open 一次（模拟"同一个 socket 被重复 open"）：isReopen 为 false，不该重发
    harness.current().acceptOpen();
    expect(
      harness
        .current()
        .sentFrames()
        .map((f) => f.seq),
    ).toEqual([1]);
  });
});

describe('收尾', () => {
  it('主动关闭时，在途指令被结算（不能留下永远挂着的 Promise）', async () => {
    const { core, harness } = setup();
    core.start();
    harness.current().acceptOpen();

    const result = settle(core.sendCommand(gainCommand));
    core.close();

    const outcome = await result;
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: Error }).error.message).toMatch(/连接已断开/);
  });

  it('getPendingCount 与实际在途数一致', async () => {
    const { core, harness } = setup();
    const client = core as unknown as { getPendingCount: () => number };
    core.start();
    harness.current().acceptOpen();

    expect(client.getPendingCount()).toBe(0);
    const result = settle(core.sendCommand(gainCommand));
    expect(client.getPendingCount()).toBe(1);
    harness.current().deliverJson({
      version: 1,
      type: 'ack',
      ts: Date.now(),
      payload: { seq: 1, ok: true, applied: 0 },
    });
    await result;
    expect(client.getPendingCount()).toBe(0);
  });
});
