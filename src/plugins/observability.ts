/**
 * ② 观测插件 —— 只观测，不消费
 *
 * 这是整个 Demo 的"证据链"：插件化的代价是执行顺序敏感、调用栈深，
 * 对冲办法就是让链上每个动作都留痕 —— 事件流就是观测面板的数据源。
 * 于是"加一个插件"会自然变成"面板上多一条可观测维度"。
 *
 * 定位：本插件订阅内核与各插件的事件，聚合成一份**引用稳定**的快照，
 * 供 React 用 useSyncExternalStore 订阅（getSnapshot 必须返回缓存引用，
 * 否则 React 会无限重渲染 —— 见 `React/10` 的"值 vs 事件"分流）。
 *
 * 事件命名规范：内核 `core:*`，插件 `<plugin>:*`，业务 `type` 原样。
 */
import type { CoreState, Plugin } from '../core/ws-core';
import { CoreEvents } from '../core/ws-core';

export interface TimelineEvent {
  at: number;
  kind: string;
  text: string;
}

export interface MetricsSnapshot {
  coreState: CoreState;
  isReopen: boolean;
  /** 收到的消息条数（含被消费的 pong/ack） */
  rx: number;
  /** 发出的消息条数（含心跳/指令） */
  tx: number;
  parseErrors: number;
  binaryFrames: number;
  heartbeatMissed: number;
  lastRtt: number | null;
  commandRetries: number;
  commandFailed: number;
  backpressureDrops: number;
  events: readonly TimelineEvent[];
}

const MAX_EVENTS = 200;

export function observabilityPlugin(): Plugin {
  return {
    name: 'observability',
    setup(ctx) {
      let snapshot: MetricsSnapshot = {
        coreState: 'idle',
        isReopen: false,
        rx: 0,
        tx: 0,
        parseErrors: 0,
        binaryFrames: 0,
        heartbeatMissed: 0,
        lastRtt: null,
        commandRetries: 0,
        commandFailed: 0,
        backpressureDrops: 0,
        events: [],
      };

      /** 不可变更新：只替换变化的字段，快照引用整体更换 → 触发订阅者 */
      const update = (patch: Partial<MetricsSnapshot>, event?: TimelineEvent) => {
        const events = event ? [...snapshot.events, event].slice(-MAX_EVENTS) : snapshot.events;
        snapshot = { ...snapshot, ...patch, events };
        ctx.emit('metrics:changed');
      };

      const note = (kind: string, text: string, patch?: Partial<MetricsSnapshot>) => {
        update(patch ?? {}, { at: Date.now(), kind, text });
      };

      // ── 内核事件 ──────────────────────────────────────────────
      ctx.on(CoreEvents.StateChange, (e: { from: CoreState; to: CoreState }) => {
        note('state', `${e.from} → ${e.to}`, { coreState: e.to });
      });
      ctx.on(CoreEvents.ParseError, () => {
        note('parse-error', '脏数据已丢弃（非 JSON）', {
          parseErrors: snapshot.parseErrors + 1,
        });
      });
      ctx.on(CoreEvents.BinaryFrame, () => {
        update({ binaryFrames: snapshot.binaryFrames + 1 });
      });
      ctx.on(CoreEvents.SocketError, () => {
        note('socket-error', 'socket 层错误（随后必有 onclose）');
      });
      ctx.on(CoreEvents.Send, () => {
        update({ tx: snapshot.tx + 1 });
      });

      // ── 重连插件事件 ───────────────────────────────────────────
      ctx.on('reconnect:opened', ({ isReopen }: { isReopen: boolean }) => {
        note('reconnect', isReopen ? '重连成功（会话恢复中）' : '首连成功', { isReopen });
      });
      ctx.on('reconnect:scheduled', ({ attempt, delay }: { attempt: number; delay: number }) => {
        note('reconnect', `第 ${attempt} 次重连，${delay}ms 后（含抖动）`);
      });
      ctx.on('reconnect:giveup', ({ reason, code }: { reason: string; code?: number }) => {
        note('reconnect', `放弃重连：${reason}${code ? `（code=${code}）` : ''}`);
      });

      // ── 心跳插件事件 ───────────────────────────────────────────
      ctx.on('heartbeat:rtt', ({ rtt }: { rtt: number }) => {
        update({ lastRtt: rtt, heartbeatMissed: 0 });
      });
      ctx.on('heartbeat:missed', ({ missed }: { missed: number }) => {
        note('heartbeat', `第 ${missed} 次心跳超时`, { heartbeatMissed: missed });
      });
      ctx.on('heartbeat:dead', ({ missed }: { missed: number }) => {
        note('heartbeat', `判定假死（连续 ${missed} 次无 pong）→ 主动 close 触发重连`);
      });

      // ── 可靠指令事件 ───────────────────────────────────────────
      ctx.on('command:retry', ({ seq, retry }: { seq: number; retry: number }) => {
        note('command', `指令 seq=${seq} 无 ack，第 ${retry} 次重发`, {
          commandRetries: snapshot.commandRetries + 1,
        });
      });
      ctx.on('command:failed', ({ seq, reason }: { seq: number; reason: string }) => {
        note('command', `指令 seq=${seq} 失败：${reason}`, {
          commandFailed: snapshot.commandFailed + 1,
        });
      });
      ctx.on('command:settled', ({ seq, ok }: { seq: number; ok: boolean }) => {
        note('command', `指令 seq=${seq} 已确认（ok=${ok}）`);
      });
      ctx.on('command:resend', ({ seq }: { seq: number }) => {
        note('command', `重连后重发在途指令 seq=${seq}`);
      });

      // ── 流量插件事件 ───────────────────────────────────────────
      ctx.on('backpressure:dropped', ({ reason }: { reason: string }) => {
        update({ backpressureDrops: snapshot.backpressureDrops + 1 });
        // 不写时间轴：高频场景下会刷屏，只在计数里体现
        void reason;
      });

      // ── 消息计数：排在链前部，pong/ack 也能看到 ────────────────
      ctx.onMessage(() => {
        update({ rx: snapshot.rx + 1 });
        return false; // ⚠️ 不消费：继续向后传递
      });

      // ── 对外只读出口 ───────────────────────────────────────────
      ctx.expose('getMetrics', () => snapshot);
      // React 的 subscribe：ctx.on 返回取消函数，可直接作为 useSyncExternalStore 的 subscribe
      ctx.expose('subscribeMetrics', (fn: () => void) => ctx.on('metrics:changed', fn));
    },
  };
}
