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
const PROMPTS_FILE = path.join(CONFIG_DIR, 'prompts.json');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const store = new Map();
const models = new Map();
const tokens = new Map();
const prompts = new Map();
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
    pricing: { peak: 0.02, valley: 0.01, valley_start: '00:00', valley_end: '08:00' },
    fields: [
      { key: 'prompt', label: 'prompt', type: 'textarea', required: true, max: 500000 },
      { key: 'duration', label: '时长', type: 'number', min: 1, max: 15, step: 1, default: 5 },
      { key: 'resolution', label: '分辨率', type: 'select', options: ['480p竖', '768p竖', '480p横', '768p横', '480p(1:1)', '768p(1:1)'] },
      { key: 'seed', label: '随机种子', type: 'number', min: 1, max: MAX_SEED, step: 1 },
      { key: 'reference_images', label: '参考图片', type: 'images', required: true, min: 1, max: 10 },
    ],
  },
  {
    id: 'minimax_h3_lightx2v_v5', name: 'MiniMax H3 多图参考生视频', workflow: 'minimax_h3_lightx2v_v5',
    request_url: 'https://www.autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_lightx2v_v5',
    query_url: 'https://www.autodl.art/api/v1/comfyui/comfyui_workflow/result/{task_id}',
    token_id: 'default', request_params: {},
    pricing: { peak: 0.02, valley: 0.01, valley_start: '00:00', valley_end: '08:00' },
    fields: [
      { key: 'prompt', label: 'prompt', type: 'textarea', required: true, max: 500000 },
      { key: 'duration', label: '时长', type: 'number', min: 1, max: 15, step: 1, default: 5 },
      { key: 'resolution', label: '分辨率', type: 'select', options: ['480p竖', '768p竖', '1080p竖', '480p横', '768p横', '1080p横', '480p(1:1)', '768p(1:1)', '1080p(1:1)'] },
      { key: 'seed', label: '随机种子', type: 'number', min: 1, max: MAX_SEED, step: 1 },
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
    ['prompts.json', PROMPTS_FILE],
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
  let fileExists = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    records = Array.isArray(parsed) ? parsed : parsed.tokens;
  } catch (err) {
    if (err.code === 'ENOENT') fileExists = false;
    else writeLog('error', `读取令牌配置失败: ${err.message}`);
  }
  if (Array.isArray(records)) records.forEach((token) => { if (token?.id && token?.value) tokens.set(token.id, token); });
  if (!tokens.size && config.apiKey) tokens.set('default', { id: 'default', name: '默认 ComfyUI 令牌', value: config.apiKey, created_at: new Date().toISOString() });
  // 只在文件缺失（首次运行）时写盘：读取/解析失败时保留原文件，避免把已有配置覆盖成空
  if (!fileExists) saveTokens();
  else if (!Array.isArray(records)) writeLog('error', '令牌配置无法解析，已保留原文件不覆盖（请检查 data/config/tokens.json）');
}

// 提示词记录：一条记录包含多条提示词，每条含文本与时长（秒）
function savePrompts() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${PROMPTS_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, prompts: [...prompts.values()] }, null, 2));
  fs.renameSync(temporary, PROMPTS_FILE);
}

function loadPrompts() {
  let records = null;
  let fileExists = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8'));
    records = Array.isArray(parsed) ? parsed : parsed.prompts;
  } catch (err) {
    if (err.code === 'ENOENT') fileExists = false;
    else writeLog('error', `读取提示词记录失败: ${err.message}`);
  }
  if (Array.isArray(records)) {
    records.forEach((record) => {
      if (!record || !record.id) return;
      prompts.set(String(record.id), {
        id: String(record.id),
        name: String(record.name || '未命名记录').slice(0, 60),
        items: (Array.isArray(record.items) ? record.items : [])
          .map((item, index) => ({
            id: String(item?.id || `item-${index}`),
            title: String(item?.title || '').trim().slice(0, 40),
            text: String(item?.text || ''),
            duration: Number(item?.duration) > 0 ? Math.round(Number(item.duration)) : null,
          }))
          .filter((item) => item.text),
        created_at: record.created_at || new Date().toISOString(),
        updated_at: record.updated_at || record.created_at || new Date().toISOString(),
      });
    });
  }
  if (!fileExists) savePrompts();
  else if (!Array.isArray(records)) writeLog('error', '提示词记录无法解析，已保留原文件不覆盖（请检查 data/config/prompts.json）');
}

