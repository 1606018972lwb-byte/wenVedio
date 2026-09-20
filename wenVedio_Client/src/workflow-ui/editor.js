// 工作流 · 视图
// 原生 ES 模块，浏览器直接加载（<script type="module">），没有构建步骤。
// 结构：列表页 ⇄ 编辑器（左节点库 / 中画布 / 右配置面板）+ 运行记录 + Python 环境面板。
import { createCanvas, NODE_W, NODE_H } from './canvas.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (value) => String(value == null ? '' : value)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  root: null,
  meta: null,
  models: [],
  workflows: [],
  current: null,
  canvas: null,
  selectedNodeId: null,
  dirty: false,
  saveTimer: null,
  runTimer: null,
  activeRunId: null,
  pythonEnvs: null,
  pythonSelected: '',
  installTimer: null,
  view: 'list',
};

// ---------------- 接口 ----------------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
  return data;
}

// ---------------- 模板 ----------------
const TEMPLATES = [
  {
    name: '图片反推提示词',
    description: '上传一张图片 → 视觉模型分析 → 输出可复用的生成提示词',
    build: () => ({
      nodes: [
        { id: 'start_1', type: 'start', title: '开始', x: 60, y: 140, params: { fields: [{ key: 'image', label: '图片地址', type: 'text', required: true }] } },
        { id: 'vision_1', type: 'vision', title: '图片理解', x: 320, y: 140, params: { source: 'model', images: ['{{start_1.image}}'], temperature: 0.3, max_tokens: 1024 } },
        { id: 'text_1', type: 'text', title: '整理提示词', x: 580, y: 140, params: { mode: 'template', template: '{{vision_1.output}}' } },
        { id: 'end_1', type: 'end', title: '结束', x: 840, y: 140, params: { outputs: [{ key: 'prompt', value: '{{text_1.output}}' }] } },
      ],
      edges: [
        { id: 'e1', from: 'start_1', to: 'vision_1' },
        { id: 'e2', from: 'vision_1', to: 'text_1' },
        { id: 'e3', from: 'text_1', to: 'end_1' },
      ],
    }),
  },
  {
    name: '商品卖点文案',
    description: '输入商品名与卖点 → 大模型生成文案 → 输出结果',
    build: () => ({
      nodes: [
        { id: 'start_1', type: 'start', title: '开始', x: 60, y: 140, params: { fields: [
          { key: 'name', label: '商品名', type: 'text', required: true },
          { key: 'points', label: '卖点', type: 'text', required: false },
        ] } },
        { id: 'llm_1', type: 'llm', title: '生成文案', x: 320, y: 140, params: {
          source: 'deepseek', temperature: 0.8, max_tokens: 1024,
          system_prompt: '你是电商文案助手，输出简洁有力的中文卖点。',
          user_prompt: '商品：{{start_1.name}}\n卖点：{{start_1.points}}\n请输出 3 条卖点文案，每条不超过 20 字。',
        } },
        { id: 'end_1', type: 'end', title: '结束', x: 580, y: 140, params: { outputs: [{ key: 'copy', value: '{{llm_1.output}}' }] } },
      ],
      edges: [{ id: 'e1', from: 'start_1', to: 'llm_1' }, { id: 'e2', from: 'llm_1', to: 'end_1' }],
    }),
  },
  {
    name: '批量数据处理',
    description: '代码节点（支持 JavaScript / Python）加工上游数据并输出',
    build: () => ({
      nodes: [
        { id: 'start_1', type: 'start', title: '开始', x: 60, y: 140, params: { fields: [{ key: 'list', label: '数据(JSON 数组)', type: 'json', required: true }] } },
        { id: 'code_1', type: 'code', title: '处理数据', x: 320, y: 140, params: {
          language: 'javascript', timeout_ms: 30000,
          code: 'const list = Array.isArray(input.list) ? input.list : [];\nreturn { count: list.length, first: list[0] ?? null };',
        } },
        { id: 'end_1', type: 'end', title: '结束', x: 580, y: 140, params: { outputs: [{ key: 'result', value: '{{code_1.output}}' }] } },
      ],
      edges: [{ id: 'e1', from: 'start_1', to: 'code_1' }, { id: 'e2', from: 'code_1', to: 'end_1' }],
    }),
  },
];

// ---------------- 列表页 ----------------
function renderList() {
  const host = $('#wfListMode');
  const keyword = ($('#wfSearch')?.value || '').trim().toLowerCase();
  const list = state.workflows.filter((wf) => !keyword || `${wf.name} ${wf.description || ''}`.toLowerCase().includes(keyword));
  const cards = list.map((wf) => `
    <article class="wf-card" data-open="${esc(wf.id)}">
      <div class="wf-card-head">
        <span class="wf-card-title">${esc(wf.name)}</span>
        <span class="wf-state ${wf.published ? 'published' : 'draft'}">${wf.published ? `已发布 V${wf.published_version}` : '草稿'}</span>
      </div>
      <p class="wf-card-desc">${esc(wf.description || '—')}</p>
      <div class="wf-card-meta">
        <span>${(wf.nodes || []).length} 个节点</span>
        <span>运行 ${wf.run_count || 0} 次</span>
        <span>${wf.updated_at ? new Date(wf.updated_at).toLocaleString('zh-CN', { hour12: false }).slice(5, 16) : ''}</span>
      </div>
      <div class="wf-card-actions">
        <button type="button" data-open="${esc(wf.id)}">打开</button>
        <button type="button" data-run="${esc(wf.id)}">运行</button>
        <button type="button" data-copy="${esc(wf.id)}">复制</button>
        <button type="button" data-runs="${esc(wf.id)}">记录</button>
        <button type="button" class="danger" data-del="${esc(wf.id)}">删除</button>
      </div>
    </article>`).join('');

  const templateCards = TEMPLATES.map((tpl, index) => `
    <article class="wf-card" data-template="${index}">
      <div class="wf-card-head">
        <span class="wf-card-title">${esc(tpl.name)}</span>
        <span class="wf-state draft">模板</span>
      </div>
      <p class="wf-card-desc">${esc(tpl.description)}</p>
      <div class="wf-card-actions"><button type="button" data-template="${index}">使用模板</button></div>
    </article>`).join('');

  host.innerHTML = `
    <div class="wf-toolbar">
      <input id="wfSearch" type="search" placeholder="搜索工作流…" value="${esc($('#wfSearch')?.value || '')}" />
      <span class="grow"></span>
      <button class="outline-button accent" id="wfPythonEnv" type="button">🐍 Python 环境</button>
      <button class="primary-button" id="wfNew" type="button"><span>＋</span> 新建工作流</button>
    </div>
    <div class="wf-cards">${cards || ''}${templateCards}</div>
    ${state.workflows.length ? '' : '<div class="wf-empty">还没有工作流。点「新建工作流」从空白开始，或直接用下面的模板。</div>'}`;

  $('#wfSearch')?.addEventListener('input', () => renderList());
  $('#wfNew')?.addEventListener('click', () => createWorkflow());
  $('#wfPythonEnv')?.addEventListener('click', () => openPythonPanel());
  $$('[data-open]', host).forEach((el) => el.addEventListener('click', (event) => {
    if (event.target.closest('button[data-run],button[data-copy],button[data-runs],button[data-del]')) return;
    openWorkflow(el.dataset.open);
  }));
  $$('button[data-open]', host).forEach((el) => el.addEventListener('click', () => openWorkflow(el.dataset.open)));
  $$('button[data-run]', host).forEach((el) => el.addEventListener('click', () => promptRun(el.dataset.run)));
  $$('button[data-runs]', host).forEach((el) => el.addEventListener('click', () => openRunList(el.dataset.runs)));
  $$('button[data-copy]', host).forEach((el) => el.addEventListener('click', async () => {
    try { await api(`/api/workflows/${encodeURIComponent(el.dataset.copy)}/duplicate`, { method: 'POST' }); await loadWorkflows(); renderList(); }
    catch (err) { toast(`复制失败：${err.message}`, 'error'); }
  }));
  $$('button[data-del]', host).forEach((el) => el.addEventListener('click', async () => {
    if (!window.confirm('删除这个工作流？运行记录也会一起删掉。')) return;
    try { await api(`/api/workflows/${encodeURIComponent(el.dataset.del)}`, { method: 'DELETE' }); await loadWorkflows(); renderList(); toast('已删除'); }
    catch (err) { toast(`删除失败：${err.message}`, 'error'); }
  }));
  $$('[data-template]', host).forEach((el) => el.addEventListener('click', async () => {
    const tpl = TEMPLATES[Number(el.dataset.template)];
    if (!tpl) return;
    const built = tpl.build();
    const created = await createWorkflow({ name: tpl.name, description: tpl.description, ...built });
    if (created) toast(`已从模板创建：${tpl.name}`);
  }));
}

