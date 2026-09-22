import { useConsole } from "./react/useConsole";
import { TopBar } from "./components/layout/TopBar";
import { DeviceListPanel } from "./components/layout/DeviceListPanel";
import { ChannelStrip } from "./components/layout/ChannelStrip";
import { VizSection } from "./components/layout/VizSection";
import { ObservabilityPanel } from "./components/layout/ObservabilityPanel";
import { ChaosBar } from "./components/layout/ChaosBar";
import type { Device } from "./protocol";

/**
 * 组装层：只做三件事 —— 取状态（useConsole）、连线（props）、摆布局。
 *
 * 展示逻辑全在 `components/layout/*`，各个面板不需要知道
 * WebSocket 是怎么接的、数据是 ref 还是 state —— 这是"容器 / 展示"的分界。
 */
export default function App() {
  const {
    client,
    metrics,
    devices,
    metersRef,
    hotPath,
    setHotPath,
    selectedId,
    select,
    setMuted,
    chaos,
    reconnectInfo,
    spectrumStore,
    waveformStore,
    spectrumRenderer,
    waveformRenderer,
    vizSource,
    setVizSource,
    meterTarget,
    audio,
    loadAudioFile,
    loadSampleAudio,
    toggleAudioPlay,
    toggleMonitor,
  } = useConsole();

  const selected: Device | null =
    devices.find((d) => d.deviceId === selectedId) ?? null;

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-200">
      <TopBar
        metrics={metrics}
        info={reconnectInfo()}
        pending={client.getPendingCount()}
        outbox={client.getOutboxSize()}
        onClose={() => client.close(1000, "用户主动关闭")}
        onReconnect={() => client.start()}
        onResync={() => void client.resync().catch(() => {})}
      />

      <main className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[230px_minmax(0,1fr)_330px]">
        <DeviceListPanel
          devices={devices}
          selectedId={selectedId}
          onSelect={select}
        />

        <ChannelStrip
          metersRef={metersRef}
          selected={selected}
          vizSource={vizSource}
          meterTarget={meterTarget}
          hotPath={hotPath}
          onHotPathChange={setHotPath}
          onToggleMute={setMuted}
        >
          <VizSection
            source={vizSource}
            onSourceChange={setVizSource}
            audio={audio}
            onLoadFile={(f) => {
              void loadAudioFile(f).catch((err: unknown) =>
                console.warn("[viz] 解码失败：", err),
              );
            }}
            onLoadSample={() => {
              void loadSampleAudio().catch((err: unknown) =>
                console.warn("[viz] 示例音频加载失败：", err),
              );
            }}
            onTogglePlay={toggleAudioPlay}
            onToggleMonitor={toggleMonitor}
            spectrum={{ store: spectrumStore, renderer: spectrumRenderer }}
            waveform={{ store: waveformStore, renderer: waveformRenderer }}
          />
        </ChannelStrip>

        <ObservabilityPanel events={metrics.events} />
      </main>

      <ChaosBar onRun={chaos} />
    </div>
  );
}
