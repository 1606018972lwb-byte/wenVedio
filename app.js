// wenVedio · 视频生成工作台 前端逻辑
// 说明：真实 API 由后端 server.js 代理，浏览器不再持有长期 API Key。
// 演示模式（mock）在浏览器本地模拟完整流程，用于快速评审。

const DEFAULTS = { apiBase: '', mock: false };

const state = {
  tasks: [
    { id: 'FF-240831-001', name: '夏日气泡水 · 01', prompt: '玻璃杯中的气泡水在阳光下闪闪发光，镜头缓慢推进', resolution: '768p', duration: 5, status: 'processing', progress: 68, time: '刚刚' },
    { id: 'FF-240831-000', name: '夏日气泡水 · 预告', prompt: '清晨露珠落在薄荷叶上，微距镜头，清透自然', resolution: '768p', duration: 5, status: 'completed', progress: 100, time: '12 分钟前' },
    { id: 'FF-240830-014', name: '产品静物 · A 版', prompt: '白色背景上的产品静物，柔和侧光，极简商业摄影', resolution: '480p', duration: 5, status: 'queued', progress: 0, time: '昨天 18:42' },
  ],
  filter: 'all',
  selected: new Set(),
  rows: [],
  pollTimers: [],
};
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('frameflow-settings') || '{}') }; }
  catch (_) { return DEFAULTS; }
}
let settings = loadSettings();

function addRow(value = '') { state.rows.push(value); renderRows(); }

function renderRows() {
  const wrap = $('#promptRows');
  wrap.innerHTML = '';
  state.rows.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'prompt-row';
    row.innerHTML = `<span class="row-number">${String(i + 1).padStart(2, '0')}</span><input value="${String(v).replaceAll('"', '&quot;')}" placeholder="输入第 ${i + 1} 条提示词" /><button class="remove-row" title="删除">×</button>`;
    row.querySelector('input').addEventListener('input', (e) => { state.rows[i] = e.target.value; });
    row.querySelector('.remove-row').addEventListener('click', () => { state.rows.splice(i, 1); renderRows(); });
    wrap.appendChild(row);
  });
  updateCost();
}

function updateCost() {
  const count = state.rows.filter(Boolean).length || 1;
  $('#costEstimate').textContent = `¥ ${(count * Number($('#duration').value || 3) * 0.02).toFixed(2)}`;
}

function statusMarkup(t) {
  const labels = { submitting: '提交中', queued: '排队中', processing: '生成中', completed: '已完成', failed: '失败' };
  const st = t.status in labels ? t.status : 'queued';
  return `<span class="state ${st}"><i></i>${labels[st]}</span>${st === 'processing' || st === 'submitting' ? `<div class="progress"><i style="width:${t.progress || 8}%"></i></div>` : ''}`;
}

function renderTasks() {
  const tbody = $('#taskTable');
  const filtered = state.tasks.filter((t) => state.filter === 'all' || t.status === state.filter);
  tbody.innerHTML = '';
  filtered.forEach((t) => {
    const tr = document.createElement('tr');
    tr.dataset.id = t.id;
    tr.innerHTML = `<td class="check-col"><input type="checkbox" ${state.selected.has(t.id) ? 'checked' : ''} /></td><td><div class="task-name">${t.name}</div><div class="task-id">${escapeHtml(t.id)} · ${escapeHtml(t.prompt)}</div></td><td><span class="resolution-tag">${t.resolution || '768p'}</span></td><td>${t.duration}s</td><td class="progress-cell">${statusMarkup(t)}</td><td>${t.time}</td><td class="row-menu">•••</td>`;
    tr.querySelector('input').addEventListener('change', (e) => {
      e.target.checked ? state.selected.add(t.id) : state.selected.delete(t.id);
      updateSelection();
    });
    tbody.appendChild(tr);
  });
  $('#taskTotal').textContent = state.tasks.length;
  $('#emptyState').hidden = filtered.length > 0;
  updateSelection();
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function updateSelection() {
  const n = state.selected.size;
  $('#selectedCount').textContent = n;
  $('#downloadSelected').disabled = !n;
  $("#selectAll").checked = n > 0 && n === state.tasks.filter((t) => state.filter === 'all' || t.status === state.filter).length;
}

// 演示模式：模拟任务从排队到完成
function simulateTask(localId) {
  const t = state.tasks.find((x) => x.id === localId);
  if (!t) return;
  let p = 8;
  const timer = setInterval(() => {
    p += Math.floor(Math.random() * 18) + 8;
    if (p >= 100) { p = 100; clearInterval(timer); t.status = 'completed'; }
    else { t.status = 'processing'; t.progress = p; }
    renderTasks();
  }, 600);
  state.pollTimers.push(timer);
}

async function submitBatch() {
  const prompt = $('#prompt').value.trim();
  if (!prompt) { $('#prompt').focus(); return; }
  const prompts = state.rows.filter(Boolean);
  if (!prompts.length) prompts.push(prompt);
  const name = $('#batchName').value || '未命名批次';
  const duration = Number($('#duration').value) || 3;
  const reference = $('#reference').value.trim();

  const localTasks = prompts.map((p, i) => ({
    id: `WV-${Date.now().toString().slice(-6)}-${String(i + 1).padStart(3, '0')}`,
    name: `${name} · ${String(i + 1).padStart(2, '0')}`,
    prompt: p,
    resolution: $('#resolution').value,
    duration,
    status: settings.mock ? 'processing' : 'submitting',
    progress: settings.mock ? 8 : 0,
    time: '刚刚',
    reference: reference,
  }));

  // 演示模式：本地模拟，不请求后端
  if (settings.mock) {
    state.tasks.unshift(...localTasks);
    renderTasks();
    localTasks.forEach((t) => { t.status = 'processing'; simulateTask(t.id); });
    return;
  }

  // 真实模式：提交到本地后端
  try {
    const res = await fetch(`${settings.apiBase}/api/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        tasks: prompts.map((p) => ({
          prompt: p,
          duration,
          resolution: $('#resolution').value,
          reference_images: reference ? [reference] : [],
        })),
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);

    // 用后端返回的本地任务 id 重新登记
    data.tasks.forEach((t, i) => {
      const base = localTasks[i] || localTasks[0];
      state.tasks.unshift({
        id: t.local_id,
        name: base.name,
        prompt: t.prompt,
        resolution: $('#resolution').value,
        duration: t.duration,
        status: t.status,
        progress: t.status === 'submitting' ? 8 : 0,
        error: t.error,
        provider_task_id: t.provider_task_id,
        time: '刚刚',
      });
    });
    renderTasks();
    // 开始轮询真实任务
    data.tasks.filter((t) => t.local_id && t.status !== 'failed').forEach((t) => pollTask(t.local_id));
  } catch (err) {
    alert(`提交失败：${err.message}`);
  }
}

// 轮询单个任务状态
function pollTask(localId) {
  const t = state.tasks.find((x) => x.id === localId);
  if (!t) return;
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`${settings.apiBase}/api/tasks/${localId}`);
      const data = await res.json();
      if (!data.ok) return;
      const remote = data.task;
      t.status = remote.status || t.status;
      t.error = remote.error || null;
      if (remote.video_url) { t.video_url = remote.video_url; }
      if (remote.status === 'completed') { t.progress = 100; clearInterval(timer); }
      else if (remote.status === 'failed') { clearInterval(timer); }
      else { t.progress = remote.progress || t.progress || 8; }
      renderTasks();
    } catch (_) { /* 网络抖动忽略 */ }
  }, 3000);
  state.pollTimers.push(timer);
}

function downloadSelected() {
  let any = false;
  state.selected.forEach((id) => {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    if (t.video_url) {
      window.open(t.video_url, '_blank');
      any = true;
    } else if (settings.mock && (t.status === 'completed' || t.status === 'processing')) {
      const blob = new Blob([`wenVedio demo video\nTask: ${t.id}\nPrompt: ${t.prompt}`], { type: 'video/mp4' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${String(t.name).replaceAll(' ', '_')}.mp4`;
      a.click();
      URL.revokeObjectURL(a.href);
      any = true;
    }
  });
  if (!any) alert('无法下载：真实视频地址需配置服务端登录令牌后由平台返回，或当前任务未完成。');
}