async function createWorkflow(preset) {
  try {
    const payload = preset || {
      name: `未命名工作流 ${state.workflows.length + 1}`,
      description: '',
      nodes: [{ id: 'start_1', type: 'start', title: '开始', x: 60, y: 140, params: { fields: [] } }],
      edges: [],
    };
    const data = await api('/api/workflows', { method: 'POST', body: payload });
    await loadWorkflows();
    renderList();
    await openWorkflow(data.workflow.id);
    return data.workflow;
  } catch (err) {
    toast(`创建失败：${err.message}`, 'error');
    return null;
  }
}

// ---------------- 编辑器 ----------------
function renderEditor() {
  const wf = state.current;
  if (!wf) return;
  const host = $('#wfEditMode');
  host.hidden = false;
  $('#wfListMode').hidden = true;

  host.innerHTML = `
    <div class="wf-head">
      <button class="wf-back" id="wfBack" type="button" title="返回列表">‹</button>
      <input class="wf-name-input" id="wfName" value="${esc(wf.name)}" maxlength="60" />
      <span class="wf-state ${wf.published ? 'published' : 'draft'}">${wf.published ? `已发布 V${wf.published_version}` : '草稿'}</span>
      <span class="wf-save-state" id="wfSaveState">已保存</span>
      <div class="wf-head-actions">
        <button type="button" id="wfUndo" title="撤销 Ctrl+Z">↶</button>
        <button type="button" id="wfRedo" title="重做 Ctrl+Y">↷</button>
        <button type="button" id="wfDebugNode" title="只运行选中的这一个节点">⚡ 测试节点</button>
        <button type="button" id="wfRuns">运行记录</button>
        <button type="button" id="wfPublish">发布</button>
        <button type="button" class="primary" id="wfRun" title="试运行整个工作流">▶ 试运行</button>
      </div>
    </div>
    <div class="wf-body" id="wfBody">
      <div class="wf-canvas-host" id="wfCanvasHost"></div>
      <aside class="wf-palette" id="wfPalette"></aside>
    </div>`;

  renderPalette();
  mountCanvas();
  renderInspector();

  $('#wfBack').addEventListener('click', backToList);
  $('#wfUndo').addEventListener('click', () => state.canvas.undo());
  $('#wfRedo').addEventListener('click', () => state.canvas.redo());
  $('#wfRun').addEventListener('click', () => promptRun(wf.id));
  $('#wfRuns').addEventListener('click', () => openRunList(wf.id));
  $('#wfPublish').addEventListener('click', publishCurrent);
  $('#wfDebugNode').addEventListener('click', debugSelectedNode);
  $('#wfName').addEventListener('input', () => { state.current.name = $('#wfName').value; markDirty(); });
}

// 节点库放在画布下方的「添加节点」面板（Coze 1.0 的位置）
function renderPalette() {
  const host = $('#wfPalette');
  const keyword = (host.dataset.search || '').toLowerCase();
  const collapsed = host.dataset.collapsed === '1';
  host.classList.toggle('collapsed', collapsed);
  const groups = new Map();
  for (const def of Object.values(state.meta?.nodes || {})) {
    if (keyword && !`${def.label} ${def.type} ${def.description}`.toLowerCase().includes(keyword)) continue;
    if (!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group).push(def);
  }
  const columns = [...groups.entries()].map(([group, list]) => `
    <div class="wf-palette-col">
      <div class="wf-palette-group">${esc(group)}</div>
      ${list.map((def) => `<button type="button" class="wf-node-btn" draggable="true" data-type="${esc(def.type)}" title="${esc(def.description || '')}">
        <span class="ico">${esc(def.icon || '●')}</span><span>${esc(def.label)}</span></button>`).join('')}
    </div>`).join('');
  host.innerHTML = `
    <div class="wf-palette-head">
      <b>添加节点</b>
      <input class="wf-palette-search" id="wfPaletteSearch" placeholder="搜索节点…" value="${esc(host.dataset.search || '')}" />
      <span class="wf-palette-tip">点一下加进画布，或拖到画布上的位置</span>
      <button type="button" class="wf-palette-toggle" id="wfPaletteToggle" title="${collapsed ? '展开' : '收起'}">${collapsed ? '＋' : '－'}</button>
    </div>
    <div class="wf-palette-body">${columns || '<div class="wf-palette-tip">没有匹配的节点</div>'}</div>`;

  $('#wfPaletteToggle')?.addEventListener('click', () => {
    host.dataset.collapsed = collapsed ? '0' : '1';
    renderPalette();
  });
  const search = $('#wfPaletteSearch');
  search?.addEventListener('input', () => { host.dataset.search = search.value; renderPalette(); $('#wfPaletteSearch')?.focus(); });
  $$('.wf-node-btn', host).forEach((button) => {
    button.addEventListener('click', () => {
      // 落在当前视口可见位置，避免新增节点跑到画布外面
      const hostRect = $('#wfCanvasHost').getBoundingClientRect();
      const center = state.canvas.screenToWorld(hostRect.left + hostRect.width / 2, hostRect.top + hostRect.height / 2);
      const offset = state.canvas.getGraph().nodes.length % 6;
      const node = state.canvas.addNode(button.dataset.type,
        { x: Math.round(center.x - NODE_W / 2 + offset * 18), y: Math.round(center.y - NODE_H / 2 + offset * 14) },
        state.meta.nodes[button.dataset.type]);
      state.selectedNodeId = node.id;
      renderInspector();
    });
    button.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/wf-node', button.dataset.type);
      event.dataTransfer.effectAllowed = 'copy';
    });
  });
}

function mountCanvas() {
  const host = $('#wfCanvasHost');
  // 旧的画布在 window 上挂了事件监听，重建前必须先销毁，否则监听会越积越多
  try { state.canvas?.destroy?.(); } catch (_) { /* 忽略 */ }
  state.canvas = null;
  host.innerHTML = '';
  state.canvas = createCanvas(host, {
    onChange: () => { markDirty(); syncSelectionLabel(); },
    // Coze：点选节点，右侧出现它的配置
    onSelect: (ids, edgeId) => {
      state.selectedNodeId = ids[0] || null;
      if (!state.selectedNodeId) closeInspector();
      else renderInspector();
      if (edgeId) closeInspector();
    },
    onStatus: (message) => toast(message),
    // 双击节点也打开配置（n8n 习惯）
    onOpenNode: (id) => { state.canvas.selectNode(id); state.selectedNodeId = id; renderInspector(); },
    // 右键节点出小菜单
    onNodeMenu: (id, event) => { state.canvas.selectNode(id); state.selectedNodeId = id; renderInspector(); openContextMenu(id, event); },
    onCanvasMenu: () => { closeInspector(); closeContextMenu(); },
    onEdgeMenu: (id, event) => openEdgeMenu(id, event),
    // 连线/节点上的「+」：先选节点类型，再插进去并自动接线
    onAddNode: (target) => openNodePicker(target),
    // 节点右上角的结果角标
    onNodeResult: (id) => openNodeResult(id),
    // 从条件分支节点连出来的线，立刻让它选属于哪个出口
    onEdgeCreated: (edgeId) => pickEdgeBranch(edgeId),
  });
  state.canvas.setGraph(state.current.nodes || [], state.current.edges || []);
  host.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
  host.addEventListener('drop', (event) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('text/wf-node');
    if (!type || !state.meta.nodes[type]) return;
    // 换算到画布坐标系，落点对准光标（此前忽略了平移与缩放，拖进来的节点会跑偏）
    const point = state.canvas.screenToWorld(event.clientX, event.clientY);
    const node = state.canvas.addNode(type, { x: point.x - NODE_W / 2, y: point.y - NODE_H / 2 }, state.meta.nodes[type]);
    state.selectedNodeId = node.id;
    renderInspector();
  });
  setTimeout(() => state.canvas?.fit(), 60);
}

function syncSelectionLabel() {
  const ids = state.canvas.getSelection();
  if (ids.length > 1) toast(`已选 ${ids.length} 个节点`);
}

function markDirty() {
  state.dirty = true;
  const label = $('#wfSaveState');
  if (label) label.textContent = '未保存…';
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => { saveCurrent().catch(() => {}); }, 900);
}

