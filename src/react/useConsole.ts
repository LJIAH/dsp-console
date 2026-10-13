/**
 * React 适配层：把插件化客户端接到组件生命周期上
 *
 * 三条纪律：
 *   1. hook 里绝不 new 连接 —— 应用级单例 + 惰性初始化（N 个组件 = N 条连接 = N 套心跳）；
 *   2. 高频数据（电平 20Hz × 16 通道、频谱/波形 10Hz）**不进 React 状态** ——
 *      直写 ref/store，由全局 rAF 循环直读（连"rAF 攒批"都省了，一次 React 渲染都不发生）；
 *   3. 连接状态/指标走 useSyncExternalStore（"值"的通道）；
 *      业务消息用事件订阅（"事件"的通道），两条通道分开。
 *
 * 可视化有**两条数据源**，在管线里长得一模一样（都是 FrameSource）：
 *   device → 设备 DSP 算好、网关推来（音频流不经过浏览器：只能"可视化"）
 *   local  → Web Audio 本地分析（音频进了浏览器：这才叫"分析"）
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { WSCore } from '../core/ws-core';
import { GATEWAY_HTTP, assembleFull } from '../assembly/profiles';
import { LEVEL_NO_SIGNAL, clientPolicy, cmd } from '../protocol';
import type { AckPayload, Device } from '../protocol';
import { registerRenderLoop } from '../viz/raf-loop';
import type { MetricsSnapshot } from '../plugins/observability';
import { LatestStore } from '../viz/store';
import { createWsFrameSource } from '../viz/sources/ws-source';
import { AudioEngine } from '../viz/sources/web-audio-engine';
import {
  createWebAudioSpectrumSource,
  createWebAudioWaveformSource,
} from '../viz/sources/web-audio-source';
import { createSpectrumRenderer } from '../viz/renderers/spectrum';
import { createWaveformRenderer } from '../viz/renderers/waveform';
import type { Renderer, SpectrumFrame, WaveformFrame } from '../viz/types';

/** 应用级单例 —— 惰性初始化，模块级持有（不挂 window） */
let singleton: WSCore | null = null;
function getClient(): WSCore {
  if (!singleton) {
    singleton = assembleFull();
    singleton.start();
  }
  return singleton;
}

/** 高频电平的存放处：deviceId → 16 通道的线上定点值 */
export type MetersStore = Map<string, number[]>;
export interface MetersStoreRef {
  current: MetersStore;
}

/** viz 单例：renderer 是无状态绘制器，store 只保留最新帧 —— 三者都不进 React */
const spectrumStore = new LatestStore<SpectrumFrame>();
const waveformStore = new LatestStore<WaveformFrame>();
const spectrumRenderer = createSpectrumRenderer();
const waveformRenderer = createWaveformRenderer();
const audioEngine = new AudioEngine();

export type HotPathMode = 'ref' | 'state';
export type VizSourceKind = 'device' | 'local';

/**
 * 本地分析模式下的「虚拟设备 id」。
 * Web Audio 同样能出电平（RMS → dBFS），只是要以设备的形式塞进同一张
 * meters 表 —— 这样整块电平表、通道带、Mute 逻辑都不用为它开一条件。
 */
export const LOCAL_METER_ID = '__local__';

/** 本地分析虚拟设备的通道数：与本地音频的声道结构对齐（L / R 两路计量） */
export const LOCAL_METER_CHANNELS = 2;

/** 拖动预览的发送节流（ms）：本地 UI 每帧跟随，网络最多 ~16 条/秒（constants.json 的 client.preview） */
const PREVIEW_THROTTLE_MS = clientPolicy.preview.throttleMs;

/** 等权威值回来的兜底时长（ms）：state 丢了也不能让推子永远冻在乐观值上 */
const GAIN_CONFIRM_TIMEOUT_MS = clientPolicy.preview.confirmTimeoutMs;

