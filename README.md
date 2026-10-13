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

插件体系之外还有一层「不属于任何一端、但两端都必须遵守」的东西：**协议契约**（`protocol/`，见第八节）——
插件管"这条连接怎么活"，契约管"两端说的话是不是同一句"。

---

## 二、快速开始

```bash
pnpm install

# 一条命令起两个进程：网关(8080) + 前端(5090)
pnpm start

# 或分开起
pnpm server   # Mock 设备网关（Express + ws）
pnpm dev      # 前端（Vite，端口见 vite.config.ts）

# 单测 + 契约测试（含「起一个真网关、收它实发的帧再校验」那一环）
pnpm test
```

打开 http://localhost:5090

- 手机真机验证：`pnpm dev` 已开 `--host`，同一局域网访问 `http://<你的IP>:5090`
- 本机开发时前端与网关是**两个**端口，所以 `.env.development` 里显式写了网关地址；
  生产是**一个**端口（网关托管 `dist/`，同源推导 wss），见第十一节「部署到线上」

---

## 三、故障注入台（右下角）

| 按钮            | 注入什么                    | 应该看到什么                                                                                     |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| 优雅断开 (1001) | 服务端发关闭帧              | onclose → 退避重连（指数上限 1s→2s→4s…封顶 30s；实际等待带 50% 抖动，所以是 0.5~1s、1~2s… 地涨） |
| 半开连接        | `ws.terminate()` 不发关闭帧 | readyState 停在 OPEN；心跳连续 2 次超时 → 判死 → 主动 `close(1000)` → 重连                       |
| 脏数据          | 推送非 JSON 帧              | 内核丢弃并计入 `parseErrors`（连接不受影响）                                                     |
| 结构非法        | 合法 JSON、缺字段           | 协议插件拦下，报 `protocol:invalid`                                                              |
| 指令不回 ack    | 网关吞掉指令                | 3s 超时 → 用同一个 seq 重发 ×3 → `command:failed`（乐观值回滚）                                  |
| 恢复正常        | 关闭注入                    | —                                                                                                |

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

**L / R 分声道计量**（已实现）。音频图是：

```
source → splitter ─┬→ analyserL → merger[0] ┐
                   └→ analyserR → merger[1] ┴→ gain → destination
```

**为什么要 merger**：`ChannelSplitterNode` 的输出是**两路单声道**，不按索引合回 2 声道
就没法正常送 destination（也就谈不上保留 L/R 结构）。`AnalyserNode` 顺手串在这两路之间 ——
它是透传节点，而且**不需要输出连接也能工作**（MDN 原文：「即使未连接到输出它也能正常工作」），
串在链上只是为了少建支路。

单声道文件会在 splitter 处被 up-mix（L/R 收到相同信号），这是正确行为：单声道就该在两个扬声器都响。

频谱与波形取的是**左声道**（单声道文件两边相同）；真实分析仪会提供 L / R / Sum 三种拾取可选。

本地分析的三个真坑（都写在 `viz/sources/web-audio-engine.ts` 的注释里）：
AudioContext 必须在**用户手势**里 `resume()`；`decodeAudioData` 只吃 ArrayBuffer、
会把它 **detach**、结果**重采样到 context 采样率**；`AudioBufferSourceNode` 是**一次性**的
（暂停/继续要记 offset 并重建节点）。默认**静默分析**（不出声），需要外放时点「静默 → 监听中」。

---

## 七、滑块：一个控件，三个时机

16 路增益推子。滑块本身不难，难的是**什么时候发指令** —— 教学版 Demo 的写法是
`onChange` 直接发可靠指令，拖 1 秒 = 60 条指令 + 60 个 pending 各自等 3s 超时重发。

| 时机              | 通道                  | 协议                       | 网关行为                           |
| ----------------- | --------------------- | -------------------------- | ---------------------------------- |
| 拖动中            | `send`（可丢）        | `setGainPreview`（无 seq） | 只改状态：不回 ack、**不推 state** |
| 松手              | `sendCommand`（可靠） | `setGain`（seq + ack）     | 应用 → ack(read-back) → 推 state   |
| 键盘 ↑↓/PgUp/PgDn | 同上                  | 同上                       | 同松手                             |

三个决策，每个都对应一个坑：

1. **预览不回 ack、不推 state**。否则拖动 1 秒就是几十条全量 state 洪水，
   还会和本地乐观值互相打架。预览是"尽力而为"，丢了无所谓（下一条覆盖它）。