async function saveCurrent() {
  if (!state.current) return null;
  const graph = state.canvas.getGraph();
  const payload = {
    id: state.current.id,
    name: $('#wfName')?.value || state.current.name,
    description: state.current.description || '',
    nodes: graph.nodes,
    edges: graph.edges,
    variables: state.current.variables || [],
  };
  const data = await api('/api/workflows', { method: 'POST', body: payload });
  state.current = data.workflow;
  state.dirty = false;
  const label = $('#wfSaveState');
  if (label) label.textContent = `已保存 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  await loadWorkflows();
  return data.workflow;
}

async function openWorkflow(id) {
  try {
    const data = await api(`/api/workflows/${encodeURIComponent(id)}`);
    state.current = data.workflow;
    state.selectedNodeId = null;
    state.view = 'edit';
    renderEditor();
    await ensurePythonEnvs();
  } catch (err) { toast(`打开失败：${err.message}`, 'error'); }
}

function backToList() {
  if (state.dirty) saveCurrent().catch(() => {});
  stopRunPolling();
  state.view = 'list';
  state.current = null;
  state.canvas = null;
  $('#wfEditMode').hidden = true;
  $('#wfEditMode').innerHTML = '';
  $('#wfListMode').hidden = false;
  loadWorkflows().then(renderList).catch(() => {});
}

async function publishCurrent() {
  try {
    await saveCurrent();
    const data = await api(`/api/workflows/${encodeURIComponent(state.current.id)}/publish`, { method: 'POST' });
    state.current = data.workflow;
    renderEditor();
    toast(`已发布 V${data.workflow.version}`);
  } catch (err) { toast(`发布失败：${err.message}`, 'error'); }
}

// ---------------- 配置面板 ----------------
function paramVisible(param, values) {
  if (!param.showWhen) return true;
  for (const [key, expect] of Object.entries(param.showWhen)) {
    const actual = values[key];
    if (Array.isArray(expect)) { if (!expect.includes(actual)) return false; }
    else if (actual !== expect) return false;
  }
  return true;
}

// 节点实际对外暴露的输出：用户声明优先，否则用节点类型的默认声明
function effectiveOutputs(node, def) {
  if (Array.isArray(node?.output_params) && node.output_params.length) {
    return node.output_params.map((row) => ({ key: row.key, label: row.label || row.from || '', type: row.type || 'any' }));
  }
  const outputs = def?.outputs?.length ? def.outputs : [{ key: 'output', label: '输出' }];
  return outputs;
}

function upstreamPaths(nodeId) {
  const { nodes, edges } = state.canvas.getGraph();
  const incoming = new Map(nodes.map((n) => [n.id, []]));
  for (const edge of edges) if (incoming.has(edge.to)) incoming.get(edge.to).push(edge.from);
  const seen = new Set();
  const collect = (id) => {
    for (const parent of incoming.get(id) || []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      collect(parent);
    }
  };
  collect(nodeId);
  const out = [];
  for (const id of seen) {
    const node = nodes.find((n) => n.id === id);
    const def = state.meta.nodes[node?.type];
    if (!node || !def) continue;
    const outputs = effectiveOutputs(node, def);
    for (const output of outputs) {
      out.push({ path: `${id}.${output.key}`, group: node.title || node.type, label: output.label || output.key });
    }
  }
  return out;
}

// 节点配置是右侧面板：点选节点出现，取消选择收起（Coze 习惯）
function closeInspector() {
  const had = Boolean($('#wfInspector'));
  $('#wfInspector')?.remove();
  $('#wfBody')?.classList.remove('has-config');
  // 画布变宽了，没手动调过视角就重新适配
  if (had) setTimeout(() => state.canvas?.autoFit?.(), 40);
}

function renderInspector() {
  const id = state.selectedNodeId;
  const node = id ? state.canvas.getGraph().nodes.find((n) => n.id === id) : null;
  if (!node) { closeInspector(); return; }
  const def = state.meta.nodes[node.type] || { label: node.type, params: [], outputs: [] };
  const values = node.params || {};
  const runState = state.runNodeStates?.[node.id];

  closeInspector();
  const pop = document.createElement('aside');
  pop.className = 'wf-inspector';
  pop.id = 'wfInspector';
  pop.innerHTML = `
    <div class="wf-inspector-head">
      <span class="ico">${esc(def.icon || '●')}</span><b>${esc(node.title || def.label)}</b>
      <span class="type">${esc(node.type)}</span>
      <button type="button" class="wf-inspector-close" data-pop-close aria-label="收起">×</button>
    </div>
    <div class="wf-inspector-body">
      <label class="wf-field"><span class="lbl">节点名称</span><input type="text" id="wfNodeTitle" value="${esc(node.title || '')}" maxlength="60" /></label>
      ${def.params.map((param) => renderParam(param, values, node)).join('')}
      <div class="wf-insp-section">错误处理</div>
      <label class="wf-field"><span class="lbl">节点失败时</span>
        <select id="wfPolicy">
          <option value="stop"${node.error_policy === 'stop' ? ' selected' : ''}>停止整个工作流</option>
          <option value="continue"${node.error_policy === 'continue' ? ' selected' : ''}>继续执行下游</option>
          <option value="retry"${node.error_policy === 'retry' ? ' selected' : ''}>自动重试</option>
        </select>
      </label>
      ${node.error_policy === 'retry' ? `
        <label class="wf-field"><span class="lbl">最大重试次数</span><input type="number" id="wfMaxRetry" min="0" max="10" value="${Number(node.max_retry) || 0}" /></label>
        <label class="wf-field"><span class="lbl">重试间隔(毫秒)</span><input type="number" id="wfRetryInterval" min="0" max="60000" step="100" value="${Number(node.retry_interval_ms) || 2000}" /></label>` : ''}
      <div class="wf-insp-section">输入参数</div>
      <small class="help" style="display:block;margin-bottom:6px">不填就用上游第一个节点的输出；填了之后代码里用 <code>input.参数名</code> 取。</small>
      <div class="wf-rows" data-io="input">
        ${(node.input_params || []).map((row, index) => `<div class="wf-row" data-io-row="input" data-index="${index}" style="grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) 26px">
          <input type="text" data-io="key" value="${esc(row.key || '')}" placeholder="参数名" />
          <input type="text" data-io="value" value="${esc(typeof row.value === 'string' ? row.value : JSON.stringify(row.value ?? ''))}" placeholder="{{节点.字段}}" />
          <button type="button" class="wf-row-del" data-io-del="input" data-index="${index}">×</button>
        </div>`).join('')}
      </div>
      <button type="button" class="wf-add-row" data-io-add="input">＋ 添加输入参数</button>

      <div class="wf-insp-section">输出参数</div>
      <small class="help" style="display:block;margin-bottom:6px">决定下游能引用到什么，留空则用该节点类型的默认输出。</small>
      <div class="wf-rows" data-io="output">
        ${(node.output_params || []).map((row, index) => `<div class="wf-row" data-io-row="output" data-index="${index}" style="grid-template-columns:minmax(0,1fr) minmax(0,1.2fr) 26px">
          <input type="text" data-io="key" value="${esc(row.key || '')}" placeholder="名称" />
          <input type="text" data-io="from" value="${esc(row.from || '')}" placeholder="来源路径，留空=同名" />
          <button type="button" class="wf-row-del" data-io-del="output" data-index="${index}">×</button>
        </div>`).join('')}
      </div>
      <div class="wf-insp-actions" style="margin-top:6px">
        <button type="button" data-io-add="output">＋ 添加输出参数</button>
        <button type="button" data-io-reset="1">用默认输出</button>
      </div>
      <div class="wf-io" style="margin-top:8px"><span class="io-title">下游可以这样引用</span><pre>${esc(effectiveOutputs(node, def).map((o) => `${node.id}.${o.key}`).join('\n') || '（无输出）')}</pre></div>
      ${runState ? `
        <div class="wf-insp-section">本次运行</div>
        <div class="wf-io ${runState.status === 'failed' ? 'bad' : runState.status === 'success' ? 'ok' : ''}">
          <span class="io-title">${esc(runState.status)}${runState.duration_ms != null ? ` · ${(runState.duration_ms / 1000).toFixed(1)}s` : ''}</span>
          <pre>${esc(JSON.stringify(runState.error ? { error: runState.error } : (runState.output ?? null), null, 2)).slice(0, 3000)}</pre>
        </div>` : ''}
      <div class="wf-insp-actions">
        <button type="button" id="wfTestNode">⚡ 测试运行</button>
        <button type="button" id="wfDeleteNode">删除节点</button>
      </div>
    </div>`;
  document.body.appendChild(pop);
  $('#wfBody').insertBefore(pop, $('#wfPalette'));
  $('#wfBody').classList.add('has-config');
  // 画布变窄了，没手动调过视角就重新适配，避免右侧节点被挤出可视区
  setTimeout(() => state.canvas?.autoFit?.(), 40);
  // 面板内部的点击不要冒泡到画布，否则会被当成点空白而收起
  pop.addEventListener('mousedown', (event) => event.stopPropagation());
  pop.querySelector('[data-pop-close]').addEventListener('click', () => closeInspector());

  bindParamInputs(node, def);
  $('#wfNodeTitle').addEventListener('input', (event) => {
    state.canvas.updateNode(node.id, { title: event.target.value }, { record: false });
    const head = pop.querySelector('.wf-inspector-head b');
    if (head) head.textContent = event.target.value;
  });
  $('#wfPolicy').addEventListener('change', (event) => { state.canvas.updateNode(node.id, { error_policy: event.target.value }); renderInspector(); });
  $('#wfMaxRetry')?.addEventListener('change', (event) => state.canvas.updateNode(node.id, { max_retry: Number(event.target.value) || 0 }));
  $('#wfRetryInterval')?.addEventListener('change', (event) => state.canvas.updateNode(node.id, { retry_interval_ms: Number(event.target.value) || 0 }));
  $('#wfDeleteNode').addEventListener('click', () => { state.canvas.selectNode(node.id); state.canvas.removeSelected(); state.selectedNodeId = null; closeInspector(); });
  $('#wfTestNode').addEventListener('click', () => debugNode(node));
}

function renderParam(param, values, node) {
  if (!paramVisible(param, values)) return '';
  const value = values[param.key];
  const label = `<span class="lbl">${esc(param.label)}${param.required ? ' <i class="req">*</i>' : ''}</span>`;
  const help = param.help ? `<small class="help">${esc(param.help)}</small>` : '';
  const key = esc(param.key);
  switch (param.type) {
    case 'select':
      return `<label class="wf-field">${label}<select data-param="${key}">${(param.options || []).map((opt) => {
        const optionValue = typeof opt === 'string' ? opt : opt.value;
        const optionLabel = typeof opt === 'string' ? opt : opt.label;
        return `<option value="${esc(optionValue)}"${String(value) === String(optionValue) ? ' selected' : ''}>${esc(optionLabel)}</option>`;
      }).join('')}</select>${help}</label>`;
    case 'number':
      return `<label class="wf-field">${label}<input type="number" data-param="${key}" value="${value == null ? '' : esc(value)}"${param.min != null ? ` min="${param.min}"` : ''}${param.max != null ? ` max="${param.max}"` : ''}${param.step != null ? ` step="${param.step}"` : ''} />${help}</label>`;
    case 'switch':
      return `<label class="wf-switch-row"><span>${esc(param.label)}</span><span class="wf-switch"><input type="checkbox" data-param="${key}"${value === true ? ' checked' : ''} /><span></span></span></label>`;
    case 'textarea':
    case 'json':
    case 'code':
      return `<label class="wf-field">${label}<textarea data-param="${key}" rows="${param.rows || (param.type === 'code' ? 10 : 4)}" placeholder="${esc(param.placeholder || '')}">${esc(typeof value === 'string' ? value : (value == null ? '' : JSON.stringify(value, null, 2)))}</textarea>${help}</label>`;
    case 'prompt':
      return `<label class="wf-field">${label}<span class="wf-prompt-wrap"><textarea data-param="${key}" data-varable="1" rows="${param.rows || 3}" placeholder="${esc(param.placeholder || '支持 {{节点.字段}} 变量')}">${esc(value || '')}</textarea><button type="button" class="wf-var-btn" data-insert-var="${key}" title="插入变量">{ }</button></span>${help}</label>`;
    case 'model': {
      const kinds = param.kinds || [];
      const options = state.models.filter((m) => !kinds.length || kinds.includes(m.kind === 'image' ? 'image' : m.kind === 'text' ? 'text' : 'video'));
      const text = options.length
        ? options.map((m) => `<option value="${esc(m.id)}"${value === m.id ? ' selected' : ''}>${esc(m.name)}（${esc(m.kind)}）</option>`).join('')
        : '<option value="">（没有可用的模型，先去模型管理添加）</option>';
      return `<label class="wf-field">${label}<select data-param="${key}"><option value="">请选择模型</option>${text}</select>${help}</label>`;
    }
    case 'python-env': {
      const envs = state.pythonEnvs?.envs || [];
      const selected = value || state.pythonEnvs?.selected || state.pythonEnvs?.default_env || '';
      const options = envs.map((env) => `<option value="${esc(env.id)}"${selected === env.id ? ' selected' : ''}>${esc(env.name)} · ${esc(env.version || '未知版本')}${env.pip ? '' : ' · 无 pip'}</option>`).join('');
      return `<label class="wf-field">${label}
        <select data-param="${key}"><option value="">（用默认环境）</option>${options || '<option value="">（没有检测到 Python，点下面的按钮安装）</option>'}</select>
        <span class="wf-insp-actions" style="margin-top:6px"><button type="button" id="wfEnsurePip">检查 / 安装 pip</button><button type="button" id="wfOpenEnvPanel">环境管理</button></span>${help}</label>`;
    }
    case 'image-list': {
      const list = Array.isArray(value) ? value : [];
      return `<div class="wf-field">${label}
        <div class="wf-rows" data-rows="${key}">
          ${(list.length ? list : ['']).map((item) => `<div class="wf-row" style="grid-template-columns:minmax(0,1fr) 26px">
            <input type="text" data-row-value="${key}" value="${esc(typeof item === 'string' ? item : JSON.stringify(item))}" placeholder="图片地址或 {{节点.字段}}" />
            <button type="button" class="wf-row-del" data-row-del="${key}">×</button></div>`).join('')}
        </div>
        <button type="button" class="wf-add-row" data-row-add="${key}">＋ 添加图片</button>${help}</div>`;
    }
    case 'fields': {
      const list = Array.isArray(value) ? value : [];
      return `<div class="wf-field">${label}<small class="help">运行工作流时需要填写的输入项</small>
        <div class="wf-rows" data-fields="1">
          ${list.map((field, index) => `<div class="wf-row" data-field-row="${index}">
            <input type="text" data-field="key" value="${esc(field.key || '')}" placeholder="变量名" />
            <input type="text" data-field="label" value="${esc(field.label || '')}" placeholder="显示名" />
            <select data-field="type">
              ${['text', 'number', 'boolean', 'json', 'image'].map((t) => `<option value="${t}"${(field.type || 'text') === t ? ' selected' : ''}>${t}</option>`).join('')}
            </select>
            <button type="button" class="wf-row-del" data-field-del="${index}">×</button>
          </div>`).join('')}
        </div>
        <button type="button" class="wf-add-row" id="wfAddField">＋ 添加输入项</button></div>`;
    }
    case 'outputs':
    case 'assignments': {
      const list = Array.isArray(value) ? value : [];
      const isOutput = param.type === 'outputs';
      return `<div class="wf-field">${label}<small class="help">${isOutput ? '选择要作为工作流结果返回的内容' : '左边是变量名，右边是它的值（可插入变量）'}</small>
        <div class="wf-rows" data-pairs="${param.type}">
          ${list.map((row, index) => `<div class="wf-row" data-pair-row="${index}">
            <input type="text" data-pair="key" value="${esc(row.key || '')}" placeholder="名称" />
            <input type="text" data-pair="value" value="${esc(typeof row.value === 'string' ? row.value : JSON.stringify(row.value ?? ''))}" placeholder="{{节点.字段}}" />
            <button type="button" class="wf-row-del" data-pair-del="${index}">×</button>
          </div>`).join('')}
        </div>
        <button type="button" class="wf-add-row" data-pair-add="${param.type}">＋ 添加一行</button></div>`;
    }
    case 'branches':
      return `<div class="wf-field">${label}<small class="help">${esc(param.help || '')}</small>
        <div class="wf-rows" data-branches="1">${renderBranchRows(value)}</div>
        <button type="button" class="wf-add-row" id="wfAddBranch">＋ 添加出口</button>
        <small class="help">都命中不了会走自动带的「否则」出口</small></div>`;
    case 'pairs':
      return `<div class="wf-field">${label}<small class="help">${esc(param.help || '')}</small>
        <div class="wf-rows" data-pairs2="1">${renderPairRows(value)}</div>
        <button type="button" class="wf-add-row" data-pair2-add="1">＋ 添加</button></div>`;
    case 'workflow': {
      const options = (state.workflows || []).filter((item) => !state.current || item.id !== state.current.id);
      const text = options.length
        ? options.map((item) => `<option value="${esc(item.id)}"${value === item.id ? ' selected' : ''}>${esc(item.name)}（${(item.nodes || []).length} 个节点${item.published ? ' · 已发布' : ''}）</option>`).join('')
        : '<option value="">（还没有其它工作流可选）</option>';
      return `<label class="wf-field">${label}<select data-param="${key}"><option value="">请选择子工作流</option>${text}</select>${help}</label>`;
    }
    default:
      return `<label class="wf-field">${label}<input type="text" data-param="${key}" value="${esc(value == null ? '' : value)}" placeholder="${esc(param.placeholder || '')}" />${help}</label>`;
  }
}

// 条件分支的出口行
function renderBranchRows(list) {
  return (Array.isArray(list) ? list : []).map((row, index) => `<div class="wf-row" data-branch-row="${index}" style="grid-template-columns:minmax(0,0.8fr) minmax(0,1.6fr) 26px">
    <input type="text" data-branch="key" value="${esc(row.key || '')}" placeholder="出口名" />
    <input type="text" data-branch="expr" value="${esc(row.expr || '')}" placeholder="如 Number(input.score) > 80" />
    <button type="button" class="wf-row-del" data-branch-del="${index}">×</button>
  </div>`).join('');
}

// 键值对参数行（判断用的输入 / 聚合字段）
function renderPairRows(list) {
  return (Array.isArray(list) ? list : []).map((row, index) => `<div class="wf-row" data-pair2-row="${index}" style="grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) 26px">
    <input type="text" data-pair2="key" value="${esc(row.key || '')}" placeholder="名称" />
    <input type="text" data-pair2="value" value="${esc(typeof row.value === 'string' ? row.value : JSON.stringify(row.value ?? ''))}" placeholder="{{节点.字段}}" />
    <button type="button" class="wf-row-del" data-pair2-del="${index}">×</button>
  </div>`).join('');
}

function collectRows(node, def) {
  const params = { ...(node.params || {}) };
  const host = $('#wfInspector');
  for (const param of def.params || []) {
    const type = param.type;
    if (type === 'fields') {
      params[param.key] = $$('[data-field-row]', host).map((row) => ({
        key: $(`[data-field="key"]`, row).value.trim(),
        label: $(`[data-field="label"]`, row).value.trim(),
        type: $(`[data-field="type"]`, row).value,
        required: false,
      })).filter((row) => row.key);
    } else if (type === 'outputs' || type === 'assignments') {
      params[param.key] = $$('[data-pair-row]', host).map((row) => ({
        key: $(`[data-pair="key"]`, row).value.trim(),
        value: $(`[data-pair="value"]`, row).value,
      })).filter((row) => row.key);
    } else if (type === 'image-list') {
      params[param.key] = $$(`[data-row-value="${param.key}"]`, host).map((input) => input.value.trim()).filter(Boolean);
    } else if (type === 'branches') {
      params[param.key] = $$('[data-branch-row]', host).map((row) => ({
        key: $(`[data-branch="key"]`, row).value.trim(),
        expr: $(`[data-branch="expr"]`, row).value,
      })).filter((row) => row.key);
    } else if (type === 'pairs') {
      params[param.key] = $$('[data-pair2-row]', host).map((row) => ({
        key: $(`[data-pair2="key"]`, row).value.trim(),
        value: $(`[data-pair2="value"]`, row).value,
      })).filter((row) => row.key);
    }
  }
  return params;
}

function bindParamInputs(node, def) {
  const host = $('#wfInspector');
  const commit = () => {
    const params = collectRows(node, def);
    state.canvas.updateNodeParams(node.id, params, { record: false });
    // 条件分支：把出口同步到节点上，画布据此画端口与分支标签
    if ((def.params || []).some((p) => p.type === 'branches')) {
      const rows = Array.isArray(params.branches) ? params.branches : [];
      const branches = rows.map((row) => ({ id: row.key, label: row.key }));
      branches.push({ id: 'else', label: '否则' });
      state.canvas.updateNode(node.id, { branches }, { record: false });
    }
  };
  $$('[data-param]', host).forEach((input) => {
    const event = input.type === 'checkbox' ? 'change' : (input.tagName === 'SELECT' ? 'change' : 'input');
    input.addEventListener(event, () => {
      const key = input.dataset.param;
      const param = (def.params || []).find((p) => p.key === key) || {};
      let value;
      if (input.type === 'checkbox') value = input.checked;
      else if (param.type === 'number') value = input.value === '' ? '' : Number(input.value);
      else if (param.type === 'json') {
        try { value = input.value.trim() ? JSON.parse(input.value) : ''; }
        catch (_) { value = input.value; }
      } else value = input.value;
      const next = { ...(node.params || {}), [key]: value };
      state.canvas.updateNodeParams(node.id, next, { record: false });
      if (param.showWhen) renderInspector();
    });
    if (input.tagName === 'SELECT') input.addEventListener('change', () => renderInspector());
  });

  // 行编辑（输入项 / 输出映射 / 图片列表）
  $$('[data-field-row] [data-field]', host).forEach((input) => input.addEventListener('input', commit));
  $$('[data-pair-row] [data-pair]', host).forEach((input) => input.addEventListener('input', commit));
  $$('[data-row-value]', host).forEach((input) => input.addEventListener('input', commit));
  $$('[data-pair-add]', host).forEach((button) => button.addEventListener('click', () => {
    const rows = collectRows(node, def);
    rows[button.dataset.pairAdd] = [...(rows[button.dataset.pairAdd] || []), { key: '', value: '' }];
    state.canvas.updateNodeParams(node.id, rows);
    renderInspector();
  }));
  $$('[data-pair-del]', host).forEach((button) => button.addEventListener('click', () => {
    const type = button.closest('[data-pairs]').dataset.pairs;
    const rows = collectRows(node, def);
    rows[type] = (rows[type] || []).filter((_, index) => index !== Number(button.dataset.pairDel));
    state.canvas.updateNodeParams(node.id, rows);
    renderInspector();
  }));
  $$('[data-row-add]', host).forEach((button) => button.addEventListener('click', () => {
    const key = button.dataset.rowAdd;
    const rows = collectRows(node, def);
    rows[key] = [...(rows[key] || []), ''];
    state.canvas.updateNodeParams(node.id, rows);
    renderInspector();
  }));
  $$('[data-row-del]', host).forEach((button) => button.addEventListener('click', () => {
    const key = button.dataset.rowDel;
    const inputs = $$(`[data-row-value="${key}"]`, host);
    const index = inputs.findIndex((input) => input.closest('.wf-row').contains(button));
    const rows = collectRows(node, def);
    rows[key] = (rows[key] || []).filter((_, i) => i !== index);
    state.canvas.updateNodeParams(node.id, rows);
    renderInspector();
  }));
  $('#wfAddField')?.addEventListener('click', () => {
    const rows = collectRows(node, def);
    rows.fields = [...(rows.fields || []), { key: '', label: '', type: 'text' }];
    state.canvas.updateNodeParams(node.id, rows);
    renderInspector();
  });
  $$('[data-field-del]', host).forEach((button) => button.addEventListener('click', () => {
    const rows = collectRows(node, def);
    rows.fields = (rows.fields || []).filter((_, index) => index !== Number(button.dataset.fieldDel));
    state.canvas.updateNodeParams(node.id, rows);
    renderInspector();
  }));

  // 条件分支出口 / 键值对行
  $$('[data-branch-row] [data-branch]', host).forEach((input) => input.addEventListener('input', commit));
  $$('[data-pair2-row] [data-pair2]', host).forEach((input) => input.addEventListener('input', commit));
  $('#wfAddBranch')?.addEventListener('click', () => {
    const params = collectRows(node, def);
    params.branches = [...(params.branches || []), { key: '', expr: '' }];
    state.canvas.updateNodeParams(node.id, params);
    renderInspector();
  });
  $$('[data-branch-del]', host).forEach((button) => button.addEventListener('click', () => {
    const params = collectRows(node, def);
    params.branches = (params.branches || []).filter((_, index) => index !== Number(button.dataset.branchDel));
    state.canvas.updateNodeParams(node.id, params);
    renderInspector();
  }));
  $$('[data-pair2-add]', host).forEach((button) => button.addEventListener('click', () => {
    const target = (def.params || []).find((p) => p.type === 'pairs');
    if (!target) return;
    const params = collectRows(node, def);
    params[target.key] = [...(params[target.key] || []), { key: '', value: '' }];
    state.canvas.updateNodeParams(node.id, params);
    renderInspector();
  }));
  $$('[data-pair2-del]', host).forEach((button) => button.addEventListener('click', () => {
    const target = (def.params || []).find((p) => p.type === 'pairs');
    if (!target) return;
    const params = collectRows(node, def);
    params[target.key] = (params[target.key] || []).filter((_, index) => index !== Number(button.dataset.pair2Del));
    state.canvas.updateNodeParams(node.id, params);
    renderInspector();
  }));

  // 输入参数 / 输出参数：用户自己声明（Coze 代码节点那套）
  const readIoRows = (kind) => $$(`[data-io-row="${kind}"]`, host).map((row) => {
    const key = ($('[data-io="key"]', row)?.value || '').trim();
    if (kind === 'input') return { key, value: $('[data-io="value"]', row)?.value || '' };
    return { key, from: ($('[data-io="from"]', row)?.value || '').trim() };
  }).filter((row) => row.key);

  const writeIoRows = (kind, rows) => {
    const patch = kind === 'input' ? { input_params: rows } : { output_params: rows };
    state.canvas.updateNode(node.id, patch);
    state.selectedNodeId = node.id;
    renderInspector();
  };

  $$('[data-io-add]', host).forEach((button) => button.addEventListener('click', () => {
    const kind = button.dataset.ioAdd;
    writeIoRows(kind, [...readIoRows(kind), kind === 'input' ? { key: '', value: '' } : { key: '', from: '' }]);
  }));
  $$('[data-io-del]', host).forEach((button) => button.addEventListener('click', () => {
    const kind = button.dataset.ioDel;
    writeIoRows(kind, readIoRows(kind).filter((_, index) => index !== Number(button.dataset.index)));
  }));
  $$('[data-io-row] [data-io]', host).forEach((input) => input.addEventListener('change', () => {
    const kind = input.closest('[data-io-row]').dataset.ioRow;
    writeIoRows(kind, readIoRows(kind));
  }));
  $('[data-io-reset]', host)?.addEventListener('click', () => {
    state.canvas.updateNode(node.id, { output_params: [] });
    state.selectedNodeId = node.id;
    renderInspector();
  });

  // 变量选择器
  $$('[data-insert-var]', host).forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    openVarPicker(button, node, (path) => {
      const textarea = $(`[data-param="${button.dataset.insertVar}"]`, host);
      const token = `{{${path}}}`;
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      textarea.value = textarea.value.slice(0, start) + token + textarea.value.slice(end);
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + token.length;
      commit();
    });
  }));

  // Python 环境相关按钮
  $('#wfEnsurePip')?.addEventListener('click', async () => {
    const envId = node.params?.env_id || '';
    toast('正在检查 pip…');
    try {
      const data = await api('/api/workflows/python/pip', { method: 'POST', body: { env_id: envId } });
      toast(data.ok ? (data.installed ? `pip 已${data.via === 'ensurepip' ? '用 ensurepip' : '用 get-pip.py'}安装完成` : 'pip 已存在') : `失败：${data.msg}`, data.ok ? 'ok' : 'error');
      await ensurePythonEnvs(true);
      renderInspector();
    } catch (err) { toast(`pip 检查失败：${err.message}`, 'error'); }
  });
  $('#wfOpenEnvPanel')?.addEventListener('click', () => openPythonPanel());
}

function openVarPicker(anchor, node, onPick) {
  closeVarPicker();
  const paths = upstreamPaths(node.id);
  const pop = document.createElement('div');
  pop.className = 'wf-var-pop';
  const groups = new Map();
  for (const item of paths) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  pop.innerHTML = paths.length
    ? [...groups.entries()].map(([group, items]) => `<div class="vp-group">${esc(group)}</div>
        ${items.map((item) => `<button type="button" data-path="${esc(item.path)}">${esc(item.label)} <code>{{${esc(item.path)}}}</code></button>`).join('')}`).join('')
    : '<div class="vp-empty">上游还没有可用变量。先连上「开始」或其它节点。</div>';
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 280, rect.left - 230))}px`;
  pop.style.top = `${Math.min(window.innerHeight - 330, rect.bottom + 6)}px`;
  pop.addEventListener('click', (event) => {
    const button = event.target.closest('[data-path]');
    if (!button) return;
    onPick(button.dataset.path);
    closeVarPicker();
  });
  setTimeout(() => document.addEventListener('mousedown', closeVarPickerOnce), 0);
}

