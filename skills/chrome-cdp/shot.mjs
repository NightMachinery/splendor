#!/usr/bin/env node
// Reliable Chrome screenshotter + DOM prober over the Chrome DevTools Protocol,
// talking straight to a headful Chrome on :9222 using Node's built-in WebSocket
// (Node >= 22). No dependencies, no MCP server in the loop.
//
// Usage:
//   node skills/chrome-cdp/shot.mjs --out=PATH [--path=/gameboard/?sessionId=ID]
//   node skills/chrome-cdp/shot.mjs --session=ID [--board=orient|cities|tradingposts]
//        [--user=NAME] [--display=NAME] [--token=TOKEN] [--vp=desktop|mobile] [--probe]

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || true];
  })
);

const {
  session = '',
  board = 'orient',
  path = '',
  user = '',
  display = '',
  token = '',
  refresh = '',
  vp = 'desktop',
  out,
  probe
} = args;

const ORIGIN = process.env.SPLENDOR_ORIGIN || 'http://localhost:3000';
const CDP = process.env.CHROME_CDP || 'http://127.0.0.1:9222';

const boardPath = (kind) => {
  if (kind === 'cities') return '/gameboard-cities/';
  if (kind === 'tradingposts' || kind === 'trading-posts' || kind === 'tp') return '/gameboard-tradingposts/';
  return '/gameboard/';
};

const targetPath = path || (session ? `${boardPath(board)}?sessionId=${encodeURIComponent(session)}` : '/');

const targets = await (await fetch(`${CDP}/json`)).json();
const target = targets.find((t) => t.type === 'page') || (await (await fetch(`${CDP}/json/new`)).json());

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d.result);
    pending.delete(d.id);
  }
};

await send('Page.enable');
await send('Runtime.enable');

const dims =
  vp === 'mobile'
    ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
    : { width: 1280, height: 850, deviceScaleFactor: 1, mobile: false };
await send('Emulation.setDeviceMetricsOverride', dims);

await send('Page.navigate', { url: `${ORIGIN}/` });
await new Promise((r) => setTimeout(r, 800));

const setLS = `(${(u, d, t, r) => {
  try {
    if (u) localStorage.setItem('username', u);
    if (d) localStorage.setItem('displayName', d);
    if (t) localStorage.setItem('accessToken', t);
    if (r) localStorage.setItem('refreshToken', r);
    return 'ok';
  } catch (e) {
    return '' + e;
  }
}})(${JSON.stringify(user)}, ${JSON.stringify(display || user)}, ${JSON.stringify(token)}, ${JSON.stringify(refresh)})`;
await send('Runtime.evaluate', { expression: setLS });

const url = new URL(targetPath, ORIGIN).toString();
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 2200));

if (probe) {
  const expr = `(${() => {
    const visible = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return cs.visibility !== 'hidden' && cs.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    return JSON.stringify({
      hscroll: document.documentElement.scrollWidth > window.innerWidth,
      iw: window.innerWidth,
      ih: window.innerHeight,
      sw: document.documentElement.scrollWidth,
      sh: document.documentElement.scrollHeight,
      boardVisible: visible('#board, .board'),
      tokenCount: document.querySelectorAll('board-token').length,
      visibleBoardCards: document.querySelectorAll('.board-card-dev[card-id], .board-card-dev img[src]').length,
      visibleNobles: document.querySelectorAll('.noble-card[card-id], .noble-card img[src]').length,
      modalVisible: [...document.querySelectorAll('.modal.show')].map((el) => el.id),
      body: document.body.innerText.slice(0, 600)
    });
  }})()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(r.result?.value || JSON.stringify(r));
}

if (out) {
  const cap = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (cap.data) {
    const fs = await import('fs');
    fs.writeFileSync(out, Buffer.from(cap.data, 'base64'));
    console.log('SAVED', out);
  } else {
    console.log('FAIL', JSON.stringify(cap).slice(0, 150));
  }
}

ws.close();
