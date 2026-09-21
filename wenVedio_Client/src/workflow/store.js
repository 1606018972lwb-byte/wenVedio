// 工作流 · 存储层
// 定义与运行记录都落在数据目录的 config/ 下，沿用现有配置文件的写盘方式（临时文件 + rename）。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_VERSIONS = 20;
const MAX_RUNS = 200;
const MAX_SUB_RUNS = 30;
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
    // 序列化本身也可能抛（循环引用 / 超大对象 / 内存不足），必须兜在里面：
    // saveRun 在引擎里高频调用，一次抛出就会终止整次运行。
    let text;
    try {
      text = JSON.stringify(payload, null, 2);
    } catch (err) {
      writeLog('error', `序列化 ${path.basename(file)} 失败，本次不落盘（数据仍在内存）：${err.message}`);
      return false;
    }
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); }
    catch (_) { /* 目录已存在 */ }
    // 临时文件名带进程 + 时间 + 随机数：同一 tick 内两次写也不会撞名
    const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
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
    // 解析失败不能静默以空状态继续：下一次保存就会把损坏内容永久覆盖，定义全丢。
    // 先把坏文件改名备份，用户还有救回来的机会。
    readJsonFile(WORKFLOWS_FILE, (list) => {
      list.forEach((item) => { if (item && item.id) workflows.set(item.id, item); });
    }, '工作流');
    readJsonFile(RUNS_FILE, (list) => {
      list.forEach((item) => { if (item && item.id) runs.set(item.id, item); });
    }, '工作流运行记录');
    writeLog('info', `工作流已恢复 ${workflows.size} 个，运行记录 ${runs.size} 条`);
  }

  function readJsonFile(file, onList, label) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') writeLog('error', `读取${label}失败: ${err.message}`);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : parsed[`${label === '工作流' ? 'workflows' : 'runs'}`];
      if (Array.isArray(list)) { onList(list); return; }
      writeLog('warn', `${label}文件结构不对（没有数组），按空处理`);
    } catch (err) {
      writeLog('error', `解析${label}失败: ${err.message}`);
    }
    // 内容不可用 → 另存一份备份，绝不直接丢弃
    const backup = `${file}.corrupt-${Date.now().toString(36)}.bak`;
    try {
      fs.copyFileSync(file, backup);
      writeLog('warn', `${label}文件已损坏，原文件备份到 ${path.basename(backup)}（${text.length} 字节）`);
    } catch (copyErr) {
      writeLog('error', `备份损坏的${label}文件失败: ${copyErr.message}`);
    }
  }

  const saveWorkflows = () => writeJson(WORKFLOWS_FILE, { version: 1, workflows: [...workflows.values()] });

  // 运行记录写得非常频繁（每个节点状态变化一次），逐次同步全表写会把事件循环堵住：
  // 改成合并写，250ms 内的多次改动只落盘一次；进程退出前补一次，避免丢最后的改动。
  let runsSaveTimer = null;
  function saveRunsNow() {
    if (runsSaveTimer) { clearTimeout(runsSaveTimer); runsSaveTimer = null; }
    let list = [...runs.values()];
    try {
      JSON.stringify(list);
    } catch (_) {
      // 只要有一条记录不可序列化（循环引用 / 超大对象），整张表就都写不进去，
      // 而且那条坏记录会一直留在内存里把后续所有写入都堵死。
      // 这里逐条筛一遍：能写的照写，写不了的移出内存并大声记日志。
      const good = [];
      const bad = [];
      for (const run of list) {
        try { JSON.stringify(run); good.push(run); }
        catch (_) { bad.push(run); }
      }
      if (bad.length) {
        writeLog('error', `有 ${bad.length} 条运行记录无法序列化，已移出内存（磁盘不受影响）：${bad.map((r) => r.id).join(', ')}`);
        for (const run of bad) runs.delete(run.id);
      }
      list = good;
    }
    return writeJson(RUNS_FILE, { version: 1, runs: list });
  }
  function saveRuns() {
    if (runsSaveTimer) return true;
    runsSaveTimer = setTimeout(() => { runsSaveTimer = null; saveRunsNow(); }, 250);
    if (runsSaveTimer.unref) runsSaveTimer.unref();
    return true;
  }
  // 退出时补写最后一次改动。这里绝不能动定时器：在 'exit' 阶段 clearTimeout
  // 会撞上 libuv 的 handle 状态断言（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)），
  // 直接同步写就够了。
  process.once('exit', () => {
    if (!runsSaveTimer) return;
    runsSaveTimer = null;
    writeJson(RUNS_FILE, { version: 1, runs: [...runs.values()] });
  });

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
      // 禁用后运行时会跳过这个节点、把输入直接透传给下游
      disabled: raw.disabled === true,
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
      // 触发器状态由 triggers.js 维护：保存节点图时不能被覆盖掉
      hook_token: existing?.hook_token || '',
      hook_runs: existing?.hook_runs || 0,
      hook_last_at: existing?.hook_last_at || null,
      triggers: Array.isArray(existing?.triggers) ? existing.triggers : [],
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    workflows.set(id, record);
    saveWorkflows();
    return record;
  }

  // 只打补丁式改几个字段（触发器的令牌 / 计划 / 上次触发时间用）：
  // 走 saveWorkflow 会把界面正在编辑的节点图整份覆盖掉
  function patchWorkflow(id, patch) {
    const record = workflows.get(String(id));
    if (!record) return null;
    Object.assign(record, patch && typeof patch === 'object' ? patch : {});
    workflows.set(record.id, record);
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
      // 界面上要标出「当前发布的就是这一版」，以及版本里存了哪些变量
      published: Number(item.version) === Number(record.published_version || 0),
      variable_count: (item.variables || []).length,
    }));
  }

  // 单个版本的完整内容：版本对比要拿它和当前草稿逐项比。
  // 列表接口只给统计数字，内容单独取，避免一次把 20 个版本的节点全塞进响应。
  function getVersion(id, version) {
    const record = workflows.get(String(id));
    if (!record) return null;
    const snapshot = (record.versions || []).find((item) => Number(item.version) === Number(version));
    if (!snapshot) return null;
    return {
      version: snapshot.version,
      saved_at: snapshot.saved_at,
      nodes: JSON.parse(JSON.stringify(snapshot.nodes || [])),
      edges: JSON.parse(JSON.stringify(snapshot.edges || [])),
      variables: JSON.parse(JSON.stringify(snapshot.variables || [])),
    };
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

  function touchWorkflowRun(id, at, status) {
    const record = workflows.get(String(id));
    if (!record) return;
    if (!status) {
      // 开始一次运行：只加计数与时间，状态等结束时再落
      record.run_count = (record.run_count || 0) + 1;
      record.last_run_at = at;
    } else {
      record.last_run_status = status;
      record.last_run_finished_at = at;
    }
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
    let removed = 0;
    // 循环产生的子运行只是过程记录，单独设一个更紧的上限：
    // 不加这条的话，100 项的循环会让运行记录表涨到 100+ 条，
    // 而每次合并写都要序列化整张表（审计 #8 的写放大）。
    const subs = [...runs.values()]
      .filter((run) => run.finished_at && run.mode === 'sub')
      .sort((a, b) => String(a.finished_at).localeCompare(String(b.finished_at)));
    let subOverflow = subs.length - MAX_SUB_RUNS;
    for (const run of subs) {
      if (subOverflow <= 0) break;
      runs.delete(run.id);
      subOverflow -= 1;
      removed += 1;
    }
    // 总量仍超限时，继续优先丢子运行
    if (runs.size > MAX_RUNS) {
      for (const run of [...runs.values()].filter((item) => item.finished_at && item.mode === 'sub')) {
        if (runs.size <= MAX_RUNS) break;
        runs.delete(run.id);
        removed += 1;
      }
    }
    const finished = [...runs.values()]
      .filter((run) => run.finished_at)
      .sort((a, b) => String(a.finished_at).localeCompare(String(b.finished_at)));
    let remove = runs.size - MAX_RUNS;
    for (const run of finished) {
      if (remove <= 0) break;
      runs.delete(run.id);
      remove -= 1;
      removed += 1;
    }
    if (removed) saveRuns();
    return removed;
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

  // 清掉所有已结束的运行（含循环产生的子运行），正在跑的保留
  function clearFinishedRuns() {
    let removed = 0;
    for (const run of [...runs.values()]) {
      if (run.finished_at) { runs.delete(run.id); removed += 1; }
    }
    if (removed) saveRunsNow();
    return removed;
  }

  return {
    load,
    listWorkflows, getWorkflow, saveWorkflow, patchWorkflow, deleteWorkflow,
    publishWorkflow, listVersions, getVersion, restoreVersion, duplicateWorkflow, touchWorkflowRun,
    saveRun, pruneRuns, listRuns, getRun, allRuns, clearFinishedRuns,
  };
}

module.exports = { create };