function closeVarPicker() { $$('.wf-var-pop').forEach((el) => el.remove()); }
function closeVarPickerOnce(event) {
  if (event.target.closest('.wf-var-pop') || event.target.closest('[data-insert-var]')) return;
  closeVarPicker();
  document.removeEventListener('mousedown', closeVarPickerOnce);
}

// ---------------- 运行 ----------------
function promptRun(workflowId) {
  const wf = state.current && state.current.id === workflowId
    ? state.current
    : state.workflows.find((item) => item.id === workflowId);
  if (!wf) return;
  const startNode = (wf.nodes || []).find((node) => node.type === 'start');
  const fields = Array.isArray(startNode?.params?.fields) ? startNode.params.fields : [];
  const body = fields.length
    ? fields.map((field) => {
      const input = field.type === 'json'
        ? `<textarea data-input="${esc(field.key)}" rows="3" placeholder="JSON"></textarea>`
        : `<input type="text" data-input="${esc(field.key)}" />`;
      return `<label class="wf-field"><span class="lbl">${esc(field.label || field.key)}${field.required === false ? '' : ' <i class="req">*</i>'}</span>${input}</label>`;
    }).join('')
    : '<p class="wf-insp-empty">这个工作流没有输入参数，直接运行即可。</p>';

  openDialog('运行工作流', body, [
    { label: '取消', action: 'close' },
    { label: '开始运行', primary: true, action: async (close) => {
      const inputs = {};
      $$('[data-input]').forEach((input) => {
        const value = input.value.trim();
        if (!value) return;
        if (input.tagName === 'TEXTAREA') {
          try { inputs[input.dataset.input] = JSON.parse(value); } catch (_) { inputs[input.dataset.input] = value; }
        } else inputs[input.dataset.input] = value;
      });
      close();
      if (state.current?.id !== workflowId) await openWorkflow(workflowId);
      await startRun(workflowId, inputs);
    } },
  ]);
}

