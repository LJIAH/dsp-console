/**
 * 契约测试 —— 把「一份文档」升级成「一条被持续验证的流水线」。
 *
 * 对应 `协议设计/06` 的定义：契约测试验证的是**实现与契约是否一致**，而不是"代码有没有跑通"。
 * 这里做四件事：
 *   ① 结构：JSON Schema 的消息类型集合 == Zod 判别联合的类型集合（只加一端会红）；
 *   ② 数值：JSON Schema 里的每个边界 == constants.json 里的值（改一处漏一处会红）；
 *   ③ 行为：同一批样例帧，Ajv 与 Zod 的**接受/拒绝结论必须一致**（两端口径漂移会红）；
 *   ④ 兼容：新固件多发字段、v2 的 version —— 解析边界要宽容地放过。
 *
 * 网关"真实发出的帧"由 `gateway-frames.test.ts` 覆盖（那一个会起真进程）。
 */
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import contract from '../protocol/constants.json';
import schema from '../protocol/messages.schema.json';
import { ServerMessageSchema, cmd, parseServerMessage } from '../src/protocol';
import type { ClientMessage } from '../src/protocol';

const WIRE = contract.wire;

// ── 校验器 ────────────────────────────────────────────────────
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = ajv.compile(schema);
const schemaAccepts = (frame: unknown) => validate(frame) === true;

/** 从 JSON Schema 的 $ref 拿到分支定义 */
const deref = (ref: string) => {
  const name = ref.replace('#/$defs/', '');
  return (schema.$defs as Record<string, any>)[name];
};
const schemaTypesOf = (union: 'ServerMessage' | 'ClientMessage') =>
  (schema.$defs as Record<string, any>)[union].oneOf
    .map((branch: { $ref: string }) => deref(branch.$ref).properties.type.const as string)
    .sort();

// ── ① 结构：两端的消息类型集合必须相同 ────────────────────────
describe('消息类型集合（Schema vs Zod）', () => {
  it('服务端方向：8 种，且两边完全一致', () => {
    const fromZod = ServerMessageSchema.options
      .map((option) => option.shape.type.value as string)
      .sort();
    expect(schemaTypesOf('ServerMessage')).toEqual(fromZod);
    expect(fromZod).toEqual([
      'ack',
      'error',
      'meters',
      'pong',
      'snapshot',
      'spectrum',
      'state',
      'waveform',
    ]);
  });

  it('客户端方向：7 种，且与 ClientMessage 联合类型互锁（多一个/少一个都编译不过）', () => {
    // 这两行是编译期断言：任一方向对不上，tsc 就会报错
    const listed: readonly ClientMessage['type'][] = CLIENT_MESSAGE_LIST;
    const unionMembers: readonly (typeof CLIENT_MESSAGE_LIST)[number][] =
      [] as readonly ClientMessage['type'][];
    expect(listed.length).toBe(CLIENT_MESSAGE_LIST.length);
    expect(unionMembers.length).toBe(0);

    expect(schemaTypesOf('ClientMessage')).toEqual([...CLIENT_MESSAGE_LIST].sort());
  });
});

const CLIENT_MESSAGE_LIST = [
  'ping',
  'subscribe',
  'focus',
  'setMuted',
  'setLevel',
  'setGain',
  'setGainPreview',
] as const;

