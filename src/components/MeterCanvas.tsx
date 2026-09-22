/**
 * 通道电平表（Canvas 2D + 仪表动画）—— 竖排，调音台形态
 *
 * 结构：左侧一条**共用刻度轴**（dBFS），右侧 16 列电平条（CH1..CH16）。
 *   单位是 dBFS：数字域满刻度 0dB 在顶、-60dB 在底、无信号（-999 哨兵）为空槽。
 *   ⚠️ 0 在顶不是因为"刻度反了"——dB 是比值，数字域把满刻度定为 0 参考点，
 *      所以一切都是负数，往上长就是往 0 靠。
 *
 * ── 刻度为什么这么密/这么疏（dB 线性刻度） ─────────────────────
 *   映射是 `(db + 60) / 60` —— dB 值线性映射，所以 -60~-30 占了表高一半，
 *   高电平区（-6~0）被拉开。这是数字电平表的通行做法（dB-linear），
 *   好处是"接近削波"的区间看得清 —— 那正是最需要精确读数的地方。
 *   主刻度（标数值）挑间隔够的位置：0 / -6 / -12 / -24 / -40 / -60。
 *
 * ── 动画：为什么不用 CSS ────────────────────────────────────────
 *   Canvas 是一整张位图，没有 DOM 节点可挂 transition；
 *   而且电平表的"顺滑"有行业语义：上升快（attack，看清瞬态）、
 *   回落慢（release，来得及读数）、峰值保持（peak hold，抓住最高点）。
 *   插值系数用 dt 算（k = 1 − e^(−dt/τ)）→ 帧率无关，60Hz 与 120Hz 一致。
 */
import { useEffect, useRef } from 'react';
import type { MetersStoreRef } from '../react/useConsole';
import { LEVEL_MIN_DB10, LEVEL_NO_SIGNAL } from '../protocol';
import { registerRenderLoop } from '../viz/raf-loop';

interface Props {
  metersRef: MetersStoreRef;
  deviceId: string | null;
  channels: number;
}

/** 上升时间常数（ms）：快，保留瞬态 */
const TAU_ATTACK = 28;
/** 回落时间常数（ms）：慢，便于读数 */
const TAU_RELEASE = 280;
/** 峰值保持时长与回落时间常数 */
const PEAK_HOLD_MS = 1_200;
const TAU_PEAK_FALL = 420;

/**
 * 刻度轴宽度（px）—— ⚠️ 必须与 App.tsx 里按钮区的左侧内边距（pl-7.5 = 30px）
 * 保持一致，否则"表列 ↔ 按钮"不再逐列对齐。
 */
const AXIS_W = 30;

/** 刻度表：[dB, 是否标数值]。数值刻度挑间隔够的，避免文字打架 */
const TICKS: ReadonlyArray<readonly [number, boolean]> = [
  [0, true],
  [-3, false],
  [-6, true],
  [-9, false],
  [-12, true],
  [-18, false],
  [-24, true],
  [-30, false],
  [-40, true],
  [-50, false],
  [-60, true],
];

/** 警示区边界：-12dB 进入注意区（黄），-3dB 进入削波区（红） */
const WARN_LINES: ReadonlyArray<readonly [number, string]> = [
  [-12, 'rgba(234, 179, 8, 0.14)'],
  [-3, 'rgba(239, 68, 68, 0.18)'],
];

/** 线上定点值（dB×10）→ 0~1 显示值；-999 无信号 → 0 */
function norm(wire: number | undefined): number {
  if (wire === undefined || wire === LEVEL_NO_SIGNAL) return 0;
  return Math.min(1, Math.max(0, (wire - LEVEL_MIN_DB10) / -LEVEL_MIN_DB10));
}

