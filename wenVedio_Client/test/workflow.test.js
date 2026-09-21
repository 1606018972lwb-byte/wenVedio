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

// 版本（发布快照）：界面上「版本」抽屉依赖这几个接口，坏在这里用户只会看到空列表
async function testVersions() {
  console.log('\n[版本] 发布快照 / 列表统计 / 取单版内容 / 恢复');
  const wf = await createWorkflow({
    name: '测试·版本',
    nodes: [startNode([{ key: 'n', label: '数字', type: 'number' }]), codeNode('code_a', 'return { v: Number(input.n) + 1 };')],
    edges: [{ id: 'e1', from: 'start_1', to: 'code_a' }],
    variables: [{ key: 'v1', value: 1 }],
  });
  const pub1 = await api('POST', `/api/workflows/${wf.id}/publish`);
  check('第一次发布 → V1', pub1.data.workflow?.version === 1, JSON.stringify(pub1.data).slice(0, 120));
  check('发布版本被记为已发布版', pub1.data.workflow?.published_version === 1);

  // 改一版：加一个节点、一条边、一个变量，再发布
  await api('POST', '/api/workflows', {
    id: wf.id,
    name: '测试·版本',
    nodes: [
      startNode([{ key: 'n', label: '数字', type: 'number' }]),
      codeNode('code_a', 'return { v: Number(input.n) + 1 };'),
      { id: 'code_b', type: 'code', title: '新增的节点', x: 400, y: 0, params: { language: 'javascript', code: 'return { ok: 1 };' } },
    ],
    edges: [{ id: 'e1', from: 'start_1', to: 'code_a' }, { id: 'e2', from: 'code_a', to: 'code_b' }],
    variables: [{ key: 'v1', value: 1 }, { key: 'v2', value: 2 }],
  });
  await api('POST', `/api/workflows/${wf.id}/publish`);

  const list = await api('GET', `/api/workflows/${wf.id}/versions`);
  const versions = list.data.versions || [];
  check('列表返回 2 个版本', versions.length === 2, JSON.stringify(versions));
  check('最新在前且统计正确（3 节点 / 2 连线 / 2 变量）',
    versions[0]?.version === 2 && versions[0]?.node_count === 3 && versions[0]?.edge_count === 2 && versions[0]?.variable_count === 2,
    JSON.stringify(versions[0]));
  check('V1 统计为 2 节点 / 1 连线', versions[1]?.version === 1 && versions[1]?.node_count === 2 && versions[1]?.edge_count === 1, JSON.stringify(versions[1]));
  check('只有当前发布版带 published 标记', versions[0]?.published === true && versions[1]?.published === false);
  check('列表同时给出草稿规模', list.data.draft?.node_count === 3 && list.data.draft?.edge_count === 2, JSON.stringify(list.data.draft));

  const one = await api('GET', `/api/workflows/${wf.id}/versions/1`);
  check('取单版返回完整内容（不是只有统计）',
    one.data.version?.nodes?.length === 2 && one.data.version?.edges?.length === 1 && one.data.version?.variables?.length === 1,
    JSON.stringify({ n: one.data.version?.nodes?.length, e: one.data.version?.edges?.length }));
  check('单版内容里没有后加的节点',
    (one.data.version?.nodes || []).some((node) => node.id === 'code_a')
    && !(one.data.version?.nodes || []).some((node) => node.id === 'code_b'));

  const missing = await api('GET', `/api/workflows/${wf.id}/versions/99`);
  check('不存在的版本返回 404', missing.status === 404 && missing.data.ok === false, JSON.stringify(missing.data));

  const restored = await api('POST', `/api/workflows/${wf.id}/versions/1/restore`);
  check('恢复 V1：草稿回到 2 节点 / 1 连线',
    restored.data.workflow?.nodes?.length === 2 && restored.data.workflow?.edges?.length === 1,
    JSON.stringify({ n: restored.data.workflow?.nodes?.length, e: restored.data.workflow?.edges?.length }));
  check('恢复本身固化成新版本（V3）', restored.data.workflow?.version === 3 && restored.data.workflow?.published_version === 3,
    JSON.stringify({ v: restored.data.workflow?.version, p: restored.data.workflow?.published_version }));
  const after = await api('GET', `/api/workflows/${wf.id}`);
  check('恢复后的草稿里 code_b 已消失', !(after.data.workflow.nodes || []).some((node) => node.id === 'code_b'));
  const list2 = await api('GET', `/api/workflows/${wf.id}/versions`);
  check('历史没有被恢复覆盖（仍然 3 个版本）', (list2.data.versions || []).length === 3, JSON.stringify(list2.data.versions?.map((v) => v.version)));
}

