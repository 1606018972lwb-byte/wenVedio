// wenVedio · 视频生成工作台 服务端
// 职责：把浏览器前端与第三方自动部署(autodl) 视频 API 解耦，
// 避免把长期 API Key 暴露在浏览器/前端代码中。
// 尽量零依赖：只使用 Node 内置模块（Node 18+ 自带全局 fetch）。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { URL } = require('url');

const ROOT = __dirname;
const PROJECT_ROOT = path.resolve(ROOT, '..');
const PUBLIC_FILES = new Map([
  ['/index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'text/javascript; charset=utf-8'],
  ['/styles.css', 'text/css; charset=utf-8'],
  ['/ui-overrides.css', 'text/css; charset=utf-8'],
]);

// ---------------- 配置读取 ----------------
// 桌面客户端会把 .env 指向用户数据目录；web 端仍是项目根目录下的 .env。
const ENV_FILE = process.env.WENVEDIO_ENV_FILE || path.join(PROJECT_ROOT, '.env');

function loadEnv() {
  const env = {};
  try {
    const text = fs.readFileSync(ENV_FILE, 'utf8');
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
  port: Number(process.env.PORT || env.PORT || 8787),
  // 监听地址：桌面客户端注入 HOST=127.0.0.1；独立服务端由 .env 的 HOST 决定（不写则保持原有行为）。
  host: process.env.HOST || env.HOST || '',
  // 第三方提交接口前缀：实际提交 POST {endpoint}/{workflow}
  endpoint: env.AUTODL_ENDPOINT || 'https://www.autodl.art/api/v1/comfyui/comfyui_workflow',
  workflow: env.AUTODL_WORKFLOW || 'minimax_h3_lightx2v_v5_15s',
  apiKey: env.AUTODL_API_KEY || '',
  // 可选：平台站内登录 token，用于查询任务结果（工作流 key 不能查询）
  tasksToken: env.AUTODL_TASKS_TOKEN || '',
  mock: env.MOCK === 'true',
  queryUrl: env.AUTODL_QUERY_URL || 'https://www.autodl.art/api/v1/comfyui/comfyui_workflow/result/{task_id}',
  requestParams: {},
};
config.requestUrl = env.AUTODL_REQUEST_URL || `${config.endpoint.replace(/\/$/, '')}/${config.workflow}`;

// 任务记录：内存用于当前请求，JSON 文件用于跨重启恢复。
const DATA_DIR = process.env.WENVEDIO_DATA_DIR
  ? path.resolve(process.env.WENVEDIO_DATA_DIR)
  : path.join(PROJECT_ROOT, 'data');
// 所有配置收敛到 data/config/，日志按天写入 data/log/，过期日志自动清理。
const CONFIG_DIR = path.join(DATA_DIR, 'config');
const LOG_DIR = path.join(DATA_DIR, 'log');
const TASKS_FILE = path.join(CONFIG_DIR, 'tasks.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const MODELS_FILE = path.join(CONFIG_DIR, 'models.json');
const TOKENS_FILE = path.join(CONFIG_DIR, 'tokens.json');
const store = new Map();
const models = new Map();
const tokens = new Map();
let seq = 0;
const MAX_SEED = 999999999999999;
const TASK_TIMEOUT_MS = 20 * 60 * 1000;
let scheduledBusy = false;
let lastScheduledSubmissionAt = 0;

const DEFAULT_MODELS = [
  {
    id: 'minimax_h3_lightx2v_v5_15s', name: 'MiniMax H3 多图参考 15 秒', workflow: 'minimax_h3_lightx2v_v5_15s',
    request_url: 'https://www.autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_lightx2v_v5_15s',
    query_url: 'https://www.autodl.art/api/v1/comfyui/comfyui_workflow/result/{task_id}',
    token_id: 'default', request_params: {},
    fields: [
      { key: 'prompt', label: 'prompt', type: 'textarea', required: true, max: 500000 },
      { key: 'duration', label: 'duration', type: 'number', min: 1, max: 15, step: 1, default: 5 },
      { key: 'resolution', label: 'resolution', type: 'select', options: ['480p竖', '768p竖', '480p横', '768p横', '480p(1:1)', '768p(1:1)'] },
      { key: 'seed', label: 'seed', type: 'number', min: 1, max: MAX_SEED, step: 1 },
      { key: 'reference_images', label: '参考图片', type: 'images', required: true, min: 1, max: 10 },
    ],
  },
  {
    id: 'minimax_h3_lightx2v_v5', name: 'MiniMax H3 多图参考生视频', workflow: 'minimax_h3_lightx2v_v5',
    request_url: 'https://www.autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_lightx2v_v5',
    query_url: 'https://www.autodl.art/api/v1/comfyui/comfyui_workflow/result/{task_id}',
    token_id: 'default', request_params: {},
    fields: [
      { key: 'prompt', label: 'prompt', type: 'textarea', required: true, max: 500000 },
      { key: 'duration', label: 'duration', type: 'number', min: 1, max: 15, step: 1, default: 5 },
      { key: 'resolution', label: 'resolution', type: 'select', options: ['480p竖', '768p竖', '1080p竖', '480p横', '768p横', '1080p横', '480p(1:1)', '768p(1:1)', '1080p(1:1)'] },
      { key: 'seed', label: 'seed', type: 'number', min: 1, max: MAX_SEED, step: 1 },
      { key: 'reference_images', label: '参考图片', type: 'images', required: true, min: 1, max: 10 },
    ],
  },
];

function persistedRecord(record) {
  if (record.status === 'scheduled') return record;
  // Base64 原图体积很大，真正提交后不再需要。
  const { reference_images, ...safe } = record;
  return safe;
}

function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${TASKS_FILE}.tmp`;
  const records = [...store.values()].map(persistedRecord);
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, tasks: records }, null, 2));
  fs.renameSync(temporary, TASKS_FILE);
}

function saveModels() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${MODELS_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, models: [...models.values()] }, null, 2));
  fs.renameSync(temporary, MODELS_FILE);
}

function saveTokens() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${TOKENS_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, tokens: [...tokens.values()] }, null, 2));
  fs.renameSync(temporary, TOKENS_FILE);
}

// 兜底：模型引用的令牌不存在时（例如全新安装后先添加令牌），自动改绑到第一个可用令牌。
function rebindModelTokens() {
  const first = [...tokens.values()][0];
  if (!first) return false;
  let changed = false;
  for (const model of models.values()) {
    if (!tokens.has(model.token_id)) {
      model.token_id = first.id;
      changed = true;
    }
  }
  if (changed) saveModels();
  return changed;
}

// 模型令牌缺失时回退到第一个可用令牌，避免“添加了令牌却用不了”。
function tokenValueFor(model) {
  return tokens.get(model?.token_id)?.value || [...tokens.values()][0]?.value || config.apiKey || '';
}

// 应用级设置（预约提交间隔等），持久化到数据目录 settings.json。
const DEFAULT_SCHEDULE_INTERVAL_MS = 5 * 1000;
let scheduleIntervalMs = DEFAULT_SCHEDULE_INTERVAL_MS;

function loadAppSettings() {
  try {
    const stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
    const seconds = Math.round(Number(stored.schedule_interval_seconds));
    if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 600) scheduleIntervalMs = seconds * 1000;
  } catch (err) {
    if (err.code !== 'ENOENT') writeLog('error', `读取应用设置失败: ${err.message}`);
  }
}

function saveAppSettings() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const temporary = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ schedule_interval_seconds: scheduleIntervalMs / 1000 }, null, 2));
  fs.renameSync(temporary, SETTINGS_FILE);
}

// ---- 数据目录布局与日志 ----
// 日志按天写入 data/log/YYYY-MM-DD.log，保留 30 天，过期自动删除。
const LOG_RETENTION_DAYS = 30;

function beijingParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function writeLog(level, message) {
  const p = beijingParts();
  const line = `[${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}] [${level}] ${message}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${p.year}-${p.month}-${p.day}.log`), `${line}\n`);
  } catch (_) { /* 写日志失败不影响业务 */ }
}

// 旧版本把配置直接放在 data/ 根目录，启动时迁移到 data/config/。
function migrateDataLayout() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  for (const [name, target] of [
    ['tasks.json', TASKS_FILE],
    ['models.json', MODELS_FILE],
    ['tokens.json', TOKENS_FILE],
    ['settings.json', SETTINGS_FILE],
  ]) {
    const legacy = path.join(DATA_DIR, name);
    try {
      if (fs.existsSync(legacy) && !fs.existsSync(target)) {
        fs.renameSync(legacy, target);
        console.log(`[wenVedio] 已迁移 ${name} 到 config/`);
      }
    } catch (err) {
      console.error(`[wenVedio] 迁移 ${name} 失败: ${err.message}`);
    }
  }
}

function cleanExpiredLogs() {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(LOG_DIR)) {
      const match = name.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
      const file = path.join(LOG_DIR, name);
      let time = match ? new Date(`${match[1]}T00:00:00+08:00`).getTime() : NaN;
      if (!Number.isFinite(time)) time = fs.statSync(file).mtimeMs;
      if (Number.isFinite(time) && time < cutoff) {
        fs.unlinkSync(file);
        console.log(`[wenVedio] 已删除过期日志 ${name}`);
      }
    }
  } catch (err) {
    console.error(`[wenVedio] 清理过期日志失败: ${err.message}`);
  }
}

function loadTokens() {
  let records = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    records = Array.isArray(parsed) ? parsed : parsed.tokens;
  } catch (err) {
    if (err.code !== 'ENOENT') writeLog('error', `读取令牌配置失败: ${err.message}`);
  }
  if (Array.isArray(records)) records.forEach((token) => { if (token?.id && token?.value) tokens.set(token.id, token); });
  if (!tokens.size && config.apiKey) tokens.set('default', { id: 'default', name: '默认 ComfyUI 令牌', value: config.apiKey, created_at: new Date().toISOString() });
  saveTokens();
}

function loadModels() {
  let records = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    records = Array.isArray(parsed) ? parsed : parsed.models;
  } catch (err) {
    if (err.code !== 'ENOENT') writeLog('error', `读取模型配置失败: ${err.message}`);
  }
  const source = Array.isArray(records) && records.length ? records : DEFAULT_MODELS;
  source.forEach((model) => models.set(model.id, { ...model, token_id: model.token_id || 'default' }));
  saveModels();
}

function loadStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    const records = Array.isArray(parsed) ? parsed : parsed.tasks;
    if (!Array.isArray(records)) return;
    for (const record of records) {
      if (!record || typeof record.local_id !== 'string') continue;
      store.set(record.local_id, {
        ...record,
        reference_images: record.status === 'scheduled' && Array.isArray(record.reference_images)
          ? record.reference_images
          : [],
      });
      const match = record.local_id.match(/-(\d+)$/);
      if (match) seq = Math.max(seq, Number(match[1]) || 0);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') writeLog('error', `读取任务记录失败: ${err.message}`);
  }
}

migrateDataLayout();
loadTokens();
loadModels();
rebindModelTokens();
loadStore();
loadAppSettings();
cleanExpiredLogs();

function randomSeed() {
  while (true) {
    const bytes = crypto.randomBytes(7);
    const value = BigInt(`0x${bytes.toString('hex')}`) & ((1n << 50n) - 1n);
    if (value >= 1n && value <= BigInt(MAX_SEED)) return Number(value);
  }
}

function normalizeSeed(value) {
  const seed = Number(value);
  return Number.isInteger(seed) && seed >= 1 && seed <= MAX_SEED ? seed : randomSeed();
}

function newLocalId() {
  seq += 1;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `WV-${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${String(seq).padStart(3, '0')}`;
}

function chinaTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
}

function isNightDiscountTime(date = new Date()) {
  return chinaTimeParts(date).hour < 8;
}

function nextChinaMidnight(date = new Date()) {
  const p = chinaTimeParts(date);
  return new Date(Date.UTC(p.year, p.month - 1, p.day + 1, -8, 0, 0));
}

function nextScheduledTime() {
  const midnight = nextChinaMidnight();
  const last = [...store.values()]
    .filter((task) => task.status === 'scheduled' && task.scheduled_at)
    .reduce((latest, task) => Math.max(latest, new Date(task.scheduled_at).getTime()), 0);
  return new Date(Math.max(midnight.getTime(), last ? last + scheduleIntervalMs : 0));
}

// ---------------- 第三方 API 封装 ----------------
// 提交单个任务
async function submitTask(task) {
  const model = models.get(task.model_id) || models.get(config.workflow) || DEFAULT_MODELS[0];
  const token = tokenValueFor(model);
  const body = { ...(model.request_params || {}), ...config.requestParams, ...(task.params || {}), prompt: task.prompt };
  const duration = Number(task.duration);
  if (Number.isInteger(duration) && duration >= 1 && duration <= 15) body.duration = duration;
  if (task.resolution) body.resolution = task.resolution;
  if (Number.isInteger(task.seed)) body.seed = task.seed;
  task.reference_images.forEach((url, i) => {
    if (typeof url === 'string' && url.trim()) body[`ref_image_${i}`] = url.trim();
  });

  const res = await fetch(model.request_url || getRequestUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
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

async function performSubmission(record) {
  record.status = 'submitting';
  record.submitted_at = new Date().toISOString();
  record.error = null;
  saveStore();
  try {
    if (config.mock) {
      record.status = 'queued';
      record.provider_task_id = `MOCK-${record.local_id}`;
      record.mock = true;
    } else {
      const result = await submitTask(record);
      record.status = result.status || 'queued';
      record.provider_task_id = result.task_id || null;
      record.workflow = result.workflow || models.get(record.model_id)?.workflow || config.workflow;
    }
  } catch (err) {
    record.status = 'failed';
    record.error = err.message;
  }
  if (record.status === 'failed') writeLog('error', `任务 ${record.local_id} 提交失败: ${record.error}`);
  else writeLog('info', `任务 ${record.local_id} 提交成功，状态 ${record.status}`);
  delete record.scheduled_at;
  saveStore();
  return record;
}

async function processScheduledTasks() {
  if (scheduledBusy || Date.now() - lastScheduledSubmissionAt < scheduleIntervalMs) return;
  const due = [...store.values()]
    .filter((task) => task.status === 'scheduled' && new Date(task.scheduled_at).getTime() <= Date.now())
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))[0];
  if (!due) return;
  scheduledBusy = true;
  lastScheduledSubmissionAt = Date.now();
  try { await performSubmission(due); }
  finally { scheduledBusy = false; }
}

// 查询单个任务（需要平台登录 token；工作流 key 无法查询）
async function queryTask(taskId, modelId) {
  const model = models.get(modelId);
  const queryToken = tokens.get(model?.token_id)?.value || [...tokens.values()][0]?.value || config.tasksToken || config.apiKey;
  if (!queryToken) {
    return { task_id: taskId, status: 'queued', query_status: 'unavailable',
      note: '未配置 AUTODL_TASKS_TOKEN，无法从平台查询任务结果，请在平台控制台查看。' };
  }
  const url = getQueryUrl(taskId, model?.query_url);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${queryToken}` } });
  let data = null;
  try { data = await res.json(); } catch (_) { data = {}; }
  if (!res.ok) throw new Error(data?.msg || `HTTP ${res.status}`);
  if (data?.code && !['Success', 'SUCCESS', 0, 200].includes(data.code)) {
    throw new Error(data.msg || data.message || String(data.code));
  }
  const payload = data.data ?? data;
  const candidates = Array.isArray(payload) ? payload
    : payload && typeof payload === 'object'
      ? (payload.list || payload.rows || payload.tasks || payload.records)
      : null;
  if (Array.isArray(candidates)) {
    return candidates.find((item) => String(item.task_id || item.id) === String(taskId)) || candidates[0] || {};
  }
  return payload || {};
}

function normalizeProviderStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['success', 'succeeded', 'completed', 'complete', 'finished', 'done'].includes(status)) return 'completed';
  if (['failure', 'failed', 'error', 'cancelled', 'canceled'].includes(status)) return 'failed';
  if (['running', 'processing', 'generating', 'executing', 'in_progress'].includes(status)) return 'processing';
  if (['pending', 'waiting', 'queued', 'queue', 'submitted'].includes(status)) return 'queued';
  return status || '';
}

function findResultUrl(remote) {
  const direct = remote?.video_url || remote?.output?.video_url || remote?.result?.video_url;
  if (direct) return direct;
  if (!Array.isArray(remote?.results)) return '';
  const video = remote.results.find((item) => item && typeof item === 'object'
    && (item.type === 'video' || item.file_type === 'mp4' || /\.mp4(?:$|\?)/i.test(item.url || '')));
  if (video?.url) return video.url;
  const first = remote.results.find((item) => typeof item === 'string' || item?.url);
  return typeof first === 'string' ? first : (first?.url || '');
}

function getRequestUrl() {
  return config.requestUrl.includes('{workflow}')
    ? config.requestUrl.replaceAll('{workflow}', encodeURIComponent(config.workflow))
    : config.requestUrl;
}

function getQueryUrl(taskId, template = config.queryUrl) {
  const encodedId = encodeURIComponent(taskId);
  if (template.includes('{task_id}')) return template.replaceAll('{task_id}', encodedId);
  return `${template}${template.includes('?') ? '&' : '?'}task_id=${encodedId}`;
}

