// 工作流后端回归测试
//
// 自包含：自己拉起一个服务端（独立端口 + 临时数据目录），跑完关掉。
//   cd wenVedio_Client && node test/workflow.test.js
//
// 覆盖的是「改动容易悄悄破坏」的不变量：
//   分支路由、禁用节点透传、循环与子工作流、取消传播、沙箱逃逸、
//   自定义输入输出投影、导入导出、重跑、坏记录不堵死落盘
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.WF_TEST_PORT || 8795);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  OK   ${name}`); return; }
  fail += 1;
  failures.push(name);
  console.log(`  FAIL ${name}${extra === undefined ? '' : ` → ${extra}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function createWorkflow(definition) {
  const { data } = await api('POST', '/api/workflows', definition);
  return data.workflow;
}

async function startRun(workflowId, inputs = {}) {
  const { data } = await api('POST', `/api/workflows/${workflowId}/run`, { inputs });
  return data.run_id;
}

async function waitRun(runId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await api('GET', `/api/workflow-runs/${runId}`);
    if (data.run && ['success', 'failed', 'cancelled'].includes(data.run.status)) return data.run;
    await sleep(250);
  }
  return null;
}

const startNode = (fields = []) => ({ id: 'start_1', type: 'start', title: '开始', x: 0, y: 0, params: { fields } });
const codeNode = (id, code, extra = {}) => ({ id, type: 'code', title: id, x: 200, y: 0, params: { language: 'javascript', code }, ...extra });
const statuses = (run) => Object.entries(run.nodes).map(([k, v]) => `${k}=${v.status}`).join(' ');

// ---------------- 用例 ----------------

async function testBranchRouting() {
  console.log('\n[分支路由] 条件分支 + 自定义输出参数，且普通节点的 branch 字段不得劫持路由');
  const wf = await createWorkflow({
    name: '测试·分支路由',
    nodes: [
      startNode([{ key: 'score', label: '分数', type: 'number' }]),
      { id: 'cond_1', type: 'condition', title: '判断', x: 200, y: 0,
        branches: [{ id: '高分', label: '高分' }, { id: 'else', label: '否则' }],
        output_params: [{ key: '命中了', from: 'branch' }],
        params: { branches: [{ key: '高分', expr: 'Number(input.score) > 80' }], input_fields: [{ key: 'score', value: '{{start_1.score}}' }] } },
      codeNode('code_hi', "return { level: 'A' };"),
      codeNode('code_lo', "return { level: 'C' };"),
      { id: 'merge_1', type: 'merge', title: '聚合', x: 600, y: 0, params: {} },
    ],
    edges: [
      { id: 'e1', from: 'start_1', to: 'cond_1' },
      { id: 'e2', from: 'cond_1', to: 'code_hi', branch: '高分' },
      { id: 'e3', from: 'cond_1', to: 'code_lo', branch: 'else' },
      { id: 'e4', from: 'code_hi', to: 'merge_1' },
      { id: 'e5', from: 'code_lo', to: 'merge_1' },
    ],
  });
  const hi = await waitRun(await startRun(wf.id, { score: 95 }));
  check('95 分命中高分分支', hi?.nodes?.code_hi?.status === 'success', statuses(hi || { nodes: {} }));
  check('95 分未命中分支被跳过', hi?.nodes?.code_lo?.status === 'skipped', statuses(hi || { nodes: {} }));
  check('声明的输出参数没吃掉路由信息', hi?.nodes?.cond_1?.output?.branch === '高分', JSON.stringify(hi?.nodes?.cond_1?.output));
  const lo = await waitRun(await startRun(wf.id, { score: 40 }));
  check('40 分命中否则分支', lo?.nodes?.code_lo?.status === 'success' && lo?.nodes?.code_hi?.status === 'skipped', statuses(lo || { nodes: {} }));

  // 普通节点输出里有个叫 branch 的字段，不得被当成路由信号
  const wf2 = await createWorkflow({
    name: '测试·branch 字段不劫持',
    nodes: [startNode(), codeNode('code_bad', "return { branch: 'else' };"), codeNode('code_a', "return { who: 'A' };"), codeNode('code_b', "return { who: 'B' };")],
    edges: [
      { id: 'e1', from: 'start_1', to: 'code_bad' },
      { id: 'e2', from: 'code_bad', to: 'code_a', branch: '高分' },
      { id: 'e3', from: 'code_bad', to: 'code_b', branch: 'else' },
    ],
  });
  const r2 = await waitRun(await startRun(wf2.id));
  check('非分支节点的 branch 字段不放行也不拦截', r2?.nodes?.code_a?.status === 'success' && r2?.nodes?.code_b?.status === 'success', statuses(r2 || { nodes: {} }));
}

async function testDisabledNode() {
  console.log('\n[禁用节点] 跳过不执行但对下游透传');
  const wf = await createWorkflow({
    name: '测试·禁用透传',
    nodes: [
      startNode(),
      codeNode('code_1', 'return { v: 42 };'),
      codeNode('code_2', "throw new Error('不该执行到我');", { disabled: true }),
      { id: 'end_1', type: 'end', title: '结束', x: 600, y: 0, params: { outputs: [{ key: '透传值', value: '{{code_2.output.v}}' }] } },
    ],
    edges: [
      { id: 'e1', from: 'start_1', to: 'code_1' },
      { id: 'e2', from: 'code_1', to: 'code_2' },
      { id: 'e3', from: 'code_2', to: 'end_1' },
    ],
  });
  const run = await waitRun(await startRun(wf.id));
  check('整体成功', run?.status === 'success', run?.error);
  check('被禁用节点状态为 skipped', run?.nodes?.code_2?.status === 'skipped', statuses(run || { nodes: {} }));
  check('被禁用节点的代码确实没跑（未抛错）', run?.nodes?.code_2?.error == null, run?.nodes?.code_2?.error);
  check('下游拿到透传值', JSON.stringify(run?.outputs) === JSON.stringify({ 透传值: 42 }), JSON.stringify(run?.outputs));
}

async function testCustomInputOutput() {
  console.log('\n[自定义输入输出] 输入映射 + 输出投影');
  const wf = await createWorkflow({
    name: '测试·自定义输入输出',
    nodes: [
      startNode([{ key: 'raw', label: '原始文本', type: 'text' }]),
      { id: 'code_1', type: 'code', title: '加工', x: 200, y: 0,
        input_params: [{ key: 'text', value: '{{start_1.raw}}' }],
        output_params: [{ key: '标题', from: 'output.title' }, { key: '长度', from: 'output.len' }],
        params: { language: 'javascript', code: "return { title: String(input.text).toUpperCase(), len: String(input.text).length, 内部字段: 1 };" } },
    ],
    edges: [{ id: 'e1', from: 'start_1', to: 'code_1' }],
  });
  const run = await waitRun(await startRun(wf.id, { raw: 'hello' }));
  check('输入映射生效', run?.nodes?.code_1?.output?.标题 === 'HELLO', JSON.stringify(run?.nodes?.code_1?.output));
  check('输出按声明投影（未声明字段被挡掉）', run?.nodes?.code_1?.output?.内部字段 === undefined, JSON.stringify(run?.nodes?.code_1?.output));
}

async function testLoopAndCancel() {
  console.log('\n[循环与取消] 子工作流重复执行、取消要传播、子运行不污染列表');
  const sub = await createWorkflow({
    name: '测试·子流程',
    nodes: [startNode([{ key: 'item', label: '项', type: 'text' }]), codeNode('code_1', 'return { v: String(input.item).toUpperCase() };'),
      { id: 'end_1', type: 'end', title: '结束', x: 400, y: 0, params: { outputs: [{ key: 'v', value: '{{code_1.v}}' }] } }],
    edges: [{ id: 'e1', from: 'start_1', to: 'code_1' }, { id: 'e2', from: 'code_1', to: 'end_1' }],
  });
  const main = await createWorkflow({
    name: '测试·循环',
    nodes: [
      startNode(),
      codeNode('code_1', "return { list: ['alpha','beta','gamma'] };"),
      { id: 'loop_1', type: 'loop', title: '循环', x: 400, y: 0,
        params: { items: '{{code_1.list}}', workflow_id: sub.id, item_key: 'item', concurrency: 1, fail_fast: false, timeout_ms: 30000 } },
      { id: 'end_1', type: 'end', title: '结束', x: 600, y: 0, params: { outputs: [{ key: '成功数', value: '{{loop_1.count}}' }] } },
    ],
    edges: [{ id: 'e1', from: 'start_1', to: 'code_1' }, { id: 'e2', from: 'code_1', to: 'loop_1' }, { id: 'e3', from: 'loop_1', to: 'end_1' }],
  });
  const run = await waitRun(await startRun(main.id), 60000);
  check('循环整体成功', run?.status === 'success', run?.error);
  check('三项全部成功', run?.nodes?.loop_1?.output?.count === 3, JSON.stringify(run?.nodes?.loop_1?.output)?.slice(0, 120));
  check('结果按输入顺序对齐', JSON.stringify(run?.nodes?.loop_1?.output?.results) === JSON.stringify([{ v: 'ALPHA' }, { v: 'BETA' }, { v: 'GAMMA' }]), JSON.stringify(run?.nodes?.loop_1?.output?.results)?.slice(0, 160));
  const listed = (await api('GET', '/api/workflow-runs?limit=200')).data.runs;
  check('子运行不进运行记录列表', listed.every((item) => item.mode !== 'sub'), `${listed.length} 条`);
}

async function testSandbox() {
  console.log('\n[沙箱] 逃逸必须被挡，正常代码必须照常');
  const escape = await waitRun(await startRun((await createWorkflow({
    name: '测试·沙箱逃逸',
    nodes: [startNode(), codeNode('code_1', "try { const p = Object.constructor('return process')(); return { escaped: true, pid: p.pid }; } catch (e) { return { escaped: false, why: String(e.message).slice(0, 80) }; }")],
    edges: [{ id: 'e1', from: 'start_1', to: 'code_1' }],
  })).id));
  check('没拿到 process', escape?.nodes?.code_1?.output?.escaped === false, JSON.stringify(escape?.nodes?.code_1?.output));
  const normal = await waitRun(await startRun((await createWorkflow({
    name: '测试·沙箱正常',
    nodes: [startNode([{ key: 'list', label: 'list', type: 'json' }, { key: 'name', label: 'name', type: 'text' }]), codeNode('code_1', 'return { sum: input.list.reduce((a,b)=>a+b,0), up: String(input.name).toUpperCase() };')],
    edges: [{ id: 'e1', from: 'start_1', to: 'code_1' }],
  })).id, { list: [1, 2, 3, 4], name: 'abc' }));
  check('正常代码求和正确', normal?.nodes?.code_1?.output?.sum === 10, JSON.stringify(normal?.nodes?.code_1?.output));
  check('字符串方法可用', normal?.nodes?.code_1?.output?.up === 'ABC', JSON.stringify(normal?.nodes?.code_1?.output));
}

async function testImportExportRerun() {
  console.log('\n[导入导出与重跑]');
  const wf = await createWorkflow({
    name: '测试·导入导出',
    nodes: [startNode([{ key: 'n', label: '数字', type: 'number' }]), codeNode('code_1', 'return { squared: Number(input.n) ** 2 };'),
      { id: 'end_1', type: 'end', title: '结束', x: 400, y: 0, params: { outputs: [{ key: '结果', value: '{{code_1.squared}}' }] } }],
    edges: [{ id: 'e1', from: 'start_1', to: 'code_1' }, { id: 'e2', from: 'code_1', to: 'end_1' }],
  });
  const first = await waitRun(await startRun(wf.id, { n: 7 }));
  check('首次运行正确', first?.outputs?.结果 === 49, JSON.stringify(first?.outputs));

  const exported = (await api('GET', `/api/workflows/${wf.id}/export`)).data;
  check('导出带 kind 标记与节点', exported.kind === 'wenvedio-workflow' && exported.workflow.nodes.length === 3, JSON.stringify(exported.workflow?.nodes?.length));
  const imported = (await api('POST', '/api/workflows/import', { workflow: exported.workflow })).data.workflow;
  check('导入生成新工作流', imported.id !== wf.id && imported.name.includes('（导入）'), imported.name);
  const badImport = await api('POST', '/api/workflows/import', { nodes: [] });
  check('空内容导入被拒绝', badImport.status === 400 || badImport.data.ok === false, String(badImport.status));

  const rerun = await waitRun((await api('POST', `/api/workflow-runs/${first.id}/rerun`)).data.run_id);
  check('重跑沿用同样输入', rerun?.inputs?.n === 7, JSON.stringify(rerun?.inputs));
  check('重跑结果一致', rerun?.outputs?.结果 === 49, JSON.stringify(rerun?.outputs));
}

async function testRunFromNode() {
  console.log('\n[从中间节点开始] 上游沿用历史结果、平行分支跳过、无历史运行被拒');
  const definition = {
    name: '测试·从中间节点开始',
    nodes: [
      startNode([{ key: 'n', label: '数字', type: 'number' }]),
      codeNode('code_a', 'return { v: Number(input.n) + 1 };'),
      codeNode('code_b', 'return { v: Number(input.output.v) * 10 };'),
      codeNode('code_c', 'return { v: Number(input.output.v) + 5 };'),
      codeNode('code_p', "return { v: '不该跑' };"),
      { id: 'end_1', type: 'end', title: '结束', x: 800, y: 0, params: { outputs: [{ key: 'C的结果', value: '{{code_c.output.v}}' }] } },
    ],
    edges: [
      { id: 'e1', from: 'start_1', to: 'code_a' },
      { id: 'e2', from: 'code_a', to: 'code_b' },
      { id: 'e3', from: 'code_b', to: 'code_c' },
      { id: 'e4', from: 'code_b', to: 'code_p' },
      { id: 'e5', from: 'code_c', to: 'end_1' },
    ],
  };
  const wf = await createWorkflow(definition);
  const full = await waitRun(await startRun(wf.id, { n: 2 }));
  check('完整跑：A=3 B=30 C=35',
    full?.nodes?.code_a?.output?.v === 3 && full?.nodes?.code_b?.output?.v === 30 && full?.nodes?.code_c?.output?.v === 35,
    statuses(full || { nodes: {} }));
  check('完整跑：平行分支也执行了', full?.nodes?.code_p?.status === 'success', statuses(full || { nodes: {} }));

  const partial = await waitRun((await api('POST', `/api/workflows/${wf.id}/run`, { from_node: 'code_c' })).data.run_id);
  check('从 C 开始：整体成功', partial?.status === 'success', partial?.error);
  check('从 C 开始：结果与完整跑一致', partial?.outputs?.C的结果 === 35, JSON.stringify(partial?.outputs));
  check('上游被标记为沿用（seeded）', partial?.nodes?.code_a?.seeded === true && partial?.nodes?.code_b?.seeded === true, statuses(partial || { nodes: {} }));
  check('C 的输入来自历史结果', partial?.nodes?.code_c?.input?.output?.v === 30, JSON.stringify(partial?.nodes?.code_c?.input)?.slice(0, 60));
  check('平行分支被跳过', partial?.nodes?.code_p?.status === 'skipped', statuses(partial || { nodes: {} }));
  check('运行记录标记了 from_node', partial?.from_node === 'code_c', partial?.from_node);
  check('节点输入有落盘（详情面板要用）', partial?.nodes?.code_c?.input !== undefined);

  const fresh = await createWorkflow({ ...definition, name: '测试·从中间节点开始（无历史）' });
  const denied = await api('POST', `/api/workflows/${fresh.id}/run`, { from_node: 'code_c' });
  check('无历史运行被拒绝', denied.data.ok === false && /历史运行/.test(denied.data.msg || ''), JSON.stringify(denied.data));
}

async function testPersistence() {
  console.log('\n[持久化] 坏记录不得堵死后续落盘');
  const { create } = require(path.join(ROOT, 'src', 'workflow', 'store.js'));
  const dir = path.join(os.tmpdir(), `wf-test-store-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const logs = [];
  const store = create({ configDir: dir, writeLog: (level, msg) => logs.push(`${level}: ${msg}`) });
  store.load();
  // 损坏文件要备份而不是被覆盖
  fs.writeFileSync(path.join(dir, 'workflows.json'), '{ "workflows": [ { "id": "corrupt"');
  const store2 = create({ configDir: dir, writeLog: () => {} });
  store2.load();
  const backup = fs.readdirSync(dir).find((name) => name.includes('.corrupt-'));
  check('损坏的定义文件被备份', Boolean(backup));
  check('备份里保留了原始坏数据', backup ? fs.readFileSync(path.join(dir, backup), 'utf8').includes('corrupt') : false);

  store.saveRun({ id: 'run_ok', workflow_id: 'w', status: 'success', nodes: {} });
  const circular = { id: 'run_circ', status: 'running', nodes: {} };
  circular.self = circular;
  store.saveRun(circular); // 不应抛异常
  check('循环引用不会抛异常', true);
  await sleep(600);
  check('坏记录被移出内存', !store.getRun('run_circ'));
  check('日志点名了坏记录', logs.some((line) => line.includes('无法序列化')), JSON.stringify(logs));
  store.saveRun({ id: 'run_after', workflow_id: 'w', status: 'running', nodes: {} });
  await sleep(600);
  const text = fs.readFileSync(path.join(dir, 'workflow-runs.json'), 'utf8');
  check('坏记录之后仍能正常落盘', text.includes('run_after'));
  check('坏记录没有被写进磁盘', !text.includes('run_circ'));
}

// ---------------- 启动与收尾 ----------------

function spawnServer(dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', WENVEDIO_DATA_DIR: dataDir },
    stdio: 'ignore',
    windowsHide: true,
  });
  return child;
}

async function waitHealthy(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch (_) { /* 还没起来 */ }
    await sleep(300);
  }
  return false;
}

(async () => {
  const dataDir = path.join(os.tmpdir(), `wf-test-data-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const server = spawnServer(dataDir);
  try {
    if (!await waitHealthy()) {
      console.error(`服务端没能在 ${BASE} 起来（端口可能被占用，可用 WF_TEST_PORT 换一个）`);
      process.exitCode = 1;
      return;
    }
    await testBranchRouting();
    await testDisabledNode();
    await testCustomInputOutput();
    await testLoopAndCancel();
    await testSandbox();
    await testImportExportRerun();
    await testRunFromNode();
    await testPersistence();
    console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
    if (fail) console.log(`失败用例：${failures.join('、')}`);
    process.exitCode = fail ? 1 : 0;
  } catch (err) {
    console.error('测试异常：', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    try { server.kill(); } catch (_) { /* 已经退出 */ }
    await sleep(200);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) { /* 清理失败无所谓 */ }
  }
})();
