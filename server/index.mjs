/**
 * Mock 设备网关：Express（REST）+ ws（WebSocket）
 *
 * 定位：这是「设备网关」的替身，不是学习重点 —— 它存在的意义是让前端能跑、
 * 能演示故障。真实环境里这一层是嵌入式网关（C + lwIP）或边缘服务。
 *
 * 两个刻意的设计：
 *   1. WS 用 `noServer: true` + 手动 handleUpgrade，而不是 `new WebSocketServer({ server })`：
 *      附加模式下连接已被接受，无法在握手阶段拒绝 —— 而 Origin 校验
 *      （防跨站 WebSocket 劫持 CSWSH）恰恰必须在 upgrade 阶段做；
 *   2. REST 与 WS 同端口（一个 http.Server 两条路径），对齐真实设备网关的形态。
 *
 * 运行：pnpm server
 */
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8080);
const DEVICE_COUNT = 10;
/**
 * 型号 → 通道数（真实产品线：ADSP1616 = 16 进 16 出，ADSP0808AEC = 8 进 8 出）。
 * 通道数是**设备能力**，不是界面常量 —— 前端的列数跟着 device.channels 走。
 */
const MODELS = [
  { model: 'ADSP1616', channels: 16 },
  { model: 'ADSP0808AEC', channels: 8 },
];
const LEVEL_NO_SIGNAL = -999;
/** 电平推送频率：20Hz 批量（协议约定 10~20Hz，UI 只看得到 20~30fps） */
const METER_INTERVAL_MS = 50;
/**
 * 频谱 / 波形规格 —— ⚠️ 必须与 src/protocol.ts 里的同名常量一致（契约的两端）。
 * 数值刻意与 Web Audio 的字节数组同构（0~255；波形 128 为中轴），
 * 方便以后接"浏览器本地分析"数据源，渲染器不用改。
 */
const SPECTRUM_BINS = 64;
const WAVEFORM_POINTS = 256;
/** 频谱/波形推送间隔：10Hz —— 大帧比电平慢一档，省链路 */
const VIZ_INTERVAL_MS = 100;
/** 服务端侧协议层心跳巡检（ws ping，浏览器会自动回 pong，对前端透明） */
const SERVER_PING_MS = 30_000;
const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const log = (...args) => console.log('[gateway]', ...args);

