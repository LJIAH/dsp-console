/**
 * 设备消息协议 —— 前端侧的运行时入口
 *
 * ⚠️ **数值不在这个文件里**：唯一来源是 `protocol/constants.json`，
 *    前端与网关 `server/index.mjs` 都 import 它（以前是两边各写一份、靠注释提醒"必须一致"）。
 *    本文只做三件事：
 *      ① 把常量取出成具名导出（调用处不必记 JSON 路径）；
 *      ② 用 Zod 把「结构 + 边界」写成运行时校验；
 *      ③ 给出信封的类型与构造器。
 *
 * 语言无关的那一份契约（给设备侧/嵌入式看）→ `protocol/`：
 *   messages.schema.json  结构与边界（JSON Schema）
 *   limits.md             单位与边界表 + 为什么这么定
 *   errors.md             错误码 / 关闭码 + 前端该干什么
 *   versioning.md         版本与兼容策略（只增不删 / 适配层 / bootId）
 *
 * 设计依据 → `协议设计/`：
 *   信封四要素 type / ts / seq / version
 *   单位与边界：level 是 dB 的 10 倍定点整数；-999 为"无信号"哨兵
 *   状态建模：Device 扁平结构，按 deviceId 归一化
 *   ack 语义：ok=true 且回带 applied（read-back），失败带 code + retryable
 *
 * ⚠️ 类型只保证"前端自己写对了"；网络来的数据一律用 Zod 运行时校验，
 *    失败返回 null 交给上层丢弃 —— 单条脏数据不能让整个连接崩溃。
 */
import contract from '../protocol/constants.json';
import { z } from 'zod';

const WIRE = contract.wire;
const CLIENT = contract.client;

/**
 * 策略常量（分组导出，调用处能看到"这是哪一类参数"）：
 *   `wirePolicy`   —— 与设备侧共同遵守的（ack 超时、重发次数、推送节拍…）
 *   `clientPolicy` —— 客户端本地策略（心跳、退避、outbox、背压、预览节流…）
 * 插件与容器里凡是写死的魔法数字，都应该指到这里 —— 一个文件看全部可调项。
 */
export const wirePolicy = WIRE;
export const clientPolicy = CLIENT;

/** 协议版本：随信封下发，缺省视为 1（见 `protocol/versioning.md`） */
export const PROTOCOL_VERSION: number = contract.protocolVersion;

// ── 单位与边界（唯一来源 protocol/constants.json，不靠猜） ───────
/** 电平哨兵：-999 表示"无信号"（物理上不可能出现的值） */
export const LEVEL_NO_SIGNAL = WIRE.level.noSignal;
/** 电平范围：-60.0 dB ~ 0.0 dB，线上是 ×10 定点整数 */
export const LEVEL_MIN_DB10 = WIRE.level.min;
export const LEVEL_MAX_DB10 = WIRE.level.max;

/** 增益（**控制量**，可设定）：滑块与 ChannelSchema 取的是同一份数 */
export const GAIN_MIN = WIRE.gain.min;
export const GAIN_MAX = WIRE.gain.max;
export const GAIN_STEP = WIRE.gain.step;

/**
 * 频谱 bin 数 / 波形采样点数（契约的两端都从 constants.json 取，不再"各自写一份"）。
 * 数值刻意与 Web Audio 的字节数组同构：
 * 频谱 ≈ getByteFrequencyData()（0~255），波形 ≈ getByteTimeDomainData()（0~255，128 为中轴）
 * —— 这样"设备推送"与"浏览器本地分析"两个数据源可以互换，渲染器不用改。
 */
export const SPECTRUM_BINS = WIRE.spectrum.bins;
export const WAVEFORM_POINTS = WIRE.waveform.points;
/** 波形中轴：静音就是它（0~255 里的 128） */
export const WAVEFORM_CENTER = WIRE.waveform.center;

/**
 * 关闭码取值：契约里那几张码表带了 `$comment` 文档键，所以不能直接下标取（类型会变宽），
 * 顺便在这里挡住"名字写错"—— 写错就当场炸，而不是悄悄拿到 undefined。
 */
export function closeCode(name: string): number {
  const code = (WIRE.closeCodes as Record<string, unknown>)[name];
  if (typeof code !== 'number') {
    throw new Error(`协议里没有关闭码 "${name}"（见 protocol/errors.md）`);
  }
  return code;
}

/** 收到这些关闭码就不重连 —— 重连也没用（策略违规 / 设备离线 / 固件升级中） */
export const NO_RETRY_CLOSE_CODES: number[] = CLIENT.reconnect.noRetryCloseCodes.map(closeCode);

