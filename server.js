// wenVedio · 视频生成工作台 服务端
// 职责：把浏览器前端与第三方自动部署(autodl) 视频 API 解耦，
// 避免把长期 API Key 暴露在浏览器/前端代码中。
// 尽量零依赖：只使用 Node 内置模块（Node 18+ 自带全局 fetch）。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;

// ---------------- 配置读取 ----------------
function loadEnv() {
  const env = {};
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch (_) { /* 无 .env 时使用默认值（演示模式） */ }
  return env;
}

const env = loadEnv();
const config = {
  port: Number(env.PORT || 8787),
  // 第三方提交接口前缀：实际提交 POST {endpoint}/{workflow}
  endpoint: env.AUTODL_ENDPOINT || 'https://www.autodl.art/api/v1/comfyui/comfyui_workflow',
  workflow: env.AUTODL_WORKFLOW || 'minimax_h3_lightx2v_v5_15s',
  apiKey: env.AUTODL_API_KEY || '',
  // 可选：平台站内登录 token，用于查询任务结果（工作流 key 不能查询）
  tasksToken: env.AUTODL_TASKS_TOKEN || '',
  mock: env.MOCK === 'true',
};

// 平台默认占位参考图（当用户未提供参考图时保证必填参数 ref_image_0 合法）
const DEFAULT_REF = 'https://codewithgpu.ks3-cn-beijing.ksyuncs.com/comfyui_api/blank/blank.png';

// 任务提交解析（内存，重启即清空）
const store = new Map();
let seq = 0;

function newLocalId() {
  seq += 1;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `WV-${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${String(seq).padStart(3, '0')}`;
}

// ---------------- 第三方 API 封装 ----------------
// 提交单个任务
async function submitTask(task) {
  const body = { prompt: task.prompt };
  const duration = Number(task.duration);
  if (Number.isFinite(duration) && duration > 0) body.duration = Math.min(15, Math.max(1, duration));

  const refs = (task.reference_images && task.reference_images.filter(Boolean)) || [];
  // ref_image_0 必填，缺失时使用占位图
  const used = refs.length ? refs.slice(0, 6) : [DEFAULT_REF];
  used.forEach((url, i) => { body[`ref_image_${i}`] = url; });

  const res = await fetch(`${config.endpoint}/${config.workflow}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  let data = null;
  try { data = await res.json(); } catch (_) { data = {}; }

  if (!res.ok) {
    const msg = data?.error?.message || data?.msg || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (data.code && data.code !== 'Success') {
    throw new Error(data.msg || data.code);
  }

  return data.data || {};
}

// 查询单个任务（需要平台登录 token；工作流 key 无法查询）
async function queryTask(taskId) {
  if (!config.tasksToken) {
    return { task_id: taskId, status: 'queued', query_status: 'unavailable',
      note: '未配置 AUTODL_TASKS_TOKEN，无法从平台查询任务结果，请在平台控制台查看。' };
  }
  const url = `https://www.autodl.art/api/v1/comfyui/workflow/tasks?task_id=${encodeURIComponent(taskId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${config.tasksToken}` } });
  let data = null;
  try { data = await res.json(); } catch (_) { data = {}; }
  return data.data || data;
}

// ---------------- JSON / 静态资源 工具 ----------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function serveStatic(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ---------------- 路由 ----------------
async function handleApi(req, res, url) {
  const route = url.pathname;

  // 健康检查
  if (route === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      provider: 'autodl/MinimaxH3',
      workflow: config.workflow,
      mock: config.mock,
      has_key: Boolean(config.apiKey),
      can_query: Boolean(config.tasksToken),
    });
  }

  // 提交批次
  if (route === '/api/batches' && req.method === 'POST') {
    let payload = {};
    try { payload = JSON.parse(await readBody(req)); } catch (_) {}
    const name = payload.name || '未命名批次';
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];

    if (!tasks.length) return sendJson(res, 400, { ok: false, msg: '没有可提交的任务' });
    if (!config.mock && !config.apiKey) return sendJson(res, 400, { ok: false, msg: '未配置 AUTODL_API_KEY' });

    const created = [];
    for (const t of tasks) {
      const localId = newLocalId();
      const record = {
        local_id: localId,
        name,
        prompt: t.prompt || '',
        duration: Number(t.duration) || 3,
        reference_images: t.reference_images || [t.reference_image].filter(Boolean),
        status: 'submitting',
        provider_task_id: null,
        error: null,
        created_at: new Date().toISOString(),
      };
      store.set(localId, record);

      try {
        if (config.mock) {
          // 演示模式：本地模拟成功并返回虚构 task_id
          record.status = 'queued';
          record.provider_task_id = `MOCK-${localId}`;
          record.mock = true;
        } else {
          const r = await submitTask(t);
          record.status = r.status || 'queued';
          record.provider_task_id = r.task_id || null;
          record.workflow = r.workflow || config.workflow;
        }
      } catch (err) {
        record.status = 'failed';
        record.error = err.message;
      }
      created.push(record);
    }
    return sendJson(res, 200, { ok: true, name, tasks: created });
  }

  // 查询单个任务：GET /api/tasks/{localId}
  const m = route.match(/^\/api\/tasks\/([^/]+)$/);
  if (m && req.method === 'GET') {
    const localId = decodeURIComponent(m[1]);
    const rec = store.get(localId);
    if (!rec) return sendJson(res, 404, { ok: false, msg: '任务不存在' });

    if (!config.mock && rec.provider_task_id) {
      try {
        const remote = await queryTask(rec.provider_task_id);
        // 尽力同步远端状态
        if (remote && remote.status) rec.status = remote.status;
        if (remote && remote.video_url) rec.video_url = remote.video_url;
      } catch (_) { /* 保持本地状态 */ }
    }
    return sendJson(res, 200, { ok: true, task: rec });
  }

  // 任务列表
  if (route === '/api/tasks' && req.method === 'GET') {
    const list = [...store.values()];
    return sendJson(res, 200, { ok: true, tasks: list });
  }

  return sendJson(res, 404, { ok: false, msg: 'API 路由不存在' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e7) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ---------------- 服务器 ----------------
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host}`); }
  catch (_) { return sendJson(res, 400, { ok: false, msg: 'bad url' }); }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
  }

  // 静态资源
  const route = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = path.normalize(route).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, safe);
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
  return serveStatic(res, filePath, types[ext] || 'application/octet-stream');
});

server.listen(config.port, () => {
  console.log(`[wenVedio] 视频生成工作台服务已启动`);
  console.log(`[wenVedio] 本地地址  http://127.0.0.1:${config.port}`);
  console.log(`[wenVedio] 工作流     ${config.workflow}`);
  console.log(`[wenVedio] 模式       ${config.mock ? '演示 (mock)' : '真实 API'}${config.apiKey ? '' : '（未配置 API Key）'}`);
  console.log(`[wenVedio] 查询能力   ${config.tasksToken ? '已配置登录 token，可查结果' : '未配置，仅可提交任务'}`);
});
