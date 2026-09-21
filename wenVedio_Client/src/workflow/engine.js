// 工作流 · 执行引擎
// 设计要点：
// 1) 服务端驱动：不依赖前端页面开着，HTTP 请求结束也不会中断。
// 2) 每个节点的状态与「挂起标记」都落盘：进程退出（关掉客户端）后重启能接着跑。
// 3) 异步节点（图片/视频）在同一个 advance 调用里等待，tick 只负责把没在推进的运行踢起来。
'use strict';

const crypto = require('crypto');
const { NODE_DEFS, delay, loopMembers } = require('./nodes');
const { resolveParam, getPath } = require('./vars');

const TICK_MS = 800;
// 一批最多同时推进几个节点：互相独立的分支并发跑，但不能无限开
const MAX_PARALLEL = Math.max(1, Math.min(16, Number(process.env.WF_MAX_PARALLEL) || 4));
// 运行记录里保存的输入/输出：超长字符串（图片 data URL 之类）截断，避免记录文件膨胀
const MAX_RUN_STRING = 2000;

function shrinkForRun(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > MAX_RUN_STRING ? `${value.slice(0, MAX_RUN_STRING)}…（共 ${value.length} 字，已截断）` : value;
  }
  if (typeof value !== 'object') return value;
  if (depth > 8) return '（层级过深，已省略）';
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => shrinkForRun(item, depth + 1));
  const out = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= 200) { out.__truncated__ = '（字段过多，已省略）'; break; }
    out[key] = shrinkForRun(item, depth + 1);
    count += 1;
  }
  return out;
}
const TERMINAL = new Set(['success', 'failed', 'skipped']);
const RUN_TERMINAL = new Set(['success', 'failed', 'cancelled']);