export interface AudioUiState {
  fileName: string | null;
  duration: number;
  playing: boolean;
  position: number;
  /** 监听开关：默认静默分析（演示时不至于突然外放） */
  monitor: boolean;
}

export interface UseConsoleResult {
  client: WSCore;
  metrics: MetricsSnapshot;
  devices: Device[];
  metersRef: MetersStoreRef;
  /** 高频通道模式：ref = 零 React 渲染；state = 每条消息 setState（对照组） */
  hotPath: HotPathMode;
  setHotPath: (m: HotPathMode) => void;
  selectedId: string | null;
  select: (id: string) => void;
  setMuted: (deviceId: string, ch: number, muted: boolean) => Promise<AckPayload>;
  setLevel: (deviceId: string, ch: number, level: number) => Promise<AckPayload>;
  /** 增益预览的乐观值（拖动中）：key = `deviceId:ch`，同一时刻只会有一个 */
  gainDraft: { key: string; value: number } | null;
  /** 拖动中调用：本地立即跟随 + 节流发「可丢预览指令」 */
  previewGain: (deviceId: string, ch: number, gain: number) => void;
  /** 松手/键盘调整后调用：发「可靠定值指令」并等待 ack */
  commitGain: (deviceId: string, ch: number, gain: number) => Promise<AckPayload>;
  chaos: (name: string) => Promise<string>;
  reconnectInfo: () => ReturnType<WSCore['getReconnectInfo']>;
  /** 频谱 / 波形：帧存储与渲染器（交给 VizCanvas） */
  spectrumStore: LatestStore<SpectrumFrame>;
  waveformStore: LatestStore<WaveformFrame>;
  spectrumRenderer: Renderer<SpectrumFrame>;
  waveformRenderer: Renderer<WaveformFrame>;
  /** 数据源切换：设备推送 / 浏览器本地分析 */
  vizSource: VizSourceKind;
  setVizSource: (kind: VizSourceKind) => void;
  /** 电平表的数据目标（已按数据源合成：本地分析 → 虚拟设备） */
  meterTarget: string | null;
  /** 本地音频播放控制 */
  audio: AudioUiState;
  loadAudioFile: (file: File) => Promise<void>;
  /** 载入内置示例音频（面试演示时不用现找文件） */
  loadSampleAudio: () => Promise<void>;
  toggleAudioPlay: () => void;
  toggleMonitor: () => void;
}

