/**
 * 一次性验证（跑完即删）：outbox 什么时候才不是 0？
 * 预期：只有"断线状态下触发了走 send() 通道的消息"才入队；
 *     断线后唯一容易触发的就是切换设备（cmd.focus）。
 */
import http from 'node:http';
import WebSocket from 'ws';

const PORT = process.env.WEB_PORT ?? '5175';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (url) =>
  new Promise((res, rej) => {
    http
      .get(url, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try {
            res(JSON.parse(d));
          } catch (e) {
            rej(e);
          }
        });
      })
      .on('error', rej);
  });

let page = null;
for (let i = 0; i < 30 && !page; i += 1) {
  try {
    const list = await getJSON('http://127.0.0.1:9222/json/list');
    page = list.find((t) => t.type === 'page' && String(t.url).includes(PORT));
  } catch {
    /* 未就绪 */
  }
  if (!page) await sleep(500);
}
if (!page) {
  console.log('NO_PAGE');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
let id = 0;
const calls = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && calls.has(m.id)) {
    calls.get(m.id)(m);
    calls.delete(m.id);
  }
});
await new Promise((r) => ws.on('open', r));
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    calls.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;

await send('Runtime.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(3200);

const realClick = async (getBoxExpr) => {
  const boxRaw = await evaluate(`${getBoxExpr}`);
  if (!boxRaw) return false;
  const { x, y } = JSON.parse(boxRaw);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  return true;
};

const clickByText = (text) =>
  realClick(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes(${JSON.stringify(text)}));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);

const clickDevice = (index) =>
  realClick(`(() => {
    const btns = [...document.querySelectorAll('section ul li button')];
    const b = btns[${index}];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);

const report = async (label) => {
  const raw = await evaluate(`(() => {
    const read = (name) => {
      const leaf = [...document.querySelectorAll('*')].find(
        (e) => e.children.length === 0 && (e.textContent || '').trim() === name,
      );
      if (!leaf) return null;
      const m = /(\\d+)/.exec((leaf.parentElement ?? leaf).textContent || '');
      return m ? Number(m[1]) : null;
    };
    const badge = ['已连接', '连接中', '重连中', '已断开', '已放弃'].find((t) =>
      document.body.innerText.includes(t),
    );
    const sel = [...document.querySelectorAll('section ul li button')].findIndex((b) =>
      (b.className || '').includes('bg-slate-700'),
    );
    return JSON.stringify({ outbox: read('outbox'), inflight: read('在途指令'), state: badge ?? '?', sel });
  })()`);
  const s = JSON.parse(raw ?? '{}');
  console.log(
    `${label.padEnd(26)} outbox=${String(s.outbox).padEnd(3)} 在途=${String(s.inflight).padEnd(3)} 状态=${s.state}  选中第 ${s.sel + 1} 台`,
  );
  return s;
};

const geomRaw = await evaluate(`(() => {
  const el = document.querySelector('[aria-label="CH1 增益"]');
  const r = el.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left + r.width / 2), top: Math.round(r.top), h: Math.round(r.height) });
})()`);
const geom = JSON.parse(geomRaw);

await report('① 初始（已连接）');

await clickByText('主动断开');
await sleep(700);
await report('② 主动断开后');

// 断线拖动：预览是易失消息 → 不入队
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geom.x, y: Math.round(geom.top + geom.h * 0.75), button: 'left', clickCount: 1, buttons: 1 });
for (const f of [0.6, 0.45, 0.3]) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geom.x, y: Math.round(geom.top + geom.h * f), button: 'left', buttons: 1 });
  await sleep(150);
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geom.x, y: Math.round(geom.top + geom.h * 0.3), button: 'left', clickCount: 1, buttons: 0 });
await sleep(400);
await report('③ 断线拖滑块后');

// 断线切设备：focus 走 send() → 入队
console.log('   → 断线状态下点了第 2 台设备');
await clickDevice(1);
await sleep(600);
await report('④ 断线切设备后');

await clickByText('重新连接');
await sleep(3500);
await report('⑤ 重连 3.5 秒后');
process.exit(0);
