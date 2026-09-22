/**
 * 本地音频分析引擎（Web Audio API）
 *
 * 这是"两条数据源"里的第二条 —— 音频**真的进了浏览器**的那条：
 *   文件 → decodeAudioData → AudioBuffer → AudioBufferSourceNode → AnalyserNode
 *
 * 对比设备那条路（DSP 算好推给我们），差别就在这句话：
 *   音频流不经过浏览器时，前端只能"可视化"设备算好的结果；
 *   音频进了浏览器，前端才能真正"分析"它。这个类就是后者的入口。
 *
 * ── 三个必须知道的约束（都是真坑） ──────────────────────────────
 *   1. AudioContext 受 autoplay policy 约束：必须在**用户手势**里 resume()，
 *      否则永远 suspended —— 不出声、也拿不到数据；
 *   2. `decodeAudioData` 只接受 ArrayBuffer（传 File/Blob 直接 TypeError），
 *      而且**会把这份 buffer detach**（用完即毁，不能复用）；它还会把结果
 *      **重采样到 context 的采样率**（所以 audioBuffer.sampleRate 是 context 的）；
 *   3. AudioBufferSourceNode 是**一次性**的：start() 之后不能重用、不能暂停续播。
 *      所以"暂停/继续"要记下 offset 再重建节点 —— 这是本类唯一有点绕的地方。
 *
 * ── 输出与协议同构 ──────────────────────────────────────────────
 *   readSpectrum() 返回 64 个 0~255（≈ getByteFrequencyData 折叠而来）
 *   readWaveform() 返回 256 个 0~255、128 为中轴
 *   —— 与设备推送的 Frame 完全同构，所以渲染器一行都不用改。
 */
import { LEVEL_NO_SIGNAL, SPECTRUM_BINS, WAVEFORM_POINTS } from '../../protocol';