2. **乐观值的寿命到「权威值追上」为止，不是到「松手」为止**。
   松手即交还会闪回旧值（服务端 state 还在路上）—— 用 CDP 真实鼠标 +
   `MutationObserver` 全量记录 `aria-valuenow`，实测抓到过：

   ```
   t=500ms  值=6     拖动到最后
   t=631ms  值=7     ← 松手瞬间弹回旧权威值
   t=645ms  值=6     ← state 到达才跳回来
   ```

   现在：commit 记下目标值 + 改之前的权威值 → 该通道 gain 真的变了才交还控制权；
   2s 超时兜底（state 丢了也不能冻在乐观值上）；设备明确拒绝（`ack.ok=false`）时
   立即回滚 —— 那时候的"弹回"才是正确的。

3. **任何新拖动都作废上一轮待确认**。否则"松手后立刻再拖同一路"时，
   上一轮的 state 会把正在拖的推子拽走。

另有两处健壮性：`setPointerCapture` 包 `try/catch`（它一旦抛出会中断整个
pointerdown handler —— 推子彻底没反应，异常还会冒到 React 错误边界）；
补 `onLostPointerCapture` / `onPointerCancel` 兜底（捕获意外丢失时 `dragging`
会卡在 true —— 之后鼠标一动推子就跟着乱跳，且这次调整永远不会被提交）。

**语义**：滑块控制 `gain`（控制量，-12 ~ +12 dB），不是 `level`（测量值，设备实测、
不可设定）。网关里增益**真的参与电平生成**（`level = base + gain×10 + noise`），
所以拖推子时电平柱会跟着抬起来。

推子是自绘的（不是 `<input type="range">`）：竖排 range 依赖 `writing-mode`，
跨浏览器与移动端的观感/手感不一致；自绘还能复用通道带那套像素级对齐规则，
并带上 `role="slider"` + `aria-valuetext` + 键盘操作。

---

## 八、协议契约：一份语言无关的契约 + 契约测试

前端 TS、Mock 网关 Node、真实设备侧 C —— 「同一个东西」不能是三份代码里的三组常量。
`protocol/` 就是那份语言无关的契约：

```
protocol/
  constants.json         机器可读常量（数值的唯一来源，两端 import）
  messages.schema.json   双向信封的 JSON Schema（结构与边界）
  limits.md              单位与边界表 + 为什么这么定（−999 哨兵、dBFS×10、通道号从 1 起）
  errors.md              错误码 / 关闭码 + 前端拿到它该干什么
  versioning.md          版本与兼容（只增不删 / 适配层 / bootId）
```

三件事是这一层的重点：

1. **数值只有一处**：电平的 `-600 ~ 0` 与 `-999` 哨兵、频谱 64 bin / 波形 256 点、通道号从 1 开始、
   ack 3s × 3 次 —— 全写在 `constants.json`，`src/protocol.ts` 与 `server/index.mjs` 都 import 它。
   之前是「两端各写一份 + 注释提醒必须一致」：那种一致性靠人盯，迟早会漂。
2. **信封四要素在实现里齐了**：`type / ts / seq / version`。`version` 每帧带、缺省视为 1 ——
   滚动升级期同一网段会同时存在两代固件，逐帧判断才能「新前端读得了旧固件、旧前端不崩在新固件上」。
3. **契约测试让它不是文档**（`pnpm test`）：Schema 与 Zod 的消息类型集合一致、Schema 的每个边界等于
   `constants.json` 的值、同一批样例帧在两边接受/拒绝结论一致、**起一个真网关收它实际发出的帧**再各验一遍。
   文档会过期，测试不会。

配套的两条解析纪律：**解析边界宽容**（未知字段忽略、新增字段 `optional`、v2 的帧也按 v1 尽力解析），
**使用前兜底**（哨兵翻译成 `null`、缺值给默认值）—— 而「严格」只出现在发送方（出协议前显式挑字段，内部字段不外泄）。

---

## 九、目录结构

```
src/
  core/ws-core.ts        内核：插件协议 + 两条拦截链 + 故障隔离 + 观测盲区补丁
  plugins/                ①~⑩ 十个插件（backoff.ts 是被单测钉住的退避纯函数）
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
  protocol.ts             运行时入口：从 protocol/constants.json 取数 + Zod 校验 + 信封构造
protocol/                 语言无关的契约目录（见第八节）
server/index.mjs          Mock 网关（Express + ws noServer + chaos API + 数据模拟）
tests/                    单测 + 契约测试（vitest；含一个起真网关的用例）
```

---

## 十、还没做的（按优先级）

1. 心跳 RTT 时序图、背压演示、超大消息 `close(1009)`
   （顺带把 1009 加进「不重连」名单：重连后发出同样的超长消息只会再撞一次）