async function startRun(workflowId, inputs) {
  try {
    await saveCurrent().catch(() => {});
    const data = await api(`/api/workflows/${encodeURIComponent(workflowId)}/run`, { method: 'POST', body: { inputs } });
    state.activeRunId = data.run_id;
    toast('已开始运行');
    pollRun(data.run_id);
  } catch (err) { toast(`运行失败：${err.message}`, 'error'); }
}

function pollRun(runId) {
  stopRunPolling();
  const tick = async () => {
    try {
      const data = await api(`/api/workflow-runs/${encodeURIComponent(runId)}`);
      const run = data.run;
      state.lastRun = run;
      state.runNodeStates = run.nodes;
      state.canvas?.setNodeStates(run.nodes);
      if (state.selectedNodeId) renderInspector();
      updateRunIndicator(run);
      if (['success', 'failed', 'cancelled'].includes(run.status)) {
        stopRunPolling();
        toast(run.status === 'success' ? `运行成功（${(run.duration_ms / 1000).toFixed(1)}s）` : `运行${run.status === 'cancelled' ? '已取消' : '失败'}：${run.error || ''}`, run.status === 'success' ? 'ok' : 'error');
        openRunDetail(run.id);
      }
    } catch (_) { /* 轮询失败下次再试 */ }
  };
  tick();
  state.runTimer = setInterval(tick, 900);
}

