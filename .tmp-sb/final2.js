// 最终验证：全新实例上完整走一遍提交链路
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
    const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面: ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || ''));
    return r.result && r.result.result && r.result.result.value;
  };
  const out = {};
  await ev("window.alert = (m) => { window.__alert = m; }; window.confirm = () => true;");
  await ev("document.querySelector('#navImage').click()");
  await new Promise((r) => setTimeout(r, 400));
  await ev("(function(){ const s = document.querySelector('#imageModelSelect'); s.value = 'gpt-image-2.5-flare'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await new Promise((r) => setTimeout(r, 300));
  out.模型 = await ev("document.querySelector('#imageModelSelect').value");
  out.价格 = await ev("document.querySelector('#imageCurrentPrice').textContent");
  await ev("(function(){ const box = document.querySelector('#imagePrompt'); box.value = '夜空下的灯塔，光束穿透云层'; box.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await ev("(function(){ const inputs = document.querySelectorAll('#imageRefLinks input'); inputs[0].value = 'http://127.0.0.1:8787/api/tasks/WV-260912-001/image/0'; inputs[0].dispatchEvent(new Event('input', { bubbles: true })); })()");
  await new Promise((r) => setTimeout(r, 300));
  out.参考图预览 = await ev("document.querySelectorAll('#imageRefPreviews img').length");
  await ev("window.__called = 0; const __orig = submitImageBatch; window.submitImageBatch = function (...a) { window.__called++; return __orig.apply(this, a); };");
  const before = await ev("state.tasks.filter((t) => t.kind === 'image').length");
  await ev("document.querySelector('#submitImageBatch').click()");
  await new Promise((r) => setTimeout(r, 2500));
  out.函数被调用 = await ev("window.__called");
  out.任务数变化 = before + ' → ' + await ev("state.tasks.filter((t) => t.kind === 'image').length");
  out.提交后任务 = await ev("(function(){ const t = state.tasks.filter((t) => t.kind === 'image').sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]; return t ? t.id + ':' + t.status + ':参考图' + (t.reference_images || []).length : 'none'; })()");
  const taskId = out.提交后任务.split(':')[0];
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 15000));
    const status = await ev("(function(){ const t = state.tasks.find((x) => x.id === '" + taskId + "'); return t ? t.status + '|' + (t.image_files || []).length + '|费用' + (typeof t.cost === 'number' ? t.cost : '无') + '|' + (t.error || '') : 'none'; })()");
    process.stdout.write(`  ${i + 1}: ${status}\n`);
    if (/^completed|^failed/.test(status)) { out.最终 = status; break; }
  }
  await c.send('Page.enable');
  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log(JSON.stringify(out, null, 2));
  c.close();
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