function loadModels() {
  let records = null;
  let fileExists = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    records = Array.isArray(parsed) ? parsed : parsed.models;
  } catch (err) {
    if (err.code === 'ENOENT') fileExists = false;
    else writeLog('error', `读取模型配置失败: ${err.message}`);
  }
  const source = Array.isArray(records) && records.length ? records : DEFAULT_MODELS;
  source.forEach((model) => models.set(model.id, { ...model, token_id: model.token_id || 'default' }));
  // 旧版本保存的模型没有价格字段，内置模型补上默认价格，避免一直显示未配置。
  let pricingBackfilled = false;
  for (const model of models.values()) {
    if (!model.pricing) {
      const defaults = DEFAULT_MODELS.find((item) => item.id === model.id);
      if (defaults && defaults.pricing) {
        model.pricing = defaults.pricing;
        pricingBackfilled = true;
      }
    }
  }
  // 分辨率档位由每个模型的表单字段决定（可在模型编辑的「表单字段」里按模型增删），
  // 不做自动补齐，避免给不支持的模型加上 1080p。
  // 文件缺失或补全了价格时写盘；解析失败时保留原文件，避免清空模型配置
  if (!fileExists || pricingBackfilled) saveModels();
  else if (!Array.isArray(records)) writeLog('error', '模型配置无法解析，已保留原文件不覆盖（请检查 data/config/models.json）');
}

