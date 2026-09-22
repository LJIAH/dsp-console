/**
 * 频谱柱状图渲染器
 *
 * 关键行为：**立即上升、缓慢下落**（peak decay）
 *   频谱分析仪都是这么画的 —— 能量冲上来瞬间可见（瞬态不丢），
 *   回落慢一点让眼睛追得上。等价于音频域的 release 时间常数，
 *   与电平表的 attack/release 是同一套仪表语言。
 *
 * 数据源无关：bins 是 0~255 的字节值，设备推送和 Web Audio
 * `getByteFrequencyData()` 都能直接喂进来。
 */
import type { Renderer, SpectrumFrame } from '../types';
import { SPECTRUM_BINS } from '../../protocol';

/** 下落时间常数（ms）：越小掉得越快 */
const TAU_DECAY = 260;

export function createSpectrumRenderer(): Renderer<SpectrumFrame> {
  /** 每根柱的显示值（0~1），带衰减记忆 */
  const smooth = new Float32Array(SPECTRUM_BINS);

  let grad: CanvasGradient | null = null;
  let gradH = -1;
  let lastAt = 0;

  return {
    name: 'spectrum-bars',

    draw(ctx, frame, { w, h }) {
      const now = performance.now();
      const dt = lastAt === 0 ? 16 : Math.min(now - lastAt, 100);
      lastAt = now;
      // 帧率无关的衰减：k = e^(−dt/τ)，与电平表插值同源
      const decay = Math.exp(-dt / TAU_DECAY);

      // 垂直渐变（复用对象，尺幅变化才重建）
      if (!grad || gradH !== h) {
        grad = ctx.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, 'oklch(0.75 0.19 150)');
        grad.addColorStop(0.62, 'oklch(0.82 0.16 85)');
        grad.addColorStop(0.85, 'oklch(0.65 0.21 25)');
        gradH = h;
      }

      const gap = 1;
      const barW = Math.max((w - gap * (SPECTRUM_BINS - 1)) / SPECTRUM_BINS, 1);

      for (let i = 0; i < SPECTRUM_BINS; i += 1) {
        const target = frame ? (frame.bins[i] ?? 0) / 255 : 0;
        smooth[i] = Math.max(target, smooth[i] * decay);

        const value = smooth[i];
        if (value < 0.004) continue; // 太低不画，省 fillRect

        const x = i * (barW + gap);
        const barH = Math.max(value * h, 1);
        ctx.fillStyle = grad;
        ctx.fillRect(x, h - barH, barW, barH);
      }
    },
  };
}
