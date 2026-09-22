/**
 * 只保留最新一帧的存储
 *
 * 可视化数据是**易失实时量**：旧帧没有价值，堆积只会变成内存泄漏
 * （对应 `协议设计/09` 的"易失实时量不做历史对齐，取 latest-value"）。
 * 所以这里不做队列、不做历史，只留最后一帧。
 *
 * 注意它刻意**不触发 React 渲染**：canvas 的渲染循环直接 read()，
 * 高频帧数据一次都不会进入 React 的渲染路径。
 */
export class LatestStore<F> {
  private frame: F | null = null;

  push(frame: F): void {
    this.frame = frame;
  }

  read(): F | null {
    return this.frame;
  }

  clear(): void {
    this.frame = null;
  }
}
