# DSP Console · 数字音频设备 Web 控制台

> 面向「数字音频设备 B/S 上位机」场景的前端原型：**插件化 WebSocket 客户端 + 实时计量可视化 + 故障注入台**。
>
> 它要证明的不是"会画图"，而是**这条随时会断的长连接，被我管住了**。

---

## 一、为什么是插件化

内核（`src/core/ws-core.ts`）只保留四件事：**幂等建连 + 事件总线 + 原始发送 + 插件挂载点**。
其他能力全是 `use()` 上去的插件 —— 新增功能不改类，按设备/场景选装。

```
┌─ 消息链（返回 true = 消费，停止传递）──────────────────────────┐
│ 内核 parse → ①重连(观察) → ②观测(记录) → ③协议校验(拦非法)     │
│            → ④心跳(吃 pong) → ⑤可靠(吃 ack) → ⑩分发(兜底)     │
└──────────────────────────────────────────────────────────────┘
┌─ 发送链（不调 next = 拦截）──────────────────────────────────┐
│ send() → ⑥outbox(未连接则入队) → ⑦背压(超水位则丢) → sendRaw │
└──────────────────────────────────────────────────────────────┘
内部能力绕过整条链：sendRaw ← ④心跳 / ⑤可靠指令
```

| #   | 插件            | 职责                             | 顺序理由                                                |
| --- | --------------- | -------------------------------- | ------------------------------------------------------- |
| ①   | `reconnect`     | 退避 + 抖动 + code 过滤          | **铁律一：必须第一**，onOpen 抢先生产 `shared.isReopen` |
| ②   | `observability` | 事件流 → 指标 / 时间轴（不消费） | 靠前才能看到 pong/ack                                   |
| ③   | `protocol`      | Zod 校验，非法消息在此消费       | heartbeat/reliable 默认结构合法                         |
| ④   | `heartbeat`     | 应用层心跳，连续超时判死         | 消费 pong                                               |
| ⑤   | `reliable`      | seq + ack + 超时重发 + 重连重发  | 消费 ack                                                |
| ⑥   | `outbox`        | 断线入队、重连补发               | **必须在 ⑦ 之前**，否则收不到货                         |
| ⑦   | `backpressure`  | `bufferedAmount` 高水位丢新      | 发送链末端                                              |
| ⑧   | `session`       | 重连后重新订阅 + REST 快照对齐   | 依赖 `isReopen`                                         |
| ⑨   | `visibility`    | 切前台 / 网络恢复时主动探活      | 事件源，`emit('probe:now')` 解耦                        |
| ⑩   | `pubsub`        | 按 `type` 兜底分发               | **铁律二：必须最后**                                    |

装配方案（profile）可整体替换：`profiles.full` 与 `profiles.legacyFirmware`
（后者不装 heartbeat —— 老固件没有应用层 pong，半开连接永远发现不了）。

---

## 二、快速开始

```bash
pnpm install

# 一条命令起两个进程：网关(8080) + 前端(5173)
pnpm start

# 或分开起
pnpm server   # Mock 设备网关（Express + ws）
pnpm dev      # 前端（Vite）
```

打开 http://localhost:5173

- 手机真机验证：`pnpm dev` 已开 `--host`，同一局域网访问 `http://<你的IP>:5173`
- 前端地址在 `.env.development`（`VITE_` 前缀，构建期注入）

---

## 三、故障注入台（右下角）

| 按钮            | 注入什么                    | 应该看到什么                                                          |
| --------------- | --------------------------- | --------------------------------------------------------------------- |
| 优雅断开 (1001) | 服务端发关闭帧              | onclose → 退避重连（倒计时 1s→2s→4s…封顶 30s + 抖动）                 |
| 半开连接        | `ws.terminate()` 不发关闭帧 | readyState 停在 OPEN；心跳连续超时 → 判死 → 主动 `close(1000)` → 重连 |
| 脏数据          | 推送非 JSON 帧              | 内核丢弃并计入 `parseErrors`（连接不受影响）                          |
| 结构非法        | 合法 JSON、缺字段           | 协议插件拦下，报 `protocol:invalid`                                   |
| 指令不回 ack    | 网关吞掉指令                | 3s 超时 → 重发 ×3 → `command:failed`                                  |
| 恢复正常        | 关闭注入                    | —                                                                     |