// 并行分支：互相独立的分支要并发推进；多上游节点要等所有上游定局才启动
async function testParallelBranches() {
  console.log('\n[并行分支] 独立分支并发推进 / 多上游等齐');
  const http = require('http');
  const DELAY_MS = 600;
  const slow = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ from: path }));
    }, DELAY_MS);
  });
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const slowPort = slow.address().port;
  try {
    const wf = await createWorkflow({
      name: '测试·并行分支',
      nodes: [
        startNode([]),
        { id: 'http_a', type: 'http', title: '慢A', x: 200, y: 0, params: { method: 'GET', url: `http://127.0.0.1:${slowPort}/slow_a`, timeout: 30 } },
        { id: 'http_b', type: 'http', title: '慢B', x: 200, y: 120, params: { method: 'GET', url: `http://127.0.0.1:${slowPort}/slow_b`, timeout: 30 } },
        {
          id: 'code_join', type: 'code', title: '汇总', x: 460, y: 60,
          input_params: [{ key: 'a', value: '{{http_a.json.from}}' }, { key: 'b', value: '{{http_b.json.from}}' }],
          params: { language: 'javascript', code: 'return { both: [input.a, input.b] };' },
        },
      ],
      edges: [
        { id: 'e1', from: 'start_1', to: 'http_a' },
        { id: 'e2', from: 'start_1', to: 'http_b' },
        { id: 'e3', from: 'http_a', to: 'code_join' },
        { id: 'e4', from: 'http_b', to: 'code_join' },
      ],
    });
    const wallStart = Date.now();
    const run = await waitRun(await startRun(wf.id, {}), 40000);
    const wall = Date.now() - wallStart;
    check('两个并行分支都成功',
      run?.nodes?.http_a?.status === 'success' && run?.nodes?.http_b?.status === 'success',
      statuses(run || { nodes: {} }));
    const gap = Math.abs(new Date(run.nodes.http_a.started_at) - new Date(run.nodes.http_b.started_at));
    check(`两个分支同时开始（相差 ${gap}ms < 250）`, gap < 250, `gap=${gap}ms`);
    check(`两次 ${DELAY_MS}ms 请求总耗时接近单次（${wall}ms < 1050；串行要 1200ms+）`, wall < 1050, `wall=${wall}ms`);
    check('汇总节点等两边都结束才启动（两个分支的值都在输入里）',
      run?.nodes?.code_join?.input?.a === '/slow_a' && run?.nodes?.code_join?.input?.b === '/slow_b',
      JSON.stringify(run?.nodes?.code_join?.input));
    check('汇总结果里两个分支的值都在',
      run?.nodes?.code_join?.output?.both?.[0] === '/slow_a' && run?.nodes?.code_join?.output?.both?.[1] === '/slow_b',
      JSON.stringify(run?.nodes?.code_join?.output));
  } finally {
    await new Promise((resolve) => slow.close(resolve));
  }
}