// 上次进程异常退出可能留下「提交中」且没有平台任务号的记录，启动时标记为失败，避免长期显示进行中
function recoverStuckTasks() {
  const cutoff = Date.now() - 2 * 60 * 1000;
  let changed = false;
  store.forEach((task) => {
    if (task.status !== 'submitting' || task.provider_task_id) return;
    const at = new Date(task.submitted_at || task.created_at || 0).getTime();
    if (!Number.isNaN(at) && at > cutoff) return;
    task.status = 'failed';
    task.error = task.error || '提交中断（提交过程中客户端或服务退出）';
    changed = true;
    writeLog('warn', `任务 ${task.local_id} 曾在提交中被中断，已标记为失败`);
  });
  if (changed) saveStore();
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
loadPrompts();
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
  // 传入非法时间会让 formatToParts 抛 RangeError（曾导致内置服务退出、客户端闪退）。
  // 这里兜底为当前时间，并记录一条告警便于定位来源。
  let value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) {
    writeLog('warn', `时间参数非法（${String(date)}），已按当前时间处理`);
    value = new Date();
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
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
  // 费用计算属于附加信息，任何异常都不应影响任务记录与进程存活
  try {
    const costModel = models.get(record.model_id);
    const rate = modelRateFor(costModel?.pricing, record.resolution, record.submitted_at);
    if (rate != null && Number(record.duration) > 0) {
      record.cost = Math.round(rate * Number(record.duration) * 1000) / 1000;
      record.cost_currency = costModel?.pricing?.currency === 'USD' ? 'USD' : 'CNY';
    }
  } catch (err) {
    writeLog('warn', `任务 ${record.local_id} 费用计算失败（不影响任务）：${err.message}`);
  }
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
  const pick = Array.isArray(candidates)
    ? (candidates.find((item) => String(item.task_id || item.id) === String(taskId)) || candidates[0] || {})
    : (payload || {});
  // 平台的失败原因写在 data 的同级 msg 上，之前只取了 data 导致原因丢失
  const topMessage = String(data?.msg || data?.message || data?.error || '').trim();
  const status = normalizeProviderStatus(pick.status ?? pick.state ?? pick.task_status);
  if (topMessage && ['failed', 'timeout'].includes(status) && !pick.msg && !pick.message && !pick.error) {
    return { ...pick, msg: topMessage };
  }
  return pick;
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

// ---- 图片生成（OpenAI 兼容 images 接口，后台异步执行）----
function createMockImage(index) {
  const width = 512;
  const height = 512;
  const palette = [[63, 104, 240], [232, 121, 69], [26, 167, 120], [138, 98, 211]];
  const [r, g, b] = palette[index % palette.length];
  const rowSize = width * 3 + ((4 - ((width * 3) % 4)) % 4);
  const pixels = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowSize + x * 3;
      pixels[offset] = b;
      pixels[offset + 1] = g;
      pixels[offset + 2] = r;
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  return Buffer.concat([header, pixels]);
}

// 参考图解析：data URL 直接解码，http(s) 链接下载。
async function resolveRefBuffer(ref) {
  const value = String(ref || '').trim();
  if (!value) throw new Error('参考图为空');
  const dataMatch = value.match(/^data:([^;]+);base64,(.+)$/s);
  if (dataMatch) return { type: dataMatch[1], data: Buffer.from(dataMatch[2], 'base64') };
  if (/^https?:\/\//i.test(value)) {
    const res = await fetch(value, { signal: AbortSignal.timeout(60 * 1000) });
    if (!res.ok) throw new Error(`下载参考图失败 HTTP ${res.status}`);
    return { type: res.headers.get('content-type') || 'image/png', data: Buffer.from(await res.arrayBuffer()) };
  }
  throw new Error('参考图仅支持图片链接或 base64 图片');
}

// 零依赖 multipart/form-data 构建
function buildMultipartBody(fields, files) {
  const boundary = '----wenVedioForm' + crypto.randomBytes(10).toString('hex');
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === '' || value == null) continue;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  files.forEach((file) => {
    const fieldName = files.length > 1 ? 'image[]' : 'image';
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    chunks.push(file.data);
    chunks.push(Buffer.from('\r\n'));
  });
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

async function runImageGeneration(record) {
  const model = models.get(record.model_id);
  try {
    if (!model) throw new Error('模型配置不存在');
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    if (config.mock) {
      const count = Math.min(10, Math.max(1, Math.round(Number(record.params?.n) || 1)));
      const files = [];
      for (let i = 0; i < count; i += 1) {
        const name = `${record.local_id}-${i + 1}.bmp`;
        fs.writeFileSync(path.join(IMAGES_DIR, name), createMockImage(i));
        files.push(name);
      }
      record.image_files = files;
      record.image_count = files.length;
      record.status = 'completed';
      record.completed_at = new Date().toISOString();
      writeLog('info', `图片任务 ${record.local_id} 演示生成完成（${files.length} 张）`);
    } else {
      const token = tokenValueFor(model);
      if (!token) throw new Error('模型未配置有效令牌');
      const body = { model: model.workflow, prompt: record.prompt };
      for (const [key, value] of Object.entries(record.params || {})) {
        if (value === '' || value == null) continue;
        body[key] = value;
      }
      if (body.n != null) body.n = Math.min(10, Math.max(1, Math.round(Number(body.n) || 1)));
      const refs = Array.isArray(record.reference_images) ? record.reference_images.filter((ref) => ref && String(ref).trim()) : [];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 900 * 1000);
      let res;
      try {
        if (refs.length) {
          // 图生图：multipart 提交到 edits 接口
          const editUrl = model.edit_url || String(model.request_url || '').replace('generations', 'edits');
          if (!editUrl || editUrl === model.request_url) throw new Error('该模型未配置图生图地址，无法使用参考图');
          const refBuffers = [];
          for (let i = 0; i < refs.length; i += 1) {
            const ref = await resolveRefBuffer(refs[i]);
            refBuffers.push({ filename: `ref-${i + 1}.png`, type: ref.type, data: ref.data });
          }
          const form = buildMultipartBody(body, refBuffers);
          res = await fetch(editUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': form.contentType },
            body: form.body,
            signal: controller.signal,
          });
        } else {
          res = await fetch(model.request_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        }
      } finally {
        clearTimeout(timeout);
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || data?.msg || `HTTP ${res.status}`);
      const items = Array.isArray(data.data) ? data.data : [];
      if (!items.length) throw new Error('接口未返回图片数据');
      const files = [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        let buffer;
        let ext = 'png';
        if (item.b64_json) {
          buffer = Buffer.from(item.b64_json, 'base64');
          if (typeof item.mime_type === 'string') {
            if (item.mime_type.includes('jpeg')) ext = 'jpg';
            else if (item.mime_type.includes('webp')) ext = 'webp';
          }
        } else if (item.url) {
          const imageRes = await fetch(item.url);
          if (!imageRes.ok) throw new Error(`下载生成图片失败 HTTP ${imageRes.status}`);
          const type = imageRes.headers.get('content-type') || '';
          if (type.includes('jpeg')) ext = 'jpg';
          else if (type.includes('webp')) ext = 'webp';
          buffer = Buffer.from(await imageRes.arrayBuffer());
        } else {
          throw new Error('返回的图片缺少数据');
        }
        const name = `${record.local_id}-${i + 1}.${ext}`;
        fs.writeFileSync(path.join(IMAGES_DIR, name), buffer);
        files.push(name);
      }
      record.image_files = files;
      record.image_count = files.length;
      record.status = 'completed';
      record.completed_at = new Date().toISOString();
      const imageRate = modelRateFor(model.pricing, String(record.params?.size || ''), new Date());
      if (imageRate != null) {
        record.cost = Math.round(imageRate * files.length * 1000) / 1000;
        record.cost_currency = model.pricing?.currency === 'USD' ? 'USD' : 'CNY';
      }
      writeLog('info', `图片任务 ${record.local_id} 生成完成（${files.length} 张）`);
    }
  } catch (err) {
    record.status = 'failed';
    record.error = err.message;
    writeLog('error', `图片任务 ${record.local_id} 失败: ${err.message}`);
  }
  saveStore();
}

