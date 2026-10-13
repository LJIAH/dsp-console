/**
 * 心跳插件的单测 —— 半开连接（服务端悄悄没了，不发关闭帧）的唯一发现手段。
 *
 * 断言两件事：
 *   ① 探测节拍：按 interval 发 ping（走 sendRaw，绕过背压/队列）；
 *   ② 判死条件：连续 maxMissed 次超时才 close，且用的是 **1000**（伪装成正常断开）
 *      —— 因为重连插件必须接管，而 1000 不在"不重连关闭码"名单里。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreEvents, WSCore } from '../src/core/ws-core';
import type { CoreState } from '../src/core/ws-core';
import { heartbeatPlugin } from '../src/plugins/heartbeat';
import { heartbeatPolicy } from '../src/protocol';
import { createSocketHarness } from './helpers/mock-websocket';

/** 把节拍压到毫秒级：100ms 探一次、50ms 等 pong、连续 2 次判死 */
const CONFIG = {
  heartbeatInterval: 100,
  heartbeatTimeout: 50,
  maxMissed: 2,
  buildPing: heartbeatPolicy.buildPing,
  isPong: heartbeatPolicy.isPong,
};

function setup() {
  const harness = createSocketHarness();
  const core = new WSCore({ url: 'ws://test/ws', createSocket: harness.createSocket });
  const missed: { missed: number }[] = [];
  const dead: { missed: number }[] = [];
  const rtt: { rtt: number }[] = [];
  /** 事实状态只有内核里有（插件读的是 ctx.getState）；测试从状态迁移事件观察它 */
  const states: CoreState[] = [];
  core.use(heartbeatPlugin(), CONFIG);
  core.on('heartbeat:missed', (e) => missed.push(e as { missed: number }));
  core.on('heartbeat:dead', (e) => dead.push(e as { missed: number }));
  core.on('heartbeat:rtt', (e) => rtt.push(e as { rtt: number }));
  core.on(CoreEvents.StateChange, (e) => states.push((e as { to: CoreState }).to));
  return { core, harness, missed, dead, rtt, states };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('探测节拍', () => {
  it('连接建立后按 interval 发 ping（应用层心跳包）', () => {
    const { core, harness } = setup();
    core.start();
    harness.current().acceptOpen();

    expect(harness.current().sentFrames()).toHaveLength(0); // 刚连上不急着探
    vi.advanceTimersByTime(100);
    const pings = harness
      .current()
      .sentFrames()
      .filter((f) => f.type === 'ping');
    expect(pings).toHaveLength(1);
    expect(pings[0]!.payload.echo).toEqual(expect.any(Number));

    // 每拍都回一次 pong 保持存活（不回的话 2 拍就在 250ms 处判死了 —— 见下一组用例）
    for (let i = 0; i < 2; i += 1) {
      harness.current().deliverJson({ type: 'pong', ts: Date.now(), payload: { echo: 1 } });
      vi.advanceTimersByTime(100);
    }
    expect(
      harness
        .current()
        .sentFrames()
        .filter((f) => f.type === 'ping'),
    ).toHaveLength(3);
  });

  it('pong 到得及时 → 一次也不判死', () => {
    const { core, harness, missed, dead, states } = setup();
    core.start();
    harness.current().acceptOpen();

    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(100);
      harness.current().deliverJson({ type: 'pong', ts: Date.now(), payload: { echo: 1 } });
    }
    expect(missed).toHaveLength(0);
    expect(dead).toHaveLength(0);
    expect(states.at(-1)).toBe('open');
  });

  it('pong 回来时记录 RTT（面板上那个数字）', () => {
    const { core, harness, rtt } = setup();
    core.start();
    harness.current().acceptOpen();

    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(30); // 30ms 之后 pong 才回来
    harness.current().deliverJson({ type: 'pong', ts: Date.now(), payload: { echo: 1 } });

    expect(rtt).toHaveLength(1);
    expect(rtt[0]!.rtt).toBe(30);
  });

  it('pong 被心跳消费，不会继续往业务链传（前端业务不该看到心跳回声）', () => {
    const { core, harness } = setup();
    const seen: unknown[] = [];
    core.use({ name: 'spy', setup: (ctx) => ctx.onMessage((msg) => void seen.push(msg)) });
    core.start();
    harness.current().acceptOpen();

    vi.advanceTimersByTime(100);
    harness.current().deliverJson({ type: 'pong', ts: Date.now(), payload: { echo: 1 } });
    harness
      .current()
      .deliverJson({ type: 'meters', ts: Date.now(), seq: 1, payload: { devices: [] } });

    expect(seen.map((m) => (m as { type: string }).type)).toEqual(['meters']);
  });
});

describe('判死（半开连接）', () => {
  it('连续 2 次超时 → 主动 close(1000)，并广播 heartbeat:dead', () => {
    const { core, harness, missed, dead, states } = setup();
    core.start();
    harness.current().acceptOpen();

    vi.advanceTimersByTime(250); // t=100 ping#1 → t=150 超时#1 → t=200 ping#2 → t=250 超时#2
    expect(missed.map((m) => m.missed)).toEqual([1, 2]);
    expect(dead).toEqual([{ missed: 2 }]);
    expect(harness.current().closeCalls).toEqual([{ code: 1000, reason: 'heartbeat timeout' }]);
    expect(states.at(-1)).toBe('closed');
  });

  it('一次抖动不算死：中途收到 pong 就重新计数', () => {
    const { core, harness, missed, dead, states } = setup();
    core.start();
    harness.current().acceptOpen();

    vi.advanceTimersByTime(150); // 超时一次
    expect(missed).toHaveLength(1);
    harness.current().deliverJson({ type: 'pong', ts: Date.now(), payload: { echo: 1 } });

    vi.advanceTimersByTime(140); // 窗口是 250ms，此刻不该判死
    expect(dead).toHaveLength(0);
    expect(states.at(-1)).toBe('open');
  });

  it('判死后心跳彻底停下（不会在"要重连了"之前继续打日志）', () => {
    const { core, harness } = setup();
    core.start();
    harness.current().acceptOpen();
    vi.advanceTimersByTime(250);
    const afterDeath = harness.current().sent.length;

    vi.advanceTimersByTime(1_000);
    expect(harness.current().sent.length).toBe(afterDeath);
  });

  it('主动关闭后定时器被清掉（不留后台定时器）', () => {
    const { core, harness } = setup();
    core.start();
    harness.current().acceptOpen();
    vi.advanceTimersByTime(100);
    const before = harness.current().sent.length;

    core.close();
    vi.advanceTimersByTime(5_000);
    expect(harness.current().sent.length).toBe(before);
  });
});
