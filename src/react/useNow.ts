import { useEffect, useState } from 'react';

/**
 * 每 `intervalMs` 刷新一次的"当前时间"。
 * 专门给倒计时这类**低频** UI 用：重连倒计时只需要 1s 精度，
 * 没必要为它触发高频渲染（高频的东西都走 canvas 渲染循环了）。
 */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