// 删除图片任务时同时清理落盘的图片文件。
function deleteTaskFiles(record) {
  if (!record || record.kind !== 'image' || !Array.isArray(record.image_files)) return;
  for (const name of record.image_files) {
    try { fs.unlinkSync(path.join(IMAGES_DIR, path.basename(name))); } catch (_) { /* 文件可能已不存在 */ }
  }
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

// 费率计算：分辨率设置了专属价格（数字或 {峰,谷}）优先，否则按时段取峰价/谷价。
function rateByTimeSlot(prices, atDate) {
  const parts = chinaTimeParts(atDate || new Date());
  const start = Number(String(prices.valley_start || '00:00').slice(0, 2));
  const end = Number(String(prices.valley_end || '08:00').slice(0, 2));
  const inValley = start <= end ? parts.hour >= start && parts.hour < end : parts.hour >= start || parts.hour < end;
  if (inValley) return prices.valley != null ? prices.valley : prices.peak;
  return prices.peak != null ? prices.peak : prices.valley;
}

function modelRateFor(pricing, resolution, atDate) {
  if (!pricing) return null;
  if (resolution && pricing.by_resolution) {
    const entry = pricing.by_resolution[resolution];
    if (entry != null) {
      if (typeof entry === 'object') return rateByTimeSlot(entry, atDate);
      return entry;
    }
  }
  if (pricing.peak == null && pricing.valley == null) return null;
  return rateByTimeSlot(pricing, atDate);
}

// 模型可选价格：峰谷价格（元/秒）、谷值时段、按分辨率单价。
function sanitizePricing(pricing) {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return undefined;
  const toPrice = (value) => {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? Math.round(num * 1000) / 1000 : null;
  };
  const out = {};
  if (['per_image', 'per_second', 'per_call', 'per_token', 'fixed'].includes(pricing.unit)) out.unit = pricing.unit;
  if (pricing.currency === 'USD') out.currency = 'USD';
  const peak = toPrice(pricing.peak);
  if (peak != null) out.peak = peak;
  const valley = toPrice(pricing.valley);
  if (valley != null) out.valley = valley;
  const time = (value) => (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null);
  const valleyStart = time(pricing.valley_start);
  if (valleyStart) out.valley_start = valleyStart;
  const valleyEnd = time(pricing.valley_end);
  if (valleyEnd) out.valley_end = valleyEnd;
  if (pricing.by_resolution && typeof pricing.by_resolution === 'object' && !Array.isArray(pricing.by_resolution)) {
    const byResolution = {};
    for (const [resolution, value] of Object.entries(pricing.by_resolution)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const peak = toPrice(value.peak);
        const valley = toPrice(value.valley);
        if (peak != null || valley != null) {
          byResolution[resolution.trim()] = {
            ...(peak != null ? { peak } : {}),
            ...(valley != null ? { valley } : {}),
          };
        }
      } else {
        const price = toPrice(value);
        if (price != null && resolution.trim()) byResolution[resolution.trim()] = price;
      }
    }
    if (Object.keys(byResolution).length) out.by_resolution = byResolution;
  }
  return Object.keys(out).length ? out : undefined;
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
    const id = String(payload.id || crypto.randomUUID());
    const existing = tokens.get(id);
    // 带已有 id 即为编辑：Key 留空表示保留原值；新增仍必须提供 Key。
    if (!name || (!value && !existing)) return sendJson(res, 400, { ok: false, msg: '令牌名称和 API Key 不能为空' });
    const token = {
      id,
      name,
      value: value || existing?.value || '',
      provider: String(payload.provider || existing?.provider || '').trim(),
      remark: payload.remark != null ? String(payload.remark).slice(0, 200) : String(existing?.remark || ''),
      created_at: existing?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    tokens.set(id, token);
    saveTokens();
    rebindModelTokens();
    return sendJson(res, 200, { ok: true, token: { id, name, masked: `••••••••${token.value.slice(-4)}`, created_at: token.created_at } });
  }

  // 提示词管理：一条记录包含多条提示词，每条含文本与时长（秒）
  if (route === '/api/prompts' && req.method === 'GET') {
    const list = [...prompts.values()].sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
    return sendJson(res, 200, { ok: true, prompts: list });
  }

  if (route === '/api/prompts' && req.method === 'POST') {
    let payload = {};
    try { payload = JSON.parse(await readBody(req)); } catch (_) {}
    const name = String(payload.name || '').trim().slice(0, 60);
    if (!name) return sendJson(res, 400, { ok: false, msg: '记录名称不能为空' });
    const items = (Array.isArray(payload.items) ? payload.items : [])
      .map((item, index) => ({
        id: String(item?.id || `item-${Date.now().toString(36)}-${index}`),
        title: String(item?.title || '').trim().slice(0, 40),
        text: String(item?.text || '').trim(),
        duration: Number(item?.duration) > 0 ? Math.min(600, Math.round(Number(item.duration))) : null,
      }))
      .filter((item) => item.text)
      .slice(0, 50);
    if (!items.length) return sendJson(res, 400, { ok: false, msg: '至少需要一条提示词' });
    const id = String(payload.id || '').trim() || crypto.randomUUID();
    const existing = prompts.get(id);
    const record = {
      id, name, items,
      created_at: existing?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    prompts.set(id, record);
    savePrompts();
    return sendJson(res, 200, { ok: true, prompt: record });
  }

  const promptDelete = route.match(/^\/api\/prompts\/([^/]+)$/);
  if (promptDelete && req.method === 'DELETE') {
    const id = decodeURIComponent(promptDelete[1]);
    if (!prompts.delete(id)) return sendJson(res, 404, { ok: false, msg: '记录不存在' });
    savePrompts();
    return sendJson(res, 200, { ok: true, deleted: id });
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
    const kind = model.kind === 'image' ? 'image' : model.kind === 'text' ? 'text' : 'video';
    if (!id || !name || !workflow || !requestUrl || (kind === 'video' && !queryUrl)) {
      return sendJson(res, 400, { ok: false, msg: kind === 'video' ? '模型 ID、名称、工作流 ID、提交地址和查询地址均为必填' : '模型 ID、名称、工作流 ID 和提交地址为必填' });
    }
    if (!Array.isArray(model.fields) || !model.fields.length) {
      return sendJson(res, 400, { ok: false, msg: '参数字段定义必须是非空数组' });
    }
    const pricing = sanitizePricing(model.pricing);
    const saved = {
      id, name, workflow, kind, request_url: requestUrl,
      ...(kind === 'video' ? { query_url: queryUrl } : {}),
      ...(kind === 'image' && model.edit_url && String(model.edit_url).trim() ? { edit_url: String(model.edit_url).trim() } : {}),
      token_id: String(model.token_id || '').trim(),
      request_params: model.request_params && typeof model.request_params === 'object' && !Array.isArray(model.request_params) ? model.request_params : {},
      fields: model.fields,
      ...(pricing ? { pricing } : {}),
      enabled: model.enabled !== false,
      visible: model.visible !== false,
      provider: String(model.provider || '').trim(),
      type: String(model.type || '').trim().slice(0, 32),
      tags: Array.isArray(model.tags)
        ? model.tags.map((tag) => String(tag || '').trim().slice(0, 24)).filter(Boolean).slice(0, 8)
        : [],
      description: String(model.description || '').slice(0, 500),
      sort: Number.isFinite(Number(model.sort)) ? Number(model.sort) : 0,
      timeout_seconds: Number.isFinite(Number(model.timeout_seconds)) && Number(model.timeout_seconds) >= 5 ? Number(model.timeout_seconds) : 300,
      poll_interval: Number.isFinite(Number(model.poll_interval)) && Number(model.poll_interval) >= 1 ? Number(model.poll_interval) : 3,
      max_concurrency: Number.isFinite(Number(model.max_concurrency)) && Number(model.max_concurrency) >= 1 ? Number(model.max_concurrency) : 5,
      max_retry: Number.isFinite(Number(model.max_retry)) && Number(model.max_retry) >= 0 ? Number(model.max_retry) : 0,
      debug: model.debug === true,
      created_at: models.get(id)?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (!saved.token_id || !tokens.has(saved.token_id)) return sendJson(res, 400, { ok: false, msg: '请为模型选择已保存的令牌' });
    models.set(id, saved);
    const apiKey = String(payload.api_key || '').trim();
    if (apiKey) config.apiKey = apiKey;
    saveModels();
    return sendJson(res, 200, { ok: true, model: saved });
  }

  // 模型手动排序：按提交的 id 顺序重排
  if (route === '/api/models/order' && req.method === 'POST') {
    let payload = {};
    try { payload = JSON.parse(await readBody(req)); } catch (_) {}
    const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : [];
    if (!ids.length) return sendJson(res, 400, { ok: false, msg: '缺少排序数据' });
    const reordered = [];
    const seen = new Set();
    for (const id of ids) {
      const model = models.get(id);
      if (model) {
        models.delete(id);
        models.set(id, model);
        seen.add(id);
      }
    }
    for (const [id, model] of [...models]) {
      if (!seen.has(id)) {
        models.delete(id);
        models.set(id, model);
      }
    }
    saveModels();
    return sendJson(res, 200, { ok: true, order: [...models.keys()] });
  }

  // 模型连接测试：依次探测查询地址 / 提交地址，返回时延与状态
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
    const isImageModel = selectedModel.kind === 'image';
    const wantsSchedule = payload.scheduled === true;
    const shouldSchedule = wantsSchedule && !isNightDiscountTime() && !isImageModel;
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];

    if (!tasks.length) return sendJson(res, 400, { ok: false, msg: '没有可提交的任务' });
    if (!config.mock && !tokenValueFor(selectedModel)) return sendJson(res, 400, { ok: false, msg: '所选模型未配置有效令牌' });
    const refField = Array.isArray(selectedModel.fields) ? selectedModel.fields.find((field) => field && field.key === 'reference_images') : null;
    const refsRequired = !refField || refField.required !== false;

    const created = [];
    for (const t of tasks) {
      const localId = newLocalId();
      const prompt = String(t.prompt || '').trim();
      const refs = Array.isArray(t.reference_images)
        ? t.reference_images.slice(0, 10).map((url) => typeof url === 'string' ? url.trim() : '')
        : [];
      if (!prompt || prompt.length > 500000) return sendJson(res, 400, { ok: false, msg: 'prompt 长度必须是 1-500000' });
      if (!isImageModel && refsRequired) {
        if (Array.isArray(t.reference_images) && t.reference_images.length > 10) return sendJson(res, 400, { ok: false, msg: '图片参数最多支持 ref_image_0 到 ref_image_9（最多 10 张）' });
        if (!refs[0]) return sendJson(res, 400, { ok: false, msg: '请填写 ref_image_0' });
      }
      const record = {
        local_id: localId,
        name,
        model_id: selectedModel.id,
        model_name: selectedModel.name,
        prompt,
        params: t.params && typeof t.params === 'object' && !Array.isArray(t.params) ? t.params : {},
        reference_images: refs,
        image_count: refs.filter(Boolean).length,
        status: shouldSchedule ? 'scheduled' : 'submitting',
        provider_task_id: null,
        error: null,
        created_at: new Date().toISOString(),
      };
      if (isImageModel) {
        record.kind = 'image';
        record.image_count = 0;
        record.status = 'processing';
      } else {
        record.duration = Number.isInteger(Number(t.duration)) ? Math.min(15, Math.max(1, Number(t.duration))) : 5;
        record.resolution = typeof t.resolution === 'string' ? t.resolution.trim() : '';
        record.seed = normalizeSeed(t.seed);
      }
      if (shouldSchedule) record.scheduled_at = nextScheduledTime().toISOString();
      store.set(localId, record);

      if (isImageModel && !shouldSchedule) {
        saveStore();
        runImageGeneration(record);
      } else if (shouldSchedule) {
        saveStore();
      } else {
        await performSubmission(record);
      }
      created.push(record);
    }
    return sendJson(res, 200, { ok: true, name, tasks: created });
  }

  // 令牌连接测试：借用绑定了该令牌的模型地址探测
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
    if (rec.kind === 'image') {
      const name = Array.isArray(rec.image_files) ? rec.image_files[0] : null;
      const file = name ? path.join(IMAGES_DIR, path.basename(name)) : null;
      if (!file || !fs.existsSync(file)) return sendJson(res, 409, { ok: false, msg: '任务尚无可下载的图片' });
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': ext === '.jpg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : 'image/png',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(fs.readFileSync(file));
      return;
    }
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
    const rec = store.get(localId);
    if (!rec) return sendJson(res, 404, { ok: false, msg: '任务不存在' });
    deleteTaskFiles(rec);
    store.delete(localId);
    saveStore();
    return sendJson(res, 200, { ok: true, deleted: [localId] });
  }

  // 批量删除选中记录。
  if (route === '/api/tasks' && req.method === 'DELETE') {
    let payload = {};
    try { payload = JSON.parse(await readBody(req)); } catch (_) {}
    const ids = Array.isArray(payload.ids) ? [...new Set(payload.ids.map(String))] : [];
    const deleted = [];
    for (const id of ids) {
      const rec = store.get(id);
      if (!rec) continue;
      deleteTaskFiles(rec);
      store.delete(id);
      deleted.push(id);
    }
    if (deleted.length) saveStore();
    return sendJson(res, 200, { ok: true, deleted });
  }

  // 图片任务预览：GET /api/tasks/{id}/image/{序号}
  const imageMatch = route.match(/^\/api\/tasks\/([^/]+)\/image\/(\d+)$/);
  if (imageMatch && req.method === 'GET') {
    const rec = store.get(decodeURIComponent(imageMatch[1]));
    const index = Number(imageMatch[2]);
    const name = rec && rec.kind === 'image' && Array.isArray(rec.image_files) ? rec.image_files[index] : null;
    const file = name ? path.join(IMAGES_DIR, path.basename(name)) : null;
    if (!file || !fs.existsSync(file)) return sendJson(res, 404, { ok: false, msg: '图片不存在' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': ext === '.jpg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : 'image/png',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(fs.readFileSync(file));
    return;
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
        // 失败时记录平台给出的原因，便于在任务详情里直接看到
        const platformMessage = String(remote?.msg || remote?.message || remote?.error || remote?.reason || '').trim();
        if (['failed', 'timeout'].includes(rec.status) && platformMessage) rec.error = platformMessage;
        if (rec.status === 'completed' && !rec.error) rec.error = null;
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
  recoverStuckTasks();
  writeLog('info', `数据目录 ${DATA_DIR}`);
}

// 内置服务被 Electron 主进程托管：任何未捕获异常都不能终止进程，
// 否则主进程会认为服务崩溃并弹出错误提示（表现为客户端闪退）。
process.on('uncaughtException', (err) => {
  writeLog('error', `未捕获异常：${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (reason) => {
  writeLog('error', `未处理的 Promise 拒绝：${reason && reason.stack ? reason.stack : reason}`);
});

if (config.host) server.listen(config.port, config.host, onListening);
else server.listen(config.port, onListening);