function stopRunPolling() {
  if (state.runTimer) clearInterval(state.runTimer);
  state.runTimer = null;
}

function updateRunIndicator(run) {
  const button = $('#wfRun');
  if (!button) return;
  const running = run.status === 'running' || run.status === 'pending';
  button.textContent = running ? '运行中…' : '▶ 运行';
  button.disabled = running;
  if (running && !$('#wfCancelRun')) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.id = 'wfCancelRun';
    cancel.textContent = '取消运行';
    cancel.addEventListener('click', async () => {
      await api(`/api/workflow-runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST' }).catch(() => {});
    });
    button.after(cancel);
  }
  if (!running) $('#wfCancelRun')?.remove();
}

// ---------------- 运行记录 ----------------
async function openRunList(workflowId) {
  try {
    const query = workflowId ? `?workflow_id=${encodeURIComponent(workflowId)}&limit=50` : '?limit=50';
    const data = await api(`/api/workflow-runs${query}`);
    const rows = data.runs.map((run) => `
      <div class="wf-run-row" data-run="${esc(run.id)}">
        <span class="wf-state ${esc(run.status)}">${esc(run.status)}</span>
        <span class="mono">${esc((run.id || '').slice(4, 14))}</span>
        <span>${esc(run.workflow_name || '')}${run.workflow_version ? ` <code>v${run.workflow_version}</code>` : ''}</span>
        <span class="mono">${run.total_tokens ? `${run.total_tokens} tok` : ''}</span>
        <span class="dur">${run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(1)}s` : '—'}</span>
      </div>`).join('');
    openDrawer('运行记录', `<div class="wf-runs">${rows || '<div class="wf-empty">还没有运行记录</div>'}</div>`, (root) => {
      $$('[data-run]', root).forEach((el) => el.addEventListener('click', () => openRunDetail(el.dataset.run)));
    });
  } catch (err) { toast(`读取运行记录失败：${err.message}`, 'error'); }
}

async function openRunDetail(runId) {
  try {
    const data = await api(`/api/workflow-runs/${encodeURIComponent(runId)}`);
    const run = data.run;
    const order = (run.snapshot?.nodes || []).map((node) => run.nodes[node.id]).filter(Boolean);
    const blocks = order.map((nodeState) => `
      <div class="wf-run-node">
        <div class="wf-run-node-head">
          <span class="wf-state ${esc(nodeState.status)}">${esc(nodeState.status)}</span>
          <b>${esc(nodeState.title || nodeState.id)}</b>
          <span class="mono">${nodeState.duration_ms != null ? `${(nodeState.duration_ms / 1000).toFixed(1)}s` : ''}${nodeState.attempts > 1 ? ` · 第 ${nodeState.attempts} 次` : ''}</span>
        </div>
        ${nodeState.error ? `<div class="wf-io bad"><span class="io-title">错误</span><pre>${esc(nodeState.error)}</pre></div>` : ''}
        ${nodeState.output !== undefined ? `<div class="wf-io"><span class="io-title">输出</span><pre>${esc(JSON.stringify(nodeState.output, null, 2)).slice(0, 2500)}</pre></div>` : ''}
      </div>`).join('');
    openDrawer(`运行 ${String(run.id).slice(4, 14)}`, `
      <div class="wf-run-detail">
        <div class="wf-io ${run.status === 'success' ? 'ok' : run.status === 'failed' ? 'bad' : ''}">
          <span class="io-title">概况</span>
          <pre>${esc(JSON.stringify({
            状态: run.status, 版本: run.workflow_version, 模式: run.mode,
            耗时毫秒: run.duration_ms, Token: run.total_tokens, 错误: run.error || null,
          }, null, 2))}</pre>
        </div>
        ${run.outputs ? `<div class="wf-io ok"><span class="io-title">工作流输出</span><pre>${esc(JSON.stringify(run.outputs, null, 2)).slice(0, 3000)}</pre></div>` : ''}
        ${blocks}
      </div>`);
  } catch (err) { toast(`读取运行详情失败：${err.message}`, 'error'); }
}

// ---------------- 单节点调试 ----------------
function debugSelectedNode() {
  const id = state.selectedNodeId;
  if (!id) { toast('先在画布上选中一个节点'); return; }
  const node = state.canvas.getGraph().nodes.find((n) => n.id === id);
  if (node) debugNode(node);
}

function debugNode(node) {
  const def = state.meta.nodes[node.type] || {};
  openDialog(`测试节点 · ${node.title || def.label || node.type}`, `
    <p class="wf-insp-empty">填写这个节点需要的输入（相当于上游节点的输出），只运行这一个节点。</p>
    <label class="wf-field"><span class="lbl">input（上游输出，JSON）</span><textarea id="wfDebugInput" rows="6">{}</textarea></label>`,
  [
    { label: '取消', action: 'close' },
    { label: '运行', primary: true, action: async (close) => {
      let inputs = {};
      try { inputs = JSON.parse($('#wfDebugInput').value || '{}'); }
      catch (_) { toast('输入不是合法 JSON', 'error'); return; }
      close();
      toast('正在测试节点…');
      try {
        const data = await api(`/api/workflows/${encodeURIComponent(state.current.id)}/test-node`, { method: 'POST', body: { node, inputs } });
        openDialog(`测试结果 · ${def.label || node.type}`, data.ok
          ? `<div class="wf-io ok"><span class="io-title">输出（${data.duration_ms} ms）</span><pre>${esc(JSON.stringify(data.output, null, 2)).slice(0, 4000)}</pre></div>`
          : `<div class="wf-io bad"><span class="io-title">失败</span><pre>${esc(data.msg || '')}</pre></div>`,
        [{ label: '关闭', primary: true, action: 'close' }]);
      } catch (err) { toast(`测试失败：${err.message}`, 'error'); }
    } },
  ]);
}

// ---------------- Python 环境 ----------------
async function ensurePythonEnvs(force) {
  if (state.pythonEnvs && !force) return state.pythonEnvs;
  try {
    state.pythonEnvs = await api('/api/workflows/python/envs');
  } catch (err) {
    state.pythonEnvs = { envs: [], selected: '', default_env: '', install: { running: false } };
    toast(`读取 Python 环境失败：${err.message}`, 'error');
  }
  return state.pythonEnvs;
}

async function openPythonPanel() {
  await ensurePythonEnvs(true);
  const data = state.pythonEnvs;
  const render = () => {
    const envs = data.envs || [];
    const selected = data.selected || data.default_env || '';
    const rows = envs.map((env) => `
      <div class="wf-env-row${env.id === selected ? ' selected' : ''}" data-env="${esc(env.id)}">
        <span class="tag ${esc(env.kind)}">${env.kind === 'conda' ? 'conda' : env.kind === 'venv' ? '自建' : '系统'}</span>
        <span class="meta"><b>${esc(env.name)}</b><small title="${esc(env.error || '')}">${esc(env.python)} · ${esc(env.version || '未知版本')}</small></span>
        ${env.pip ? '<span class="tag">pip</span>' : '<span class="tag nopip" title="' + esc(env.error || '') + '">无 pip</span>'}
      </div>`).join('');
    const install = data.install || {};
    return `
      <p class="wf-insp-empty">代码节点用 Python 时使用这里选中的解释器。默认优先级：conda base → conda 的第一个环境 → 自建环境 → 系统 Python。</p>
      <div class="wf-env-list">${rows || '<div class="wf-empty">没有检测到任何 Python 环境</div>'}</div>
      <div class="wf-install-bar">
        <div style="flex:1;min-width:0">
          <b style="font-size:12.5px">${install.running ? esc(install.message || '安装中…') : install.stage === 'done' ? '安装完成' : install.stage === 'failed' ? `安装失败：${esc(install.error || '')}` : '没有 Python？可以自动下载安装 3.12'}</b>
          <div class="wf-progress" style="margin-top:6px"><i style="width:${Number(install.percent) || 0}%"></i></div>
        </div>
        <button class="primary-button" id="wfInstallPy" type="button"${install.running ? ' disabled' : ''}>${install.running ? '安装中…' : '自动安装 Python 3.12'}</button>
      </div>
      <p class="wf-insp-empty" style="margin-top:10px">安装会依次尝试清华、北外、南大、中科大镜像与官方源，任一条失败会自动切换下一条；装好后会创建独立环境并确认 pip。</p>`;
  };

  const drawer = openDrawer('Python 环境', render(), (root) => {
    const bind = () => {
      $$('[data-env]', root).forEach((el) => el.addEventListener('click', async () => {
        try {
          await api('/api/workflows/python/select', { method: 'POST', body: { env_id: el.dataset.env } });
          data.selected = el.dataset.env;
          state.pythonEnvs.selected = el.dataset.env;
          toast('已切换 Python 环境');
          root.querySelector('.model-drawer-body').innerHTML = render();
          bind();
          renderInspector();
        } catch (err) { toast(`切换失败：${err.message}`, 'error'); }
      }));
      $('#wfInstallPy', root)?.addEventListener('click', async () => {
        try {
          await api('/api/workflows/python/install', { method: 'POST' });
          toast('已开始下载安装，请留意进度');
          startInstallPolling(root, data);
        } catch (err) { toast(`启动安装失败：${err.message}`, 'error'); }
      });
    };
    bind();
  });
  return drawer;
}

function startInstallPolling(root, data) {
  clearInterval(state.installTimer);
  state.installTimer = setInterval(async () => {
    try {
      const res = await api('/api/workflows/python/status');
      data.install = res.install;
      const body = root.querySelector('.model-drawer-body');
      if (body) body.innerHTML = body.innerHTML; // 保持结构，仅更新进度条与按钮文案
      const bar = $('.wf-progress i', root);
      const label = $('.wf-install-bar b', root);
      const button = $('#wfInstallPy', root);
      if (bar) bar.style.width = `${Number(res.install.percent) || 0}%`;
      if (label) label.textContent = res.install.running ? (res.install.message || '安装中…') : res.install.stage === 'done' ? '安装完成' : res.install.stage === 'failed' ? `安装失败：${res.install.error || ''}` : '没有 Python？可以自动下载安装 3.12';
      if (button) { button.disabled = Boolean(res.install.running); button.textContent = res.install.running ? '安装中…' : '自动安装 Python 3.12'; }
      if (!res.install.running) {
        clearInterval(state.installTimer);
        state.installTimer = null;
        await ensurePythonEnvs(true);
        toast(res.install.stage === 'done' ? 'Python 安装完成' : `安装失败：${res.install.error || ''}`, res.install.stage === 'done' ? 'ok' : 'error');
        openPythonPanel();
      }
    } catch (_) { /* 下次再试 */ }
  }, 1500);
}

// ---------------- Coze 式交互：右键菜单 / 加号选节点 / 节点结果 ----------------
function closeContextMenu() { $$('.wf-ctx').forEach((el) => el.remove()); }

function openMenuAt(event, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'wf-ctx';
  menu.innerHTML = items.map((item, index) => `<button type="button" class="${item.danger ? 'danger' : ''}" data-item="${index}">${esc(item.label)}</button>`).join('');
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
  menu.addEventListener('mousedown', (e) => e.stopPropagation());
  menu.addEventListener('click', (e) => {
    const button = e.target.closest('[data-item]');
    if (!button) return;
    closeContextMenu();
    items[Number(button.dataset.item)].run();
  });
  setTimeout(() => document.addEventListener('mousedown', closeContextMenu, { once: true }), 0);
  return menu;
}

function openContextMenu(nodeId, event) {
  const node = state.canvas.getGraph().nodes.find((n) => n.id === nodeId);
  if (!node) return;
  openMenuAt(event, [
    { label: '⚙ 配置节点', run: () => { state.selectedNodeId = nodeId; renderInspector(); } },
    { label: '⚡ 测试此节点', run: () => debugNode(node) },
    { label: '⧉ 复制', run: () => { state.canvas.selectNode(nodeId); copyNodeToClipboard(); } },
    { label: '⟳ 重命名', run: () => { state.selectedNodeId = nodeId; renderInspector(); setTimeout(() => $('#wfNodeTitle')?.select(), 60); } },
    { label: '✕ 删除', danger: true, run: () => { state.canvas.selectNode(nodeId); state.canvas.removeSelected(); state.selectedNodeId = null; closeInspector(); } },
  ]);
}

function copyNodeToClipboard() {
  // 借用画布自己的复制：先选中再触发 Ctrl+C 的等价操作
  const ok = state.canvas.copySelection?.();
  toast(ok === false ? '请先选中节点' : '已复制节点，可切到别的画布 Ctrl+V 粘贴');
}

function openEdgeMenu(edgeId, event) {
  openMenuAt(event, [
    { label: '＋ 在这条线上插入节点', run: () => {
      const edge = state.canvas.getGraph().edges.find((e) => e.id === edgeId);
      if (!edge) return;
      const nodes = state.canvas.getGraph().nodes;
      const from = nodes.find((n) => n.id === edge.from) || { x: 0, y: 0 };
      openNodePicker({ x: from.x + 220, y: from.y, clientX: event.clientX, clientY: event.clientY, from: edge.from, to: edge.to, edgeId });
    } },
    { label: '✕ 删除连线', danger: true, run: () => state.canvas.removeEdge?.(edgeId) },
    { label: '⑂ 改到哪个出口', run: () => pickEdgeBranch(edgeId) },
  ]);
}

// 「+」打开的节点选择器（Coze 点加号后的那个列表）
function closeNodePicker() { $('#wfNodePicker')?.remove(); }

function openNodePicker(target) {
  closeNodePicker();
  const picker = document.createElement('div');
  picker.className = 'wf-ctx';
  picker.id = 'wfNodePicker';
  picker.style.minWidth = '220px';
  picker.style.maxHeight = '360px';
  picker.style.overflowY = 'auto';
  const groups = new Map();
  for (const def of Object.values(state.meta?.nodes || {})) {
    if (!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group).push(def);
  }
  picker.innerHTML = `
    <input class="wf-palette-search" id="wfPickerSearch" placeholder="搜索节点…" style="max-width:none;margin:2px 0 6px" />
    <div id="wfPickerList">
      ${[...groups.entries()].map(([group, list]) => `
        <div class="wf-palette-group">${esc(group)}</div>
        ${list.map((def) => `<button type="button" data-pick="${esc(def.type)}">${esc(def.icon || '●')} ${esc(def.label)}</button>`).join('')}
      `).join('')}
    </div>`;
  document.body.appendChild(picker);
  const rect = picker.getBoundingClientRect();
  picker.style.left = `${Math.max(8, Math.min(target.clientX ?? 200, window.innerWidth - rect.width - 8))}px`;
  picker.style.top = `${Math.max(8, Math.min(target.clientY ?? 200, window.innerHeight - rect.height - 8))}px`;
  picker.addEventListener('mousedown', (event) => event.stopPropagation());

  const pick = (type) => {
    closeNodePicker();
    const def = state.meta.nodes[type];
    if (!def) return;
    const position = { x: target.x ?? 200, y: target.y ?? 160 };
    const node = target.edgeId || target.from
      ? state.canvas.insertNode(type, position, def, { edgeId: target.edgeId, from: target.from, to: target.to })
      : state.canvas.addNode(type, position, def);
    state.selectedNodeId = node.id;
    renderInspector();
    setTimeout(() => state.canvas.fit(), 30);
  };
  picker.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pick]');
    if (button) pick(button.dataset.pick);
  });
  const search = $('#wfPickerSearch');
  search.addEventListener('input', () => {
    const keyword = search.value.trim().toLowerCase();
    $$('#wfPickerList [data-pick]', picker).forEach((button) => {
      const def = state.meta.nodes[button.dataset.pick];
      const hit = !keyword || `${def.label} ${def.type} ${def.description}`.toLowerCase().includes(keyword);
      button.style.display = hit ? '' : 'none';
    });
  });
  search.focus();
  setTimeout(() => document.addEventListener('mousedown', closeNodePicker, { once: true }), 0);
}