// ── ② 数值：Schema 的每个边界都必须来自 constants.json ────────
describe('边界数值（Schema vs constants.json）', () => {
  const at = (path: string[]) =>
    path.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], schema);

  const BOUNDS: [string[], string | number, string][] = [
    [['$defs', 'Level', 'minimum'], WIRE.level.noSignal, 'level 哨兵（无信号）'],
    [['$defs', 'Level', 'maximum'], WIRE.level.max, 'level 上限'],
    [['$defs', 'Gain', 'minimum'], WIRE.gain.min, 'gain 下限'],
    [['$defs', 'Gain', 'maximum'], WIRE.gain.max, 'gain 上限'],
    [['$defs', 'Channel', 'properties', 'ch', 'minimum'], WIRE.channel.indexMin, '通道号从 1 开始'],
    [['$defs', 'Channel', 'properties', 'ch', 'maximum'], WIRE.channel.maxCount, '通道号上限'],
    [
      ['$defs', 'Device', 'properties', 'channels', 'maxItems'],
      WIRE.channel.maxCount,
      '设备通道数上限',
    ],
    [['$defs', 'SpectrumBins', 'minItems'], WIRE.spectrum.bins, '频谱 bin 数'],
    [['$defs', 'SpectrumBins', 'maxItems'], WIRE.spectrum.bins, '频谱 bin 数'],
    [['$defs', 'SpectrumBins', 'items', 'minimum'], WIRE.spectrum.min, '频谱取值范围'],
    [['$defs', 'SpectrumBins', 'items', 'maximum'], WIRE.spectrum.max, '频谱取值范围'],
    [['$defs', 'WaveformSamples', 'minItems'], WIRE.waveform.points, '波形点数'],
    [['$defs', 'WaveformSamples', 'maxItems'], WIRE.waveform.points, '波形点数'],
    [['$defs', 'WaveformSamples', 'items', 'minimum'], WIRE.waveform.min, '波形取值范围'],
    [['$defs', 'WaveformSamples', 'items', 'maximum'], WIRE.waveform.max, '波形取值范围'],
    [
      [
        '$defs',
        'meters',
        'properties',
        'payload',
        'properties',
        'devices',
        'items',
        'properties',
        'levels',
        'maxItems',
      ],
      WIRE.channel.maxCount,
      '批量帧每台设备的电平数上限',
    ],
    [['$defs', 'meters', 'properties', 'seq', 'minimum'], 1, 'meters 序号从 1 开始'],
    [['$defs', 'setGain', 'properties', 'seq', 'minimum'], 1, '可靠指令 seq 从 1 开始'],
    [
      ['$defs', 'setGain', 'properties', 'payload', 'properties', 'gain', '$ref'],
      '#/$defs/Gain',
      'setGain.gain 引用同一个 Gain 定义',
    ],
    [
      ['$defs', 'setLevel', 'properties', 'payload', 'properties', 'level', 'minimum'],
      WIRE.level.min,
      'setLevel 范围',
    ],
    [
      ['$defs', 'setLevel', 'properties', 'payload', 'properties', 'level', 'maximum'],
      WIRE.level.max,
      'setLevel 范围',
    ],
  ];

  it.each(BOUNDS)('%s → %s（%s）', (path, expected) => {
    expect(at(path)).toBe(expected);
  });

  it('$ref 用到的定义都存在（改名不会留下悬空引用）', () => {
    const refs: string[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === '$ref' && typeof value === 'string') refs.push(value);
        else walk(value);
      }
    };
    walk(schema);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(deref(ref)).toBeDefined();
  });
});

// ── ③ 行为：同一批样例帧，Ajv 与 Zod 结论必须一致 ─────────────
const device = {
  deviceId: 'dev-001',
  name: 'DSP-01',
  model: 'ADSP1616',
  online: true,
  bootId: 'b1',
  fw: '1.4.2',
  channels: [
    { ch: 1, level: -120, muted: false, gain: 0 },
    { ch: 2, level: WIRE.level.noSignal, muted: true, gain: 3.5 },
  ],
};
const envelope = { version: contract.protocolVersion, ts: 1_700_000_000_000 };
const bins = Array.from({ length: WIRE.spectrum.bins }, () => 128);
const samples = Array.from({ length: WIRE.waveform.points }, () => WIRE.waveform.center);

