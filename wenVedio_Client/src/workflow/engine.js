// 工作流 · 执行引擎
// 设计要点：
// 1) 服务端驱动：不依赖前端页面开着，HTTP 请求结束也不会中断。
// 2) 每个节点的状态与「挂起标记」都落盘：进程退出（关掉客户端）后重启能接着跑。
// 3) 异步节点（图片/视频）在同一个 advance 调用里等待，tick 只负责把没在推进的运行踢起来。
'use strict';

const crypto = require('crypto');
const { NODE_DEFS, delay } = require('./nodes');
const { resolveParam, getPath } = require('./vars');

const TICK_MS = 800;
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

  function startRun(workflow, inputs, mode) {
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
      run.nodes[node.id] = { id: node.id, type: node.type, title: node.title || node.type, status: 'pending' };
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
    store.pruneRuns();
    writeLog(status === 'success' ? 'info' : 'warn', `工作流运行结束 ${run.id} → ${status}${run.error ? `（${run.error}）` : ''}`);
    return run;
  }

  // ---------------- 推进 ----------------

  function buildGraph(snapshot) {
    const nodes = snapshot.nodes || [];
    const incoming = new Map();
    const outgoing = new Map();
    nodes.forEach((node) => { incoming.set(node.id, []); outgoing.set(node.id, []); });
    for (const edge of snapshot.edges || []) {
      if (!incoming.has(edge.to) || !outgoing.has(edge.from)) continue;
      incoming.get(edge.to).push(edge.from);
      outgoing.get(edge.from).push(edge.to);
    }
    return { nodes, incoming, outgoing };
  }

  // 下一个可以执行的节点：自己还 pending，且所有上游都已进入终态
  function pickNext(run, graph) {
    for (const node of graph.nodes) {
      const state = run.nodes[node.id];
      if (!state || state.status !== 'pending') continue;
      const upstream = graph.incoming.get(node.id) || [];
      const ready = upstream.every((id) => {
        const up = run.nodes[id];
        return up && TERMINAL.has(up.status);
      });
      if (ready) return node;
    }
    return null;
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

      const next = pickNext(run, graph);
      if (!next) {
        if (!hasPendingOrRunning(run)) {
          const failed = Object.values(run.nodes).some((state) => state.status === 'failed');
          finalize(run, failed ? 'failed' : 'success', failed ? (run.error || '存在失败节点') : null);
        } else {
          // 还有节点没跑但都不可达：连线成环，或上游链断了
          finalize(run, 'failed', '有节点无法执行：连线可能形成了环，或没有从开始节点连过来');
        }
        return;
      }
      await executeNode(run, next, graph);
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
    const incomingIds = graph.incoming.get(node.id) || [];
    const firstUpstream = incomingIds[0];

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
      isCancelled: () => run.cancel_requested === true,
      signal: controllers.get(run.id)?.signal || null,
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
      for (const keep of ['printed', 'interpreter', 'env_name', 'total_tokens', 'model', 'task_id', 'cost', 'cost_currency']) {
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

  function cancelRun(id) {
    const run = store.getRun(id);
    if (!run) return null;
    if (RUN_TERMINAL.has(run.status)) return run;
    run.cancel_requested = true;
    run.paused = false;
    store.saveRun(run);
    // 立刻打断这个运行正在等待的请求，否则要等它自己超时
    const controller = controllers.get(run.id);
    if (controller) controller.abort();
    kick(run.id);
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
      isCancelled: () => false,
      bridge,
    };
    const output = await def.run(ctx);
    return { output: output === undefined ? null : output, duration_ms: Date.now() - started };
  }

  return { start, stop, startRun, kick, cancelRun, pauseRun, resumeRun, resumeOnLoad, testNode, isAdvancing: (id) => advancing.has(id) };
}

module.exports = { create };
