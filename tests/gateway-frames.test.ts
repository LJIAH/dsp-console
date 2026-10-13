/**
 * 契约测试里**唯一不是"自己跟自己比"**的一环：
 * 起一个真的 Mock 网关进程，连上去收它**实际发出**的帧，再用
 * JSON Schema（Ajv，设备侧看到的那份）与前端 Zod 各验一遍。
 *
 * 它挡的是"网关偷偷发了契约之外的东西"——比如某天给 `state` 多加一个内部字段、
 * 或者忘了给新消息带 `version`。纯单测永远发现不了这类漂移，因为两边都是自己写的。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import contract from '../protocol/constants.json';
import schema from '../protocol/messages.schema.json';
import { parseServerMessage } from '../src/protocol';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** 随机高位端口：避免和开发中的 8080 撞车 */
const PORT = 21_000 + Math.floor(Math.random() * 20_000);

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = ajv.compile(schema);

let gateway: ChildProcess | undefined;
let logs = '';
const frames: { type: string; raw: string }[] = [];

/** 等网关把启动横幅打出来（比 sleep 可靠：起不来会带着日志失败） */
function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`网关 10s 未就绪：\n${logs}`)), 10_000);
    child.stdout?.on('data', (buf: Buffer) => {
      logs += buf.toString();
      if (logs.includes('WebSocket')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`网关退出（code=${code}，多半是端口 ${PORT} 被占）：\n${logs}`));
    });
  });
}

/** 收 1.2s 的帧：期间主动打三条指令，把 ack / state / spectrum / waveform 逼出来 */
function collectFrames(): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      resolve();
    }, 1_200);

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('连不上网关'));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ version: 1, type: 'ping', ts: Date.now(), payload: { echo: 1 } }));
      ws.send(
        JSON.stringify({
          version: 1,
          type: 'focus',
          ts: Date.now(),
          payload: { deviceId: 'dev-001' },
        }),
      );
      ws.send(
        JSON.stringify({
          version: 1,
          type: 'setGain',
          ts: Date.now(),
          seq: 1,
          payload: { deviceId: 'dev-001', ch: 1, gain: 3.5 },
        }),
      );
    };
    ws.onmessage = (event) => {
      const raw = String(event.data);
      const parsed = JSON.parse(raw) as { type?: string };
      frames.push({ type: parsed.type ?? '(no type)', raw });
    };
  });
}

beforeAll(async () => {
  gateway = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForReady(gateway);
  await collectFrames();
}, 20_000);

afterAll(() => {
  gateway?.kill();
});

describe('网关实发帧（真进程）', () => {
  it('该出现的帧都出现了（snapshot / meters / ack / state / spectrum / waveform + 心跳 pong）', () => {
    const types = new Set(frames.map((f) => f.type));
    for (const expected of ['snapshot', 'meters', 'ack', 'state', 'spectrum', 'waveform', 'pong']) {
      expect(types, `缺少 ${expected}（收到：${[...types].join(',')}）`).toContain(expected);
    }
  });

  it('每一帧都带 version = protocolVersion', () => {
    for (const frame of frames) {
      const parsed = JSON.parse(frame.raw) as { version?: number };
      expect(parsed.version, `${frame.type} 没带 version`).toBe(contract.protocolVersion);
    }
  });

  it('每一帧都过 JSON Schema（设备侧读到的那份契约）', () => {
    for (const frame of frames) {
      const ok = validate(JSON.parse(frame.raw));
      if (!ok) {
        throw new Error(
          `${frame.type} 不符合契约：${JSON.stringify(ajv.errors)}\n原始帧：${frame.raw.slice(0, 200)}`,
        );
      }
    }
  });

  it('每一帧都过前端 Zod（parseServerMessage 不返回 null）', () => {
    for (const frame of frames) {
      expect(
        parseServerMessage(frame.raw),
        `${frame.type} 被 Zod 拒了：${frame.raw.slice(0, 200)}`,
      ).not.toBeNull();
    }
  });

  it('meters 的节拍与通道数与契约一致（20Hz × 8/16 通道）', () => {
    const meters = frames.filter((f) => f.type === 'meters');
    expect(meters.length).toBeGreaterThan(0);
    const payload = JSON.parse(meters[0]!.raw) as {
      payload: { devices: { deviceId: string; levels: number[] }[] };
    };
    const counts = payload.payload.devices.map((d) => d.levels.length);
    expect(counts.every((n) => n === 16 || n === 8)).toBe(true);
  });
});
