/**
 * 波形折线渲染器
 *
 * 数据：256 个采样点，0~255，128 = 零电平中轴。
 * 与 Web Audio 的 `getByteTimeDomainData()` 输出同构 ——
 * 所以"设备推送的降采样波形"和"浏览器本地分析的波形"共用这一个渲染器。
 *
 * ⚠️ 一个诚实的取舍：这里画的是**折线**。
 *    专业波形编辑器（Audition / iZotope）画的是**每像素列的 min/max 竖线**，
 *    因为当采样点远多于像素时，折线抽点会丢峰值（屏幕上看到的振幅比真实的小）。
 *    我们 256 点 / ~300px 宽 ≈ 每像素 1.2 点，折线足够；
 *    若点数上千，就该换成 min/max 抽稀 —— 这是"波形绘制"最有含量的一个知识点。
 */
import type { Renderer, WaveformFrame } from '../types';

export function createWaveformRenderer(): Renderer<WaveformFrame> {
  return {
    name: 'waveform-line',

    draw(ctx, frame, { w, h }) {
      const mid = h / 2;

      // 零电平中轴
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, mid + 0.5);
      ctx.lineTo(w, mid + 0.5);
      ctx.stroke();

      if (!frame || frame.samples.length < 2) return;

      const n = frame.samples.length;
      const amp = mid * 0.92;

      ctx.strokeStyle = 'oklch(0.78 0.13 210)';
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < n; i += 1) {
        const x = (i / (n - 1)) * w;
        const v = ((frame.samples[i] ?? 128) - 128) / 128;
        const y = mid - v * amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    },
  };
}