// 节点右上角角标：看这个节点最近的输入输出
function openNodeResult(nodeId) {
  const run = state.lastRun;
  const nodeState = state.runNodeStates?.[nodeId];
  const node = state.canvas.getGraph().nodes.find((n) => n.id === nodeId);
  if (!nodeState) { toast('这个节点还没有运行结果，先点「试运行」'); return; }
  openDrawer(`节点结果 · ${node?.title || nodeId}`, `
    <div class="wf-run-detail">
      <div class="wf-io ${nodeState.status === 'failed' ? 'bad' : nodeState.status === 'success' ? 'ok' : ''}">
        <span class="io-title">${esc(nodeState.status)}${nodeState.duration_ms != null ? ` · ${(nodeState.duration_ms / 1000).toFixed(1)}s` : ''}</span>
        <pre>${esc(JSON.stringify({ 输入: nodeState.input ?? null, 输出: nodeState.output ?? null, 错误: nodeState.error || null, 尝试次数: nodeState.attempts || 1 }, null, 2)).slice(0, 6000)}</pre>
      </div>
      ${run ? `<div class="wf-io"><span class="io-title">所属运行</span><pre>${esc(`${run.id} · ${run.status} · ${run.workflow_name}`)}</pre></div>` : ''}
    </div>`);
}

