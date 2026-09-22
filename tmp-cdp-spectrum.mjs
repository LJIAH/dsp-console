/**
 * 一次性取证脚本（跑完即删）
 * 用 CDP 真实鼠标事件（element.click() 的 isTrusted=false，不算用户手势，
 * AudioContext.resume() 会被拒）切本地分析 → 载入内置样本 → 播放，
 * 然后读频谱 canvas 的横向 8 等分像素分布 + 截图。
 */
import http from 'node:http';
import fs from 'node:fs';
import WebSocket from 'ws';

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

const tag = process.argv[2] ?? 'before';

let page = null;
for (let i = 0; i < 24 && !page; i += 1) {
  try {
    const list = await getJSON('http://127.0.0.1:9222/json/list');
    page = list.find((t) => t.type === 'page' && String(t.url).includes('5173'));
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
const pending = new Map();
const errors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(String(m.params?.exceptionDetails?.exception?.description ?? '').slice(0, 160));
  }
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
await new Promise((r) => ws.on('open', r));
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;

await send('Runtime.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(3200);

/** 用真实鼠标事件点按钮（文案或 title 包含指定字符串） */
const clickBy = async (text) => {
  const box = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) =>
      (x.textContent || '').includes(${JSON.stringify(text)}) ||
      (x.getAttribute('title') || '').includes(${JSON.stringify(text)}));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);
  if (!box) return false;
  const { x, y } = JSON.parse(box);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  return true;
};

console.log('切到本地分析 :', await clickBy('本地分析'));
await sleep(400);

const fileArg = process.argv[3];
if (fileArg) {
  await send('DOM.enable');
  const doc = await send('DOM.getDocument');
  const node = await send('DOM.querySelector', {
    nodeId: doc.result.root.nodeId,
    selector: 'input[type=file]',
  });
  await send('DOM.setFileInputFiles', { files: [fileArg], nodeId: node.result.nodeId });
  console.log('注入文件     :', fileArg);
} else {
  console.log('载入内置样本 :', await clickBy('内置'));
}
await sleep(900);
console.log('点击播放     :', await clickBy('播放'));
await sleep(2600);

// canvas 探针：横向 16 等分，统计每段"有内容"的比例
const probe = await evaluate(`(() => {
  const out = [];
  [...document.querySelectorAll('canvas')].forEach((c, idx) => {
    const r = c.getBoundingClientRect();
    let seg;
    try {
      const ctx = c.getContext('2d');
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const n = 16;
      seg = [];
      for (let s = 0; s < n; s += 1) {
        const x0 = Math.floor((s / n) * c.width);
        const x1 = Math.max(Math.floor(((s + 1) / n) * c.width), x0 + 1);
        let on = 0;
        let tot = 0;
        for (let y = 0; y < c.height; y += 2) {
          for (let x = x0; x < x1; x += 2) {
            const i = (y * c.width + x) * 4;
            tot += 1;
            if (img.data[i] + img.data[i + 1] + img.data[i + 2] > 110) on += 1;
          }
        }
        seg.push(Math.round((on / Math.max(tot, 1)) * 100));
      }
    } catch (e) {
      seg = 'ERR ' + e.message;
    }
    out.push({ idx, cssW: Math.round(r.width), cssH: Math.round(r.height), top: Math.round(r.top), seg });
  });
  return JSON.stringify(out);
})()`);

console.log('\ncanvas 探针（seg = 横向 16 等分「有内容」百分比）：');
for (const c of JSON.parse(probe ?? '[]')) {
  console.log(`  canvas#${c.idx}  ${c.cssW}×${c.cssH} @top=${c.top}`);
  console.log(`    ${Array.isArray(c.seg) ? c.seg.join(' ') : c.seg}`);
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
const file = `g:/复习/dsp-console/tmp-viz-${tag}.png`;
fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
console.log('\n截图已保存：' + file);
if (errors.length) console.log('页面错误：\n' + errors.slice(-4).join('\n'));
process.exit(0);
