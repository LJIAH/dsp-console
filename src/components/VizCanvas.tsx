/**
 * 通用可视化画布宿主：把「一个 Store + 一个 Renderer」接到 DOM 上
 *
 * 它只做三件事：尺寸管理（DPR + ResizeObserver）、清屏、把帧交给 renderer。
 * 渲染节奏由全局单 rAF 循环统一调度（`viz/raf-loop.ts`），
 * 所以页面上有三个 canvas 也只有一个 requestAnimationFrame。
 */
import { useEffect, useRef } from 'react';
import { registerRenderLoop } from '../viz/raf-loop';
import type { Renderer } from '../viz/types';
import type { LatestStore } from '../viz/store';

interface Props<F> {
  store: LatestStore<F>;
  renderer: Renderer<F>;
}

export function VizCanvas<F>({ store, renderer }: Props<F>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let cssW = 0;
    let cssH = 0;

    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      cssW = rect.width;
      cssH = rect.height;
    });
    ro.observe(canvas);

    const unregister = registerRenderLoop(() => {
      if (cssW <= 0 || cssH <= 0) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      renderer.draw(ctx, store.read(), { w: cssW, h: cssH });
    });

    return () => {
      unregister();
      ro.disconnect();
    };
  }, [store, renderer]);

  return <canvas ref={canvasRef} className="h-full w-full" />;
}
