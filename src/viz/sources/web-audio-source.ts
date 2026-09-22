/**
 * 把「拉取型」的 Web Audio 引擎桥接成「推送型」FrameSource
 *
 * 引擎是按帧 `read()` 的（analyser 每次读取给的是"此刻"的快照），
 * 而管线要的是 `subscribe(cb)` —— 中间用**全局 rAF 循环**桥接：
 * 每帧读一次、推一帧。不额外起循环，和 canvas 共用同一个调度器。
 *
 * 于是"两条数据源"在管线里长得一模一样：
 *   ws-source      （设备推送）  ─┐
 *                                 ├─→ LatestStore → Renderer
 *   web-audio-source（本地分析） ─┘
 * 渲染器完全不知道数据从哪来 —— 这就是当初把 Frame 设计成
 * 与 Web Audio 字节数组同构的回报。
 */
import { registerRenderLoop } from '../raf-loop';
import type { AudioEngine } from './web-audio-engine';
import type { FrameSource, SpectrumFrame, WaveformFrame } from '../types';

export function createWebAudioSpectrumSource(engine: AudioEngine): FrameSource<SpectrumFrame> {
  return {
    name: 'webaudio:spectrum',
    subscribe(cb) {
      return registerRenderLoop(() => {
        if (!engine.loaded) return;
        // 暂停时冻结画面（不读 = 保持最后一帧），符合"暂停"的直觉
        if (!engine.playing) return;
        cb({ ts: Date.now(), bins: engine.readSpectrum() });
      });
    },
  };
}

export function createWebAudioWaveformSource(engine: AudioEngine): FrameSource<WaveformFrame> {
  return {
    name: 'webaudio:waveform',
    subscribe(cb) {
      return registerRenderLoop(() => {
        if (!engine.loaded || !engine.playing) return;
        cb({ ts: Date.now(), samples: engine.readWaveform() });
      });
    },
  };
}
