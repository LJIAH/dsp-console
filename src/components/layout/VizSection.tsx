import { VizBox } from '../ui/VizBox';
import { SPECTRUM_BINS, WAVEFORM_POINTS } from '../../protocol';
import { fmtDuration } from '../../lib/format';
import type { AudioUiState, VizSourceKind } from '../../react/useConsole';
import type { LatestStore } from '../../viz/store';
import type { Renderer, SpectrumFrame, WaveformFrame } from '../../viz/types';

interface Props {
  source: VizSourceKind;
  onSourceChange: (kind: VizSourceKind) => void;
  audio: AudioUiState;
  onLoadFile: (file: File) => void;
  onLoadSample: () => void;
  onTogglePlay: () => void;
  onToggleMonitor: () => void;
  spectrum: { store: LatestStore<SpectrumFrame>; renderer: Renderer<SpectrumFrame> };
  waveform: { store: LatestStore<WaveformFrame>; renderer: Renderer<WaveformFrame> };
}

/**
 * 可视化区：数据源控制条 + 频谱/波形两块画布。
 *
 * 两条数据源在管线里长得一模一样（都是 FrameSource）——
 * 所以切换时**只换订阅**，store / renderer / 画布宿主全都不动。
 */
export function VizSection({
  source,
  onSourceChange,
  audio,
  onLoadFile,
  onLoadSample,
  onTogglePlay,
  onToggleMonitor,
  spectrum,
  waveform,
}: Props) {
  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2 text-[10px]">
        <span className="text-slate-500">数据源</span>
        <div className="flex items-center gap-1 rounded-md border border-slate-700 p-0.5">
          <button
            className={`rounded px-2 py-0.5 transition ${
              source === 'device' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300'
            }`}
            onClick={() => onSourceChange('device')}
            title="设备 DSP 算好、网关推来（只推被聚焦的那台设备）"
          >
            设备推送
          </button>
          <button
            className={`rounded px-2 py-0.5 transition ${
              source === 'local' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300'
            }`}
            onClick={() => onSourceChange('local')}
            title="浏览器本地分析：Web Audio AnalyserNode"
          >
            本地分析
          </button>
        </div>

        {source === 'local' && (
          <>
            <label className="cursor-pointer rounded-md border border-slate-700 px-2 py-0.5 text-slate-300 transition hover:border-slate-500 hover:text-slate-100">
              选择音频文件
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onLoadFile(f);
                  e.target.value = ''; // 允许再次选择同一个文件
                }}
              />
            </label>
            <button
              onClick={onLoadSample}
              title="内置 4 秒多谐波音频（演示时不用现找文件）"
              className="rounded-md border border-slate-700 px-2 py-0.5 text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
            >
              示例音频
            </button>
            <button
              disabled={!audio.fileName}
              onClick={onTogglePlay}
              className="rounded-md border border-slate-700 px-2 py-0.5 text-slate-300 transition hover:border-slate-500 hover:text-slate-100 disabled:opacity-40"
            >
              {audio.playing ? '暂停' : '播放'}
            </button>
            {/* 默认外放；点一下静默（只分析不出声）—— 按钮状态要一眼看清 */}
            <button
              onClick={onToggleMonitor}
              title={
                audio.monitor
                  ? '当前会外放；点此改为「静默分析」（只出图不出声）'
                  : '当前静默分析（不出声）；点此开启外放'
              }
              className={`rounded-md border px-2 py-0.5 transition ${
                audio.monitor
                  ? 'border-emerald-500/50 text-emerald-300 hover:border-emerald-400'
                  : 'border-amber-500/60 text-amber-300 hover:border-amber-400'
              }`}
            >
              {audio.monitor ? '外放中' : '静默中'}
            </button>
            {audio.fileName && (
              <span className="num max-w-56 truncate text-slate-500">
                {audio.fileName} · {fmtDuration(audio.position)} / {fmtDuration(audio.duration)}
              </span>
            )}
          </>
        )}
      </div>

      {/* 顺序：波形（时域）在左、频谱（频域）在右 —— 也是信号处理里的经典顺序 */}
      <div className="grid h-36 grid-cols-2 gap-2">
        <VizBox
          title={`波形 · ${WAVEFORM_POINTS} 点`}
          store={waveform.store}
          renderer={waveform.renderer}
        />
        <VizBox
          title={`频谱 · ${SPECTRUM_BINS} bins`}
          store={spectrum.store}
          renderer={spectrum.renderer}
        />
      </div>
    </div>
  );
}