/** dB ⇄ 线上定点值 */
export const levelCodec = {
  /** 线上 → 显示：-999 → null（无信号），-405 → -40.5 */
  fromWire(v: number): number | null {
    return v === LEVEL_NO_SIGNAL ? null : v / 10;
  },
  /** 显示 → 线上：夹取到 [-60, 0] 后乘 10 取整 */
  toWire(dbValue: number): number {
    return Math.round(Math.min(0, Math.max(-60, dbValue)) * 10);
  },
};

// ── 数据模型 ────────────────────────────────────────────────────
/**
 * 默认通道数（虚拟设备与兜底用）。
 * ⚠️ 真实设备的通道数以 `device.channels.length` 为准 —— 这是**设备能力**：
 * ADSP1616 是 16 进 16 出、ADSP0808AEC 是 8 进 8 出，界面列数应该跟着设备走。
 */
export const CHANNELS = WIRE.channel.defaultCount;

/** 协议上限：单台设备的通道数（防止畸形数据把界面撑爆） */
export const MAX_CHANNELS = WIRE.channel.maxCount;

/** 通道号从 1 开始（不是 0）—— 跨端最容易差一的地方，写进契约而不是靠记 */
const CH_INDEX_MIN = WIRE.channel.indexMin;

const ChannelSchema = z.object({
  ch: z.number().int().min(CH_INDEX_MIN).max(MAX_CHANNELS),
  /** 电平（×10 定点），或 -999 无信号 */
  level: z.number().int().min(LEVEL_NO_SIGNAL).max(LEVEL_MAX_DB10),
  muted: z.boolean(),
  /** 增益，dB 浮点，-12 ~ +12 */
  gain: z.number().min(GAIN_MIN).max(GAIN_MAX),
});

export const DeviceSchema = z.object({
  deviceId: z.string(),
  name: z.string(),
  /** 型号：ADSP1616 / ADSP0808AEC ... */
  model: z.string(),
  online: z.boolean(),
  /** 设备本次上电的 ID：变化 = 设备重启 → 序号归零、需拉全量 */
  bootId: z.string(),
  fw: z.string(),
  /** ⚠️ 数组长度就是这台设备的通道数（ADSP1616 → 16，ADSP0808AEC → 8） */
  channels: z.array(ChannelSchema).min(1).max(MAX_CHANNELS),
});

export type Device = z.infer<typeof DeviceSchema>;
export type Channel = z.infer<typeof ChannelSchema>;

// ── 信封：服务端 → 浏览器 ───────────────────────────────────────
/**
 * 信封公共字段：version 缺省视为 1。
 * 这里用 optional（而不是 z.literal(1)）：解析边界要宽容 —— 新固件发 v2 的帧，
 * 老前端宁可按 v1 尽力解析，也不要整帧丢弃（策略见 `protocol/versioning.md`）。
 */
