/**
 * 可视化管线 —— 第二套插件协议
 *
 * 为什么不把它们塞进 WSCore 的插件协议：
 *   连接的生命周期是「消息」，渲染的生命周期是「帧」，两者正交。
 *   硬挂在同一条链上，PluginContext 会被迫长出 canvas/尺寸/DPR 这些和连接无关的能力，
 *   变成上帝接口。所以这里独立一套三件套：
 *
 *     FrameSource（数据从哪来） → Frame（帧数据） → Renderer（怎么画）
 *
 * 关键设计：Frame 的数值格式与 **Web Audio 的字节数组同构** ——
 *   · 频谱 = 0~255 / 每个 bin   ≈ `getByteFrequencyData()`
 *   · 波形 = 0~255 / 128 为中心 ≈ `getByteTimeDomainData()`
 *   这样"设备推送"与"浏览器本地分析"两个数据源可以**互换**，
 *   渲染器一行都不用改（这正是把波形数据源做成可切换的前提）。
 */
export interface Box {
  w: number;
  h: number;
}

/** 频谱帧：64 个 bin，每个 0~255（频率由低到高） */
export interface SpectrumFrame {
  ts: number;
  bins: readonly number[];
}

/** 波形帧：256 个采样点，0~255，128 = 零电平中轴 */
export interface WaveformFrame {
  ts: number;
  samples: readonly number[];
}

export interface Renderer<F> {
  name: string;
  /** 纯绘制：不读网络、不持业务状态（动画平滑状态除外） */
  draw(ctx: CanvasRenderingContext2D, frame: F | null, box: Box): void;
}

export interface FrameSource<F> {
  name: string;
  subscribe(cb: (frame: F) => void): () => void;
}