/** FFT 窗口：2048 → frequencyBinCount = 1024 */
const FFT_SIZE = 2048;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;

  // ⚠️ 显式写 <ArrayBuffer>：TS 5.7 起 TypedArray 带上了缓冲区泛型参数，
  // 而 Web Audio 的 getByteXxxData 只接受 Uint8Array<ArrayBuffer>（不收 SharedArrayBuffer）
  private freq: Uint8Array<ArrayBuffer> | null = null;
  private time: Uint8Array<ArrayBuffer> | null = null;

  /** 复用数组：每帧原地重写，避免高频分配（调用方请当帧用完即弃） */
  private readonly binCache: number[] = new Array<number>(SPECTRUM_BINS).fill(0);
  private readonly pointCache: number[] = new Array<number>(WAVEFORM_POINTS).fill(128);

  private startedAt = 0;
  private offset = 0;
  private playingFlag = false;
  /** 默认外放 —— 用户点了"播放"却没声音是最差的默认值；要静音是一个动作的事 */
  private monitorOn = true;

  get playing(): boolean {
    return this.playingFlag;
  }

  get loaded(): boolean {
    return this.buffer !== null;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  /** 当前播放位置（秒） */
  get position(): number {
    if (!this.ctx || !this.playingFlag) return this.offset;
    return Math.min(this.ctx.currentTime - this.startedAt, this.duration);
  }

  /** 监听开关：默认关闭（只分析不出声）—— 演示时不至于突然外放 */
  setMonitor(on: boolean): void {
    this.monitorOn = on;
    if (this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
    }
  }

  get monitoring(): boolean {
    return this.monitorOn;
  }

  /** 惰性创建音频图。⚠️ 必须在用户手势里调用（或由手势触发的调用链调用） */
  private ensure(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.7;

      const gain = ctx.createGain();
      gain.gain.value = this.monitorOn ? 1 : 0;

      // source → analyser → gain → destination
      // （analyser 是透传节点；gain 决定是否真的出声）
      analyser.connect(gain);
      gain.connect(ctx.destination);

      this.ctx = ctx;
      this.analyser = analyser;
      this.gain = gain;
      this.freq = new Uint8Array(analyser.frequencyBinCount);
      this.time = new Uint8Array(analyser.fftSize);
    }
    return this.ctx;
  }

  /** 载入本地文件并解码 */
  async load(file: File): Promise<void> {
    const ctx = this.ensure();
    await ctx.resume(); // 手势内 resume，否则在部分浏览器里仍是 suspended
    const bytes = await file.arrayBuffer(); // ⚠️ 只吃 ArrayBuffer
    this.buffer = await ctx.decodeAudioData(bytes); // 这份 bytes 会被 detach
    this.stopSource();
    this.offset = 0;
    this.playingFlag = false;
  }

  play(): void {
    if (!this.buffer || !this.ctx || !this.analyser) return;
    this.stopSource();

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.analyser);
    src.onended = () => {
      if (this.source === src) {
        // 自然播完：位置归零，等待用户再次播放
        this.playingFlag = false;
        this.offset = 0;
        this.source = null;
      }
    };
    // 从暂停位置继续（offset 在 pause 里记录）
    src.start(0, this.offset % Math.max(this.buffer.duration, 0.001));
    this.source = src;
    this.startedAt = this.ctx.currentTime - this.offset;
    this.playingFlag = true;
  }

  pause(): void {
    if (!this.ctx || !this.playingFlag) return;
    this.offset = this.position;
    this.stopSource();
    this.playingFlag = false;
  }

  private stopSource(): void {
    const src = this.source;
    if (!src) return;
    src.onended = null; // 防止把"主动停止"当成播完
    try {
      src.stop();
    } catch {
      // 已经停过：忽略
    }
    src.disconnect();
    this.source = null;
  }

  /** 频谱：1024 个 FFT bin → 64 个显示 bin */
  readSpectrum(): number[] {
    const analyser = this.analyser;
    const data = this.freq;
    if (!analyser || !data) return this.binCache;
    analyser.getByteFrequencyData(data);
    foldToBins(data, this.binCache);
    return this.binCache;
  }

  /**
   * 电平（dBFS 定点 ×10，与设备推送的 level 完全同构）。
   *
   * 这是"真电平"的算法，和设备 DSP 做的事一样：
   *   **RMS（均方根）= 信号的等效能量**，再取 20·log10 转成 dB。
   * 一个经典细节：满幅**正弦**的 RMS = 1/√2 ≈ 0.707 → **-3dBFS**，
   * 所以"看着满格"的正弦其实差 3dB，只有方波才到 0dBFS。
   *
   * ⚠️ 这里读的是 AnalyserNode **down-mix 之后**的单声道结果
   *    （规范：分析前会把输入混成单声道）。要做 L/R **分声道**电平，
   *    得在前面挂一个 ChannelSplitterNode，每个声道各接一个 AnalyserNode ——
   *    真实调音台就是这么做的，这里为了演示简洁先取总电平。
   */
  readLevel(): number {
    const analyser = this.analyser;
    const data = this.time;
    if (!analyser || !data) return LEVEL_NO_SIGNAL;

    analyser.getByteTimeDomainData(data);

    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const x = (data[i] - 128) / 128; // 0~255 → -1~1（128 是中轴）
      sum += x * x;
    }
    const rms = Math.sqrt(sum / data.length);
    const db = 20 * Math.log10(rms); // 0 → -∞
    if (db <= -60) return LEVEL_NO_SIGNAL; // 低于表盘下限：当作无信号
    return Math.round(db * 10);
  }

  /** 波形：2048 个时域点 → 256 个显示点 */
  readWaveform(): number[] {
    const analyser = this.analyser;
    const data = this.time;
    if (!analyser || !data) return this.pointCache;
    analyser.getByteTimeDomainData(data);
    decimate(data, this.pointCache);
    return this.pointCache;
  }

  dispose(): void {
    this.stopSource();
    void this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
    this.gain = null;
    this.buffer = null;
  }
}

/**
 * 1024 → 64：把 FFT bin 折叠成显示 bin。
 *
 * 两个刻意的选择：
 *   1. **按频率平方分组**（≈ 对数轴）：低频段每组很窄、高频段很宽 ——
 *      贴近人耳的频率感知，也和专业频谱仪的习惯一致。等分会让低频细节糊成一团。
 *   2. 每组取 **max** 而不是平均：平均会把窄带峰值（某个频点的强能量）抹平，
 *      而"有没有峰"恰恰是看频谱的主要目的。
 */
function foldToBins(src: Uint8Array, out: number[]): void {
  const n = src.length;
  const bins = out.length;
  for (let i = 0; i < bins; i += 1) {
    const lo = Math.floor((i / bins) ** 2 * n);
    const hi = Math.max(Math.floor(((i + 1) / bins) ** 2 * n), lo + 1);
    let max = 0;
    for (let k = lo; k < hi && k < n; k += 1) {
      if (src[k] > max) max = src[k];
    }
    out[i] = max;
  }
}

/**
 * 2048 → 256：等间隔抽取。
 * 诚实说明：等间隔抽取会丢瞬态峰值（折线显示下影响不大）。
 * 若要做到"一个峰值都不丢"，应改为每组的 **min/max 对**，
 * 让渲染器按像素列画竖线 —— 那是专业波形编辑器的画法。
 */
function decimate(src: Uint8Array, out: number[]): void {
  const n = src.length;
  const m = out.length;
  for (let i = 0; i < m; i += 1) {
    out[i] = src[Math.floor((i / m) * n)] ?? 128;
  }
}
