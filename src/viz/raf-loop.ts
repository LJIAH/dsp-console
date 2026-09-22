/**
 * 全局单 rAF 循环：所有 canvas 共用一次 requestAnimationFrame 调度
 *
 * 为什么不是每个 canvas 各起一个 rAF：
 *   浏览器每帧要跑一遍所有已注册的 rAF 回调，多个循环意味着多次"帧回调表"遍历，
 *   更关键的是——**无法统一统计 FPS / 每帧耗时**，观测面板会失去唯一的一把尺子。
 *
 * 顺带做了故障隔离：一个渲染回调抛错不会拖垮其他 canvas
 * （和 WSCore 插件钩子 guard 是同一个思路）。
 */
type Tick = (dt: number, now: number) => void;

const ticks = new Set<Tick>();
let raf = 0;
let last = 0;

function frame(now: number): void {
  // dt 夹取：标签页切回时跨度可能几百 ms
  const dt = Math.min(Math.max(now - last, 1), 100);
  last = now;

  for (const fn of ticks) {
    try {
      fn(dt, now);
    } catch (err) {
      console.error('[viz] 渲染回调异常：', err);
    }
  }

  raf = requestAnimationFrame(frame);
}

export function registerRenderLoop(fn: Tick): () => void {
  if (ticks.size === 0) {
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  ticks.add(fn);

  return () => {
    ticks.delete(fn);
    if (ticks.size === 0 && raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}