export function MeterCanvas({ metersRef, deviceId, channels }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 仪表动画状态：显示值 / 峰值 / 峰值保持截止时间
    const disp = new Float32Array(channels);
    const peak = new Float32Array(channels);
    const holdUntil = new Float32Array(channels);

    let cssW = 0;
    let cssH = 0;

    // 复用渐变对象：尺幅变化时才重建（避免每帧 createLinearGradient）
    let meterGrad: CanvasGradient | null = null;
    let gradH = -1;

    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      cssW = rect.width;
      cssH = rect.height;
    });
    ro.observe(canvas);

    // 由全局单 rAF 循环驱动：dt 由调度器统一算好（同样做过夹取）
    const draw = (dt: number, now: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = cssW;
      const h = cssH;

      if (w > 0 && h > 0) {
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const plotX = AXIS_W;
        const plotW = w - plotX;
        const colW = plotW / channels;
        const barW = Math.max(colW - 6, 3);

        // ── 刻度轴（共用纵轴：16 列共用一条，避免每列都标数字） ──
        ctx.fillStyle = 'rgba(148, 163, 184, 0.04)';
        ctx.fillRect(0, 0, plotX, h);

        ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
        ctx.beginPath();
        ctx.moveTo(plotX - 0.5, 0);
        ctx.lineTo(plotX - 0.5, h);
        ctx.stroke();

        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const [db, labeled] of TICKS) {
          // 夹取 6px：0dB 与 -60dB 两个端点不让文字被画布边缘切掉
          const y = Math.min(Math.max(h - norm(db * 10) * h, 6), h - 6) + 0.5;
          ctx.strokeStyle = labeled
            ? 'rgba(148, 163, 184, 0.55)'
            : 'rgba(148, 163, 184, 0.28)';
          ctx.beginPath();
          ctx.moveTo(labeled ? plotX - 9 : plotX - 5, y);
          ctx.lineTo(plotX - 1, y);
          ctx.stroke();
          if (labeled) {
            ctx.fillStyle = 'rgba(148, 163, 184, 0.75)';
            ctx.fillText(String(db), plotX - 12, y);
          }
        }

        // 警示区边界（贯穿绘图区，便于跨列对齐）
        ctx.setLineDash([3, 4]);
        for (const [db, color] of WARN_LINES) {
          const y = Math.round(h - norm(db * 10) * h) + 0.5;
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.moveTo(plotX, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        // 条内渐变：底部绿 → -12dB 黄 → -3dB 红（停点与刻度严格对齐）
        if (!meterGrad || gradH !== h) {
          meterGrad = ctx.createLinearGradient(0, h, 0, 0);
          meterGrad.addColorStop(0, 'oklch(0.75 0.19 150)');
          meterGrad.addColorStop(norm(-120), 'oklch(0.82 0.16 85)');
          meterGrad.addColorStop(norm(-30), 'oklch(0.65 0.21 25)');
          gradH = h;
        }

        // 插值系数只跟 dt 有关 → 每帧算一次，全通道共用（省 32 次 exp/帧）
        const kUp = 1 - Math.exp(-dt / TAU_ATTACK);
        const kDown = 1 - Math.exp(-dt / TAU_RELEASE);
        const kPeak = 1 - Math.exp(-dt / TAU_PEAK_FALL);

        const levels = deviceId ? metersRef.current.get(deviceId) : undefined;

        for (let ch = 0; ch < channels; ch += 1) {
          const target = norm(levels?.[ch]);

          // 指数逼近：上升/回落用不同时间常数 → 仪表的"手感"
          disp[ch] += (target - disp[ch]) * (target > disp[ch] ? kUp : kDown);

          // 峰值保持：创新高立即跟上并重置保持窗口，之后缓慢回落
          if (target >= peak[ch]) {
            peak[ch] = target;
            holdUntil[ch] = now + PEAK_HOLD_MS;
          } else if (now > holdUntil[ch]) {
            peak[ch] += (target - peak[ch]) * kPeak;
          }

          const x = plotX + ch * colW + (colW - barW) / 2;
          const value = disp[ch];

          // 底槽
          ctx.fillStyle = 'rgba(148, 163, 184, 0.10)';
          ctx.fillRect(x, 0, barW, h);

          // 主条：从底部长上来，填充色随高度渐变
          if (value > 0.001) {
            const barH = Math.max(value * h, 1);
            ctx.fillStyle = meterGrad;
            ctx.fillRect(x, h - barH, barW, barH);
          }

          // 峰值线：水平细线，仅当明显高于当前值时才画
          const pk = peak[ch];
          if (pk > 0.02 && (pk - value) * h > 1.5) {
            ctx.fillStyle = 'rgba(226, 232, 240, 0.72)';
            ctx.fillRect(x, Math.max(h - pk * h - 1, 0), barW, 2);
          }
        }
      }

    };

    const unregister = registerRenderLoop(draw);
    return () => {
      unregister();
      ro.disconnect();
    };
  }, [metersRef, deviceId, channels]);

  return <canvas ref={canvasRef} className="h-full w-full" />;
}