const versionField = { version: z.number().int().optional() };

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    ts: z.number(),
    ...versionField,
    payload: z.object({ devices: z.array(DeviceSchema) }),
  }),
  z.object({
    type: z.literal('meters'),
    ts: z.number(),
    ...versionField,
    /** 全局单调序号：跳号 = 有缺口（高频通道不做历史对齐，只做实时容错） */
    seq: z.number().int().positive(),
    /**
     * ⚠️ levels 只校验「整数数组 + 长度合规」，**不校验值域**：
     * 高频通道上宁可画出一个越界值，也不能因为一条越界值的行李丢掉整帧。
     */
    payload: z.object({
      devices: z.array(
        z.object({
          deviceId: z.string(),
          levels: z.array(z.number().int()).min(1).max(MAX_CHANNELS),
        }),
      ),
    }),
  }),
  z.object({
    type: z.literal('spectrum'),
    ts: z.number(),
    ...versionField,
    payload: z.object({
      deviceId: z.string(),
      bins: z
        .array(z.number().int().min(WIRE.spectrum.min).max(WIRE.spectrum.max))
        .length(SPECTRUM_BINS),
    }),
  }),
  z.object({
    type: z.literal('waveform'),
    ts: z.number(),
    ...versionField,
    payload: z.object({
      deviceId: z.string(),
      samples: z
        .array(z.number().int().min(WIRE.waveform.min).max(WIRE.waveform.max))
        .length(WAVEFORM_POINTS),
    }),
  }),
  z.object({
    type: z.literal('state'),
    ts: z.number(),
    ...versionField,
    payload: z.object({ device: DeviceSchema }),
  }),
  z.object({
    type: z.literal('ack'),
    ts: z.number(),
    ...versionField,
    payload: z.object({
      seq: z.number().int(),
      ok: z.boolean(),
      /** read-back：设备实际应用后的值（可选） */
      applied: z.number().optional(),
      code: z.number().optional(),
      msg: z.string().optional(),
      retryable: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('pong'),
    ts: z.number(),
    ...versionField,
    payload: z.object({ echo: z.number() }),
  }),
  z.object({
    type: z.literal('error'),
    ts: z.number(),
    ...versionField,
    payload: z.object({
      code: z.number(),
      msg: z.string(),
      retryable: z.boolean().optional(),
    }),
  }),
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage['type'];
export type AckPayload = Extract<ServerMessage, { type: 'ack' }>['payload'];

/**
 * 运行时校验：任何来自网络的数据都不可信。
 * 解析/校验失败返回 null（对应 `Websocket/04` 的"脏数据不崩溃"）。
 */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = ServerMessageSchema.safeParse(json);
  return result.success ? result.data : null;
}

// ── 信封：浏览器 → 服务端 ───────────────────────────────────────
/** 出站信封的公共字段（`ts` 为本地毫秒；`version` 缺省视为 1） */
interface ClientEnvelope {
  ts: number;
  version?: number;
}

export type ClientMessage =
  | ({ type: 'ping'; payload: { echo: number } } & ClientEnvelope)
  | ({ type: 'subscribe'; seq: number; payload: { deviceIds: string[] } } & ClientEnvelope)
  /**
   * 聚焦设备：网关只给"被聚焦"的那台设备推频谱/波形这类高频大帧。
   * 这是"按需推送"的落点 —— 16 通道电平是全设备总览（小、必须），
   * 频谱/波形是大帧（64+256 个数），全设备推会把链路和浏览器打满。
   */
  | ({ type: 'focus'; payload: { deviceId: string | null } } & ClientEnvelope)
  | ({
      type: 'setMuted';
      seq: number;
      payload: { deviceId: string; ch: number; muted: boolean };
    } & ClientEnvelope)
  | ({
      type: 'setLevel';
      seq: number;
      payload: { deviceId: string; ch: number; level: number };
    } & ClientEnvelope)
  /**
   * 增益设定（**可靠指令**）：松手那一刻发，seq + ack + 超时重发。
   * ⚠️ gain 与 level 的区别：level 是**测量值**（设备实测电平，不可设定），
   *    gain 才是**控制量**（-12 ~ +12 dB）—— 滑块控制的必须是后者。
   */
  | ({
      type: 'setGain';
      seq: number;
      payload: { deviceId: string; ch: number; gain: number };
    } & ClientEnvelope)
  /**
   * 增益**预览**（**可丢指令**）：拖动过程中约 16 次/秒发送，不带 seq、不回 ack。
   * 丢了无所谓 —— 下一条会覆盖它；服务端也不会为它推 state，
   * 否则拖动 1 秒就是几十条全量 state 洪水，反而把界面搞乱。
   */
  | ({
      type: 'setGainPreview';
      payload: { deviceId: string; ch: number; gain: number };
    } & ClientEnvelope);

/** 出站信封：每条消息都带 ts + version（版本逐帧带，理由见 protocol/versioning.md） */
const envelope = () => ({ ts: Date.now(), version: PROTOCOL_VERSION });

export const cmd = {
  ping: (): ClientMessage => ({ type: 'ping', ...envelope(), payload: { echo: Date.now() } }),
  subscribe: (seq: number, deviceIds: string[]): ClientMessage => ({
    type: 'subscribe',
    ...envelope(),
    seq,
    payload: { deviceIds },
  }),
  setMuted: (seq: number, deviceId: string, ch: number, muted: boolean): ClientMessage => ({
    type: 'setMuted',
    ...envelope(),
    seq,
    payload: { deviceId, ch, muted },
  }),
  setLevel: (seq: number, deviceId: string, ch: number, level: number): ClientMessage => ({
    type: 'setLevel',
    ...envelope(),
    seq,
    payload: { deviceId, ch, level },
  }),
  /** 增益定值：走可靠通道（sendCommand → seq + ack） */
  setGain: (seq: number, deviceId: string, ch: number, gain: number): ClientMessage => ({
    type: 'setGain',
    ...envelope(),
    seq,
    payload: { deviceId, ch, gain },
  }),
  /** 增益预览：走 send（可丢、不入可靠通道），拖动过程中高频发送 */
  setGainPreview: (deviceId: string, ch: number, gain: number): ClientMessage => ({
    type: 'setGainPreview',
    ...envelope(),
    payload: { deviceId, ch, gain },
  }),
  /** 聚焦设备：非可靠指令（丢了也只是收不到高频帧，重发无意义） */
  focus: (deviceId: string | null): ClientMessage => ({
    type: 'focus',
    ...envelope(),
    payload: { deviceId },
  }),
};

/**
 * 心跳策略：由 heartbeat 插件注入使用。
 * 「什么算心跳」是协议知识而不是连接知识 —— 换项目只换这个对象。
 */
export const heartbeatPolicy = {
  buildPing: () => cmd.ping(),
  isPong: (msg: { type?: string } | null | undefined) => msg?.type === 'pong',
};
