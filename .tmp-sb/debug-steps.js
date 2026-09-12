// 调试：逐步验证（容错）
const http = require('http');
function getTargets() {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:9222/json', (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    ws.addEventListener('open', () => resolve({
      send: (method, params = {}) => new Promise((r) => { const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })); }),
      close: () => ws.close(),
    }));
    ws.addEventListener('error', reject);
  });
}
(async () => {
  const list = await getTargets();
  const page = list.find((t) => t.type === 'page' && String(t.url).includes('127.0.0.1'));
  const c = await connect(page.webSocketDebuggerUrl);
  const ev = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面: ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || expr.slice(0, 60)));
    return r.result && r.result.result && r.result.result.value;
  };
  const out = {};
  const steps = [
    ['折叠_初始子项可见', "!!document.querySelector('.nav-sub')"],
    ['折叠_第一次点击', 'CLICK_NAVTASKS'],
    ['折叠_收起判定', "getComputedStyle(document.querySelector('.nav-sub')).display === 'none'"],
    ['折叠_第二次点击', 'CLICK_NAVTASKS'],
    ['折叠_展开判定', "getComputedStyle(document.querySelector('.nav-sub')).display !== 'none'"],
    ['图片页_打开', 'CLICK_NAVIMAGE'],
    ['参考图面板未隐藏', "!document.querySelector('#imageRefPanel').hidden"],
    ['选flare模型', 'SELECT_FLARE'],
    ['flare价格显示', "document.querySelector('#imageCurrentPrice').textContent"],
  ];
  for (const [name, expr] of steps) {
    try {
      if (expr === 'CLICK_NAVTASKS') { await ev("document.querySelector('#navTasks').click()"); await new Promise((r) => setTimeout(r, 300)); out[name] = 'ok'; continue; }
      if (expr === 'CLICK_NAVIMAGE') { await ev("document.querySelector('#navImage').click()"); await new Promise((r) => setTimeout(r, 400)); out[name] = 'ok'; continue; }
      if (expr === 'SELECT_FLARE') { await ev("(function(){ const s = document.querySelector('#imageModelSelect'); s.value = 'gpt-image-2.5-flare'; s.dispatchEvent(new Event('change', { bubbles: true })); })()"); await new Promise((r) => setTimeout(r, 300)); out[name] = 'ok'; continue; }
      out[name] = await ev(expr);
    } catch (err) { out[name] = '错误: ' + err.message; }
  }
  console.log(JSON.stringify(out, null, 2));
  c.close();
  process.exit(0);
})().catch((e) => { console.error('外层失败:', e.message); process.exit(1); });
