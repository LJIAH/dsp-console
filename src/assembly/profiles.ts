/**
 * 装配（use 链）—— 顺序即契约
 *
 * ┌─ 消息链（返回 true = 消费，停止传递）─────────────────────────────┐
 * │ 内核 parse → ①重连(观察) → ②观测(记录) → ③协议校验(拦非法)        │
 * │            → ④心跳(吃 pong) → ⑤可靠(吃 ack) → ⑩分发(兜底)        │
 * └──────────────────────────────────────────────────────────────────┘
 * ┌─ 发送链（不调 next = 拦截）────────────────────────────────────┐
 * │ send() → ⑥outbox(未连接则入队) → ⑦背压(超水位则丢) → sendRaw    │
 * └──────────────────────────────────────────────────────────────────┘
 * 内部能力绕过整条链：sendRaw ← ④心跳 / ⑤可靠指令
 *
 * 两条铁律（违反即出 bug）：
 *   1. reconnect **必须第一个** —— 它的 onOpen 抢先复位退避计数、生产 shared.isReopen，
 *      后面的 reliable（重连重发）、session（快照对齐）都依赖这个值；
 *   2. pubsub **必须最后一个** —— 兜底消费者，装前面会把 pong/ack 也当业务消息分发。
 *
 * 其余顺序的理由：
 *   - observability 靠前：要看到 pong/ack 在内的所有消息（它不消费）；
 *   - protocol 在 heartbeat/reliable 前：它们默认结构合法；
 *   - outbox 在 backpressure 前：backpressure 会把"未连接"当丢弃语义先拦掉，
 *     outbox 就收不到货了（这是最容易被忽略的一条顺序依赖）。
 */
import { WSCore } from '../core/ws-core';
import { reconnectPlugin } from '../plugins/reconnect';
import { observabilityPlugin } from '../plugins/observability';
import { protocolPlugin } from '../plugins/protocol';
import { heartbeatPlugin } from '../plugins/heartbeat';
import { reliablePlugin } from '../plugins/reliable';
import { outboxPlugin } from '../plugins/outbox';
import { backpressurePlugin } from '../plugins/backpressure';
import { sessionPlugin } from '../plugins/session';
import { visibilityPlugin } from '../plugins/visibility';
import { pubsubPlugin } from '../plugins/pubsub';
import { heartbeatPolicy } from '../protocol';
import type { AckPayload, ClientMessage, Device } from '../protocol';
import type { MetricsSnapshot } from '../plugins/observability';

export const GATEWAY_WS = import.meta.env.VITE_GATEWAY_WS ?? 'ws://localhost:8080/ws';
export const GATEWAY_HTTP = import.meta.env.VITE_GATEWAY_HTTP ?? 'http://localhost:8080';

export interface ReconnectInfo {
  attempt: number;
  delay: number;
  nextRetryAt: number;
  givenUp: boolean;
}

/**
 * 类型补充：expose 是**运行时**注入到实例上的，TS 侧用 declaration merging 补齐。
 * 放在装配文件里最合适 —— "装了什么插件，实例上就有什么能力"，
 * 换一套装配方案（见下方 profiles）时，这里就是能力清单。
 */
declare module '../core/ws-core' {
  interface WSCore {
    /** ⑤ 可靠指令：seq + ack + 重发（返回 Promise，UI 可 await 后回滚乐观更新） */
    sendCommand(build: (seq: number) => ClientMessage): Promise<AckPayload>;
    /** ⑧ 手动触发一次快照对齐 */
    resync(): Promise<Device[]>;
    /** ② 观测快照（引用稳定，可直接喂 useSyncExternalStore） */
    getMetrics(): MetricsSnapshot;
    /** ② 订阅观测变化，返回取消函数 */
    subscribeMetrics(fn: () => void): () => void;
    /** ① 重连意图（连接事实状态由内核 getState() 提供） */
    getReconnectInfo(): ReconnectInfo;
    getPendingCount(): number;
    getOutboxSize(): number;
  }
}

export interface AssemblyOptions {
  url?: string;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
  maxMissed?: number;
  ackTimeout?: number;
  maxRetry?: number;
  highWater?: number;
  outboxLimit?: number;
  noRetryCodes?: number[];
  maxReconnectAttempts?: number;
  snapshotUrl?: string;
}

/**
 * 装配方案（profile）：同一个内核，按设备/场景选装能力。
 * 真实处境：不同代次的固件支持的应用层能力不同（有没有应用层 pong、
 * 要不要断线重发），插件化让"适配不同代次设备"变成换装配方案，而不是 fork 代码。
 */
export const profiles = {
  /** 完整方案：现代固件（支持应用层心跳与 ack） */
  full(opts: AssemblyOptions = {}): WSCore {
    const client = new WSCore({ url: opts.url ?? GATEWAY_WS });
    client
      .use(reconnectPlugin(), {
        baseDelay: 1_000,
        maxDelay: 30_000,
        noRetryCodes: opts.noRetryCodes ?? [1008, 4001, 4002],
        maxReconnectAttempts: opts.maxReconnectAttempts ?? Infinity,
      })
      .use(observabilityPlugin())
      .use(protocolPlugin())
      .use(heartbeatPlugin(), {
        heartbeatInterval: opts.heartbeatInterval ?? 15_000,
        heartbeatTimeout: opts.heartbeatTimeout ?? 5_000,
        maxMissed: opts.maxMissed ?? 2,
        buildPing: heartbeatPolicy.buildPing,
        isPong: heartbeatPolicy.isPong,
      })
      .use(reliablePlugin(), {
        ackTimeout: opts.ackTimeout ?? 3_000,
        maxRetry: opts.maxRetry ?? 3,
      })
      .use(
        outboxPlugin({
          // 拖动预览是「下一条覆盖它」的实时量：断线期间补发毫无意义，
          // 却会以每秒十几条的速率把队列塞满。不发，也不入队。
          isVolatile: (msg) => (msg as { type?: string } | null)?.type === 'setGainPreview',
        }),
        { outboxLimit: opts.outboxLimit ?? 200 },
      )
      .use(backpressurePlugin(), { highWater: opts.highWater ?? 5 * 1024 * 1024 })
      .use(sessionPlugin(), { snapshotUrl: opts.snapshotUrl ?? `${GATEWAY_HTTP}/api/devices` })
      .use(visibilityPlugin())
      .use(pubsubPlugin());
    return client;
  },

  /**
   * 老固件方案：设备端不支持应用层 pong —— **不装 heartbeat**。
   * 现场对比用：半开连接时，这个方案永远不会发现，UI 会一直显示"已连接"。
   * 这就是"为什么要应用层心跳"最直接的实证。
   */
  legacyFirmware(opts: AssemblyOptions = {}): WSCore {
    const client = new WSCore({ url: opts.url ?? GATEWAY_WS });
    client
      .use(reconnectPlugin(), { baseDelay: 1_000, maxDelay: 30_000 })
      .use(observabilityPlugin())
      .use(protocolPlugin())
      .use(reliablePlugin(), { ackTimeout: 3_000, maxRetry: 3 })
      .use(pubsubPlugin());
    return client;
  },
};

/** 应用默认装配 */
export function assembleFull(opts?: AssemblyOptions): WSCore {
  return profiles.full(opts);
}
