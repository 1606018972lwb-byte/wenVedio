// 工作流 · 存储层
// 定义与运行记录都落在数据目录的 config/ 下，沿用现有配置文件的写盘方式（临时文件 + rename）。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_VERSIONS = 20;
const MAX_RUNS = 200;
const MAX_NODES = 200;

function create({ configDir, writeLog }) {
  const WORKFLOWS_FILE = path.join(configDir, 'workflows.json');
  const RUNS_FILE = path.join(configDir, 'workflow-runs.json');
  const workflows = new Map();
  const runs = new Map();

  // Windows 上目标文件可能被索引器 / 杀软短暂占用，rename 会 EPERM；
  // 所以这里重试几次，仍失败就直接覆盖写（宁可非原子，也不能丢数据或抛异常）。
  function sleepSync(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
    catch (_) { const end = Date.now() + ms; while (Date.now() < end) { /* 忙等兜底 */ } }
  }

  function writeJson(file, payload) {
    const text = JSON.stringify(payload, null, 2);
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); }
    catch (_) { /* 目录已存在 */ }
    // 临时文件名带上进程与时间，避免并发写同一个 tmp
    const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      fs.writeFileSync(temporary, text);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { fs.renameSync(temporary, file); return true; }
        catch (err) {
          if (attempt === 4) throw err;
          sleepSync(25 * (attempt + 1));
        }
      }
    } catch (err) {
      try { fs.unlinkSync(temporary); } catch (_) { /* 清理失败无所谓 */ }
      writeLog('warn', `原子写失败，改为直接覆盖 ${path.basename(file)}：${err.message}`);
    }
    try {
      fs.writeFileSync(file, text);
      return true;
    } catch (err) {
      writeLog('error', `写入 ${path.basename(file)} 失败（数据只保留在内存里）：${err.message}`);
      return false;
    }
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : parsed.workflows;
      if (Array.isArray(list)) list.forEach((item) => { if (item && item.id) workflows.set(item.id, item); });
    } catch (err) {
      if (err.code !== 'ENOENT') writeLog('error', `读取工作流失败: ${err.message}`);
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : parsed.runs;
      if (Array.isArray(list)) list.forEach((item) => { if (item && item.id) runs.set(item.id, item); });
    } catch (err) {
      if (err.code !== 'ENOENT') writeLog('error', `读取工作流运行记录失败: ${err.message}`);
    }
    writeLog('info', `工作流已恢复 ${workflows.size} 个，运行记录 ${runs.size} 条`);
  }

  const saveWorkflows = () => writeJson(WORKFLOWS_FILE, { version: 1, workflows: [...workflows.values()] });
  const saveRuns = () => writeJson(RUNS_FILE, { version: 1, runs: [...runs.values()] });

  // ---------------- 定义 ----------------

  const str = (value, max) => String(value == null ? '' : value).slice(0, max);
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

  function sanitizeNode(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = str(raw.id, 64).trim();
    const type = str(raw.type, 40).trim();
    if (!id || !type) return null;
    return {
      id,
      type,
      title: str(raw.title, 60) || type,
      x: num(raw.x, 0),
      y: num(raw.y, 0),
      params: raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params) ? raw.params : {},
      // 输入映射与输出声明都由用户自定义（Coze 代码节点那套）：留空则用节点类型的默认值
      input_params: (Array.isArray(raw.input_params) ? raw.input_params : [])
        .filter((row) => row && typeof row === 'object')
        .map((row) => ({ key: str(row.key, 60).trim(), value: row.value === undefined ? '' : row.value, type: str(row.type, 20) || 'any' }))
        .filter((row) => row.key)
        .slice(0, 60),
      output_params: (Array.isArray(raw.output_params) ? raw.output_params : [])
        .filter((row) => row && typeof row === 'object')
        .map((row) => ({ key: str(row.key, 60).trim(), label: str(row.label, 60), from: str(row.from, 120).trim(), type: str(row.type, 20) || 'any' }))
        .filter((row) => row.key)
        .slice(0, 60),
      // 条件分支节点的出口列表（画布按它渲染多个出口，边上带分支名）
      branches: (Array.isArray(raw.branches) ? raw.branches : [])
        .filter((row) => row && typeof row === 'object')
        .map((row) => ({ id: str(row.id, 40), label: str(row.label, 40) || str(row.id, 40) }))
        .filter((row) => row.id)
        .slice(0, 20),
      error_policy: ['stop', 'continue', 'retry'].includes(raw.error_policy) ? raw.error_policy : 'stop',
      max_retry: Math.max(0, Math.min(10, num(raw.max_retry, 2))),
      retry_interval_ms: Math.max(0, Math.min(60000, num(raw.retry_interval_ms, 2000))),
    };
  }

  function sanitizeDefinition(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const nodes = (Array.isArray(source.nodes) ? source.nodes : [])
      .map(sanitizeNode).filter(Boolean).slice(0, MAX_NODES);
    const ids = new Set(nodes.map((node) => node.id));
    const edges = (Array.isArray(source.edges) ? source.edges : [])
      .filter((edge) => edge && ids.has(String(edge.from)) && ids.has(String(edge.to)))
      .map((edge, index) => ({ id: str(edge.id, 64) || `e${index + 1}`, from: String(edge.from), to: String(edge.to), branch: str(edge.branch, 40).trim() }))
      .slice(0, MAX_NODES * 2);
    return { nodes, edges };
  }

  function listWorkflows() {
    return [...workflows.values()].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }

  function getWorkflow(id) {
    return workflows.get(String(id)) || null;
  }

  // 新建或更新草稿（nodes/edges）；不发版本，版本只在发布时产生
  function saveWorkflow(payload) {
    const now = new Date().toISOString();
    const id = str(payload.id, 64).trim() || `wf_${crypto.randomBytes(6).toString('hex')}`;
    const existing = workflows.get(id);
    const { nodes, edges } = sanitizeDefinition(payload);
    const record = {
      id,
      name: str(payload.name, 60).trim() || '未命名工作流',
      description: str(payload.description, 300),
      nodes,
      edges,
      variables: Array.isArray(payload.variables) ? payload.variables.slice(0, 50) : (existing?.variables || []),
      version: existing?.version || 0,
      published: existing?.published === true,
      published_version: existing?.published_version ?? null,
      versions: existing?.versions || [],
      run_count: existing?.run_count || 0,
      last_run_at: existing?.last_run_at || null,
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    workflows.set(id, record);
    saveWorkflows();
    return record;
  }

  function deleteWorkflow(id) {
    const ok = workflows.delete(String(id));
    if (ok) {
      saveWorkflows();
      for (const [runId, run] of runs) if (run.workflow_id === id) runs.delete(runId);
      saveRuns();
    }
    return ok;
  }

  // 发布：把当前草稿固化成一个新版本
  function publishWorkflow(id) {
    const record = workflows.get(String(id));
    if (!record) return null;
    const version = (record.version || 0) + 1;
    const snapshot = {
      version,
      saved_at: new Date().toISOString(),
      nodes: JSON.parse(JSON.stringify(record.nodes)),
      edges: JSON.parse(JSON.stringify(record.edges)),
      variables: JSON.parse(JSON.stringify(record.variables || [])),
    };
    record.version = version;
    record.published = true;
    record.published_version = version;
    record.versions = [snapshot, ...(record.versions || [])].slice(0, MAX_VERSIONS);
    record.updated_at = snapshot.saved_at;
    workflows.set(record.id, record);
    saveWorkflows();
    return record;
  }

  function listVersions(id) {
    const record = workflows.get(String(id));
    if (!record) return [];
    return (record.versions || []).map((item) => ({
      version: item.version,
      saved_at: item.saved_at,
      node_count: (item.nodes || []).length,
      edge_count: (item.edges || []).length,
    }));
  }

  // 恢复某个历史版本：内容覆盖到草稿，同时本身也固化成一个新版本，避免历史被抹掉
  function restoreVersion(id, version) {
    const record = workflows.get(String(id));
    if (!record) return null;
    const snapshot = (record.versions || []).find((item) => Number(item.version) === Number(version));
    if (!snapshot) return null;
    record.nodes = JSON.parse(JSON.stringify(snapshot.nodes));
    record.edges = JSON.parse(JSON.stringify(snapshot.edges));
    record.variables = JSON.parse(JSON.stringify(snapshot.variables || []));
    workflows.set(record.id, record);
    saveWorkflows();
    return publishWorkflow(record.id);
  }

  function duplicateWorkflow(id) {
    const record = workflows.get(String(id));
    if (!record) return null;
    const copy = JSON.parse(JSON.stringify(record));
    copy.id = `wf_${crypto.randomBytes(6).toString('hex')}`;
    copy.name = `${record.name} 副本`.slice(0, 60);
    copy.version = 0;
    copy.published = false;
    copy.published_version = null;
    copy.versions = [];
    copy.run_count = 0;
    copy.last_run_at = null;
    copy.created_at = new Date().toISOString();
    copy.updated_at = copy.created_at;
    workflows.set(copy.id, copy);
    saveWorkflows();
    return copy;
  }

  function touchWorkflowRun(id, at) {
    const record = workflows.get(String(id));
    if (!record) return;
    record.run_count = (record.run_count || 0) + 1;
    record.last_run_at = at;
    workflows.set(record.id, record);
    saveWorkflows();
  }

  // ---------------- 运行记录 ----------------

  function saveRun(run) {
    runs.set(run.id, run);
    saveRuns();
    return run;
  }

  // 记录会一直增长，超出上限时丢掉最旧的已结束记录
  function pruneRuns() {
    // 循环产生的子运行没有单独查看的价值，超限时优先丢它们
    const subs = [...runs.values()].filter((run) => run.finished_at && run.mode === 'sub');
    for (const run of subs) {
      if (runs.size <= MAX_RUNS) break;
      runs.delete(run.id);
    }
    if (runs.size <= MAX_RUNS) { if (subs.length) saveRuns(); return; }
    const finished = [...runs.values()]
      .filter((run) => run.finished_at)
      .sort((a, b) => String(a.finished_at).localeCompare(String(b.finished_at)));
    let remove = runs.size - MAX_RUNS;
    for (const run of finished) {
      if (remove <= 0) break;
      runs.delete(run.id);
      remove -= 1;
    }
    saveRuns();
  }

  // 运行记录默认不列子运行（循环体内的），否则会把真正的记录挤掉
  function listRuns(workflowId, limit = 50, { includeSub = false } = {}) {
    return [...runs.values()]
      .filter((run) => includeSub || run.mode !== 'sub')
      .filter((run) => !workflowId || run.workflow_id === workflowId)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
  }

  const getRun = (id) => runs.get(String(id)) || null;
  const allRuns = () => [...runs.values()];

  return {
    load,
    listWorkflows, getWorkflow, saveWorkflow, deleteWorkflow,
    publishWorkflow, listVersions, restoreVersion, duplicateWorkflow, touchWorkflowRun,
    saveRun, pruneRuns, listRuns, getRun, allRuns,
  };
}

module.exports = { create };