2. 多标签页选主（Web Locks + BroadcastChannel）
3. 三端适配收尾（44px 触控 / `100dvh` / 断点重排）
4. 能力协商帧：连上后由设备发一次能力集（支持哪些消息、通道上限、固件版本），前端据此选装插件
   —— 目前通道数是从 `snapshot` 的 `channels` 长度倒推的，够用但不够显式

---

## 十一、部署到线上（宝塔 + Nginx 反代）

形态：**一个 Node 进程、一个端口**。它同时提供 REST、WebSocket 与前端静态文件
（`pnpm build` 的产物由网关托管）—— 同源，所以不需要 CORS、不需要第二张证书，
前端产物里也不写死域名（`wss://` 从 `location` 推导，换域名不用重新构建）。

```
浏览器 ──https/wss──> dsp.kevy.top:443 ──(宝塔 Nginx 反代)──> 127.0.0.1:5090
                                                              └ 网关：/api + /ws + dist/
```

### 一键部署

在**自己的电脑上**执行（Git Bash / macOS / Linux，仓库根目录，已配好 SSH）：

```bash
ssh root@8.138.193.49 "bash -s" < deploy/deploy.sh
```

在**服务器上**执行（宝塔终端 / SSH，之后更新代码也跑同一条）：

```bash
bash /www/wwwroot/dsp.kevy.top/deploy/deploy.sh
```

脚本做的事（可重复执行 = 更新部署）：检查 Node ≥ 22 → `git fetch + reset` 到最新提交 →
`pnpm install && pnpm build` → 写 systemd 单元并重启（开机自启、崩溃自拉）→
`curl /healthz` 自检。代码目录默认 `APP_DIR=/www/wwwroot/dsp.kevy.top`（= 宝塔给该域名建的站点目录），
可用环境变量覆盖：`APP_DIR` / `REPO_URL` / `BRANCH` / `PORT` / `NO_SERVICE=1`。

### 宝塔里要配的一次性设置（把 `dsp.kevy.top` 转给 5090）

**先确认入口在不在**：网站 → `dsp.kevy.top` → 设置 → 看左侧有没有「反向代理」。

- **有**（标准版）：反向代理 → 添加 → 目标 URL `http://127.0.0.1:5090`、发送域名 `$host`，
  再确认生成配置里有 `Upgrade` / `Connection` / `proxy_read_timeout`（现在的模板一般自带，
  可能是 `$connection_upgrade` 写法，等价，别重复添加）。
- **没有**（阿里云联合定制版等精简版：站点设置里只有「域名管理 / 流量限制 / 伪静态 / 配置文件 /
  重定向 / SSL / 网站日志」）：直接点 **「配置文件」**，在 `server { ... }` 里插入下面这段 ——
  效果与面板的反代完全一致，只是手写：

  ```nginx
  # dsp-console 反代（含 WebSocket 升级）
  location / {
      proxy_pass http://127.0.0.1:5090;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_read_timeout 3600s;
      proxy_send_timeout 3600s;
  }
  ```

  保存后面板会自动 reload。若提示 `duplicate location "/"`，说明原本已有一个 `location /` ——
  把原来那一段整段替换成上面这段即可（不要并存两个）。

三条 WebSocket 头是全篇唯一的硬要求：**缺了就是「页面能开、顶栏一直连不上」**。
安全组放行 **80 / 443** 即可；5090 只在同机反代，不必对外开放。

> 代码目录就是站点目录，所以反代**必须**配好：配好之后 `/` 全部转给 Node（Node 只发 `dist/`，
> 仓库源码不外泄）；万一没配，nginx 会按站点根目录直接发文件（宝塔默认拦了 `.git`/`.env`，
> 但 `src/`、`server/` 是发得出去的）。

### 不用宝塔时（Caddy 备选）

```bash
cp deploy/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy   # 自动证书 + 自动转发 WS
```

Nginx 手写配置见 `deploy/nginx.conf`。两条路都别省 `Upgrade`/`Connection` 头与
`proxy_read_timeout` —— 那正是「页面能开、连接连不上」的成因。

### 检查清单

- 域名 `dsp.kevy.top` → 服务器公网 IP；宝塔里 HTTPS 证书已配好。
- ⚠️ 不要在生产上跑 `pnpm dev`：Vite 开发服务器不是生产服务器，两个端口还会带来跨域与 wss 的麻烦。
- 大陆节点的 80/443 需要 **ICP 备案**；没备案时先用 `http://<公网IP>:5090` 验功能（安全组放行 5090）。
- 上线自测：`curl https://dsp.kevy.top/healthz` → 打开页面看顶栏「已连接」→ 按两下故障注入台。
- 未做的事（演示期已知）：`POST /api/chaos/*` 对公网开放，任何人都能让你的界面「假死」；
  网关是单进程内存状态，只能 1 副本、重启即重置。