顶栏还有一对刻意做出来的对照：**主动断开**（`manuallyClosed`，不重连）vs **服务端踢**（必须重连）。

---

## 四、性能：高频通道的 A/B 开关

电平是 20Hz × 16 通道的持续推送。右上角切换：

- **高频旁路**（默认）：meters 消息直写 `ref`，Canvas 的 rAF 循环直读 —— **一次 React 渲染都不发生**；
- **全量渲染**：每条消息 `setState` 一次（对照组），用 React DevTools Profiler / FPS 观察差异。

---

## 五、电平表的动画（不是 CSS 过渡）

数据 20Hz、屏幕 60fps —— 直接画采样点就是"跳变"。顺滑来自两处：

1. **数据侧**：网关按**连续信号模型**生成电平（慢速游走 + 小噪声 + 2% 概率瞬态），
   相邻采样点平均差 ≈ 0.6dB / p95 ≈ 1.3dB（实测），而不是每 50ms 独立重采样；
2. **渲染侧**：渲染循环按帧做**指数逼近**插值 —— 上升快（τ=28ms）、回落慢（τ=280ms），
   外加**峰值保持**（1.2s 后缓落）。这正是真实音频软件仪表的 attack / release 语义。
   插值系数用 dt 计算（`k = 1 − e^(−dt/τ)`），所以 60Hz 与 120Hz 屏幕观感一致。

Canvas 里没有 DOM 节点，挂不了 CSS transition —— 仪表动画只能做在渲染循环里。
刻度是**共用纵轴**：左侧一条 dBFS 轴（0 / -6 / -12 / -24 / -40 / -60 主刻度 + 次刻度），
16 列电平共用它；-12dB 与 -3dB 是警示区边界（注意 / 削波），贯穿绘图区。
映射为 **dB 线性**（`(db + 60) / 60`）——高电平区被自然拉开，
接近削波的地方看得最清楚，这是数字电平表的通行做法。

---

## 六、可视化管线（第二套插件协议）

频谱和波形**没有**塞进 WSCore 的插件协议，而是独立一套 —— 连接的生命周期是「消息」，
渲染的生命周期是「帧」，硬挂在一起会让 `PluginContext` 长出 canvas/尺寸/DPR 这些
和连接无关的能力，变成上帝接口：

```
FrameSource（数据从哪来） → Frame（帧数据） → Renderer（怎么画）
```

| 设计点                      | 说明                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Frame 与 Web Audio 同构** | 频谱 = 0~255 / 64 bin（≈ `getByteFrequencyData()`）；波形 = 0~255 / 256 点、128 为中轴（≈ `getByteTimeDomainData()`）—— 所以"设备推送"与"浏览器本地分析"两个数据源**可以互换**，渲染器一行不用改 |
| **全局单 rAF 循环**         | 三个 canvas 共用一次 `requestAnimationFrame`，带故障隔离（一个渲染器抛错不影响其他）；FPS 统计也才有唯一口径                                                                                     |
| **LatestStore 只留最新帧**  | 可视化是易失实时量（`协议设计/09`），不做队列与历史，也不进 React                                                                                                                                |
| **按需推送**                | 16 通道电平是全设备总览（小、必推）；频谱/波形是大帧（64+256 个数），只推**被聚焦**的那台设备 —— 前端切换设备时发 `focus`                                                                        |
| **重连后重发 focus**        | 服务端不保留任何"关系"，重连后不重发就会**静默停更**（和订阅一样，是最容易漏的现场恢复动作）                                                                                                     |
| **仪表手感**                | 频谱"立即上升、260ms 时间常数下落"（peak decay）；波形是折线，点数上千时该换 min/max 抽稀                                                                                                        |