const CASES: { name: string; frame: unknown; ok: boolean }[] = [
  {
    name: 'snapshot',
    frame: { ...envelope, type: 'snapshot', payload: { devices: [device] } },
    ok: true,
  },
  {
    name: 'meters（含哨兵值）',
    frame: {
      ...envelope,
      type: 'meters',
      seq: 1,
      payload: { devices: [{ deviceId: 'dev-001', levels: [-120, WIRE.level.noSignal] }] },
    },
    ok: true,
  },
  {
    name: 'spectrum',
    frame: { ...envelope, type: 'spectrum', payload: { deviceId: 'dev-001', bins } },
    ok: true,
  },
  {
    name: 'waveform',
    frame: { ...envelope, type: 'waveform', payload: { deviceId: 'dev-001', samples } },
    ok: true,
  },
  { name: 'state', frame: { ...envelope, type: 'state', payload: { device } }, ok: true },
  {
    name: 'ack 成功（带 read-back）',
    frame: { ...envelope, type: 'ack', payload: { seq: 7, ok: true, applied: 3.5 } },
    ok: true,
  },
  {
    name: 'ack 失败（带错误码）',
    frame: {
      ...envelope,
      type: 'ack',
      payload: { seq: 7, ok: false, code: 1002, retryable: false },
    },
    ok: true,
  },
  { name: 'pong', frame: { ...envelope, type: 'pong', payload: { echo: 1 } }, ok: true },
  {
    name: 'error',
    frame: { ...envelope, type: 'error', payload: { code: 4000, msg: 'unknown type' } },
    ok: true,
  },

  // v1 的帧不带 version 也要过（缺省视为 1）
  {
    name: '不带 version 的 meters',
    frame: { ts: 1, type: 'meters', seq: 2, payload: { devices: [] } },
    ok: true,
  },
  // 新固件多发字段：解析边界要宽容（多一个字段不等于"非法数据"）
  {
    name: '带未知字段的 state（向前兼容）',
    frame: { ...envelope, type: 'state', payload: { device, peak: -3 } },
    ok: true,
  },
  // 刻意的宽松：高频通道的 levels 不校验值域 —— 画出一个怪值好过丢掉整帧
  {
    name: 'meters 里越界的电平（双方都放过）',
    frame: {
      ...envelope,
      type: 'meters',
      seq: 3,
      payload: { devices: [{ deviceId: 'd', levels: [-1000] }] },
    },
    ok: true,
  },
  // v2 的 version：v1 的解析器宁可按 v1 尽力解析，也不要整帧丢弃
  {
    name: 'version=2 的 meters（宽容策略）',
    frame: { ...envelope, version: 2, type: 'meters', seq: 4, payload: { devices: [] } },
    ok: true,
  },

  {
    name: 'level 越界（-1000 < 哨兵）',
    frame: {
      ...envelope,
      type: 'state',
      payload: {
        device: { ...device, channels: [{ ch: 1, level: -1000, muted: false, gain: 0 }] },
      },
    },
    ok: false,
  },
  {
    name: 'gain 越界（12.5）',
    frame: {
      ...envelope,
      type: 'state',
      payload: { device: { ...device, channels: [{ ch: 1, level: 0, muted: false, gain: 12.5 }] } },
    },
    ok: false,
  },
  {
    name: '通道号 0（索引从 1 开始）',
    frame: {
      ...envelope,
      type: 'state',
      payload: { device: { ...device, channels: [{ ch: 0, level: 0, muted: false, gain: 0 }] } },
    },
    ok: false,
  },
  {
    name: '通道号 33（超过上限）',
    frame: {
      ...envelope,
      type: 'state',
      payload: { device: { ...device, channels: [{ ch: 33, level: 0, muted: false, gain: 0 }] } },
    },
    ok: false,
  },
  {
    name: '频谱 63 个 bin（长度不对）',
    frame: { ...envelope, type: 'spectrum', payload: { deviceId: 'd', bins: bins.slice(1) } },
    ok: false,
  },
  {
    name: '频谱值 256（越界）',
    frame: { ...envelope, type: 'spectrum', payload: { deviceId: 'd', bins: bins.map(() => 256) } },
    ok: false,
  },
  {
    name: '波形 257 点（长度不对）',
    frame: {
      ...envelope,
      type: 'waveform',
      payload: { deviceId: 'd', samples: [...samples, 128] },
    },
    ok: false,
  },
  {
    name: 'meters 缺 seq',
    frame: { ...envelope, type: 'meters', payload: { devices: [] } },
    ok: false,
  },
  {
    name: 'meters seq = 0',
    frame: { ...envelope, type: 'meters', seq: 0, payload: { devices: [] } },
    ok: false,
  },
  { name: 'snapshot 缺 payload', frame: { ...envelope, type: 'snapshot' }, ok: false },
  {
    name: '设备缺 bootId',
    frame: { ...envelope, type: 'state', payload: { device: { ...device, bootId: undefined } } },
    ok: false,
  },
  { name: '未知消息类型', frame: { ...envelope, type: 'nope', payload: {} }, ok: false },
  {
    name: '35 路通道（超过上限）',
    frame: {
      ...envelope,
      type: 'state',
      payload: {
        device: {
          ...device,
          channels: Array.from({ length: 35 }, (_, i) => ({
            ch: i + 1,
            level: 0,
            muted: false,
            gain: 0,
          })),
        },
      },
    },
    ok: false,
  },
];

describe.each(CASES)('样例帧：$name', ({ frame, ok }) => {
  const raw = JSON.stringify(frame);

  it(`JSON Schema（Ajv）→ ${ok ? '放行' : '拒绝'}`, () => {
    expect(schemaAccepts(frame)).toBe(ok);
  });

  it(`Zod（parseServerMessage）→ ${ok ? '放行' : '拒绝'}`, () => {
    expect(parseServerMessage(raw) !== null).toBe(ok);
  });
});

// ── 客户端方向：构造器产出的帧必须过 Schema ────────────────────
describe('cmd.* 构造的帧符合 Schema', () => {
  const frames: ClientMessage[] = [
    cmd.ping(),
    cmd.subscribe(1, ['dev-001']),
    cmd.focus('dev-001'),
    cmd.focus(null),
    cmd.setMuted(2, 'dev-001', 1, true),
    cmd.setLevel(3, 'dev-001', 1, -120),
    cmd.setGain(4, 'dev-001', 1, 3.5),
    cmd.setGainPreview('dev-001', 1, -6),
  ];

  it.each(frames.map((frame) => [frame.type, frame] as const))('%s', (_type, frame) => {
    expect(schemaAccepts(frame)).toBe(true);
    expect(frame.version).toBe(contract.protocolVersion);
  });
});
