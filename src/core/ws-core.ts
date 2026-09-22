/**
 * WSCore —— 极简内核：一条连接 + 事件总线 + 插件挂载点
 *
 * 它只回答一个问题：「这条管道通不通」。
 * 不认识 ping/pong、不认识电平、不认识音量 —— 那些都住在插件里。
 *
 * 三条与「单体版」的关键差异（也是这个 Demo 的架构卖点）：
 *   1. 新增能力不改类，写个插件 use 上去（开闭原则）；
 *   2. use 顺序 = 消息消费优先级，顺序本身是显式契约；
 *   3. 故障隔离分两阶段：setup 抛错直接炸（装配期 fail fast），
 *      运行期钩子统一 guard（一个插件生病不传染全家）。
 *
 * 观测盲区补丁（相对教学版新增）：
 *   解析失败 / 二进制帧 / socket error 都会 emit 事件，
 *   否则"脏数据被丢弃"这件事在观测面板上不可见。
 */

export type Listener<T = any> = (payload: T) => void;
export type OpenHook = () => void;
export type CloseHook = (e: CloseEvent) => void;
/** 返回 true = 本插件已消费，停止向后面的插件传递 */
export type MessageHook = (msg: any, e: MessageEvent) => boolean | void;
/** 调 next(data) 才继续传递；不调用 = 拦截（该条不发送） */
export type SendInterceptor = (data: any, next: (data: any) => void) => void;

/** 连接「事实」状态 —— 内核持有；重连「意图」由 reconnect 插件补充 */
export type CoreState = 'idle' | 'connecting' | 'open' | 'closed';

export const CoreEvents = {
  /** 非 JSON / 结构非法，已被内核丢弃 */
  ParseError: 'core:parse-error',
  /** 收到二进制帧（V1 未处理，留观测用） */
  BinaryFrame: 'core:binary-frame',
  /** socket 层错误（onerror 后浏览器必定跟一次 onclose） */
  SocketError: 'core:error',
  /** 状态迁移 { from, to } */
  StateChange: 'core:state',
  /** 每发出（或尝试发出）一条消息：供观测插件统计 tx */
  Send: 'core:send',
} as const;

export interface Plugin {
  name: string;
  setup(ctx: PluginContext): void;
}

export interface PluginContext {
  /** 全局配置袋：use 的第二参数并入 */
  opts: Record<string, any>;
  /** 插件间共享状态（唯一被写入的字段：isReopen —— 由 reconnect 插件生产） */
  shared: Record<string, any>;

  // 连接事实
  getState(): CoreState;
  isOpen(): boolean;
  bufferedAmount(): number;
  isManuallyClosed(): boolean;
  /** 关闭当前连接（触发 onclose），非用户意图 */
  closeConnection(code?: number, reason?: string): void;
  /** 幂等建连，可放心调 */
  connect(): void;

  // 收发
  /** 业务发送：过拦截器链（outbox / backpressure），可能被拦截 */
  send(data: unknown): boolean;
  /** 内部发送：绕过拦截器（心跳 / 可靠指令，任何情况下都要能发出） */
  sendRaw(data: unknown): boolean;
  on(type: string, fn: Listener): () => void;
  emit(type: string, data?: any): void;

  // 生命周期钩子
  onOpen(fn: OpenHook): void;
  onClose(fn: CloseHook): void;
  onMessage(fn: MessageHook): void;
  addSendInterceptor(fn: SendInterceptor): void;
  /** 用户 close() 时触发：插件清理自己的定时器 */
  onTeardown(fn: () => void): void;
  /** 把插件 API 挂到实例上（如 sendCommand） */
  expose(name: string, value: unknown): void;
}

export interface WSCoreOptions {
  url: string;
  protocols?: string | string[];
  /** 构造器注入：单测可传 MockWebSocket */
  createSocket?: (url: string, protocols?: string | string[]) => WebSocket;
  /** 序列化，默认 JSON.stringify */
  serialize?: (data: unknown) => string;
}

export class WSCore {
  private ws: WebSocket | null = null;
  private opts: Required<WSCoreOptions>;
  private state: CoreState = 'idle';

  private listeners = new Map<string, Set<Listener>>();
  private openHooks: OpenHook[] = [];
  private closeHooks: CloseHook[] = [];
  private messageHooks: MessageHook[] = [];
  private sendInterceptors: SendInterceptor[] = [];
  private teardownHooks: (() => void)[] = [];

  private started = false;
  private manuallyClosed = false;

  readonly shared: Record<string, any> = {};

  constructor(options: WSCoreOptions) {
    this.opts = {
      protocols: [],
      createSocket: (url, protocols) => new WebSocket(url, protocols),
      serialize: (data) => JSON.stringify(data),
      ...options,
    };
  }

  // ── 装配 ───────────────────────────────────────────────────

  /** 链式装配。⚠️ use 顺序 = 消息消费优先级，两条铁律见 assembly/profiles.ts */
  use(plugin: Plugin, config?: Record<string, any>): this {
    if (config) Object.assign(this.opts, config);
    // setup 抛错不隔离：装配期 bug 必须在集成时炸出来，不是线上静默降级
    plugin.setup(this.makeCtx(plugin.name));
    return this;
  }

  /**
   * 故障隔离：包住插件钩子 —— 抛错只记日志，不传染其他插件。
   * 关键语义：消息钩子抛错 ≠ 消费（返回 undefined），消息继续流向后面的插件。
   */
  private guard<A extends unknown[]>(pluginName: string, fn: (...args: A) => any) {
    return (...args: A): any => {
      try {
        return fn(...args);
      } catch (err) {
        console.error(`[ws] 插件 "${pluginName}" 钩子异常：`, err);
        return undefined;
      }
    };
  }

