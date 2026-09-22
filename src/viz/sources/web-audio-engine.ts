/**
 * 本地音频分析引擎（Web Audio API）
 *
 * 这是"两条数据源"里的第二条 —— 音频**真的进了浏览器**的那条：
 *   文件 → decodeAudioData → AudioBuffer → AudioBufferSourceNode → 分析 → 输出
 *
 * 对比设备那条路（DSP 算好推给我们），差别就在这句话：
 *   音频流不经过浏览器时，前端只能"可视化"设备算好的结果；
 *   音频进了浏览器，前端才能真正"分析"它。这个类就是后者的入口。
 *
 * ── 音频图（分声道分析） ────────────────────────────────────────
 *   source → splitter ─┬→ analyserL → merger[0] ┐
 *                      └→ analyserR → merger[1] ┴→ gain → destination
 *
 *   ⚠️ 为什么要 merger：`ChannelSplitterNode` 的输出是**两路单声道**，
 *   不按索引合回 2 声道，就没法正常送 destination（也就谈不上"保留 L/R 结构"）。
 *   用 merger 合回来，才能既分声道计量、又正确出声。
 *
 *   AnalyserNode 是**透传**节点，而且**不需要输出连接也能工作**
 *   （MDN 原文："即使未连接到输出它也能正常工作"）——
 *   把它串在链上只是为了少建支路：一路 splitter 输出同时喂给计量与输出。
 *
 *   单声道文件会在 splitter 处被 up-mix（L/R 收到相同信号）——
 *   这是正确行为：单声道就该在两个扬声器都响。
 *
 * ── 三个必须知道的约束（都是真坑） ──────────────────────────────
 *   1. AudioContext 受 autoplay policy 约束：必须在**用户手势**里 resume()，
 *      否则永远 suspended —— 不出声、也拿不到数据；
 *   2. `decodeAudioData` 只接受 ArrayBuffer（传 File/Blob 直接 TypeError），
 *      而且**会把这份 buffer detach**（用完即毁，不能复用）；它还会把结果
 *      **重采样到 context 的采样率**（所以 audioBuffer.sampleRate 是 context 的）；
 *   3. AudioBufferSourceNode 是**一次性**的：start() 之后不能重用、不能暂停续播。
 *      所以"暂停/继续"要记下 offset 再重建节点 —— 这是本类唯一有点绕的地方。
 */
import { LEVEL_NO_SIGNAL, SPECTRUM_BINS, WAVEFORM_POINTS } from '../../protocol';