// ── 设备模型（内存态，进程重启即重置） ─────────────────────────
let bootSeq = 0;
const makeBootId = () => `b${(++bootSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const devices = new Map();
for (let i = 1; i <= DEVICE_COUNT; i += 1) {
  const id = `dev-${String(i).padStart(3, '0')}`;
  // 每 3 台混一台 8 进 8 出的机型 —— 方便在界面上一眼看出「通道数跟设备走」
  const spec = i % 3 === 0 ? MODELS[1] : MODELS[0];
  devices.set(id, {
    deviceId: id,
    name: `DSP-${String(i).padStart(2, '0')}`,
    model: spec.model,
    online: true,
    bootId: makeBootId(),
    fw: '1.4.2',
    channels: Array.from({ length: spec.channels }, (_, k) => ({
      ch: k + 1,
      level: LEVEL_NO_SIGNAL,
      muted: false,
      gain: 0,
      /** 内部字段：信号基准（dB×10），模拟连续信号用，**不进入协议** */
      base: -240 - Math.random() * 200,
    })),
  });
}

/** 出协议前显式挑字段：内部字段（base）绝不外泄（协议字段白名单） */
const cloneChannel = (c) => ({ ch: c.ch, level: c.level, muted: c.muted, gain: c.gain });
const cloneDevice = (d) => ({ ...d, channels: d.channels.map(cloneChannel) });
const snapshot = () => [...devices.values()].map(cloneDevice);

// ── 故障注入状态 ───────────────────────────────────────────────
const chaosState = { noAck: false };

// ── REST（Express） ────────────────────────────────────────────
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

/** REST 快照：重连对齐 / 冷启动用（"控制面走 REST"的分工） */
app.get('/api/devices', (_req, res) => res.json(snapshot()));
app.get('/api/chaos', (_req, res) => res.json(chaosState));

app.post('/api/chaos/:name', (req, res) => {
  const name = req.params.name;
  const clients = [...wss.clients];

  switch (name) {
    case 'drop': {
      // 优雅断开：发关闭帧 → 浏览器 onclose(code=1001) → 前端退避重连
      for (const c of clients) c.close(1001, 'server going away');
      log(`chaos/drop：优雅断开 ${clients.length} 个连接`);
      return res.send(`已优雅断开 ${clients.length} 个连接（code=1001）`);
    }
    case 'half-open': {
      // 直接销毁 socket，不发关闭帧 —— 本地最接近"拔网线"的复现手段。
      // 前端 readyState 会短暂停在 OPEN，只能靠应用层心跳发现假死。
      for (const c of clients) c.terminate();
      log(`chaos/half-open：强制销毁 ${clients.length} 个连接（无关闭帧）`);
      return res.send(`已强制销毁 ${clients.length} 个连接（观察心跳判死）`);
    }
    case 'dirty': {
      // 非 JSON：内核层 core:parse-error 丢弃
      for (const c of clients) c.send('{"type":"meters", broken json');
      log('chaos/dirty：推送非 JSON 帧');
      return res.send('已推送非 JSON 帧（前端内核层丢弃并计数）');
    }
    case 'invalid': {
      // 合法 JSON、结构非法：协议插件 protocol:invalid 拦下
      for (const c of clients) c.send(JSON.stringify({ type: 'meters', ts: Date.now() }));
      log('chaos/invalid：推送结构非法消息');
      return res.send('已推送结构非法消息（协议插件拦下）');
    }
    case 'no-ack': {
      chaosState.noAck = true;
      log('chaos/no-ack：指令不再回 ack');
      return res.send('已开启 no-ack：观察前端 3s 超时 → 重发 ×3');
    }
    case 'restore': {
      chaosState.noAck = false;
      return res.send('已恢复');
    }
    default:
      return res.status(404).send(`未知故障：${name}`);
  }
});

// ── HTTP + WebSocket 同端口 ────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  // Origin 校验：只防"浏览器里的恶意页面"，不防 curl/自写客户端（那要靠 token）
  if (origin && !ALLOWED_ORIGIN.test(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    log(`拒绝 upgrade：非法 Origin ${origin}`);
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function ack(ws, seq, ok, extra = {}) {
  send(ws, { type: 'ack', ts: Date.now(), payload: { seq, ok, ...extra } });
}

// ── 连接生命周期 ───────────────────────────────────────────────
wss.on('connection', (ws) => {
  log('客户端已连接 → 推送快照');
  ws.isAlive = true;
  ws.focusDeviceId = null; // 按需推送：聚焦哪台设备，才推它的频谱/波形
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  send(ws, { type: 'snapshot', ts: Date.now(), payload: { devices: snapshot() } });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // 前端不该发非法 JSON；忽略
    }
    handleMessage(ws, msg);
  });

  ws.on('close', (code) => log(`客户端断开 code=${code}`));
  ws.on('error', () => {});
});

function handleMessage(ws, msg) {
  // 故障注入：no-ack 模式下吞掉所有非心跳指令（心跳必须留，否则连接会假死）
  if (msg.type !== 'ping' && chaosState.noAck) {
    log(`no-ack 生效：吞掉 ${msg.type}（seq=${msg.seq}）`);
    return;
  }

  switch (msg.type) {
    case 'ping':
      send(ws, { type: 'pong', ts: Date.now(), payload: { echo: msg.payload?.echo ?? 0 } });
      break;

    case 'subscribe':
      ack(ws, msg.seq, true);
      break;

    case 'focus':
      // 高频大帧按需推送：只推被聚焦的那台设备
      // （16 通道电平是"全设备总览"，小且必须，仍全推）
      ws.focusDeviceId = msg.payload?.deviceId ?? null;
      log(`focus → ${ws.focusDeviceId ?? '(无)'}（开始/停止推送该设备频谱与波形）`);
      break;

    case 'setMuted': {
      const d = devices.get(msg.payload?.deviceId);
      const ch = d?.channels[(msg.payload?.ch ?? 0) - 1];
      if (!d || !ch) {
        return ack(ws, msg.seq, false, {
          code: 1002,
          msg: 'device/channel not found',
          retryable: false,
        });
      }
      ch.muted = Boolean(msg.payload.muted);
      if (ch.muted) ch.level = LEVEL_NO_SIGNAL;
      ack(ws, msg.seq, true, { applied: ch.muted ? 1 : 0 }); // read-back
      send(ws, { type: 'state', ts: Date.now(), payload: { device: cloneDevice(d) } });
      break;
    }

    case 'setLevel': {
      const d = devices.get(msg.payload?.deviceId);
      const ch = d?.channels[(msg.payload?.ch ?? 0) - 1];
      if (!d || !ch) {
        return ack(ws, msg.seq, false, { code: 1002, msg: 'device/channel not found' });
      }
      const clamped = Math.max(-600, Math.min(0, Math.round(Number(msg.payload.level) || 0)));
      ch.level = clamped;
      ack(ws, msg.seq, true, { applied: clamped });
      send(ws, { type: 'state', ts: Date.now(), payload: { device: cloneDevice(d) } });
      break;
    }

    default:
      send(ws, {
        type: 'error',
        ts: Date.now(),
        payload: { code: 4000, msg: `unknown message type: ${msg.type}`, retryable: false },
      });
  }
}

// ── 高频计量推送：20Hz 批量（一条消息带全部设备 × 16 通道） ────
let metersSeq = 0;
setInterval(() => {
  if (wss.clients.size === 0) return;
  metersSeq += 1;

  const batch = [];
  for (const d of devices.values()) {
    for (const c of d.channels) {
      if (c.muted || !d.online) {
        c.level = LEVEL_NO_SIGNAL;
        continue;
      }
      // 连续信号模型：基准慢速游走 + 小噪声 + 偶发瞬态。
      // ⚠️ 不要每 50ms 独立重采样 —— 那样相邻采样点能差 20dB，
      //    前端就算插值也救不回来（观感是"抖动"而不是"流动"）。
      // 目标：相邻点平均差 < 1dB；瞬态（2% 概率）允许 4~8dB，那是真实信号该有的起伏。
      c.base += (Math.random() - 0.5) * 10;
      if (Math.random() < 0.02) c.base += (Math.random() - 0.5) * 80; // 瞬态
      c.base = Math.max(-560, Math.min(-40, c.base));
      c.level = Math.round(Math.max(-600, Math.min(0, c.base + (Math.random() - 0.5) * 14)));
    }
    batch.push({ deviceId: d.deviceId, levels: d.channels.map((c) => c.level) });
  }

  const frame = JSON.stringify({
    type: 'meters',
    ts: Date.now(),
    seq: metersSeq,
    payload: { devices: batch },
  });

  for (const c of wss.clients) {
    if (c.readyState === c.OPEN) c.send(frame);
  }
}, METER_INTERVAL_MS);

// ── 频谱 / 波形：只推给"聚焦了设备"的连接（按需推送） ──────────
setInterval(() => {
  if (wss.clients.size === 0) return;
  const t = Date.now() / 1000;

  for (const client of wss.clients) {
    const deviceId = client.focusDeviceId;
    if (!deviceId || client.readyState !== client.OPEN) continue;
    const device = devices.get(deviceId);
    if (!device) continue;

    const silent = device.channels.every((c) => c.muted);
    send(client, {
      type: 'spectrum',
      ts: Date.now(),
      payload: { deviceId, bins: makeSpectrum(deviceId, t, silent) },
    });
    send(client, {
      type: 'waveform',
      ts: Date.now(),
      payload: { deviceId, samples: makeWaveform(deviceId, t, silent) },
    });
  }
}, VIZ_INTERVAL_MS);

/** 设备 id → 稳定种子：让每台设备的频谱/波形"长得不一样" */
function seedOf(id) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * 模拟频谱：低频能量高、高频衰减（粉红噪声感）+ 随时间起伏。
 * 真实设备里这是 DSP 的 FFT 结果 —— 前端只管画，不算。
 */
function makeSpectrum(deviceId, t, silent) {
  const seed = seedOf(deviceId);
  const bins = new Array(SPECTRUM_BINS);
  for (let i = 0; i < SPECTRUM_BINS; i += 1) {
    if (silent) {
      bins[i] = 0;
      continue;
    }
    const f = i / SPECTRUM_BINS;
    const tilt = (1 - f) ** 1.5; // 低频高、高频低
    const wobble = 0.55 + 0.45 * Math.sin(t * 1.6 + f * 11 + seed);
    const noise = 0.85 + Math.random() * 0.15;
    bins[i] = Math.round(255 * Math.min(1, tilt * wobble * noise * 1.25));
  }
  return bins;
}

/**
 * 模拟波形：多个正弦叠加 + 相位随时间推进（看起来像在滚动的音频波形）。
 * 0~255、128 为中线 —— 与 Web Audio `getByteTimeDomainData()` 同构。
 */
function makeWaveform(deviceId, t, silent) {
  const seed = seedOf(deviceId);
  const out = new Array(WAVEFORM_POINTS);
  const cycles = 2 + (seed % 3);
  const phase = t * 6;
  for (let i = 0; i < WAVEFORM_POINTS; i += 1) {
    if (silent) {
      out[i] = 128;
      continue;
    }
    const x = (i / WAVEFORM_POINTS) * Math.PI * 2 * cycles;
    const v =
      Math.sin(x + phase) * 0.62 +
      Math.sin(x * 2.3 + phase * 1.7) * 0.24 +
      Math.sin(x * 5.1 + phase * 0.7) * 0.1;
    out[i] = Math.round(128 + Math.max(-1, Math.min(1, v)) * 110);
  }
  return out;
}

// ── 服务端侧巡检：协议层 ping（客户端不回 pong 则终止） ────────
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      log('服务端巡检：未收到 pong → terminate');
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, SERVER_PING_MS);

server.listen(PORT, () => {
  log(`WebSocket   ws://localhost:${PORT}/ws`);
  log(`REST 快照   http://localhost:${PORT}/api/devices`);
  log(`故障注入    POST http://localhost:${PORT}/api/chaos/{drop|half-open|dirty|invalid|no-ack|restore}`);
});

process.on('SIGINT', () => {
  log('退出');
  process.exit(0);
});