function openSettings() {
  const s = settings;
  $('#apiEndpoint').value = s.apiBase || 'http://127.0.0.1:8787';
  $('#workflowId').value = 'minimax_h3_lightx2v_v5_15s';
  $('#apiKey').value = '由服务端管理';
  $('#mockMode').checked = s.mock;
  $('#settingsModal').hidden = false;
}

function saveSettings() {
  settings = {
    apiBase: $('#apiEndpoint').value.trim().replace(/\/$/, '') || DEFAULTS.apiBase,
    mock: $('#mockMode').checked,
  };
  localStorage.setItem('frameflow-settings', JSON.stringify(settings));
  $('#settingsModal').hidden = true;
}

async function testConnection() {
  const result = $('#testResult');
  result.style.color = 'var(--green)';
  try {
    if (settings.mock) { result.textContent = '演示模式已就绪，无需请求后端。'; return; }
    const res = await fetch(`${settings.apiBase}/api/health`);
    const data = await res.json();
    if (data.ok) {
      result.textContent = `后端已连接 · 工作流：${data.workflow} · ${data.mock ? '演示模式' : '真实 API'}`;
    } else {
      result.textContent = `后端返回异常：${data.msg || res.status}`;
    }
  } catch (err) {
    result.style.color = '#db5c52';
    result.textContent = `连接失败：${err.message}，请确认已运行 node server.js`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  addRow('镜头切入一杯冰镇气泡水，阳光穿过玻璃，商业广告质感');
  addRow('气泡在杯中升起，背景是夏日泳池，镜头平滑推进');
  renderTasks();

  $('#addRow').addEventListener('click', () => addRow());
  $('#duration').addEventListener('input', updateCost);
  $('#submitBatch').addEventListener('click', submitBatch);
  $('#downloadSelected').addEventListener('click', downloadSelected);
  $('#openSettings').addEventListener('click', openSettings);
  $('#closeSettings').addEventListener('click', () => { $('#settingsModal').hidden = true; });
  $('#saveSettings').addEventListener('click', saveSettings);
  $('#testConnection').addEventListener('click', testConnection);
  $('#clearForm').addEventListener('click', () => {
    $('#batchName').value = '';
    $('#prompt').value = '';
    $('#reference').value = '';
    state.rows = [];
    renderRows();
  });
  $('#toggleKey').addEventListener('click', () => {
    const i = $('#apiKey');
    i.type = i.type === 'password' ? 'text' : 'password';
    $('#toggleKey').textContent = i.type === 'password' ? '显示' : '隐藏';
  });
  $('#selectAll').addEventListener('change', (e) => {
    state.tasks.filter((t) => state.filter === 'all' || t.status === state.filter).forEach((t) => (e.target.checked ? state.selected.add(t.id) : state.selected.delete(t.id)));
    renderTasks();
  });
  $$('.segmented button').forEach((b) => b.addEventListener('click', () => {
    $$('.segmented button').forEach((x) => x.classList.remove('selected'));
    b.classList.add('selected');
    state.filter = b.dataset.filter;
    renderTasks();
  }));
});