function publicConfig() {
  const keyTail = config.apiKey ? config.apiKey.slice(-4) : '';
  return {
    request_url: getRequestUrl(),
    query_url: config.queryUrl,
    api_key_configured: Boolean(config.apiKey),
    api_key_masked: keyTail ? `••••••••${keyTail}` : '',
    request_params: config.requestParams,
    mock: config.mock,
  };
}

// ---------------- JSON / 静态资源 工具 ----------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
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
      can_query: Boolean(config.tasksToken || config.apiKey || tokens.size > 0),
      request_url: getRequestUrl(),
      query_url: config.queryUrl,
    });
  }

  if (route === '/api/models' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      models: [...models.values()],
      api_key_configured: Boolean(config.apiKey),
      api_key_masked: config.apiKey ? `••••••••${config.apiKey.slice(-4)}` : '',
    });
  }

  if (route === '/api/tokens' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, tokens: [...tokens.values()].map(({ value, ...token }) => ({ ...token, masked: `••••••••${value.slice(-4)}` })) });
  }

  if (route === '/api/tokens' && req.method === 'POST') {
    let payload = {};
    try { payload = JSON.parse(await readBody(req)); } catch (_) {}
    const name = String(payload.name || '').trim();
    const value = String(payload.value || '').trim();
    if (!name || !value) return sendJson(res, 400, { ok: false, msg: '令牌名称和 API Key 不能为空' });
    const id = String(payload.id || crypto.randomUUID());
    const token = { id, name, value, created_at: tokens.get(id)?.created_at || new Date().toISOString() };
    tokens.set(id, token);
    saveTokens();
    rebindModelTokens();
    return sendJson(res, 200, { ok: true, token: { id, name, masked: `••••••••${value.slice(-4)}`, created_at: token.created_at } });
  }

  const tokenDelete = route.match(/^\/api\/tokens\/([^/]+)$/);
  if (tokenDelete && req.method === 'DELETE') {
    const id = decodeURIComponent(tokenDelete[1]);
    if ([...models.values()].some((model) => model.token_id === id)) return sendJson(res, 409, { ok: false, msg: '该令牌正被模型使用，请先更换模型令牌' });
    if (!tokens.delete(id)) return sendJson(res, 404, { ok: false, msg: '令牌不存在' });
    saveTokens();
    return sendJson(res, 200, { ok: true, deleted: id });
  }

  if (route === '/api/models' && req.method === 'POST') {
    let payload = {};
    try { payload = JSON.parse(await readBody(req)); } catch (_) {}
    const model = payload.model && typeof payload.model === 'object' ? payload.model : {};
    const id = String(model.id || model.workflow || '').trim();
    const name = String(model.name || '').trim();
    const workflow = String(model.workflow || id).trim();
    const requestUrl = String(model.request_url || '').trim();
    const queryUrl = String(model.query_url || '').trim();
    if (!id || !name || !workflow || !requestUrl || !queryUrl) {
      return sendJson(res, 400, { ok: false, msg: '模型 ID、名称、工作流 ID、提交地址和查询地址均为必填' });
    }
    if (!Array.isArray(model.fields) || !model.fields.length) {
      return sendJson(res, 400, { ok: false, msg: '参数字段定义必须是非空数组' });
    }
    const saved = {
      id, name, workflow, request_url: requestUrl, query_url: queryUrl,
      token_id: String(model.token_id || '').trim(),
      request_params: model.request_params && typeof model.request_params === 'object' && !Array.isArray(model.request_params) ? model.request_params : {},
      fields: model.fields,
    };
    if (!saved.token_id || !tokens.has(saved.token_id)) return sendJson(res, 400, { ok: false, msg: '请为模型选择已保存的令牌' });
    models.set(id, saved);
    const apiKey = String(payload.api_key || '').trim();
    if (apiKey) config.apiKey = apiKey;
    saveModels();
    return sendJson(res, 200, { ok: true, model: saved });
  }

  const modelDelete = route.match(/^\/api\/models\/([^/]+)$/);
  if (modelDelete && req.method === 'DELETE') {
    const id = decodeURIComponent(modelDelete[1]);
    if (!models.has(id)) return sendJson(res, 404, { ok: false, msg: '模型不存在' });
    models.delete(id);
    saveModels();
    return sendJson(res, 200, { ok: true, deleted: id });
  }

  // API 管理配置：仅供本地工作台使用，配置保存在当前服务进程内。
  if (route === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, config: publicConfig() });
  }

  if (route === '/api/config' && req.method === 'POST') {
    let payload = {};
    try { payload = JSON.parse(await readBody(req)); } catch (_) {}
    const requestUrl = String(payload.request_url || '').trim();
    const queryUrl = String(payload.query_url || '').trim();
    if (!requestUrl) return sendJson(res, 400, { ok: false, msg: '请求地址不能为空' });
    if (!queryUrl) return sendJson(res, 400, { ok: false, msg: '查询地址不能为空' });
    let requestParams = payload.request_params;
    if (typeof requestParams === 'string') {
      try { requestParams = JSON.parse(requestParams); } catch (_) { return sendJson(res, 400, { ok: false, msg: '请求参数必须是有效 JSON' }); }
    }
    if (!requestParams || Array.isArray(requestParams) || typeof requestParams !== 'object') {
      return sendJson(res, 400, { ok: false, msg: '请求参数必须是 JSON 对象' });
    }
    config.requestUrl = requestUrl;
    config.queryUrl = queryUrl;
    const apiKey = String(payload.api_key || '').trim();
    if (apiKey) config.apiKey = apiKey;
    config.requestParams = requestParams;
    return sendJson(res, 200, { ok: true, config: publicConfig() });
  }

  // 提交批次
  if (route === '/api/batches' && req.method === 'POST') {
    let payload = {};
    try { payload = JSON.parse(await readBody(req)); } catch (_) {}
    const name = payload.name || '提示词任务';
    const modelId = String(payload.model_id || config.workflow);
    const selectedModel = models.get(modelId);
    if (!selectedModel) return sendJson(res, 400, { ok: false, msg: '所选模型不存在' });
    const wantsSchedule = payload.scheduled === true;
    const shouldSchedule = wantsSchedule && !isNightDiscountTime();
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];

    if (!tasks.length) return sendJson(res, 400, { ok: false, msg: '没有可提交的任务' });
    if (!config.mock && !tokenValueFor(selectedModel)) return sendJson(res, 400, { ok: false, msg: '所选模型未配置有效令牌' });

    const created = [];
    for (const t of tasks) {
      const localId = newLocalId();
      const prompt = String(t.prompt || '').trim();
      const refs = Array.isArray(t.reference_images)
        ? t.reference_images.slice(0, 10).map((url) => typeof url === 'string' ? url.trim() : '')
        : [];
      if (!prompt || prompt.length > 500000) return sendJson(res, 400, { ok: false, msg: 'prompt 长度必须是 1-500000' });
      if (!Array.isArray(t.reference_images) || t.reference_images.length > 10) return sendJson(res, 400, { ok: false, msg: '图片参数最多支持 ref_image_0 到 ref_image_9' });
      if (!refs[0]) return sendJson(res, 400, { ok: false, msg: '请填写 ref_image_0' });
      const record = {
        local_id: localId,
        name,
        model_id: selectedModel.id,
        model_name: selectedModel.name,
        prompt,
        duration: Number.isInteger(Number(t.duration)) ? Math.min(15, Math.max(1, Number(t.duration))) : 5,
        resolution: typeof t.resolution === 'string' ? t.resolution.trim() : '',
        seed: normalizeSeed(t.seed),
        params: t.params && typeof t.params === 'object' && !Array.isArray(t.params) ? t.params : {},
        reference_images: refs,
        image_count: refs.filter(Boolean).length,
        status: shouldSchedule ? 'scheduled' : 'submitting',
        provider_task_id: null,
        error: null,
        created_at: new Date().toISOString(),
      };
      if (shouldSchedule) record.scheduled_at = nextScheduledTime().toISOString();
      store.set(localId, record);

      if (shouldSchedule) saveStore();
      else await performSubmission(record);
      created.push(record);
    }
    return sendJson(res, 200, { ok: true, name, tasks: created });
  }

  const scheduledAction = route.match(/^\/api\/scheduled\/([^/]+)\/(submit|cancel)$/);
  if (scheduledAction && req.method === 'POST') {
    const localId = decodeURIComponent(scheduledAction[1]);
    const action = scheduledAction[2];
    const rec = store.get(localId);
    if (!rec) return sendJson(res, 404, { ok: false, msg: '预约任务不存在' });
    if (rec.status !== 'scheduled') return sendJson(res, 409, { ok: false, msg: '该任务已不在预约队列中' });
    if (action === 'cancel') {
      store.delete(localId);
      saveStore();
      return sendJson(res, 200, { ok: true, cancelled: localId });
    }
    await performSubmission(rec);
    return sendJson(res, 200, { ok: true, task: rec });
  }

  // 应用设置：预约提交间隔等
  if (route === '/api/settings' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, settings: { schedule_interval_seconds: scheduleIntervalMs / 1000 } });
  }

  if (route === '/api/settings' && req.method === 'POST') {
    let payload = {};
    try { payload = JSON.parse(await readBody(req)); } catch (_) {}
    const seconds = Math.round(Number(payload?.schedule_interval_seconds));
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) {
      return sendJson(res, 400, { ok: false, msg: '预约提交间隔必须是 1-600 的整数秒' });
    }
    scheduleIntervalMs = seconds * 1000;
    saveAppSettings();
    return sendJson(res, 200, { ok: true, settings: { schedule_interval_seconds: scheduleIntervalMs / 1000 } });
  }

  // 下载已生成视频：由本地服务转发，避免浏览器跨域限制。
  const downloadMatch = route.match(/^\/api\/tasks\/([^/]+)\/download$/);
  if (downloadMatch && req.method === 'GET') {
    const localId = decodeURIComponent(downloadMatch[1]);
    const rec = store.get(localId);
    if (!rec) return sendJson(res, 404, { ok: false, msg: '任务不存在' });
    if (!rec.video_url) return sendJson(res, 409, { ok: false, msg: '任务尚无可下载的视频' });
    try {
      const remote = await fetch(rec.video_url);
      if (!remote.ok || !remote.body) throw new Error(`视频源返回 HTTP ${remote.status}`);
      const headers = {
        'Content-Type': remote.headers.get('content-type') || 'video/mp4',
        'Cache-Control': 'no-store',
        // 桌面客户端远程模式下是跨域下载，必须带 CORS 头。
        'Access-Control-Allow-Origin': '*',
      };
      const length = remote.headers.get('content-length');
      if (length) headers['Content-Length'] = length;
      res.writeHead(200, headers);
      Readable.fromWeb(remote.body).pipe(res);
      return;
    } catch (err) {
      return sendJson(res, 502, { ok: false, msg: `下载视频失败：${err.message}` });
    }
  }

  // 删除单条任务记录（不删除平台上的任务和视频）。
  const deleteMatch = route.match(/^\/api\/tasks\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const localId = decodeURIComponent(deleteMatch[1]);
    if (!store.delete(localId)) return sendJson(res, 404, { ok: false, msg: '任务不存在' });
    saveStore();
    return sendJson(res, 200, { ok: true, deleted: [localId] });
  }

  // 批量删除选中记录。
  if (route === '/api/tasks' && req.method === 'DELETE') {
    let payload = {};
    try { payload = JSON.parse(await readBody(req)); } catch (_) {}
    const ids = Array.isArray(payload.ids) ? [...new Set(payload.ids.map(String))] : [];
    const deleted = ids.filter((id) => store.delete(id));
    if (deleted.length) saveStore();
    return sendJson(res, 200, { ok: true, deleted });
  }

  // 查询单个任务：GET /api/tasks/{localId}
  const m = route.match(/^\/api\/tasks\/([^/]+)$/);
  if (m && req.method === 'GET') {
    const localId = decodeURIComponent(m[1]);
    const rec = store.get(localId);
    if (!rec) return sendJson(res, 404, { ok: false, msg: '任务不存在' });

    const currentStatus = normalizeProviderStatus(rec.status);
    const createdAt = new Date(rec.submitted_at || rec.created_at).getTime();
    if (rec.status !== 'scheduled' && !['completed', 'failed'].includes(currentStatus)
      && Number.isFinite(createdAt)
      && Date.now() - createdAt >= TASK_TIMEOUT_MS) {
      rec.status = 'timeout';
      rec.error = '任务超过 20 分钟未完成，已超时';
      saveStore();
      return sendJson(res, 200, { ok: true, task: rec });
    }

    if (!config.mock && rec.provider_task_id) {
      try {
        const remote = await queryTask(rec.provider_task_id, rec.model_id);
        // 尽力同步远端状态
        const before = JSON.stringify([rec.status, rec.video_url, rec.progress, rec.error, rec.query_error]);
        const remoteStatus = remote?.status ?? remote?.state ?? remote?.task_status;
        if (remoteStatus) rec.status = normalizeProviderStatus(remoteStatus) || rec.status;
        const videoUrl = findResultUrl(remote);
        if (videoUrl) rec.video_url = videoUrl;
        if (remote && remote.progress != null) rec.progress = remote.progress;
        rec.query_error = null;
        if (before !== JSON.stringify([rec.status, rec.video_url, rec.progress, rec.error, rec.query_error])) saveStore();
      } catch (err) {
        rec.query_error = err.message;
        saveStore();
      }
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
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
  }

  // 只公开浏览器运行所需的前端文件，禁止通过静态路由读取 server.js、.env、README 等服务端文件。
  const route = url.pathname === '/' ? '/index.html' : url.pathname;
  const contentType = PUBLIC_FILES.get(route);
  if (!contentType || req.method !== 'GET') {
    return sendJson(res, 404, { ok: false, msg: '资源不存在' });
  }
  return serveStatic(res, path.join(ROOT, route.slice(1)), contentType);
});

const scheduledTimer = setInterval(() => {
  processScheduledTasks().catch((err) => writeLog('error', `预约任务调度失败: ${err.message}`));
}, 1000);
scheduledTimer.unref();

const logCleanupTimer = setInterval(cleanExpiredLogs, 24 * 60 * 60 * 1000);
logCleanupTimer.unref();

function onListening() {
  writeLog('info', `服务已启动，本地地址 http://${config.host || '127.0.0.1'}:${config.port}`);
  writeLog('info', `工作流 ${config.workflow}`);
  writeLog('info', `模式 ${config.mock ? '演示 (mock)' : '真实 API'}${config.apiKey ? '' : '（未配置 API Key）'}`);
  writeLog('info', `查询能力 ${config.tasksToken || config.apiKey || tokens.size > 0 ? '已配置' : '未配置'}`);
  writeLog('info', `任务记录已恢复 ${store.size} 条`);
  writeLog('info', `数据目录 ${DATA_DIR}`);
}

if (config.host) server.listen(config.port, config.host, onListening);
else server.listen(config.port, onListening);