export function useConsole(): UseConsoleResult {
  const client = getClient();

  // ── "值"通道：连接状态与指标 ────────────────────────────────
  const metrics = useSyncExternalStore(
    (cb) => client.subscribeMetrics(cb),
    () => client.getMetrics(),
  );

  // ── 低频业务状态：设备清单（snapshot / state 消息驱动） ──────
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ── 高频数据：电平直写 ref，Canvas 直读 ─────────────────────
  const metersRef = useRef<MetersStore>(new Map()) as MetersStoreRef;
  const [hotPath, setHotPath] = useState<HotPathMode>('ref');
  const hotPathRef = useRef<HotPathMode>('ref');
  hotPathRef.current = hotPath;
  const [, forceTick] = useState(0); // 对照组：让每条 meters 触发一次渲染

  useEffect(() => {
    const offs = [
      client.on('session:snapshot', ({ devices: list }: { devices: Device[] }) => {
        setDevices(list);
        for (const d of list) {
          metersRef.current.set(
            d.deviceId,
            d.channels.map((c) => c.level),
          );
        }
      }),
      client.on(
        'meters',
        ({ devices: batch }: { devices: { deviceId: string; levels: number[] }[] }) => {
          for (const item of batch) {
            metersRef.current.set(item.deviceId, item.levels);
          }
          // 对照组：把高频数据塞进 React 状态，观察渲染开销（现场 A/B 演示点）
          if (hotPathRef.current === 'state') forceTick((n) => n + 1);
        },
      ),
      client.on('state', ({ device }: { device: Device }) => {
        setDevices((prev) => {
          const next = prev.slice();
          const i = next.findIndex((d) => d.deviceId === device.deviceId);
          if (i >= 0) next[i] = device;
          else next.push(device);
          return next;
        });
      }),
      client.on('session:snapshot-failed', ({ msg }: { msg: string }) => {
        console.warn('[console] 快照对齐失败：', msg);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [client, metersRef]);

  // ── 数据源切换：换订阅，不换 store 与 renderer ───────────────
  const [vizSource, setVizSource] = useState<VizSourceKind>('device');

  useEffect(() => {
    // 清掉上一源的残留帧，否则切换瞬间还会画着旧数据
    spectrumStore.clear();
    waveformStore.clear();

    if (vizSource === 'device') {
      const offSpectrum = createWsFrameSource<SpectrumFrame>(client, 'spectrum', (p) => ({
        ts: Date.now(),
        bins: p.bins as number[],
      })).subscribe((f) => spectrumStore.push(f));

      const offWaveform = createWsFrameSource<WaveformFrame>(client, 'waveform', (p) => ({
        ts: Date.now(),
        samples: p.samples as number[],
      })).subscribe((f) => waveformStore.push(f));

      return () => {
        offSpectrum();
        offWaveform();
      };
    }

    const offSpectrum = createWebAudioSpectrumSource(audioEngine).subscribe((f) =>
      spectrumStore.push(f),
    );
    const offWaveform = createWebAudioWaveformSource(audioEngine).subscribe((f) =>
      waveformStore.push(f),
    );
    return () => {
      offSpectrum();
      offWaveform();
    };
  }, [vizSource, client]);

  // ── 本地分析：把 AnalyserNode 算出的电平写进同一张 meters 表 ──
  // key 是虚拟设备 id，所以 MeterCanvas / 通道带一行都不用改。
  useEffect(() => {
    if (vizSource !== 'local') return;

    const levels = new Array<number>(LOCAL_METER_CHANNELS).fill(LEVEL_NO_SIGNAL);
    return registerRenderLoop(() => {
      if (!audioEngine.loaded) return;
      if (audioEngine.playing) {
        const channels = audioEngine.readChannelLevels();
        for (let i = 0; i < LOCAL_METER_CHANNELS; i += 1) {
          levels[i] = channels[i] ?? LEVEL_NO_SIGNAL;
        }
      } else {
        // 暂停 = 没信号：电平归零，比"冻住上一帧"更符合直觉
        levels.fill(LEVEL_NO_SIGNAL);
      }
      metersRef.current.set(LOCAL_METER_ID, levels);
    });
  }, [vizSource, metersRef]);

  // 默认选中第一台
  useEffect(() => {
    if (!selectedId && devices.length > 0) setSelectedId(devices[0].deviceId);
  }, [devices, selectedId]);

  // ── 聚焦：网关只给被聚焦的设备推频谱/波形（按需推送） ────────
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selectedId;
    // 本地分析模式下不需要设备帧 → focus(null)，省链路
    client.send(cmd.focus(vizSource === 'device' ? selectedId : null));
  }, [selectedId, vizSource, client]);

  useEffect(() => {
    // 服务端不保留任何"关系"（和订阅一样）：重连后必须重发，
    // 否则频谱/波形会静默停更 —— 这是最容易漏的一类"重连后恢复现场"
    return client.on('reconnect:opened', () => {
      client.send(cmd.focus(vizSource === 'device' ? selectedRef.current : null));
    });
  }, [client, vizSource]);

  // ── 本地音频（Web Audio）：文件选择 / 播放 / 监听 ────────────
  const [audio, setAudio] = useState<AudioUiState>({
    fileName: null,
    duration: 0,
    playing: false,
    position: 0,
    monitor: true, // 默认外放（与 AudioEngine 的默认一致）
  });

  const loadAudioFile = useCallback(async (file: File) => {
    // ⚠️ 必须在用户手势的调用链里（input change 算），否则 AudioContext 起不来
    await audioEngine.load(file);
    setAudio({
      fileName: file.name,
      duration: audioEngine.duration,
      playing: false,
      position: 0,
      monitor: audioEngine.monitoring,
    });
  }, []);

  const loadSampleAudio = useCallback(async () => {
    const res = await fetch('/samples/demo-tone.wav');
    if (!res.ok) throw new Error(`示例音频加载失败：HTTP ${res.status}`);
    const blob = await res.blob();
    await loadAudioFile(new File([blob], 'demo-tone.wav', { type: 'audio/wav' }));
  }, [loadAudioFile]);

  const toggleAudioPlay = useCallback(() => {
    if (audioEngine.playing) audioEngine.pause();
    else audioEngine.play();
    setAudio((s) => ({ ...s, playing: audioEngine.playing, position: audioEngine.position }));
  }, []);

  const toggleMonitor = useCallback(() => {
    const next = !audioEngine.monitoring;
    audioEngine.setMonitor(next);
    setAudio((s) => ({ ...s, monitor: next }));
  }, []);

  // 播放进度：250ms 刷新一次（低频 UI 状态，不碰高频管线）
  useEffect(() => {
    if (!audio.playing) return;
    const t = setInterval(() => {
      setAudio((s) => ({ ...s, position: audioEngine.position, playing: audioEngine.playing }));
    }, 250);
    return () => clearInterval(t);
  }, [audio.playing]);

  // ── 指令：可靠通道（seq + ack + 重发） ──────────────────────
  const setMuted = useCallback(
    (deviceId: string, ch: number, muted: boolean) =>
      client.sendCommand((seq) => cmd.setMuted(seq, deviceId, ch, muted)),
    [client],
  );

  const setLevel = useCallback(
    (deviceId: string, ch: number, level: number) =>
      client.sendCommand((seq) => cmd.setLevel(seq, deviceId, ch, level)),
    [client],
  );

  // ── 增益滑块：拖动走「可丢预览」，松手走「可靠定值」 ──────────
  // 教学版那个 Demo 的坑就是 onInput 直接发可靠指令：拖 1 秒 = 60 条指令 +
  // 60 个 pending 各自等 3s 超时重发。这里把它拆成两条通道。
  const [gainDraft, setGainDraft] = useState<{ key: string; value: number } | null>(null);
  const lastPreviewAt = useRef(0);
  /** 权威值快照：commit 时记下"改之前是多少"，用来判断服务端 state 到没到 */
  const devicesRef = useRef<Device[]>([]);
  devicesRef.current = devices;
  /**
   * 松手后的「待确认目标」。
   * ⚠️ 乐观值的生命周期是**权威值追上**为止，而不是"松手"为止 ——
   * 松手立刻清 draft 会闪回旧值（服务端 state 还在路上），
   * 用户看到的就是"弹回去、再跳出来"。
   */
  const gainTargetRef = useRef<{ key: string; value: number; before?: number } | null>(null);
  const gainClearTimer = useRef<number | null>(null);

  const releaseGainDraft = useCallback((key: string) => {
    if (gainTargetRef.current?.key === key) gainTargetRef.current = null;
    if (gainClearTimer.current !== null) {
      window.clearTimeout(gainClearTimer.current);
      gainClearTimer.current = null;
    }
    setGainDraft((d) => (d?.key === key ? null : d));
  }, []);

  const previewGain = useCallback(
    (deviceId: string, ch: number, gain: number) => {
      const key = `${deviceId}:${ch}`;
      // 用户又动手了：任何"待确认"都作废 —— 这次拖动才是最新意图。
      // ⚠️ 不能只在 key 不同时才清：松手后**立刻再拖同一路**时 key 相同，
      //    上一轮的待确认状态会一直活到 state 到达，然后把正在拖的推子拽走
      //    —— 这就是"我滑的时候被弹回去"。
      if (gainTargetRef.current) {
        if (gainClearTimer.current !== null) window.clearTimeout(gainClearTimer.current);
        gainClearTimer.current = null;
        gainTargetRef.current = null;
      }
      // 本地 UI 每帧跟随（乐观值），网络侧节流到 ~16 条/秒
      setGainDraft({ key, value: gain });
      const now = performance.now();
      if (now - lastPreviewAt.current < PREVIEW_THROTTLE_MS) return;
      lastPreviewAt.current = now;
      client.send(cmd.setGainPreview(deviceId, ch, gain));
    },
    [client],
  );

  const commitGain = useCallback(
    async (deviceId: string, ch: number, gain: number) => {
      const key = `${deviceId}:${ch}`;
      const before = devicesRef.current.find((d) => d.deviceId === deviceId)?.channels[ch - 1]
        ?.gain;
      // 乐观值继续留着，等服务端 state 到达（或超时兜底）再交还权威值
      gainTargetRef.current = { key, value: gain, before };
      if (gainClearTimer.current !== null) window.clearTimeout(gainClearTimer.current);
      gainClearTimer.current = window.setTimeout(() => {
        releaseGainDraft(key);
      }, GAIN_CONFIRM_TIMEOUT_MS);

      try {
        const res = await client.sendCommand((seq) => cmd.setGain(seq, deviceId, ch, gain));
        // 设备明确拒绝时"弹回"才是正确的 —— 指令确实没生效
        if (!res.ok) releaseGainDraft(key);
        return res;
      } catch (err) {
        // 超时 / 断线：回滚乐观值，并把失败**作为返回值**交出去。
        // ⚠️ 不要 throw —— UI 的 onCommit 是同步调用点，throw 会变成 unhandled
        // rejection：用户只在控制台看到一行红字，界面上反而没有任何反馈。
        releaseGainDraft(key);
        return { seq: 0, ok: false, msg: err instanceof Error ? err.message : String(err) };
      }
    },
    [client, releaseGainDraft],
  );

  // 权威值到达 → 交还控制权。这一步就是"松手不闪回"的关键。
  useEffect(() => {
    const target = gainTargetRef.current;
    if (!target) return;
    const [deviceId, chStr] = target.key.split(':');
    const authority = devices.find((d) => d.deviceId === deviceId)?.channels[Number(chStr) - 1]
      ?.gain;
    if (authority === undefined) return;
    // 追上目标（正常路径），或已被设备改成别的值（clamp / 他人改动）→ 本轮结束
    if (Math.abs(authority - target.value) < 1e-6 || authority !== target.before) {
      releaseGainDraft(target.key);
    }
  }, [devices, releaseGainDraft]);

  // ── 故障注入（走网关 REST，前端只是按钮） ───────────────────
  const chaos = useCallback(async (name: string) => {
    const res = await fetch(`${GATEWAY_HTTP}/api/chaos/${name}`, { method: 'POST' });
    return res.text();
  }, []);

  const reconnectInfo = useCallback(() => client.getReconnectInfo(), [client]);

  /** 电平表的取数目标：本地分析看「虚拟设备」，否则看选中设备 */
  const meterTarget = vizSource === 'local' ? LOCAL_METER_ID : selectedId;

  return {
    client,
    metrics,
    devices,
    metersRef,
    hotPath,
    setHotPath,
    selectedId,
    select: setSelectedId,
    setMuted,
    setLevel,
    gainDraft,
    previewGain,
    commitGain,
    chaos,
    reconnectInfo,
    spectrumStore,
    waveformStore,
    spectrumRenderer,
    waveformRenderer,
    vizSource,
    setVizSource,
    meterTarget,
    audio,
    loadAudioFile,
    loadSampleAudio,
    toggleAudioPlay,
    toggleMonitor,
  };
}
