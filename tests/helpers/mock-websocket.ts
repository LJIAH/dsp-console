/**
 * 测试用 WebSocket 替身。
 *
 * 为什么必须自己写一个而不是用现成库：我们要的是**把时间与事件都攥在手里** ——
 * 「什么时候 open、什么时候收帧、什么时候断」必须是测试的显式动作，
 * 否则「3s 超时重发」「退避 1s→2s」「连续 2 次心跳超时判死」这些断言就只能靠真等。
 *
 * ⚠️ readyState 的数字必须与全局 WebSocket 一致（内核读的是 `WebSocket.OPEN`）：
 * 这里直接用 `WebSocket.OPEN` 等静态值，而不是自己写 1/3。
 */
export class MockWebSocket {
  static readonly CONNECTING = WebSocket.CONNECTING;
  static readonly OPEN = WebSocket.OPEN;
  static readonly CLOSING = WebSocket.CLOSING;
  static readonly CLOSED = WebSocket.CLOSED;

  readyState: number = MockWebSocket.CONNECTING;
  binaryType: string = 'blob';
  bufferedAmount = 0;

  /** 客户端**发出去**的帧（已序列化的字符串）—— 断言"发了什么、发了几个"就看它 */
  readonly sent: string[] = [];
  /** close() 收到的参数 —— 断言"是不是用 1000 关的"（心跳判死那条） */
  readonly closeCalls: { code: number; reason: string }[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {}

  // ── 测试侧驱动 ─────────────────────────────────────────────
  /** 连接建立 */
  acceptOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  /** 服务端推来一帧（字符串走业务，其余走二进制分支） */
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** 服务端推一个 JSON 消息 */
  deliverJson(msg: unknown): void {
    this.deliver(JSON.stringify(msg));
  }

  /** 连接断开：code 默认 1006（异常中断，浏览器在没收到关闭帧时给的就是它） */
  drop(code = 1006, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  // ── 内核调用的 API ─────────────────────────────────────────
  send(raw: string): void {
    this.sent.push(String(raw));
  }

  close(code = 1000, reason = ''): void {
    this.closeCalls.push({ code, reason });
    this.drop(code, reason);
  }

  /** 断言辅助：客户端发出的帧解析成对象 */
  sentFrames<T = any>(): T[] {
    return this.sent.map((raw) => JSON.parse(raw) as T);
  }
}

/** 造一个「内核 + 它建过的所有 socket」的测试台 */
export function createSocketHarness() {
  const sockets: MockWebSocket[] = [];
  return {
    sockets,
    createSocket: (url: string) => {
      const socket = new MockWebSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    /** 最近一条连接（重连会换新的） */
    current: () => sockets[sockets.length - 1]!,
  };
}
