// 最终端到端验证：选择模型 → 价格 → 图生图提交 → 轮询 → 完成
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

  const catUrl = 'http://127.0.0.1:8787/api/tasks/WV-260912-001/image/0';
  const out = {};

  // 选择 flare 模型
  await ev("(function(){ const s = document.querySelector('#imageModelSelect'); s.value = 'gpt-image-2.5-flare'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await new Promise((r) => setTimeout(r, 400));
  out.选中模型 = await ev("document.querySelector('#imageModelSelect').value");
  out.当前价格 = await ev("document.querySelector('#imageCurrentPrice').textContent");

  // 填提示词 + 参考图
  await ev("(function(){ const box = document.querySelector('#imagePrompt'); box.value = '参考这张图，把背景换成雪夜森林，保持主体不变'; box.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await ev("(function(){ const inputs = document.querySelectorAll('#imageRefLinks input'); inputs[0].value = '" + catUrl + "'; inputs[0].dispatchEvent(new Event('input', { bubbles: true })); })()");
  await new Promise((r) => setTimeout(r, 400));
  out.参考图预览 = await ev("document.querySelectorAll('#imageRefPreviews img').length");

  // 提交
  await ev("document.querySelector('#submitImageBatch').click()");
  await new Promise((r) => setTimeout(r, 2500));
  out.提交后 = await ev("(function(){ const t = state.tasks.filter((x) => x.kind === 'image').sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]; return t ? t.id + ':' + t.status + ':参考图' + (t.reference_images || []).length : '未找到'; })()");

  // 轮询至完成（最长 10 分钟）
  const taskId = out.提交后.split(':')[0];
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 15000));
    const status = await ev("(function(){ const t = state.tasks.find((x) => x.id === '" + taskId + "'); return t ? t.status + '|' + (t.image_files || []).length + '|' + (t.error || '') + '|费用' + (typeof t.cost === 'number' ? t.cost : '无') : 'none'; })()");
    process.stdout.write(`  ${i + 1}: ${status}\n`);
    if (/^completed|^failed/.test(status)) { out.最终状态 = status; break; }
  }

  out.缩略图 = await ev("(function(){ const t = state.tasks.find((x) => x.id === '" + taskId + "'); return t ? document.querySelectorAll('#imageTaskTable tr img').length : 0; })()");

  // 任务记录：图片任务子项 + 费用
  await ev("document.querySelector('#navTasksImage').click()");
  await new Promise((r) => setTimeout(r, 500));
  out.图片记录费用列 = await ev("[...document.querySelectorAll('#recordTaskTable .cost-cell')].slice(0, 4).map((c) => c.textContent).join(',')");

  await c.send('Page.enable');
  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync('D:/code/视频生成工作台/.tmp-sb/final.png', Buffer.from(shot.result.data, 'base64'));
  console.log(JSON.stringify(out, null, 2));
  c.close();
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
