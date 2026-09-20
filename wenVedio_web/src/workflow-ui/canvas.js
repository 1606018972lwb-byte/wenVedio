// 工作流 · 画布
// 原生 SVG 手写，不引入任何库与构建步骤。
// 性能取法：节点 DOM 按 id 复用，只更新变化的属性；状态刷新走 setNodeStates() 局部更新，
// 不整块重建，所以几十上百个节点也不会明显卡。
const NS = 'http://www.w3.org/2000/svg';
export const NODE_W = 176;
export const NODE_H = 54;

const el = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

const truncate = (text, max = 13) => {
  const value = String(text == null ? '' : text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

export function createCanvas(host, handlers = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'wf-canvas-wrap';
  wrap.tabIndex = 0;

  const svg = el('svg', { class: 'wf-canvas' });
  svg.innerHTML = `<defs>
    <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-2)"></path>
    </marker>
  </defs>`;
  const bg = el('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: 'transparent' });
  const viewport = el('g');
  const edgesLayer = el('g');
  const nodesLayer = el('g');
  const marquee = el('rect', { class: 'wf-marquee', rx: 3 });
  marquee.setAttribute('visibility', 'hidden');
  const draftEdge = el('path', { class: 'wf-draft-edge' });
  draftEdge.setAttribute('visibility', 'hidden');

  viewport.append(edgesLayer, nodesLayer, marquee, draftEdge);
  svg.append(bg, viewport);

  const toolbar = document.createElement('div');
  toolbar.className = 'wf-canvas-toolbar';
  toolbar.innerHTML = `
    <button type="button" data-zoom="out" title="缩小">−</button>
    <span class="zoom-label">100%</span>
    <button type="button" data-zoom="in" title="放大">＋</button>
    <button type="button" data-zoom="fit" title="适应画布">⤢</button>
    <button type="button" data-zoom="layout" title="自动布局">⇉</button>`;
  const hint = document.createElement('div');
  hint.className = 'wf-canvas-hint';
  hint.textContent = '右键节点改设置 · 拖动空白平移 · 滚轮缩放 · Shift+框选 · Delete 删除';
  wrap.append(svg, toolbar, hint);
  host.appendChild(wrap);

  // ---------------- 状态 ----------------
  let nodes = [];
  let edges = [];
  let nodeStates = {};
  let selection = new Set();
  let selectedEdge = null;
  let scale = 1;
  let panX = 40;
  let panY = 30;
  let readOnly = false;
  let userAdjusted = false;
  let edgeSeq = 0;

  const nodeEls = new Map();
  const edgeEls = new Map();
  const history = { past: [], future: [] };
  const MAX_HISTORY = 60;

  const applyTransform = () => {
    viewport.setAttribute('transform', `translate(${panX},${panY}) scale(${scale})`);
    toolbar.querySelector('.zoom-label').textContent = `${Math.round(scale * 100)}%`;
  };

  const toWorld = (clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    return { x: (clientX - rect.left - panX) / scale, y: (clientY - rect.top - panY) / scale };
  };

  const emitChange = () => handlers.onChange?.({ nodes, edges });
  const emitSelect = () => handlers.onSelect?.([...selection], selectedEdge);

  function snapshot() {
    history.past.push(JSON.stringify({ nodes, edges }));
    if (history.past.length > MAX_HISTORY) history.past.shift();
    history.future.length = 0;
  }

  function restore(json) {
    const parsed = JSON.parse(json);
    nodes = parsed.nodes;
    edges = parsed.edges;
    selection = new Set([...selection].filter((id) => nodes.some((n) => n.id === id)));
    selectedEdge = null;
    render();
    emitChange();
    emitSelect();
  }

  // ---------------- 渲染 ----------------
  function nodeStateOf(id) {
    return nodeStates[id] || {};
  }

  function createNodeEl(node) {
    const g = el('g', { class: 'wf-node', 'data-node': node.id });
    g.append(
      el('rect', { class: 'box', width: NODE_W, height: NODE_H, rx: 10 }),
      el('circle', { class: 'status-dot', cx: 15, cy: 27, r: 3.5 }),
      el('text', { class: 'title', x: 27, y: 24 }),
      el('text', { class: 'subtitle', x: 27, y: 40 }),
      el('circle', { class: 'port', 'data-port': 'in', 'data-node': node.id, cx: 0, cy: 27, r: 5.5 }),
      el('circle', { class: 'port', 'data-port': 'out', 'data-node': node.id, cx: NODE_W, cy: 27, r: 5.5 }),
    );
    // 悬停节点时右侧出现的「+」：点它直接接一个新节点（Coze 的习惯）
    const next = el('g', { class: 'wf-add wf-add-next', 'data-add': 'next', 'data-node': node.id, transform: `translate(${NODE_W + 26},${NODE_H / 2})` });
    next.append(el('circle', { r: 10 }), el('text', { y: 4, 'text-anchor': 'middle' }));
    next.querySelector('text').textContent = '+';
    g.appendChild(next);
    // 右上角结果角标：运行过之后出现，点它看这个节点的输入输出（Coze 习惯）
    const result = el('g', { class: 'wf-node-result', 'data-result': node.id, transform: `translate(${NODE_W - 13},11)` });
    result.append(el('circle', { r: 8 }), el('text', { y: 3.5, 'text-anchor': 'middle' }));
    result.querySelector('text').textContent = 'i';
    const tip = el('title');
    tip.textContent = '查看这个节点的输入与输出';
    result.appendChild(tip);
    g.appendChild(result);
    return g;
  }

  function updateNodeEl(g, node) {
    const state = nodeStateOf(node.id);
    const status = state.status || 'idle';
    const classes = ['wf-node'];
    if (selection.has(node.id)) classes.push('selected');
    if (status && status !== 'idle') classes.push(status);
    g.setAttribute('class', classes.join(' '));
    g.setAttribute('transform', `translate(${Math.round(node.x)},${Math.round(node.y)})`);
    g.querySelector('.title').textContent = truncate(node.title || node.type);
    const subtitle = g.querySelector('.subtitle');
    if (state.error) subtitle.textContent = truncate(String(state.error).split('\n')[0], 18);
    else if (status === 'running') subtitle.textContent = state.progress != null ? `运行中 ${state.progress}%` : '运行中…';
    else if (status === 'success' && state.duration_ms != null) subtitle.textContent = `完成 ${(state.duration_ms / 1000).toFixed(1)}s`;
    else if (status === 'failed') subtitle.textContent = '失败';
    else if (status === 'skipped') subtitle.textContent = '已跳过';
    else subtitle.textContent = node.type;
    // 开始节点没有输入口，结束节点没有输出口；结束节点后面不能再接
    g.querySelector('[data-port="in"]').setAttribute('visibility', node.type === 'start' ? 'hidden' : 'visible');
    g.querySelector('[data-port="out"]').setAttribute('visibility', node.type === 'end' ? 'hidden' : 'visible');
    g.querySelector('.wf-add-next').setAttribute('visibility', node.type === 'end' ? 'hidden' : 'visible');
  }

  function portPos(id, side) {
    const node = nodes.find((n) => n.id === id);
    if (!node) return { x: 0, y: 0 };
    return { x: node.x + (side === 'out' ? NODE_W : 0), y: node.y + NODE_H / 2 };
  }

  function edgePath(from, to) {
    const a = portPos(from, 'out');
    const b = portPos(to, 'in');
    const dx = Math.max(36, Math.abs(b.x - a.x) * 0.5);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }

  function renderEdges() {
    const seen = new Set();
    for (const edge of edges) {
      seen.add(edge.id);
      let group = edgeEls.get(edge.id);
      if (!group) {
        group = el('g');
        group.append(el('path', { class: 'wf-edge-hit' }), el('path', { class: 'wf-edge' }));
        group.setAttribute('data-edge', edge.id);
        // 连线中间的「+」：点它在两个节点之间插入新节点（Coze 的习惯）
        const adder = el('g', { class: 'wf-add wf-add-edge', 'data-add': 'edge', 'data-edge': edge.id });
        adder.append(el('circle', { r: 10 }), el('text', { y: 4, 'text-anchor': 'middle' }));
        adder.querySelector('text').textContent = '+';
        group.appendChild(adder);
        // 分支线的名字标在中间，一眼能看出这条走的是哪个出口
        const label = el('text', { class: 'wf-edge-label', 'text-anchor': 'middle' });
        group.appendChild(label);
        edgeEls.set(edge.id, group);
        edgesLayer.appendChild(group);
      }
      const d = edgePath(edge.from, edge.to);
      const visible = group.querySelector('.wf-edge');
      const hit = group.querySelector('.wf-edge-hit');
      visible.setAttribute('d', d);
      visible.setAttribute('marker-end', 'url(#wf-arrow)');
      const fromState = nodeStateOf(edge.from).status;
      visible.setAttribute('class', `wf-edge${selectedEdge === edge.id ? ' selected' : ''}${fromState && fromState !== 'idle' ? ` ${fromState}` : ''}`);
      hit.setAttribute('d', d);
      const a = portPos(edge.from, 'out');
      const b = portPos(edge.to, 'in');
      group.querySelector('.wf-add-edge').setAttribute('transform', `translate(${Math.round((a.x + b.x) / 2)},${Math.round((a.y + b.y) / 2)})`);
      const labelEl = group.querySelector('.wf-edge-label');
      const fromNode = nodes.find((n) => n.id === edge.from);
      const branchDef = edge.branch ? (fromNode?.branches || []).find((item) => item.id === edge.branch) : null;
      if (edge.branch) {
        labelEl.textContent = branchDef?.label || edge.branch;
        labelEl.setAttribute('x', Math.round((a.x + b.x) / 2));
        labelEl.setAttribute('y', Math.round((a.y + b.y) / 2) - 14);
        labelEl.setAttribute('visibility', 'visible');
      } else {
        labelEl.setAttribute('visibility', 'hidden');
      }
    }
    for (const [id, group] of edgeEls) {
      if (!seen.has(id)) { group.remove(); edgeEls.delete(id); }
    }
  }

  function render() {
    const seen = new Set();
    for (const node of nodes) {
      seen.add(node.id);
      let g = nodeEls.get(node.id);
      if (!g) { g = createNodeEl(node); nodeEls.set(node.id, g); nodesLayer.appendChild(g); }
      updateNodeEl(g, node);
    }
    for (const [id, g] of nodeEls) {
      if (!seen.has(id)) { g.remove(); nodeEls.delete(id); }
    }
    renderEdges();
  }

  // ---------------- 交互 ----------------
  let mode = null; // 'pan' | 'node' | 'marquee' | 'connect'
  let drag = null;

  const canvasPoint = (event) => ({ clientX: event.clientX, clientY: event.clientY });

  svg.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    wrap.focus({ preventScroll: true });
    const target = event.target;

    // 连线中间 / 节点右侧的「+」：打开节点选择器，选中后自动接上
    const addTarget = target.closest ? target.closest('.wf-add') : null;
    if (addTarget && !readOnly) {
      event.preventDefault();
      const point = toWorld(event.clientX, event.clientY);
      const payload = {
        x: point.x - NODE_W / 2,
        y: point.y - NODE_H / 2,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      if (addTarget.dataset.add === 'edge') {
        const edge = edges.find((e) => e.id === addTarget.dataset.edge);
        if (edge) handlers.onAddNode?.({ ...payload, from: edge.from, to: edge.to, edgeId: edge.id });
      } else {
        handlers.onAddNode?.({ ...payload, from: addTarget.dataset.node });
      }
      return;
    }

    // 节点右上角的结果角标
    const resultTarget = target.closest ? target.closest('.wf-node-result') : null;
    if (resultTarget) {
      event.preventDefault();
      handlers.onNodeResult?.(resultTarget.dataset.result, event);
      return;
    }

    if (target.dataset && target.dataset.port === 'out') {
      if (readOnly) return;
      mode = 'connect';
      drag = { from: target.dataset.node, point: toWorld(event.clientX, event.clientY) };
      draftEdge.setAttribute('visibility', 'visible');
      updateDraftEdge(event);
      event.preventDefault();
      return;
    }

    const nodeGroup = target.closest ? target.closest('.wf-node') : null;
    if (nodeGroup && !target.closest('.wf-add') && !target.closest('.wf-node-result')) {
      const id = nodeGroup.dataset.node;
      if (!event.shiftKey && !selection.has(id)) { selection = new Set([id]); selectedEdge = null; }
      else if (event.shiftKey && selection.has(id)) selection.delete(id);
      else selection.add(id);
      render();
      emitSelect();
      if (!readOnly) {
        const node = nodes.find((n) => n.id === id);
        mode = 'node';
        drag = { startX: event.clientX, startY: event.clientY, origin: [...selection].map((sid) => ({ id: sid, x: nodes.find((n) => n.id === sid).x, y: nodes.find((n) => n.id === sid).y })), moved: false, node };
      }
      event.preventDefault();
      return;
    }

    const edgeGroup = target.closest ? target.closest('[data-edge]') : null;
    if (edgeGroup) {
      selectedEdge = edgeGroup.getAttribute('data-edge');
      selection = new Set();
      render();
      emitSelect();
      event.preventDefault();
      return;
    }

    // 空白处：Shift 框选，否则平移
    if (event.shiftKey) {
      mode = 'marquee';
      drag = { start: toWorld(event.clientX, event.clientY) };
      marquee.setAttribute('visibility', 'visible');
    } else {
      mode = 'pan';
      drag = { startX: event.clientX, startY: event.clientY, panX, panY };
      svg.classList.add('panning');
      if (!event.shiftKey) { selection = new Set(); selectedEdge = null; render(); emitSelect(); }
    }
    event.preventDefault();
  });

  function updateDraftEdge(event) {
    if (!drag || mode !== 'connect') return;
    const from = portPos(drag.from, 'out');
    const to = toWorld(event.clientX, event.clientY);
    const dx = Math.max(36, Math.abs(to.x - from.x) * 0.5);
    draftEdge.setAttribute('d', `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`);
  }

  window.addEventListener('mousemove', onWindowMouseMove);
  window.addEventListener('mouseup', onWindowMouseUp);
  window.addEventListener('blur', cancelDrag);

  function onWindowMouseMove(event) {
    if (!mode || !drag) return;
    // 拖动期间阻止默认行为，否则会触发原生文字选择（Windows 上表现为一块强调色方块）
    event.preventDefault();
    if (mode === 'pan') {
      panX = drag.panX + (event.clientX - drag.startX);
      panY = drag.panY + (event.clientY - drag.startY);
      userAdjusted = true;
      applyTransform();
      return;
    }
    if (mode === 'node') {
      const dx = (event.clientX - drag.startX) / scale;
      const dy = (event.clientY - drag.startY) / scale;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
      if (!drag.moved) { snapshot(); drag.moved = true; }
      // 只更新被拖动的节点与连线，不整块重绘：节点多时拖动才跟得住手
      for (const origin of drag.origin) {
        const node = nodes.find((n) => n.id === origin.id);
        if (!node) continue;
        node.x = Math.round(origin.x + dx);
        node.y = Math.round(origin.y + dy);
        const group = nodeEls.get(node.id);
        if (group) group.setAttribute('transform', `translate(${node.x},${node.y})`);
      }
      renderEdges();
      return;
    }
    if (mode === 'marquee') {
      const now = toWorld(event.clientX, event.clientY);
      const x = Math.min(drag.start.x, now.x);
      const y = Math.min(drag.start.y, now.y);
      marquee.setAttribute('x', x);
      marquee.setAttribute('y', y);
      marquee.setAttribute('width', Math.abs(now.x - drag.start.x));
      marquee.setAttribute('height', Math.abs(now.y - drag.start.y));
      return;
    }
    if (mode === 'connect') updateDraftEdge(event);
  }

  function onWindowMouseUp(event) {
    if (!mode) return;
    // 无论哪种模式，收尾时都把临时图形收干净，避免留下「卡住」的框
    marquee.setAttribute('visibility', 'hidden');
    draftEdge.setAttribute('visibility', 'hidden');
    svg.classList.remove('panning');
    if (mode === 'node' && drag?.moved) emitChange();
    if (mode === 'marquee') {
      const box = {
        x: Number(marquee.getAttribute('x')), y: Number(marquee.getAttribute('y')),
        w: Number(marquee.getAttribute('width')), h: Number(marquee.getAttribute('height')),
      };
      if (box.w > 4 && box.h > 4) {
        const hit = nodes.filter((n) => n.x + NODE_W >= box.x && n.x <= box.x + box.w && n.y + NODE_H >= box.y && n.y <= box.y + box.h);
        selection = new Set(hit.map((n) => n.id));
        render();
        emitSelect();
      }
    }
    if (mode === 'connect') {
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const port = under && under.dataset ? under.dataset.port : null;
      const toId = under && under.dataset ? under.dataset.node : null;
      if (port === 'in' && toId && toId !== drag.from) connect(drag.from, toId);
    }
    mode = null;
    drag = null;
  }

  // 拖到窗口外松手会收不到 mouseup，失焦时兜底取消，避免留下半截状态
  function cancelDrag() {
    if (!mode) return;
    mode = null;
    drag = null;
    marquee.setAttribute('visibility', 'hidden');
    draftEdge.setAttribute('visibility', 'hidden');
    svg.classList.remove('panning');
  }

  svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = svg.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(2.4, Math.max(0.25, scale * factor));
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    panX = cx - ((cx - panX) / scale) * next;
    panY = cy - ((cy - panY) / scale) * next;
    scale = next;
    userAdjusted = true;
    applyTransform();
  }, { passive: false });

  svg.addEventListener('dblclick', (event) => {
    const nodeGroup = event.target.closest ? event.target.closest('.wf-node') : null;
    if (!nodeGroup || event.target.closest('.wf-add')) return;
    event.preventDefault();
    handlers.onOpenNode?.(nodeGroup.dataset.node);
  });

  svg.addEventListener('contextmenu', (event) => {
    const target = event.target;
    const edgeGroup = target.closest ? target.closest('[data-edge]') : null;
    const nodeGroup = target.closest ? target.closest('.wf-node') : null;
    if (edgeGroup) {
      event.preventDefault();
      handlers.onEdgeMenu?.(edgeGroup.getAttribute('data-edge'), event);
      return;
    }
    if (nodeGroup) {
      event.preventDefault();
      const id = nodeGroup.dataset.node;
      selection = new Set([id]);
      selectedEdge = null;
      render();
      emitSelect();
      handlers.onNodeMenu?.(id, event);
      return;
    }
    event.preventDefault();
    handlers.onCanvasMenu?.(event);
  });

  toolbar.addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.zoom;
    if (action === 'in') zoomBy(1.2);
    else if (action === 'out') zoomBy(1 / 1.2);
    else if (action === 'fit') fit();
    else if (action === 'layout') autoLayout();
  });

  wrap.addEventListener('keydown', (event) => {
    if (readOnly) return;
    const key = event.key.toLowerCase();
    const meta = event.ctrlKey || event.metaKey;
    if (meta && key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); return; }
    if (meta && (key === 'y' || (key === 'z' && event.shiftKey))) { event.preventDefault(); redo(); return; }
    if (meta && key === 'c') { event.preventDefault(); copySelection(); return; }
    if (meta && key === 'v') { event.preventDefault(); pasteClipboard(); return; }
    if (meta && key === 'a') { event.preventDefault(); selection = new Set(nodes.map((n) => n.id)); render(); emitSelect(); return; }
    if (key === 'delete' || key === 'backspace') { event.preventDefault(); removeSelected(); }
  });

  // ---------------- 图操作 ----------------
  function reaches(startId, targetId, visited = new Set()) {
    if (startId === targetId) return true;
    if (visited.has(startId)) return false;
    visited.add(startId);
    return edges.filter((e) => e.from === startId).some((e) => reaches(e.to, targetId, visited));
  }

  function nextEdgeId() {
    edgeSeq += 1;
    return `e_${Date.now().toString(36)}_${edgeSeq}`;
  }

  function connect(from, to) {
    const fromNode = nodes.find((n) => n.id === from);
    const toNode = nodes.find((n) => n.id === to);
    if (!fromNode || !toNode) return;
    if (toNode.type === 'start') { handlers.onStatus?.('开始节点不能作为连接目标'); return; }
    if (fromNode.type === 'end') { handlers.onStatus?.('结束节点不能再连出'); return; }
    if (edges.some((e) => e.from === from && e.to === to)) { handlers.onStatus?.('这两个节点已经连过了'); return; }
    if (reaches(to, from)) { handlers.onStatus?.('这条连线会形成环，已取消'); return; }
    snapshot();
    // 从条件分支节点连出去时，这条线默认归属第一个出口，之后可以改
    const branches = Array.isArray(fromNode.branches) ? fromNode.branches : [];
    const created = { id: nextEdgeId(), from, to, branch: branches.length ? branches[0].id : '' };
    edges.push(created);
    render();
    emitChange();
    if (branches.length) handlers.onEdgeCreated?.(created.id);
  }

  function addNode(type, position, meta) {
    snapshot();
    const id = `${type}_${Date.now().toString(36)}${Math.floor(Math.random() * 90 + 10)}`;
    const node = {
      id,
      type,
      title: meta?.label || type,
      x: Math.round(position?.x ?? 120),
      y: Math.round(position?.y ?? 120),
      params: {},
      error_policy: 'stop',
      max_retry: 2,
      retry_interval_ms: 2000,
    }
    // 用节点声明的默认值初始化参数，省得用户每项都填（深拷贝，避免多个节点共用同一个数组）
    for (const param of meta?.params || []) {
      if (param.default !== undefined) {
        node.params[param.key] = param.default && typeof param.default === 'object'
          ? JSON.parse(JSON.stringify(param.default))
          : param.default;
      }
    }
    // 条件分支节点：从参数推导出出口列表，画布据此标分支名
    if (meta?.branches) {
      const rows = Array.isArray(node.params.branches) ? node.params.branches : [];
      node.branches = [...rows.filter((row) => row && row.key).map((row) => ({ id: row.key, label: row.key })), { id: 'else', label: '否则' }];
    }
    nodes.push(node);
    selection = new Set([id]);
    render();
    emitChange();
    emitSelect();
    return node;
  }

  // 插入节点并自动接线：从「+」进来时用。
  // 和 Coze / n8n 一样，把插入点右侧的节点整体右移腾位置，新节点不会压住别人。
  function insertNode(type, position, meta, wiring = {}) {
    const anchor = wiring.from ? nodes.find((n) => n.id === wiring.from) : null;
    let pos = { x: Math.round(position?.x ?? 200), y: Math.round(position?.y ?? 160) };
    if (anchor) {
      const gap = NODE_W + 72;
      for (const item of nodes) {
        if (item.id === anchor.id) continue;
        if (item.x > anchor.x + 1) item.x += gap;
      }
      pos = { x: anchor.x + NODE_W + 72, y: anchor.y };
    }
    const node = addNode(type, pos, meta);
    snapshot();
    if (wiring.edgeId) edges = edges.filter((e) => e.id !== wiring.edgeId);
    if (wiring.from && node.type !== 'start') edges.push({ id: nextEdgeId(), from: wiring.from, to: node.id });
    if (wiring.to && node.type !== 'end') edges.push({ id: nextEdgeId(), from: node.id, to: wiring.to });
    render();
    emitChange();
    return node;
  }

  function updateNode(id, patch, { record = true } = {}) {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    if (record) snapshot();
    Object.assign(node, patch);
    render();
    emitChange();
  }

  function updateNodeParams(id, params, { record = true } = {}) {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    if (record) snapshot();
    node.params = { ...params };
    render();
    emitChange();
  }

  function removeSelected() {
    if (readOnly) return;
    if (!selection.size && !selectedEdge) return;
    snapshot();
    if (selectedEdge) { edges = edges.filter((e) => e.id !== selectedEdge); selectedEdge = null; }
    if (selection.size) {
      nodes = nodes.filter((n) => !selection.has(n.id));
      edges = edges.filter((e) => !selection.has(e.from) && !selection.has(e.to));
      selection = new Set();
    }
    render();
    emitChange();
    emitSelect();
  }

  let clipboard = null;

  function copySelection() {
    if (!selection.size) return;
    clipboard = {
      nodes: nodes.filter((n) => selection.has(n.id)).map((n) => JSON.parse(JSON.stringify(n))),
      edges: edges.filter((e) => selection.has(e.from) && selection.has(e.to)).map((e) => ({ ...e })),
    };
    handlers.onStatus?.(`已复制 ${clipboard.nodes.length} 个节点`);
  }

  function pasteClipboard() {
    if (!clipboard || !clipboard.nodes.length) return;
    snapshot();
    const idMap = new Map();
    const created = [];
    for (const node of clipboard.nodes) {
      const id = `${node.type}_${Date.now().toString(36)}${Math.floor(Math.random() * 900 + 100)}`;
      idMap.set(node.id, id);
      const copy = { ...JSON.parse(JSON.stringify(node)), id, x: node.x + 28, y: node.y + 28 };
      nodes.push(copy);
      created.push(id);
    }
    for (const edge of clipboard.edges) {
      const from = idMap.get(edge.from);
      const to = idMap.get(edge.to);
      if (from && to) edges.push({ id: nextEdgeId(), from, to });
    }
    selection = new Set(created);
    render();
    emitChange();
    emitSelect();
  }

  function undo() {
    if (!history.past.length) return;
    history.future.push(JSON.stringify({ nodes, edges }));
    restore(history.past.pop());
  }

  function redo() {
    if (!history.future.length) return;
    history.past.push(JSON.stringify({ nodes, edges }));
    restore(history.future.pop());
  }

  function zoomBy(factor) {
    const rect = svg.getBoundingClientRect();
    const next = Math.min(2.4, Math.max(0.25, scale * factor));
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    panX = cx - ((cx - panX) / scale) * next;
    panY = cy - ((cy - panY) / scale) * next;
    scale = next;
    userAdjusted = true;
    applyTransform();
  }

  function fit() {
    userAdjusted = false;
    if (!nodes.length) { scale = 1; panX = 40; panY = 30; applyTransform(); return; }
    const rect = svg.getBoundingClientRect();
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + NODE_W));
    const maxY = Math.max(...nodes.map((n) => n.y + NODE_H));
    const pad = 40;
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    scale = Math.min(2.4, Math.max(0.25, Math.min(rect.width / w, rect.height / h)));
    panX = (rect.width - (maxX - minX) * scale) / 2 - minX * scale;
    panY = (rect.height - (maxY - minY) * scale) / 2 - minY * scale;
    applyTransform();
  }

  // 布局变化（例如右侧配置面板开合导致画布变窄）后重新适配，
  // 但用户自己缩放/平移过就不打扰他。
  function autoFit() {
    if (!userAdjusted) fit();
  }

  // 简易分层自动布局：按入度拓扑分层，同层纵向排列
  function autoLayout() {
    if (!nodes.length) return;
    snapshot();
    const incoming = new Map(nodes.map((n) => [n.id, []]));
    for (const edge of edges) if (incoming.has(edge.to)) incoming.get(edge.to).push(edge.from);
    const depth = new Map();
    const compute = (id, guard = new Set()) => {
      if (depth.has(id)) return depth.get(id);
      if (guard.has(id)) return 0;
      guard.add(id);
      const parents = incoming.get(id) || [];
      const value = parents.length ? Math.max(...parents.map((p) => compute(p, guard))) + 1 : 0;
      depth.set(id, value);
      return value;
    };
    nodes.forEach((n) => compute(n.id));
    const columns = new Map();
    for (const node of nodes) {
      const level = depth.get(node.id) || 0;
      if (!columns.has(level)) columns.set(level, []);
      columns.get(level).push(node);
    }
    for (const [level, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
      list.forEach((node, index) => {
        node.x = 60 + level * 240;
        node.y = 60 + index * 92;
      });
    }
    render();
    emitChange();
    fit();
  }

  function setNodeStates(map) {
    nodeStates = map || {};
    for (const [id, g] of nodeEls) updateNodeEl(g, nodes.find((n) => n.id === id) || { id, type: '', x: 0, y: 0 });
    renderEdges();
  }

  function setGraph(nextNodes, nextEdges, { keepHistory = false } = {}) {
    nodes = JSON.parse(JSON.stringify(nextNodes || []));
    edges = JSON.parse(JSON.stringify(nextEdges || []));
    if (!keepHistory) { history.past.length = 0; history.future.length = 0; }
    selection = new Set();
    selectedEdge = null;
    nodeStates = {};
    for (const g of nodeEls.values()) g.remove();
    nodeEls.clear();
    for (const g of edgeEls.values()) g.remove();
    edgeEls.clear();
    render();
    emitSelect();
  }

  function setReadOnly(value) {
    readOnly = Boolean(value);
    wrap.style.opacity = readOnly ? '0.96' : '';
    hint.textContent = readOnly ? '运行回放：只读' : '右键节点改设置 · 拖动空白平移 · 滚轮缩放 · Shift+框选 · Delete 删除';
  }

  function selectNode(id) {
    selection = new Set(id ? [id] : []);
    selectedEdge = null;
    render();
    emitSelect();
  }

  function centerOn(id) {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    const rect = svg.getBoundingClientRect();
    panX = rect.width / 2 - (node.x + NODE_W / 2) * scale;
    panY = rect.height / 2 - (node.y + NODE_H / 2) * scale;
    applyTransform();
  }

  // 节点在屏幕上的位置，用来把设置浮层贴在节点旁边
  function nodeScreenRect(id) {
    const group = nodeEls.get(id);
    if (group) return group.getBoundingClientRect();
    const node = nodes.find((n) => n.id === id);
    if (!node) return null;
    const rect = svg.getBoundingClientRect();
    return {
      left: rect.left + panX + node.x * scale,
      top: rect.top + panY + node.y * scale,
      width: NODE_W * scale,
      height: NODE_H * scale,
      right: rect.left + panX + (node.x + NODE_W) * scale,
      bottom: rect.top + panY + (node.y + NODE_H) * scale,
    };
  }

  function destroy() {
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onWindowMouseUp);
    window.removeEventListener('blur', cancelDrag);
    wrap.remove();
  }

  applyTransform();

  return {
    el: wrap,
    destroy,
    screenToWorld: toWorld,
    setGraph,
    // 改某条连线属于哪个分支出口
    setEdgeBranch: (edgeId, branchId) => {
      const edge = edges.find((e) => e.id === edgeId);
      if (!edge) return false;
      snapshot();
      edge.branch = String(branchId || '');
      render();
      emitChange();
      return true;
    },
    getEdge: (edgeId) => edges.find((e) => e.id === edgeId) || null,
    getGraph: () => ({ nodes, edges }),
    setNodeStates,
    setReadOnly,
    selectNode,
    centerOn,
    nodeScreenRect,
    addNode,
    insertNode,
    removeEdge: (edgeId) => {
      const before = edges.length;
      snapshot();
      edges = edges.filter((e) => e.id !== edgeId);
      if (edges.length === before) return false;
      selectedEdge = null;
      render();
      emitChange();
      return true;
    },
    copySelection: () => {
      if (!selection.size) return false;
      copySelection();
      return true;
    },
    updateNode,
    updateNodeParams,
    removeSelected,
    undo,
    redo,
    fit,
    autoFit,
    autoLayout,
    zoomBy,
    getSelection: () => [...selection],
    getSelectedEdge: () => selectedEdge,
    resize: () => { /* SVG 自适应容器，无需处理 */ },
  };
}