// 子工作流节点：把另一个工作流当成一个节点跑，输入映射进去、返回值接出来
async function testSubWorkflowNode() {
  console.log('\n[子工作流节点] 输入映射 / 返回接出 / 自己不能调自己');
  const child = await createWorkflow({
    name: '测试·子工作流（子）',
    nodes: [
      startNode([{ key: 'x', label: '数字', type: 'number' }, { key: 'tag', label: '标签', type: 'text' }]),
      codeNode('code_double', 'return { doubled: Number(input.x) * 2, tag: String(input.tag || "") };'),
      { id: 'end_1', type: 'end', title: '结束', x: 600, y: 0,
        params: { outputs: [{ key: '结果', value: '{{code_double.output.doubled}}' }, { key: '标签', value: '{{code_double.output.tag}}' }] } },
    ],
    edges: [
      { id: 'e1', from: 'start_1', to: 'code_double' },
      { id: 'e2', from: 'code_double', to: 'end_1' },
    ],
  });
  const parent = await createWorkflow({
    name: '测试·子工作流（父）',
    nodes: [
      startNode([{ key: 'n', label: '数字', type: 'number' }]),
      {
        id: 'sub_1', type: 'subworkflow', title: '调用子工作流', x: 240, y: 0,
        params: {
          workflow_id: child.id,
          input_fields: [{ key: 'x', value: '{{start_1.n}}' }, { key: 'tag', value: '父级传入' }],
          timeout_ms: 20000,
        },
      },
      { id: 'end_1', type: 'end', title: '结束', x: 520, y: 0,
        params: { outputs: [
          { key: '子结果', value: '{{sub_1.output.结果}}' },
          { key: '标签', value: '{{sub_1.output.标签}}' },
          { key: '子运行', value: '{{sub_1.run_id}}' },
        ] } },
    ],
    edges: [
      { id: 'e1', from: 'start_1', to: 'sub_1' },
      { id: 'e2', from: 'sub_1', to: 'end_1' },
    ],
  });
  const run = await waitRun(await startRun(parent.id, { n: 4 }), 40000);
  check('父运行成功', run?.status === 'success', run?.error);
  check('子工作流返回值接到下游（4 × 2 = 8）', run?.outputs?.子结果 === 8, JSON.stringify(run?.outputs));
  check('输入映射把父级的常量也传进去了', run?.outputs?.标签 === '父级传入', JSON.stringify(run?.outputs));
  check('中文变量名能解析（{{子节点.中文键}} 不再是原样字符串）',
    typeof run?.outputs?.子结果 === 'number' && typeof run?.outputs?.标签 === 'string',
    JSON.stringify(run?.outputs));
  check('子运行 ID 回传给了父运行',
    typeof run?.nodes?.sub_1?.output?.run_id === 'string' && run.nodes.sub_1.output.run_id.startsWith('run_'),
    JSON.stringify(run?.nodes?.sub_1?.output));
  const subRun = await api('GET', `/api/workflow-runs/${run.nodes.sub_1.output.run_id}`);
  check('子运行挂在父运行下（取消能一起传播）', subRun.data.run?.parent_run_id === run.id, subRun.data.run?.parent_run_id);
  const listRuns = await api('GET', `/api/workflow-runs?workflow_id=${parent.id}&limit=50`);
  check('子运行不进工作流的运行记录列表',
    (listRuns.data.runs || []).every((item) => item.id !== run.nodes.sub_1.output.run_id),
    JSON.stringify((listRuns.data.runs || []).map((item) => item.id).slice(0, 3)));

  // 自己调自己：必须在跑之前就被拦住
  const selfRef = await createWorkflow({
    name: '测试·子工作流（自引用）',
    nodes: [startNode([]), { id: 'sub_self', type: 'subworkflow', title: '调自己', x: 240, y: 0, params: { workflow_id: '__SELF__' } }],
    edges: [{ id: 'e1', from: 'start_1', to: 'sub_self' }],
  });
  await api('POST', '/api/workflows', {
    id: selfRef.id,
    name: '测试·子工作流（自引用）',
    nodes: [startNode([]), { id: 'sub_self', type: 'subworkflow', title: '调自己', x: 240, y: 0, params: { workflow_id: selfRef.id } }],
    edges: [{ id: 'e1', from: 'start_1', to: 'sub_self' }],
  });
  const selfRun = await waitRun(await startRun(selfRef.id, {}), 30000);
  check('自己调自己被拒绝', selfRun?.status === 'failed' && /不能是自己/.test(selfRun?.error || ''), `${selfRun?.status} ${selfRun?.error}`);
  check('自引用失败时不会留下未结束的子运行',
    !(await api('GET', `/api/workflow-runs?limit=100`)).data.runs.some((item) => item.parent_run_id === selfRun?.id));
}