// 让用户选这条线走哪个分支出口（点连线或从分支节点连出来时用）
function pickEdgeBranch(edgeId) {
  const edge = state.canvas.getEdge(edgeId);
  if (!edge) return;
  const fromNode = state.canvas.getGraph().nodes.find((n) => n.id === edge.from);
  const branches = Array.isArray(fromNode?.branches) ? fromNode.branches : [];
  if (!branches.length) { toast('这个节点没有分支出口'); return; }
  const anchor = state.canvas.nodeScreenRect(edge.from);
  openMenuAt(
    { clientX: (anchor?.right || 200), clientY: (anchor?.top || 200) },
    branches.map((branch) => ({
      label: `${edge.branch === branch.id ? '● ' : '○ '}${branch.label}`,
      run: () => {
        state.canvas.setEdgeBranch(edgeId, branch.id);
        toast(`这条线改到「${branch.label}」了`);
      },
    })),
  );
}

// ---------------- 通用弹层 ----------------
function openDrawer(title, html, onMount) {
  closeDrawer();
  const backdrop = document.createElement('div');
  backdrop.className = 'model-editor-backdrop';
  backdrop.id = 'wfDrawer';
  backdrop.innerHTML = `
    <aside class="model-drawer" role="dialog" aria-modal="true">
      <header class="model-drawer-header">
        <div class="model-drawer-title"><h3>${esc(title)}</h3></div>
        <button class="model-drawer-close" type="button" data-close aria-label="关闭">×</button>
      </header>
      <div class="model-drawer-body">${html}</div>
    </aside>`;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop || event.target.closest('[data-close]')) closeDrawer(); });
  onMount?.(backdrop);
  return backdrop;
}

function closeDrawer() {
  clearInterval(state.installTimer);
  state.installTimer = null;
  $('#wfDrawer')?.remove();
}

function openDialog(title, html, actions) {
  closeDialog();
  const backdrop = document.createElement('div');
  backdrop.className = 'app-settings-backdrop';
  backdrop.id = 'wfDialog';
  backdrop.innerHTML = `
    <section class="app-settings-modal" role="dialog" aria-modal="true">
      <div class="task-detail-header">
        <div><h3>${esc(title)}</h3></div>
        <button class="task-detail-close" type="button" data-close aria-label="关闭">×</button>
      </div>
      <div style="margin-top:14px">${html}</div>
      <div class="wf-insp-actions" style="margin-top:16px">
        ${actions.map((action, index) => `<button type="button" data-action="${index}" class="${action.primary ? 'primary' : ''}">${esc(action.label)}</button>`).join('')}
      </div>
    </section>`;
  document.body.appendChild(backdrop);
  const close = () => closeDialog();
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop || event.target.closest('[data-close]')) close(); });
  $$('[data-action]', backdrop).forEach((button) => button.addEventListener('click', () => {
    const action = actions[Number(button.dataset.action)];
    if (action.action === 'close') close();
    else action.action?.(close);
  }));
  return backdrop;
}

function closeDialog() { $('#wfDialog')?.remove(); }

function toast(message, type = 'ok') {
  if (typeof window.wenvedioToast === 'function') { window.wenvedioToast(message, type); return; }
  const wrap = document.getElementById('toastWrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.style.setProperty('--toast-life', `${type === 'error' ? 6000 : 4200}ms`);
  el.textContent = message;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 700); }, type === 'error' ? 6000 : 4200);
}

// ---------------- 生命周期 ----------------
async function loadWorkflows() {
  const data = await api('/api/workflows');
  state.workflows = data.workflows || [];
  return state.workflows;
}

async function loadBasics() {
  if (!state.meta) state.meta = await api('/api/workflows/meta');
  try {
    const models = await api('/api/models');
    state.models = models.models || [];
  } catch (_) { state.models = []; }
}

export async function mount() {
  const root = $('#workflowView');
  if (!root || state.root === root) {
    if (state.view === 'edit' && state.canvas) state.canvas.fit();
    return;
  }
  state.root = root;
  root.innerHTML = '<div id="wfListMode"></div><div class="wf-editor" id="wfEditMode" hidden></div>';
  try {
    await loadBasics();
    await loadWorkflows();
  } catch (err) {
    root.innerHTML = `<div class="wf-empty">工作流模块加载失败：${esc(err.message)}</div>`;
    return;
  }
  renderList();
  ensurePythonEnvs().catch(() => {});
}

export function unmount() {
  stopRunPolling();
  closeVarPicker();
  closeInspector();
  closeContextMenu();
  closeNodePicker();
}

// Esc 关掉临时浮层；右侧配置面板不在这里关（它跟随选中状态）
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if ($('#wfNodePicker')) { closeNodePicker(); return; }
  if ($('.wf-ctx')) { closeContextMenu(); return; }
  closeVarPicker();
});

if (typeof window !== 'undefined') {
  window.wenvedioWorkflow = { mount, unmount };
}