function create({ store, bridge, writeLog }) {
  const advancing = new Set();
  // 每个正在推进的运行配一个 AbortController：取消时能立刻打断正在等待的 HTTP / 长任务
  const controllers = new Map();
  let timer = null;

  const nowIso = () => new Date().toISOString();
  const newRunId = () => `run_${crypto.randomBytes(6).toString('hex')}`;

  // ---------------- 运行记录 ----------------

  // 从中间某个节点开始跑：它上游的节点直接用上次运行的结果填充（不再执行），
  // 既不是它的上游、也不在它下游的节点（平行分支）直接跳过，避免出现悬空节点。
  function applyStartFrom(run, graph, fromNodeId, seedOutputs) {
    const downstream = new Set();
    const down = [fromNodeId];
    while (down.length) {
      const id = down.pop();
      if (downstream.has(id)) continue;
      downstream.add(id);
      for (const edge of graph.outgoing.get(id) || []) down.push(edge.to);
    }
    const ancestors = new Set();
    const up = [fromNodeId];
    while (up.length) {
      const id = up.pop();
      for (const edge of graph.incoming.get(id) || []) {
        if (ancestors.has(edge.from)) continue;
        ancestors.add(edge.from);
        up.push(edge.from);
      }
    }
    for (const node of graph.nodes) {
      if (node.id === fromNodeId) continue;
      const state = run.nodes[node.id];
      if (!state) continue;
      if (ancestors.has(node.id)) {
        state.status = 'success';
        state.output = seedOutputs[node.id] === undefined ? null : seedOutputs[node.id];
        state.seeded = true;
        state.finished_at = nowIso();
        state.note = '沿用上次运行的结果';
      } else if (!downstream.has(node.id)) {
        state.status = 'skipped';
        state.finished_at = nowIso();
        state.note = '本次从中间节点开始，这条线没跑';
      }
    }
  }

  function startRun(workflow, inputs, mode, options = {}) {
    const startedAt = nowIso();
    const run = {
      id: newRunId(),
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      workflow_version: workflow.version || 0,
      mode: mode || 'draft',
      status: 'running',
      inputs: inputs && typeof inputs === 'object' ? inputs : {},
      outputs: null,
      error: null,
      created_at: startedAt,
      started_at: startedAt,
      finished_at: null,
      duration_ms: null,
      total_tokens: 0,
      variables: {},
      nodes: {},
      // 运行时的定义快照：即使工作流之后被改动，这条记录也能回放当时的执行过程
      snapshot: {
        nodes: JSON.parse(JSON.stringify(workflow.nodes || [])),
        edges: JSON.parse(JSON.stringify(workflow.edges || [])),
      },
    };
    for (const node of run.snapshot.nodes) {
      run.nodes[node.id] = { id: node.id, type: node.type, title: node.title || node.type, status: 'pending', disabled: node.disabled === true };
    }
    // 循环体里的节点不参与顶层推进：标记成 skipped 并写明它在哪个循环里跑
    for (const [nodeId, loopId] of loopMembers(run.snapshot)) {
      const state = run.nodes[nodeId];
      if (!state) continue;
      state.in_loop = loopId;
      state.status = 'skipped';
      state.note = '在循环体内执行';
      state.finished_at = startedAt;
    }
    // 从中间节点开始：上游沿用上次结果，平行分支直接跳过
    if (options.fromNode && run.nodes[options.fromNode]) {
      applyStartFrom(run, buildGraph(run.snapshot), options.fromNode, options.seedOutputs || {});
      run.from_node = options.fromNode;
    }
    store.saveRun(run);
    store.touchWorkflowRun(workflow.id, startedAt);
    store.pruneRuns();
    writeLog('info', `工作流运行开始 ${run.id}（${run.workflow_name} v${run.workflow_version}）`);
    kick(run.id);
    return run;
  }

  function finalize(run, status, error) {
    if (RUN_TERMINAL.has(run.status) && run.id && status !== 'cancelled') {
      // 已经是终态就不再改（重复 finalize 保护）
      if (run.finished_at) return run;
    }
    run.status = status;
    run.finished_at = nowIso();
    const started = run.started_at ? new Date(run.started_at).getTime() : Date.now();
    run.duration_ms = Math.max(0, Date.now() - started);
    if (error) run.error = String(error).slice(0, 1000);
    for (const state of Object.values(run.nodes)) {
      if (!TERMINAL.has(state.status)) {
        state.status = 'skipped';
        state.finished_at = state.finished_at || run.finished_at;
      }
    }
    if (status === 'success') {
      const nodes = run.snapshot?.nodes || [];
      const endNode = nodes.find((node) => node.type === 'end');
      const endState = endNode ? run.nodes[endNode.id] : null;
      if (endState && endState.status === 'success') {
        run.outputs = endState.output;
      } else {
        const lastDone = [...nodes].reverse().map((node) => run.nodes[node.id]).find((state) => state && state.status === 'success');
        run.outputs = lastDone ? lastDone.output : null;
      }
    }
    store.saveRun(run);
    // 把结果回写到工作流上：列表页一眼能看出上次是成功还是失败
    store.touchWorkflowRun(run.workflow_id, run.finished_at, status);
    store.pruneRuns();
    writeLog(status === 'success' ? 'info' : 'warn', `工作流运行结束 ${run.id} → ${status}${run.error ? `（${run.error}）` : ''}`);
    return run;
  }

  // ---------------- 推进 ----------------

  function buildGraph(snapshot) {
    const all = snapshot.nodes || [];
    // 循环体里的节点由循环节点按项调度，不参与顶层推进（顶层把它们标成 skipped）
    const claimed = loopMembers(snapshot);
    const nodes = all.filter((node) => !claimed.has(node.id));
    const incoming = new Map();
    const outgoing = new Map();
    nodes.forEach((node) => { incoming.set(node.id, []); outgoing.set(node.id, []); });
    for (const edge of snapshot.edges || []) {
      if (!incoming.has(edge.to) || !outgoing.has(edge.from)) continue;
      // 边上可以带分支名（条件分支节点的每个出口一条），用于判断这条线有没有被走到
      incoming.get(edge.to).push({ from: edge.from, branch: edge.branch || '' });
      outgoing.get(edge.from).push({ to: edge.to, branch: edge.branch || '' });
    }
    return { nodes, incoming, outgoing, types: new Map(nodes.map((node) => [node.id, node.type])) };
  }

  // 上游节点实际走的是哪条分支：只有「条件分支」节点才有这个语义。
  // 原先只看输出里有没有 branch 字符串，于是 merge / code 把用户字段展开到顶层后，
  // 任意一个叫 branch 的字段都会劫持路由（该跑的跳过、不该跑的放行），这里按类型收紧。
  function takenBranch(run, nodeId, graph) {
    if (graph && graph.types && graph.types.get(nodeId) !== 'condition') return '';
    const state = run.nodes[nodeId];
    const output = state && state.output;
    if (output && typeof output === 'object' && typeof output.branch === 'string') return output.branch;
    return '';
  }

  // 判断一个节点现在能不能跑：
  //   ready = 至少有一条入边被真正走到
  //   skip  = 所有入边都已定局、但没有一条被走到（分支没选中它）
  //   wait  = 还有上游没跑完
  function evaluateNode(run, node, graph) {
    const incoming = graph.incoming.get(node.id) || [];
    const disabled = node.disabled === true;
    if (!incoming.length) return disabled ? 'skip' : 'ready';
    let anyActive = false;
    let allSettled = true;
    for (const edge of incoming) {
      const up = run.nodes[edge.from];
      // 上游还没定局就得等。被禁用的节点也要等——它的「透传」值就是上游的输出，
      // 早标一步会把它标成 null，下游拿到的是空值（并发推进时踩到过）。
      if (!up || !TERMINAL.has(up.status)) { allSettled = false; continue; }
      // 被禁用的节点不看分支：上游一旦定局就整条透传
      if (disabled) continue;
      // 被禁用的上游算「已放行」：它只是透传，不该把下游一起掐掉
      if (up.status !== 'success' && up.disabled !== true) continue;
      if (up.disabled === true) { anyActive = true; continue; }
      const taken = takenBranch(run, edge.from, graph);
      // 上游不是分支节点（taken 为空）→ 边一定被走到；
      // 分支节点 → 只有边上的分支名和它实际走的一致才算走到
      if (!edge.branch || !taken || edge.branch === taken) anyActive = true;
    }
    // 必须等所有入边都定局：多上游节点（变量聚合这种）早跑会拿到空的上游输出
    if (!allSettled) return 'wait';
    if (disabled) return 'skip';
    return anyActive ? 'ready' : 'skip';
  }

  // 把「现在能跑」的节点一次挑一批：互相独立的分支就能并发推进，而不是排成一队。
  // 注意 evaluateNode 要求所有入边都已定局——否则多上游节点（变量聚合这种）
  // 会在另一个上游还在跑的时候就启动，参数里引用到的那一边是空的。
  function pickBatch(run, graph, limit) {
    const ready = [];
    for (const node of graph.nodes) {
      const state = run.nodes[node.id];
      if (!state || state.status !== 'pending') continue;
      const verdict = evaluateNode(run, node, graph);
      // 分支没选中的节点：标一个跳过就立即重扫，下游依赖这个状态
      if (verdict === 'skip') return { skip: node };
      if (verdict === 'ready') {
        ready.push(node);
        if (ready.length >= limit) break;
      }
    }
    return { ready };
  }

  // 被跳过（没被分支选中）或「被禁用（透传）」的节点
  function markSkipped(run, node, graph) {
    const state = run.nodes[node.id];
    state.status = 'skipped';
    state.finished_at = nowIso();
    state.error = null;
    // 被禁用的节点把上游输出原样透传，下游才能照常跑
    if (state.disabled === true) {
      const ups = graph.incoming.get(node.id) || [];
      const first = ups.length ? run.nodes[ups[0].from] : null;
      state.output = first ? (first.output ?? null) : null;
      state.note = '已禁用，输入已透传';
    }
  }

  function hasPendingOrRunning(run) {
    return Object.values(run.nodes).some((state) => !TERMINAL.has(state.status));
  }

  async function advance(run) {
    const graph = buildGraph(run.snapshot || { nodes: [], edges: [] });
    for (;;) {
      if (run.cancel_requested) { finalize(run, 'cancelled', '运行已被取消'); return; }
      if (run.paused) { store.saveRun(run); return; }
      if (RUN_TERMINAL.has(run.status)) return;

      const picked = pickBatch(run, graph, MAX_PARALLEL);
      // 分支没选中：标记跳过，继续找下一批
      if (picked.skip) {
        markSkipped(run, picked.skip, graph);
        store.saveRun(run);
        continue;
      }
      const batch = picked.ready || [];
      if (!batch.length) {
        if (!hasPendingOrRunning(run)) {
          const failed = Object.values(run.nodes).some((state) => state.status === 'failed');
          finalize(run, failed ? 'failed' : 'success', failed ? (run.error || '存在失败节点') : null);
        } else {
          // 还有节点没跑但都不可达：连线成环，或上游链断了
          finalize(run, 'failed', '有节点无法执行：连线可能形成了环，或没有从开始节点连过来');
        }
        return;
      }
      // 并发推进这一批。某个节点失败且策略是「停止整个工作流」时，
      // executeNode 会把运行直接标成失败，批内其它节点的结果照常落盘。
      await Promise.all(batch.map((node) => executeNode(run, node, graph)));
      store.saveRun(run);
    }
  }

  async function executeNode(run, node, graph) {
    const state = run.nodes[node.id];
    const type = node.type;
    const def = NODE_DEFS[type];
    const policy = node.error_policy || 'stop';
    const maxAttempts = policy === 'retry' ? Math.max(1, Math.min(10, (node.max_retry || 2) + 1)) : 1;

    if (!def || typeof def.run !== 'function') {
      state.status = 'failed';
      state.error = `未知节点类型：${type}`;
      state.finished_at = nowIso();
      store.saveRun(run);
      if (policy !== 'continue') finalize(run, 'failed', state.error);
      return;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      state.status = 'running';
      state.started_at = state.started_at || nowIso();
      state.attempts = attempt;
      state.error = null;
      store.saveRun(run);
      try {
        const output = await runNode(run, node, graph);
        state.output = output === undefined ? null : output;
        state.status = 'success';
        state.finished_at = nowIso();
        state.duration_ms = state.started_at ? Date.now() - new Date(state.started_at).getTime() : null;
        state.pending = null;
        state.progress = null;
        if (output && Number.isFinite(Number(output.total_tokens))) {
          run.total_tokens = (run.total_tokens || 0) + Number(output.total_tokens);
        }
        store.saveRun(run);
        return;
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        state.error = message.slice(0, 1000);
        if (run.cancel_requested) { finalize(run, 'cancelled', '运行已被取消'); return; }
        if (attempt < maxAttempts) {
          state.status = 'pending';
          store.saveRun(run);
          writeLog('warn', `工作流节点 ${node.id} 第 ${attempt} 次失败，准备重试：${message}`);
          await delay(Math.max(0, Math.min(60000, Number(node.retry_interval_ms) || 2000)));
          continue;
        }
        state.status = 'failed';
        state.finished_at = nowIso();
        state.duration_ms = state.started_at ? Date.now() - new Date(state.started_at).getTime() : null;
        store.saveRun(run);
        if (policy !== 'continue') {
          run.error = `节点「${node.title || node.id}」失败：${message}`;
          finalize(run, 'failed', run.error);
        }
        return;
      }
    }
  }

  async function runNode(run, node, graph) {
    const executor = NODE_DEFS[node.type];
    const incomingEdges = graph.incoming.get(node.id) || [];
    const firstUpstream = incomingEdges.length ? incomingEdges[0].from : null;

    const scope = {};
    for (const item of graph.nodes) {
      const state = run.nodes[item.id];
      if (state && state.output !== undefined) scope[item.id] = state.output;
    }
    const state = run.nodes[node.id];
    const params = resolveParam(node.params || {}, scope);
    // 输入：节点自己声明了「输入参数」就按映射构造（Coze 代码节点的做法），
    // 没声明则沿用上游第一个节点的输出，旧工作流行为不变。
    let input = firstUpstream && run.nodes[firstUpstream] ? (run.nodes[firstUpstream].output ?? null) : null;
    const inputRows = Array.isArray(node.input_params) ? node.input_params : [];
    if (inputRows.length) {
      const mapped = {};
      for (const row of inputRows) {
        const key = String(row?.key || '').trim();
        if (key) mapped[key] = resolveParam(row?.value, scope);
      }
      input = mapped;
    }
    // 存档一份这个节点实际拿到的输入，调试面板要显示（大字段截断，别把运行记录撑爆）
    state.input = shrinkForRun(input);
    const ctx = {
      node,
      run,
      input,
      scope,
      rawInputs: run.inputs,
      params,
      pending: state.pending || null,
      setPending: (value) => { state.pending = value; store.saveRun(run); },
      clearPending: () => { state.pending = null; store.saveRun(run); },
      log: (message) => writeLog('info', `[${run.id}/${node.id}] ${message}`),
      progress: (value) => { state.progress = value; store.saveRun(run); },
      // 给节点一句人话进度（例如循环的「3/10 项」），画布上直接显示
      note: (text) => { state.note = text ? String(text).slice(0, 60) : null; store.saveRun(run); },
      isCancelled: () => run.cancel_requested === true,
      signal: controllers.get(run.id)?.signal || null,
      // 直接上游里已经成功跑完的节点输出，变量聚合节点用得到
      upstreams: incomingEdges
        .map((edge) => ({ id: edge.from, branch: edge.branch, output: run.nodes[edge.from]?.output ?? null }))
        .filter((item) => item.output !== null && item.output !== undefined && run.nodes[item.id]?.status === 'success'),
      bridge,
    };
    const raw = await executor.run(ctx);
    return projectOutput(raw, node);
  }

  // 输出：节点声明了「输出参数」就按声明投影（可以改名字、可以取嵌套字段），
  // 没声明就原样返回。这样下游能引用的字段完全由用户决定。
  function projectOutput(raw, node) {
    const rows = Array.isArray(node.output_params) ? node.output_params : [];
    if (!rows.length) return raw;
    const out = {};
    for (const row of rows) {
      const key = String(row?.key || '').trim();
      if (!key) continue;
      const from = String(row?.from || '').trim() || key;
      out[key] = getPath(raw, from);
    }
    // 运行记录与下游还要用的内部字段，避免被投影掉
    if (raw && typeof raw === 'object') {
      for (const keep of ['branch', 'index', 'is_else', 'printed', 'interpreter', 'env_name', 'total_tokens', 'model', 'task_id', 'cost', 'cost_currency']) {
        if (raw[keep] !== undefined && out[keep] === undefined) out[keep] = raw[keep];
      }
    }
    return out;
  }

  function kick(runId) {
    if (advancing.has(runId)) return;
    const run = store.getRun(runId);
    if (!run) return;
    if (RUN_TERMINAL.has(run.status)) return;
    if (run.paused) return;
    if (run.status !== 'running') run.status = 'running';
    advancing.add(runId);
    if (!controllers.has(runId)) controllers.set(runId, new AbortController());
    advance(run)
      .catch((err) => {
        writeLog('error', `工作流推进异常 ${runId}: ${err && err.message ? err.message : err}`);
        try { finalize(run, 'failed', `引擎异常：${err && err.message ? err.message : err}`); } catch (_) { /* 兜底 */ }
      })
      .finally(() => {
        advancing.delete(runId);
        controllers.delete(runId);
      });
  }

  // 进程重启后：把上次没跑完的运行接回来。
  // 处于 running 的节点退回 pending 但保留 pending 标记，执行器会用标记去续查上游任务。
  function resumeOnLoad() {
    let count = 0;
    for (const run of store.allRuns()) {
      if (RUN_TERMINAL.has(run.status)) continue;
      let touched = false;
      for (const state of Object.values(run.nodes || {})) {
        if (state.status === 'running') { state.status = 'pending'; touched = true; }
      }
      run.status = 'running';
      run.paused = false;
      run.cancel_requested = false;
      store.saveRun(run);
      touched = true;
      count += 1;
      kick(run.id);
    }
    if (count) writeLog('info', `工作流：已接回 ${count} 条未完成的运行`);
    return count;
  }

  function start() {
    if (timer) return;
    store.load();
    resumeOnLoad();
    timer = setInterval(() => {
      for (const run of store.allRuns()) {
        if (!RUN_TERMINAL.has(run.status) && !run.paused) kick(run.id);
      }
    }, TICK_MS);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // 一个运行连它派生出来的子运行（循环体）一起收出来
  function collectRunTree(rootId) {
    const out = [];
    const seen = new Set();
    const walk = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const item = store.getRun(id);
      if (!item) return;
      out.push(item);
      for (const other of store.allRuns()) {
        if (other.parent_run_id === id) walk(other.id);
      }
    };
    walk(rootId);
    return out;
  }

  function cancelRun(id) {
    const run = store.getRun(id);
    if (!run) return null;
    if (RUN_TERMINAL.has(run.status)) return run;
    // 取消必须连循环体里的子运行一起停，否则用户以为停了、后台还在继续跑（烧模型配额）
    for (const item of collectRunTree(id)) {
      if (RUN_TERMINAL.has(item.status)) continue;
      item.cancel_requested = true;
      item.paused = false;
      store.saveRun(item);
      const controller = controllers.get(item.id);
      if (controller) controller.abort();
      kick(item.id);
    }
    return run;
  }

  function pauseRun(id) {
    const run = store.getRun(id);
    if (!run || RUN_TERMINAL.has(run.status)) return run;
    run.paused = true;
    store.saveRun(run);
    return run;
  }

  function resumeRun(id) {
    const run = store.getRun(id);
    if (!run || RUN_TERMINAL.has(run.status)) return run;
    run.paused = false;
    store.saveRun(run);
    kick(run.id);
    return run;
  }

  // 单节点调试：不建运行记录，直接跑一次，返回输入输出
  async function testNode(node, inputs) {
    const def = NODE_DEFS[node.type];
    if (!def || typeof def.run !== 'function') throw new Error(`未知节点类型：${node.type}`);
    const fakeRun = {
      id: `test_${crypto.randomBytes(4).toString('hex')}`,
      workflow_id: 'test',
      inputs: inputs || {},
      variables: {},
    };
    // 单节点调试：手动填的 inputs 就是这个节点的上游输入，
    // 同时放进 scope，让 {{input.xxx}} 这类引用也能用
    const inputs2 = inputs && typeof inputs === 'object' ? inputs : {};
    const scope = { input: inputs2 };
    const started = Date.now();
    const ctx = {
      node, run: fakeRun, input: inputs2, scope,
      rawInputs: inputs2,
      params: resolveParam(node.params || {}, scope),
      pending: null,
      setPending: () => {},
      clearPending: () => {},
      log: (message) => writeLog('info', `[单节点调试/${node.id}] ${message}`),
      progress: () => {},
      note: () => {},
      isCancelled: () => false,
      bridge,
    };
    const output = await def.run(ctx);
    return { output: output === undefined ? null : output, duration_ms: Date.now() - started };
  }

  // 把一个工作流跑到结束并返回运行记录：循环 / 子工作流节点用它重复执行别的流程。
  // depth 记在子运行上，节点据此拦住「互相调用」的死循环。
  async function runToCompletion(workflow, inputs, { timeoutMs = 600000, parentRunId = '', depth = 0 } = {}) {
    const run = startRun(workflow, inputs, 'sub');
    run.depth = Number(depth) || 0;
    if (parentRunId) run.parent_run_id = parentRunId;
    store.saveRun(run);
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    for (;;) {
      const current = store.getRun(run.id) || run;
      // 父运行被取消/超时后，子运行也要跟着停（取消传播的兜底）
      if (parentRunId) {
        const parent = store.getRun(parentRunId);
        if (parent && parent.cancel_requested && !current.cancel_requested) {
          current.cancel_requested = true;
          store.saveRun(current);
        }
      }
      if (RUN_TERMINAL.has(current.status)) {
        if (current.status !== 'success') {
          throw new Error(`子工作流「${workflow.name}」${current.status === 'cancelled' ? '被取消' : '失败'}：${current.error || '未知原因'}`);
        }
        return current;
      }
      if (Date.now() > deadline) {
        current.cancel_requested = true;
        store.saveRun(current);
        throw new Error(`子工作流「${workflow.name}」执行超时`);
      }
      await delay(200);
    }
  }

  return { start, stop, startRun, kick, cancelRun, pauseRun, resumeRun, resumeOnLoad, testNode, runToCompletion, isAdvancing: (id) => advancing.has(id), hasActiveRun: (workflowId) => [...store.allRuns()].some((run) => run.workflow_id === workflowId && !RUN_TERMINAL.has(run.status)) };
}

module.exports = { create };