/** FFT 窗口：2048 → frequencyBinCount = 1024 */
const FFT_SIZE = 2048;
/** 分析的声道数：本地文件按 L/R 两路计量（与调音台"每声道一路表"一致） */
const CHANNEL_COUNT = 2;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private splitter: ChannelSplitterNode | null = null;
  /** [左, 右] 各一个 analyser —— 分声道电平靠它们 */
  private analysers: AnalyserNode[] = [];
  /** 时域缓冲（长度 = fftSize = 2048）：电平与波形共用，`getByteTimeDomainData` 会写满 */
  private timeBuffers: Uint8Array<ArrayBuffer>[] = [];
  /**
   * 频域缓冲（长度 = frequencyBinCount = fftSize/2 = 1024）。
   *
   * ⚠️ 必须和时域缓冲分开。`getByteFrequencyData` **只填前 frequencyBinCount 个元素**，
   * 后半段不动 —— 如果两者共用一个 buffer，后半段就是上一次读时域时留下的波形数据。
   * 折叠时再按整个 buffer 当有效长度，就会把**波形数据当成频谱**画出来，
   * 表现是频谱右端凭空多出一块（与"真实频谱"之间还夹着一段空白）。
   */
  private freqBuffers: Uint8Array<ArrayBuffer>[] = [];
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;

  /** 复用输出：每帧原地重写，避免高频分配（调用方请当帧用完即弃） */
  private readonly levelCache: number[] = new Array<number>(CHANNEL_COUNT).fill(LEVEL_NO_SIGNAL);
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

  /** 声道数（分析链的规模，与文件实际声道无关：单声道会被 up-mix 成 L/R） */
  get channelCount(): number {
    return CHANNEL_COUNT;
  }

  /** 当前播放位置（秒） */
  get position(): number {
    if (!this.ctx || !this.playingFlag) return this.offset;
    return Math.min(this.ctx.currentTime - this.startedAt, this.duration);
  }

  /** 监听开关：默认外放；点一下变静默分析（只出图不出声） */
  setMonitor(on: boolean): void {
    this.monitorOn = on;
    if (this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
    }
  }

  get monitoring(): boolean {
    return this.monitorOn;
  }

  /** 惰性建图。⚠️ 必须在用户手势里调用（或由手势触发的调用链调用） */
  private ensure(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext();
      const splitter = ctx.createChannelSplitter(CHANNEL_COUNT);
      const merger = ctx.createChannelMerger(CHANNEL_COUNT);

      for (let i = 0; i < CHANNEL_COUNT; i += 1) {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = 0.7;
        // splitter 的第 i 路输出 → 该声道的分析节点 → 接回 merger 的第 i 路（透传）
        splitter.connect(analyser, i, 0);
        analyser.connect(merger, 0, i);
        this.analysers.push(analyser);
        this.timeBuffers.push(new Uint8Array(analyser.fftSize));
        // 尺寸就按 frequencyBinCount 开，折叠函数自然会用对这个长度
        this.freqBuffers.push(new Uint8Array(analyser.frequencyBinCount));
      }

      const gain = ctx.createGain();
      gain.gain.value = this.monitorOn ? 1 : 0;
      merger.connect(gain);
      gain.connect(ctx.destination);

      this.ctx = ctx;
      this.splitter = splitter;
      this.gain = gain;
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
    if (!this.buffer || !this.ctx || !this.splitter) return;
    this.stopSource();

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.splitter);
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

  /**
   * 分声道电平：[左, 右]，dBFS×10 定点（无信号为哨兵）。
   *
   * 算法就是"真电平"的算法，与设备 DSP 做的一样：
   *   时域样本 → **RMS（均方根）** → 20·log10 → dBFS
   * 经典细节：满幅**正弦**的 RMS = 1/√2 ≈ 0.707 → **-3dBFS**，
   * 只有方波才到 0dBFS。
   */
  readChannelLevels(): number[] {
    for (let i = 0; i < CHANNEL_COUNT; i += 1) {
      this.levelCache[i] = this.readLevelAt(i);
    }
    return this.levelCache;
  }

  private readLevelAt(index: number): number {
    const analyser = this.analysers[index];
    const data = this.timeBuffers[index];
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

  /**
   * 频谱：1024 个 FFT bin → 64 个显示 bin。
   *
   * 用**左声道**做频谱/波形（单声道文件在 splitter 处被 up-mix，两边相同）。
   * 真实分析仪会提供 L / R / Sum 三种拾取可选，演示取 L 足够。
   */
  readSpectrum(): number[] {
    const analyser = this.analysers[0];
    const data = this.freqBuffers[0];
    if (!analyser || !data) return this.binCache;
    analyser.getByteFrequencyData(data);
    foldToBins(data, this.binCache);
    return this.binCache;
  }

  /** 波形：2048 个时域点 → 256 个显示点（同上，取左声道） */
  readWaveform(): number[] {
    const analyser = this.analysers[0];
    const data = this.timeBuffers[0];
    if (!analyser || !data) return this.pointCache;
    analyser.getByteTimeDomainData(data);
    decimate(data, this.pointCache);
    return this.pointCache;
  }

  dispose(): void {
    this.stopSource();
    void this.ctx?.close();
    this.ctx = null;
    this.splitter = null;
    this.analysers = [];
    this.timeBuffers = [];
    this.freqBuffers = [];
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
  // src 必须是**频域缓冲**（长度 = frequencyBinCount = fftSize/2）。
  // 若误传整个 fftSize 长度的时域缓冲，后半段是波形数据 —— 折叠出来就是"假频谱"。
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