**两条数据源都已就位**（面板上方可切）：

| 数据源   | 链路                                                                | 语义                                        |
| -------- | ------------------------------------------------------------------- | ------------------------------------------- |
| 设备推送 | DSP 算好 → 网关 WS → 前端                                           | 音频流不经过浏览器 → 前端只能「**可视化**」 |
| 本地分析 | 文件 → `decodeAudioData` → `AudioBufferSourceNode` → `AnalyserNode` | 音频进了浏览器 → 这才叫「**分析**」         |

切换只换订阅，**不换 store、不换 renderer** —— 这就是"Frame 与 Web Audio 同构"这个设计的回报。

**电平也在切换范围内**。Web Audio 同样能出电平，而且这才是"真电平"的算法：
`getByteTimeDomainData` → **RMS（均方根）** → `20·log10` → dBFS，与设备 DSP 做的是同一件事。
经典细节：满幅**正弦**的 RMS 是 1/√2 ≈ 0.707，即 **-3dBFS** —— 看着"满格"的正弦其实差 3dB，
只有方波才到 0dBFS。本地模式下这个电平被写成一台**虚拟设备**（`__local__`）塞进同一张 meters 表，
于是电平表、通道带、dBFS 刻度**一行都不用改**。

> ⚠️ 一处诚实的简化：AnalyserNode 分析前会把输入 **down-mix 成单声道**，
> 所以本地模式只出 CH1 总电平。要做 L/R **分声道**电平，得挂 `ChannelSplitterNode`
> 给每个声道各接一个 AnalyserNode —— 真实调音台就是这么做的。

本地分析的三个真坑（都写在 `viz/sources/web-audio-engine.ts` 的注释里）：
AudioContext 必须在**用户手势**里 `resume()`；`decodeAudioData` 只吃 ArrayBuffer、
会把它 **detach**、结果**重采样到 context 采样率**；`AudioBufferSourceNode` 是**一次性**的
（暂停/继续要记 offset 并重建节点）。默认**静默分析**（不出声），需要外放时点「静默 → 监听中」。

---

## 七、目录结构

```
src/
  core/ws-core.ts        内核：插件协议 + 两条拦截链 + 故障隔离 + 观测盲区补丁
  plugins/                ①~⑩ 十个插件（每个只做一件事）
  assembly/profiles.ts    装配表：顺序契约 + 两套 profile + 类型声明合并
  react/useConsole.ts     容器：单例 / 值-事件双通道 / 高频旁路 / 数据源切换
  components/
    layout/               展示层：TopBar · DeviceListPanel · ChannelStrip · VizSection
                          · ObservabilityPanel · ChaosBar（App.tsx 只负责组装）
    ui/                   小组件：Metric · VizBox
    MeterCanvas.tsx       电平表仪表（竖排 + dBFS 刻度轴 + attack/release + 峰值保持）
    VizCanvas.tsx         通用画布宿主（DPR + ResizeObserver + 全局 rAF）
  viz/                    可视化管线：types / raf-loop / store / renderers / sources
  lib/format.ts           时间与时长格式化
  protocol.ts             消息类型 + Zod 校验 + 单位边界（dB×10 定点、-999 哨兵）
server/index.mjs          Mock 网关（Express + ws noServer + chaos API + 数据模拟）
```

---

## 八、还没做的（按优先级）

1. **协议契约目录** `protocol/`（JSON Schema + limits.md + 边界表，与网关共用一份）
2. **单元测试**：backoff 纯函数 / 状态机迁移 / MockWebSocket + fake timers 验退避
3. 心跳 RTT 时序图、背压演示、超大消息 `close(1009)`
4. 多标签页选主（Web Locks + BroadcastChannel）
5. 三端适配收尾（44px 触控 / `100dvh` / 断点重排）