  private makeCtx(pluginName: string): PluginContext {
    return {
      opts: this.opts,
      shared: this.shared,
      getState: () => this.state,
      isOpen: () => this.ws?.readyState === WebSocket.OPEN,
      bufferedAmount: () => this.ws?.bufferedAmount ?? 0,
      isManuallyClosed: () => this.manuallyClosed,
      closeConnection: (code = 1000, reason = '') => {
        this.ws?.close(code, reason);
      },
      connect: () => this.connect(),
      send: (data) => this.send(data),
      sendRaw: (data) => this.sendRaw(data),
      on: (type, fn) => this.on(type, fn),
      emit: (type, data) => this.emit(type, data),
      onOpen: (fn) => this.openHooks.push(this.guard(pluginName, fn)),
      onClose: (fn) => this.closeHooks.push(this.guard(pluginName, fn)),
      onMessage: (fn) => this.messageHooks.push(this.guard(pluginName, fn)),
      addSendInterceptor: (fn) =>
        this.sendInterceptors.push((data, next) => {
          try {
            fn(data, next);
          } catch (err) {
            // 拦截器抛错 = 该条不发送（不调 next）：发送侧 fail-safe。
            // 实时数据丢一条可容忍；可靠指令走 sendRaw，不受影响
            console.error(`[ws] 插件 "${pluginName}" 发送拦截器异常：`, err);
          }
        }),
      onTeardown: (fn) => this.teardownHooks.push(this.guard(pluginName, fn)),
      expose: (name, value) => {
        if (name in this) {
          console.warn(`[ws] 插件 "${pluginName}" expose("${name}") 覆盖了已有成员`);
        }
        (this as any)[name] = value;
      },
    };
  }

  // ── 生命周期 ───────────────────────────────────────────────

  /** 幂等：重复调用（React StrictMode 双跑）不会重复连接 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.manuallyClosed = false;
    this.connect();
  }

  /** 主动关闭（用户意图）：先触发 teardown 让插件清定时器，再关连接 */
  close(code = 1000, reason = '主动关闭'): void {
    this.started = false;
    this.manuallyClosed = true;
    for (const fn of this.teardownHooks) fn();
    this.setState('closed');
    this.ws?.close(code, reason);
    this.ws = null;
  }

  /** 幂等建连：CONNECTING/OPEN 时不新建（防"孤儿连接"） */
  private connect(): void {
    if (this.manuallyClosed) return;
    const rs = this.ws?.readyState;
    if (rs === WebSocket.CONNECTING || rs === WebSocket.OPEN) return;

    this.setState('connecting');
    const ws = this.opts.createSocket(this.opts.url, this.opts.protocols);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.setState('open');
      for (const fn of this.openHooks) fn();
    };

    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string') {
        // 二进制帧：V1 不走业务，但必须留痕（观测盲区补丁）
        this.emit(CoreEvents.BinaryFrame, { byteLength: (e.data as ArrayBuffer).byteLength });
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch {
        // 脏数据丢弃而非崩溃 —— 但让观测面板看得见
        this.emit(CoreEvents.ParseError, { raw: e.data.slice(0, 120) });
        return;
      }
      // 拦截链：谁返回 true 谁消费（pong/ack 在这里被插件吃掉，不落到业务层）
      for (const fn of this.messageHooks) {
        if (fn(msg, e) === true) return;
      }
    };

    ws.onerror = (err) => {
      // ⚠️ onerror 之后浏览器必定触发 onclose；重连逻辑只放 onclose 一处
      this.emit(CoreEvents.SocketError, err);
    };

    ws.onclose = (e: CloseEvent) => {
      this.ws = null;
      this.shared.isReopen = false;
      // 事实状态：连接已断开。是否重连是 reconnect 插件的"意图"，UI 端合成显示
      this.setState('closed');
      for (const fn of this.closeHooks) fn(e);
    };
  }

  // ── 发送 ───────────────────────────────────────────────────

  /** 公开发送：过拦截器链（outbox / backpressure）。返回 false = 被拦或连接不可用 */
  send(data: unknown): boolean {
    let sent = false;
    const dispatch = (i: number, d: any) => {
      if (i >= this.sendInterceptors.length) {
        sent = this.sendRaw(d);
        return;
      }
      this.sendInterceptors[i](d, (nd) => dispatch(i + 1, nd));
    };
    dispatch(0, data);
    return sent;
  }

  /** 底层发送：绕过拦截器。心跳 / 可靠指令走这里（不能被背压拦） */
  sendRaw(data: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      const raw = this.opts.serialize(data);
      ws.send(raw);
      this.emit(CoreEvents.Send, { bytes: raw.length });
      return true;
    } catch {
      return false;
    }
  }

  // ── 事件总线 ───────────────────────────────────────────────

  on(type: string, fn: Listener): () => void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
    return () => this.off(type, fn);
  }

  off(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  emit(type: string, data?: any): void {
    this.listeners.get(type)?.forEach((fn) => {
      try {
        fn(data);
      } catch (err) {
        // 业务订阅者抛错不应影响其他订阅者
        console.error(`[ws] 事件 "${type}" 订阅者异常：`, err);
      }
    });
  }

  // ── 内部 ───────────────────────────────────────────────────

  private setState(next: CoreState): void {
    if (this.state === next) return;
    const from = this.state;
    this.state = next;
    this.emit(CoreEvents.StateChange, { from, to: next, at: Date.now() });
  }
}
