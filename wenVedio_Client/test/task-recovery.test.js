// 任务记录回归测试（主程序，不是工作流模块）
//
// 自包含：自己拉起一个服务端（独立端口 + 临时数据目录），跑完关掉。
//   cd wenVedio_Client && node test/task-recovery.test.js
//
// 覆盖三条容易悄悄坏掉、坏了又很难发现的行为：
//   1. 重启后「进行中」的图片任务必须判失败——图片接口没有可续查的任务号，
//      否则界面上会永远挂着「进行中」
//   2. 预约任务的参考图落盘成文件，tasks.json 里不再有 base64 原文
//   3. 任务状态频繁变化时走合并写，不每次全量重写文件
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.TASK_TEST_PORT || 8797);
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

const iso = (ms) => new Date(ms).toISOString();

// 一张 1×1 的 png，用来当参考图
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

function seedTasks(dir) {
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const now = Date.now();
  const base = { name: '夹具', model_id: 'fixture-model', prompt: 'p', params: {}, reference_images: [] };
  const tasks = [
    { ...base, local_id: 'img-stuck-1', kind: 'image', status: 'processing', created_at: iso(now - 10 * 60 * 1000) },
    { ...base, local_id: 'img-fresh-1', kind: 'image', status: 'processing', created_at: iso(now) },
    { ...base, local_id: 'vid-stuck-1', kind: 'video', status: 'submitting', created_at: iso(now - 10 * 60 * 1000) },
    { ...base, local_id: 'vid-grace-1', kind: 'video', status: 'submitting', created_at: iso(now) },
    { ...base, local_id: 'vid-run-1', kind: 'video', status: 'processing', provider_task_id: 'P-1', created_at: iso(now - 60 * 60 * 1000) },
    // 6 条早就超过 24 小时的「生成中」记录：用来数落盘次数
    ...Array.from({ length: 6 }, (_, i) => ({
      ...base, local_id: `expired-${i + 1}`, kind: 'video', status: 'processing',
      provider_task_id: `P-exp-${i}`, created_at: iso(now - 25 * 60 * 60 * 1000),
    })),
  ];
  fs.writeFileSync(path.join(configDir, 'tasks.json'), JSON.stringify({ version: 1, tasks }, null, 2));
}

function spawnServer(dataDir, envFile) {
  return spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      WENVEDIO_DATA_DIR: dataDir,
      WENVEDIO_ENV_FILE: envFile,
      // 演示模式：不依赖任何真实平台与令牌
      MOCK: 'true',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
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

async function testRecovery(dataDir) {
  console.log('\n[任务恢复] 重启后「进行中」的任务该判失败的判失败、能续查的不动');
  const { data } = await api('GET', '/api/tasks');
  const byId = new Map((data.tasks || []).map((task) => [task.local_id, task]));

  check('卡住的图片任务被判失败（processing → failed）',
    byId.get('img-stuck-1')?.status === 'failed', JSON.stringify(byId.get('img-stuck-1')?.status));
  check('失败原因说明图片接口没有可续查的任务号',
    /没有可续查的任务号/.test(byId.get('img-stuck-1')?.error || ''), byId.get('img-stuck-1')?.error);
  check('刚提交的图片任务不动（启动竞态宽限）',
    byId.get('img-fresh-1')?.status === 'processing', JSON.stringify(byId.get('img-fresh-1')?.status));
  check('卡住的视频任务（提交中、无任务号、超过 2 分钟）判失败',
    byId.get('vid-stuck-1')?.status === 'failed', JSON.stringify(byId.get('vid-stuck-1')?.status));
  check('宽限期内的视频任务不动',
    byId.get('vid-grace-1')?.status === 'submitting', JSON.stringify(byId.get('vid-grace-1')?.status));
  check('有平台任务号的视频任务不受影响（能续查）',
    byId.get('vid-run-1')?.status === 'processing', JSON.stringify(byId.get('vid-run-1')?.status));
}

async function testScheduledRefsSpill(dataDir) {
  console.log('\n[预约参考图] 落盘成文件，任务记录里不再有 base64 原文');
  const models = await api('GET', '/api/models');
  const video = (models.data.models || []).find((model) => model.kind !== 'image' && model.kind !== 'text');
  if (!video) { check('有可用的视频模型', false, '默认模型缺失'); return; }

  const created = await api('POST', '/api/batches', {
    name: '预约夹具',
    model_id: video.id,
    scheduled: true,
    tasks: [{ prompt: '预约任务的提示词', duration: 5, resolution: '480p竖', seed: 1, reference_images: [DATA_URL] }],
  });
  const task = (created.data.tasks || [])[0] || created.data.task || null;
  const scheduled = task && task.status === 'scheduled';
  check('预约任务被建出来（状态 scheduled）', Boolean(task), JSON.stringify(created.data).slice(0, 160));

  const text = fs.readFileSync(path.join(dataDir, 'config', 'tasks.json'), 'utf8');
  check('tasks.json 里没有 base64 原文', !text.includes('base64,'), `${text.length} 字节`);

  if (task) {
    const ref = (task.reference_images || [])[0] || '';
    check('记录里只剩文件名（或已在提交后被清掉）',
      !scheduled || (/^[^/\\]+\.(png|jpg|webp)$/.test(ref) && !ref.includes('data:')), ref.slice(0, 40));
    if (scheduled) {
      const file = path.join(dataDir, 'refs', ref);
      const exists = fs.existsSync(file);
      const same = exists && fs.readFileSync(file).toString('base64') === PNG_BASE64;
      check('参考图已落盘且字节与原始一致', exists && same, exists ? '内容不一致' : '文件不存在');
    }
  }
}

async function testMergedWrites(dataDir) {
  console.log('\n[合并写] 一串状态变化只落盘一两次，而不是每次全量重写');
  const file = path.join(dataDir, 'config', 'tasks.json');
  const seen = new Set();
  let watching = true;
  const watch = (async () => {
    while (watching) {
      try { seen.add(fs.statSync(file).mtimeMs); } catch (_) { /* 写入瞬间可能读不到 */ }
      await sleep(25);
    }
  })();

  // 6 条已过期的记录：每次 GET 都会把一条改成 expired（都是 saveStoreSoon 那条路径）
  await Promise.all(Array.from({ length: 6 }, (_, i) => api('GET', `/api/tasks/expired-${i + 1}`)));
  await sleep(700);
  watching = false;
  await watch;

  const after = await api('GET', '/api/tasks');
  const expired = (after.data.tasks || []).filter((task) => /^expired-/.test(task.local_id) && task.status === 'expired').length;
  check('6 条过期任务确实都被改了状态', expired === 6, `expired=${expired}`);
  check(`6 次状态变化引起的落盘次数 ≤ 2（合并写，实测 ${seen.size}）`, seen.size <= 2, `写入次数=${seen.size}`);
}

(async () => {
  const dataDir = path.join(os.tmpdir(), `task-test-data-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  seedTasks(dataDir);
  const envFile = path.join(dataDir, '.env');
  fs.writeFileSync(envFile, 'MOCK=true\n');
  const server = spawnServer(dataDir, envFile);
  try {
    if (!await waitHealthy()) {
      console.error(`服务端没能在 ${BASE} 起来（端口可能被占用，可用 TASK_TEST_PORT 换一个）`);
      process.exitCode = 1;
      return;
    }
    await testRecovery(dataDir);
    await testScheduledRefsSpill(dataDir);
    await testMergedWrites(dataDir);
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