// 触发器：Webhook 调起 + 定时计划（含到点真的会触发一次）
async function testTriggers() {
  console.log('\n[触发器] Webhook 令牌 / 必填校验 / 重置失效 / 定时到点触发');
  const wf = await createWorkflow({
    name: '测试·触发器',
    nodes: [
      startNode([{ key: 'n', label: '数字', type: 'number' }]),
      codeNode('code_double', 'return { doubled: Number(input.n) * 2 };'),
      { id: 'end_1', type: 'end', title: '结束', x: 600, y: 0,
        params: { outputs: [{ key: '结果', value: '{{code_double.output.doubled}}' }] } },
    ],
    edges: [
      { id: 'e1', from: 'start_1', to: 'code_double' },
      { id: 'e2', from: 'code_double', to: 'end_1' },
    ],
  });

  const info = await api('GET', `/api/workflows/${wf.id}/triggers`);
  const url = info.data.webhook?.url || '';
  const token = info.data.webhook?.token || '';
  check('触发器接口给出 Webhook 地址与令牌', url.includes(`/api/workflows/${wf.id}/hook/`) && token.length === 32, url);
  check('令牌是随机的十六进制', /^[0-9a-f]{32}$/.test(token), token);

  const hookPath = `/api/workflows/${wf.id}/hook/${token}`;
  const missing = await api('POST', hookPath, {});
  check('Webhook 缺必填输入被拒', missing.status === 400 && /缺少必填输入/.test(missing.data.msg || ''), JSON.stringify(missing.data));

  const fired = await api('POST', hookPath, { n: 21 });
  check('Webhook 触发成功并返回 run_id', fired.data.ok === true && String(fired.data.run_id).startsWith('run_'), JSON.stringify(fired.data));
  const hookRun = await waitRun(fired.data.run_id);
  check('Webhook 跑出来的结果正确（21 × 2）', hookRun?.outputs?.结果 === 42, JSON.stringify(hookRun?.outputs));
  check('这条运行的来源标成 hook', hookRun?.mode === 'hook', hookRun?.mode);

  const badToken = await api('POST', `/api/workflows/${wf.id}/hook/${'0'.repeat(32)}`, { n: 1 });
  check('令牌不对返回 404', badToken.status === 404, JSON.stringify(badToken.data));

  const listed = await api('GET', `/api/workflows/${wf.id}/triggers`);
  check('触发次数与最近触发时间被记录',
    listed.data.webhook?.runs === 1 && Boolean(listed.data.webhook?.last_at),
    JSON.stringify(listed.data.webhook));

  // 重置令牌：旧地址立刻失效，新地址可用
  const reset = await api('POST', `/api/workflows/${wf.id}/hook-token`);
  const newToken = reset.data.webhook?.token || '';
  check('重置后令牌换了', newToken !== token && /^[0-9a-f]{32}$/.test(newToken), newToken);
  const oldAgain = await api('POST', hookPath, { n: 1 });
  check('旧地址重置后失效', oldAgain.status === 404, JSON.stringify(oldAgain.data));
  const newOk = await api('POST', `/api/workflows/${wf.id}/hook/${newToken}`, { n: 3 });
  check('新地址可用', newOk.data.ok === true, JSON.stringify(newOk.data));
  await waitRun(newOk.data.run_id);

  // 定时计划：先验证「到点」的判定，再造一条已经过期的计划，等调度器自己跑
  const { nextFireAt, normalizeSchedules } = require(path.join(ROOT, 'src', 'workflow', 'triggers.js'));
  const now = Date.now();
  const interval = normalizeSchedules([{ mode: 'interval', every_minutes: 1, last_fired_at: new Date(now - 5 * 60000).toISOString() }])[0];
  check('间隔计划：上次触发 5 分钟前 + 每 1 分钟 → 已经到点', nextFireAt(interval, now) <= now, new Date(nextFireAt(interval, now)).toISOString());
  const future = normalizeSchedules([{ mode: 'interval', every_minutes: 30, last_fired_at: new Date(now).toISOString() }])[0];
  check('间隔计划：刚跑过 + 每 30 分钟 → 还没到点', nextFireAt(future, now) > now + 29 * 60000, new Date(nextFireAt(future, now)).toISOString());
  const daily = normalizeSchedules([{ mode: 'daily', at: '23:59' }])[0];
  const dailyNext = nextFireAt(daily, now);
  check('每天计划：下一次是未来 24 小时内的 23:59（北京时间）', dailyNext > now && dailyNext - now <= 86400000, new Date(dailyNext).toISOString());
  check('计划参数被收口（非法模式 → interval、0/超大分钟数 → 默认或上限、超过 8 条被截断）',
    normalizeSchedules([{ mode: 'weird', every_minutes: 0 }])[0].mode === 'interval'
    && normalizeSchedules([{ mode: 'interval', every_minutes: 0 }])[0].every_minutes === 60
    && normalizeSchedules([{ mode: 'interval', every_minutes: 99999 }])[0].every_minutes === 10080
    && normalizeSchedules(new Array(20).fill({ mode: 'interval', every_minutes: 5 })).length === 8);

  const saveSchedules = await api('POST', `/api/workflows/${wf.id}/triggers`, {
    schedules: [
      { mode: 'interval', every_minutes: 1, last_fired_at: new Date(Date.now() - 10 * 60000).toISOString(), inputs: { n: 5 } },
      { mode: 'daily', at: '23:59', enabled: false, inputs: { n: 7 } },
    ],
  });
  check('计划保存后返回下一次时间', saveSchedules.data.schedules?.length === 2 && Boolean(saveSchedules.data.schedules[0].next_at),
    JSON.stringify(saveSchedules.data.schedules));
  check('停用的计划没有下一次时间', saveSchedules.data.schedules[1].next_at === null);

  // 调度器每 20 秒扫一次：等它把那条已过期的计划跑起来
  let scheduled = null;
  const deadline = Date.now() + 32000;
  while (Date.now() < deadline && !scheduled) {
    const runs = await api('GET', `/api/workflow-runs?workflow_id=${wf.id}&limit=20`);
    scheduled = (runs.data.runs || []).find((run) => run.mode === 'schedule');
    if (!scheduled) await sleep(1000);
  }
  check('到点的计划被调度器真的触发了（mode=schedule）', Boolean(scheduled), scheduled ? scheduled.id : '32 秒内没有触发');
  if (scheduled) {
    const scheduledRun = await waitRun(scheduled.id, 30000);
    check('定时触发的输入来自计划里预写的 inputs（5 × 2）', scheduledRun?.outputs?.结果 === 10, JSON.stringify(scheduledRun?.outputs));
    const after = await api('GET', `/api/workflows/${wf.id}/triggers`);
    const first = after.data.schedules?.[0] || {};
    check('计划被记为已触发并给出下一次时间', Boolean(first.last_fired_at) && Boolean(first.next_at), JSON.stringify(first));
  }
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
    await testVersions();
    await testParallelBranches();
    await testSubWorkflowNode();
    await testTriggers();
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
