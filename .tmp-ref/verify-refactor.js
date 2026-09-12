// 一次性脚本：模型管理重构全面验证（通过 CDP）
const CDP = 'http://127.0.0.1:9222';
const OUT = process.env.SHOT || 'shot.png';
const fs = require('fs');

async function findPage() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`${CDP}/json`)).json();
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('127.0.0.1'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch (_) { /* 等待 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('未找到客户端页面调试目标');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        return new Promise((res) => {
          const mid = ++id;
          pending.set(mid, res);
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close: () => ws.close(),
    }));
    ws.addEventListener('error', reject);
  });
}

(async () => {
  const client = await connect((await findPage()).webSocketDebuggerUrl);
  async function evaluate(expression) {
    const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
      throw new Error(`页面报错: ${r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails)}`);
    }
    return r.result?.result?.value;
  }
  
  const result = {};
  await evaluate("window.confirm = () => true;");
  await evaluate("document.querySelector('#openSettings').click()");
  await new Promise((r) => setTimeout(r, 600));
  result.统计卡片 = await evaluate("[ '#statAllModels','#statImageModels','#statVideoModels','#statDisabledModels' ].map((s) => document.querySelector(s).textContent).join('/')");
  result.表格行数_第1页 = await evaluate("document.querySelectorAll('#modelTableBody tr').length");
  result.总数与分页 = await evaluate("document.querySelector('#modelTotal').textContent + '条|页码按钮' + document.querySelectorAll('#modelPager button').length");

  await evaluate("(function(){ const box = document.querySelector('#modelSearch'); box.value = 'flare'; box.dispatchEvent(new Event('input', { bubbles: true })); })()");
  result.搜索flare = await evaluate("document.querySelectorAll('#modelTableBody tr').length");
  await evaluate("(function(){ const box = document.querySelector('#modelSearch'); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); })()");

  await evaluate("(function(){ const box = document.querySelector('#modelFilterKind'); box.value = 'image'; box.dispatchEvent(new Event('change', { bubbles: true })); })()");
  result.筛选图片模型 = await evaluate("document.querySelectorAll('#modelTableBody tr').length");
  await evaluate("(function(){ const box = document.querySelector('#modelFilterKind'); box.value = ''; box.dispatchEvent(new Event('change', { bubbles: true })); })()");

  await evaluate("(function(){ const box = document.querySelector('#modelSort'); box.value = 'name'; box.dispatchEvent(new Event('change', { bubbles: true })); })()");
  result.按名称排序首行 = await evaluate("document.querySelector('#modelTableBody .model-info-copy b').textContent");
  await evaluate("(function(){ const box = document.querySelector('#modelSort'); box.value = 'manual'; box.dispatchEvent(new Event('change', { bubbles: true })); })()");

  await evaluate("document.querySelector('[data-model-test=\"minimax_h3_lightx2v_v5_15s\"]').click()");
  await new Promise((r) => setTimeout(r, 5000));
  result.测试连接 = await evaluate("(document.querySelector('.model-test-inline')||{textContent:'(无结果)'}).textContent");

  await evaluate("document.querySelector('[data-model-edit=\"minimax_h3_lightx2v_v5_15s\"]').click()");
  await new Promise((r) => setTimeout(r, 400));
  result.抽屉打开 = await evaluate("!document.querySelector('#modelEditorBackdrop').hidden");
  result.Tab数量 = await evaluate("document.querySelectorAll('.drawer-tabs button').length");
  result.基础_模型名 = await evaluate("document.querySelector('#modelName').value");

  await evaluate("(function(){ document.querySelector('[data-model-tab=\"api\"]').click(); })()");
  result.接口_提交地址 = await evaluate("document.querySelector('#requestUrl').value.slice(0, 52)");
  result.接口_令牌选项 = await evaluate("document.querySelector('#modelToken').options.length");

  await evaluate("(function(){ document.querySelector('[data-model-tab=\"fields\"]').click(); })()");
  result.字段卡片数 = await evaluate("document.querySelectorAll('#fieldBuilder .field-card').length");
  await evaluate("(function(){ document.querySelector('#toggleFieldsJson').click(); })()");
  result.JSON模式可见 = await evaluate("!document.querySelector('#fieldJsonWrap').hidden");
  result.JSON首行 = await evaluate("document.querySelector('#modelFields').value.slice(0, 26)");
  await evaluate("(function(){ document.querySelector('#toggleFieldsJson').click(); })()");

  await evaluate("(function(){ document.querySelector('[data-model-tab=\"pricing\"]').click(); })()");
  result.计费方式 = await evaluate("document.querySelector('#pricingUnit').value");
  result.峰谷开关 = await evaluate("document.querySelector('#priceTierEnabled').checked");
  result.分辨率规则行 = await evaluate("document.querySelectorAll('#priceResRows .price-res-row').length");
  result.价格预览1 = await evaluate("document.querySelector('#preview1Label').textContent + ' = ' + document.querySelector('#preview1Value').textContent");

  await evaluate("(function(){ document.querySelector('[data-model-tab=\"advanced\"]').click(); })()");
  result.危险操作存在 = await evaluate("!!document.querySelector('#deleteModel')");

  // 保存 + 持久化
  await evaluate("(function(){ const box = document.querySelector('#modelDescription'); box.value = '重构测试描述'; box.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await evaluate("document.querySelector('#saveSettings').click()");
  await new Promise((r) => setTimeout(r, 900));
  result.保存后抽屉仍开 = await evaluate("!document.querySelector('#modelEditorBackdrop').hidden");
  result.上次保存 = await evaluate("document.querySelector('#drawerSavedAt').textContent");
  result.持久化 = await evaluate("(async () => { const r = await fetch('/api/models'); const d = await r.json(); const m = d.models.find((x) => x.id === 'minimax_h3_lightx2v_v5_15s'); return (m.description || '') + '|' + (m.enabled === true) + '|updated:' + (m.updated_at || '').slice(11, 19); })()");

  // 未保存关闭守卫
  await evaluate("(function(){ const box = document.querySelector('#modelName'); box.value = box.value + 'X'; box.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await evaluate("document.querySelector('#closeModelEditor').click()");
  result.未保存确认出现 = await evaluate("!document.querySelector('#modelCloseConfirm').hidden");
  await evaluate("document.querySelector('#modelCloseContinue').click()");
  await evaluate("document.querySelector('#closeModelEditor').click()");
  await evaluate("document.querySelector('#modelCloseDiscard').click()");
  result.放弃修改后关闭 = await evaluate("document.querySelector('#modelEditorBackdrop').hidden");

  // 恢复描述 + 停用/启用测试（用最后一个模型 gpt-image-2.5-flare）
  await evaluate("(function(){ const box = document.querySelector('#modelDescription'); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await evaluate("document.querySelector('#saveSettings').click()");
  await new Promise((r) => setTimeout(r, 700));
  result.停用_toggle = await evaluate("(async () => { const r = await fetch('/api/models'); const d = await r.json(); const m = d.models.find((x) => x.id === 'gpt-image-2.5-flare'); const res = await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: { ...m, enabled: false } }) }); const d2 = await res.json(); return d2.ok && d2.model.enabled === false; })()");
  result.停用后统计 = await evaluate("document.querySelector('#statDisabledModels').textContent");
  result.重新启用 = await evaluate("(async () => { const r = await fetch('/api/models'); const d = await r.json(); const m = d.models.find((x) => x.id === 'gpt-image-2.5-flare'); const res = await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: { ...m, enabled: true } }) }); const d2 = await res.json(); return d2.ok && d2.model.enabled === true; })()");
  await evaluate("(function(){ const box = document.querySelector('#modelSearch'); box.value = 'zzz不存在的模型'; box.dispatchEvent(new Event('input', { bubbles: true })); })()");
  result.搜索无结果 = await evaluate("document.querySelectorAll('#modelTableBody tr').length");
  await evaluate("(function(){ const box = document.querySelector('#modelSearch'); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); })()");

  await client.send('Page.enable');
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log(JSON.stringify(result, null, 2));
  client.close();
  process.exit(0);
})().catch((err) => {
  console.error('验证失败:', err.message);
  process.exit(1);
});
