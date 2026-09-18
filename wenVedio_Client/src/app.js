// wenVedio · 视频生成工作台 前端逻辑
// 说明：真实 API 由后端 server.js 代理，浏览器不再持有长期 API Key。
// 演示模式（mock）在浏览器本地模拟完整流程，用于快速评审。

const DEFAULTS = { apiBase: '', mock: false };
const FORM_STORAGE_KEY = 'frameflow-last-form';
const FORM_DB_NAME = 'wenvedio-drafts';
const FORM_DB_STORE = 'form-data';
const MAX_SEED = 999999999999999;
let imageDraftFingerprint = '';
let imageDraftTimer = null;

const state = {
  tasks: [],
  filter: 'all',
  selected: new Set(),
  imageItems: [{ id: 'link-0', kind: 'link', value: '' }],
  pollTimers: [],
  pollingTasks: new Set(),
  downloadDirs: { video: null, image: null },
  models: [],
  selectedModelId: '',
  adminModelId: '',
  tokens: [],
  tokensLoaded: false,
  prompts: [],
  imageModelId: '',
  imageRefItems: [],
  recordsKind: 'all',
  tc: { filter: 'all', search: '', model: '', date: '' },
};
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
// 桌面客户端注入的桥接对象；web 端为 undefined，下面所有桌面分支都会跳过。
const desktopBridge = window.wenvedioDesktop || null;

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('frameflow-settings') || '{}') }; }
  catch (_) { return DEFAULTS; }
}
let settings = loadSettings();

// 应用设置（客户端本地）：桌面通知与轮询间隔；桌面专属项由主进程持久化。
const APP_SETTINGS_KEY = 'wenvedio-app-settings';
function loadAppSettings() {
  try {
    return { notifyOnFinish: true, pollIntervalSeconds: 60, ...JSON.parse(localStorage.getItem(APP_SETTINGS_KEY) || '{}') };
  } catch (_) {
    return { notifyOnFinish: true, pollIntervalSeconds: 60 };
  }
}
const appSettings = loadAppSettings();

// ---- 界面主题：light / dark / system，存 localStorage，可在「应用设置」里切换 ----
// 首帧主题由 index.html 里的内联脚本先行设定，这里只负责同步按钮与响应系统切换。
const THEME_KEY = 'wenvedio-theme';
const THEME_MODES = ['light', 'dark', 'system'];

function storedThemeMode() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return THEME_MODES.includes(value) ? value : 'system';
  } catch (_) {
    return 'system';
  }
}

function systemPrefersDark() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function resolvedTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemPrefersDark() ? 'dark' : 'light';
}

function syncThemeSwitch() {
  const mode = storedThemeMode();
  $$('#themeSwitch [data-theme-set]').forEach((button) => {
    const on = button.dataset.themeSet === mode;
    button.classList.toggle('active', on);
    button.setAttribute('aria-checked', String(on));
  });
}

// Windows 的系统窗口按钮由主进程用 titleBarOverlay 绘制，主题变了要同步底色与符号色
const TITLE_BAR_COLORS = {
  light: { color: '#ffffff', symbolColor: '#4d5b73' },
  dark: { color: '#0e141d', symbolColor: '#a6b3c6' },
};

function syncTitleBar(resolved) {
  if (!desktopBridge || typeof desktopBridge.setTitleBarTheme !== 'function') return;
  const palette = TITLE_BAR_COLORS[resolved] || TITLE_BAR_COLORS.light;
  desktopBridge.setTitleBarTheme(palette).catch(() => { /* 旧版本或非 Windows 忽略 */ });
}

// animate=true 时给根节点挂一小段过渡，避免整页硬切造成的闪烁
function applyTheme(mode = storedThemeMode(), animate = false) {
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-anim');
    setTimeout(() => root.classList.remove('theme-anim'), 260);
  }
  const resolved = resolvedTheme(mode);
  root.setAttribute('data-theme', resolved);
  syncTitleBar(resolved);
  syncThemeSwitch();
}

function setThemeMode(mode) {
  if (!THEME_MODES.includes(mode)) return;
  try { localStorage.setItem(THEME_KEY, mode); } catch (_) { /* 存不了就只在本次生效 */ }
  applyTheme(mode, true);
}

// 「跟随系统」时，Windows 外观变化要即时生效
if (window.matchMedia) {
  const themeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemThemeChange = () => { if (storedThemeMode() === 'system') applyTheme('system'); };
  if (themeQuery.addEventListener) themeQuery.addEventListener('change', onSystemThemeChange);
  else if (themeQuery.addListener) themeQuery.addListener(onSystemThemeChange);
}

// ---- 标题栏的服务状态指示：以前是一句写死的假文字，现在反映真实连接 ----
const HEALTH_POLL_MS = 20000;
let healthTimer = null;

function renderServiceStatus(ok, detail) {
  const el = $('#serviceStatus');
  if (!el) return;
  const text = $('#serviceStatusText');
  el.dataset.state = ok ? 'ok' : 'down';
  el.title = ok
    ? `本地服务正常${detail ? ` · ${detail}` : ''}`
    : `连不上本地服务${detail ? `（${detail}）` : ''}；任务状态可能不再更新，请重启客户端`;
  if (text) text.textContent = ok ? '服务正常' : '服务已断开';
}

async function checkService() {
  try {
    const res = await fetch(`${settings.apiBase}/api/health`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderServiceStatus(true, data.mock ? '演示模式' : '');
  } catch (err) {
    renderServiceStatus(false, err.message);
  }
}

function startServiceWatch() {
  checkService();
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(checkService, HEALTH_POLL_MS);
}

function saveAppSettings(patch) {
  Object.assign(appSettings, patch);
  try { localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(appSettings)); } catch (_) { /* 保存失败不影响使用 */ }
}

function randomSeed() {
  if (window.crypto?.getRandomValues) {
    const values = new Uint32Array(2);
    window.crypto.getRandomValues(values);
    const combined = (BigInt(values[0]) << 32n) | BigInt(values[1]);
    return Number((combined % BigInt(MAX_SEED)) + 1n);
  }
  return Math.floor(Math.random() * MAX_SEED) + 1;
}

const GEN_VALUES_KEY = 'wenvedio_gen_values_v1';
const genValues = { video: { values: {} }, image: { values: {} } };
function setGenFieldValue(kind, key, value) {
  genValues[kind].values[key] = value;
  saveGenValues();
  // 参数变化后立刻刷新价格面板（时长、数量等会影响预计费用）
  if (kind === 'image') renderImagePricePanel();
  else renderCurrentPrice();
}
function loadGenValues() {
  try {
    const saved = JSON.parse(localStorage.getItem(GEN_VALUES_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      if (saved.video && typeof saved.video === 'object') genValues.video.values = saved.video;
      if (saved.image && typeof saved.image === 'object') genValues.image.values = saved.image;
    }
  } catch (_) { /* 忽略损坏的历史参数 */ }
}
function saveGenValues() {
  try { localStorage.setItem(GEN_VALUES_KEY, JSON.stringify(genValues)); } catch (_) { /* 浏览器禁用本地存储时不影响提交 */ }
}
function parseResolutionOption(option) {
  const text = String(option || '').trim();
  const match = text.match(/^(\d+p)\s*(竖|横|\(1:1\))?$/);
  if (!match) return null;
  return { clarity: match[1], shape: match[2] === '(1:1)' ? '1:1' : match[2] || '', option: text };
}
function pickResolution(parsed, clarity, shape) {
  const hit = parsed.find((item) => item.clarity === clarity && item.shape === shape);
  return hit ? hit.option : '';
}

function saveForm() {
  const payload = {
    taskName: $('#taskName')?.value || '未命名任务',
    taskSequence: $('#taskSequence')?.value || '1',
    scheduleSubmit: Boolean($('#scheduleSubmit')?.checked),
    modelId: $('#modelSelect')?.value || state.selectedModelId || '',
    prompt: $('#prompt')?.value || '',
    imageItems: state.imageItems
      .filter((item) => item.kind === 'link')
      .map(({ id, kind, value, name }) => ({ id, kind, value, name })),
  };
  try {
    localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(payload));
  } catch (_) { /* 浏览器禁用本地存储时不影响提交 */ }
  scheduleImageDraftSave();
}
function restoreForm() {
  try {
    const saved = JSON.parse(localStorage.getItem(FORM_STORAGE_KEY) || 'null');
    if (!saved) return;
    if (typeof saved.taskName === 'string' && saved.taskName.trim()) $('#taskName').value = saved.taskName.trim();
    if (saved.taskSequence != null) $('#taskSequence').value = String(saved.taskSequence);
    if (typeof saved.scheduleSubmit === 'boolean') $('#scheduleSubmit').checked = saved.scheduleSubmit;
    if (typeof saved.modelId === 'string' && state.models.some((model) => model.id === saved.modelId)) {
      $('#modelSelect').value = saved.modelId;
      state.selectedModelId = saved.modelId;
      applySelectedModel();
    }
    if (typeof saved.prompt === 'string') $('#prompt').value = saved.prompt;
    if (Array.isArray(saved.imageItems)) {
      const items = saved.imageItems
        .filter((item) => item && (item.kind === 'link' || item.kind === 'file'))
        .slice(0, 10)
        .map((item, i) => ({
          id: String(item.id || `link-${i}`),
          kind: item.kind,
          value: String(item.value || ''),
          name: String(item.name || ''),
        }));
      if (items.length) state.imageItems = items;
    } else if (Array.isArray(saved.imageRows)) {
      const links = saved.imageRows.map((value, i) => ({ id: `link-${i}`, kind: 'link', value: String(value || '') })).filter((item) => item.value);
      state.imageItems = links.length ? links : [{ id: 'link-0', kind: 'link', value: '' }];
    }
  } catch (_) { /* 忽略损坏的历史表单 */ }
}
function openFormDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('IndexedDB unavailable'));
    const request = indexedDB.open(FORM_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(FORM_DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeImageDraft(items) {
  const db = await openFormDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(FORM_DB_STORE, 'readwrite');
    transaction.objectStore(FORM_DB_STORE).put(items, 'images');
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function readImageDraft() {
  const db = await openFormDb();
  const result = await new Promise((resolve, reject) => {
    const request = db.transaction(FORM_DB_STORE).objectStore(FORM_DB_STORE).get('images');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result;
}

async function readBrowserValue(key) {
  const db = await openFormDb();
  const result = await new Promise((resolve, reject) => {
    const request = db.transaction(FORM_DB_STORE).objectStore(FORM_DB_STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result;
}

async function writeBrowserValue(key, value) {
  const db = await openFormDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(FORM_DB_STORE, 'readwrite');
    transaction.objectStore(FORM_DB_STORE).put(value, key);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function clearImageDraft() {
  try {
    const db = await openFormDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(FORM_DB_STORE, 'readwrite');
      transaction.objectStore(FORM_DB_STORE).delete('images');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  } catch (_) { /* 无可用的 IndexedDB 时忽略 */ }
}

function imageDraftKey(items = state.imageItems) {
  return JSON.stringify(items.map((item) => [item.id, item.kind, item.kind === 'file' ? item.value.length : item.value, item.name || '']));
}

function scheduleImageDraftSave() {
  const fingerprint = imageDraftKey();
  if (fingerprint === imageDraftFingerprint) return;
  imageDraftFingerprint = fingerprint;
  clearTimeout(imageDraftTimer);
  imageDraftTimer = setTimeout(() => {
    writeImageDraft(state.imageItems.map(({ id, kind, value, name }) => ({ id, kind, value, name })))
      .catch((err) => console.warn('图片草稿保存失败', err));
  }, 250);
}

async function restoreImageDraft() {
  try {
    const items = await readImageDraft();
    if (Array.isArray(items) && items.length) {
      state.imageItems = items.slice(0, 10).map((item, i) => ({
        id: String(item.id || `${item.kind || 'link'}-${i}`),
        kind: item.kind === 'file' ? 'file' : 'link',
        value: String(item.value || ''),
        name: String(item.name || ''),
      }));
    } else if (state.imageItems.some((item) => item.kind === 'file')) {
      // 首次升级时迁移旧 localStorage 中的图片草稿。
      await writeImageDraft(state.imageItems);
    }
    imageDraftFingerprint = imageDraftKey();
  } catch (_) { /* 仍可使用文本和图片链接草稿 */ }
}

async function initializeFormDraft() {
  restoreForm();
  if (!$('#taskName').dataset.savedValue) $('#taskName').dataset.savedValue = $('#taskName').value.trim() || '未命名任务';
  await restoreImageDraft();
  renderImageRows();
  saveForm();
}

async function initializeModels() {
  try {
    const res = await fetch(`${settings.apiBase}/api/models`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    const previousModelId = $('#modelSelect')?.value || state.selectedModelId;
    state.models = data.models || [];
    const videoModels = state.models.filter((model) => model.kind !== 'image' && model.kind !== 'text' && model.enabled !== false && model.visible !== false);
    const imageModels = state.models.filter((model) => model.kind === 'image' && model.enabled !== false && model.visible !== false);
    const select = $('#modelSelect');
    select.innerHTML = videoModels.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}</option>`).join('');
    state.selectedModelId = videoModels.some((model) => model.id === previousModelId) ? previousModelId : (videoModels[0]?.id || '');
    select.value = state.selectedModelId;
    applySelectedModel();
    const imageSelect = $('#imageModelSelect');
    if (imageSelect) {
      const previousImageId = imageSelect.value || state.imageModelId;
      imageSelect.innerHTML = imageModels.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}</option>`).join('');
      state.imageModelId = imageModels.some((model) => model.id === previousImageId) ? previousImageId : (imageModels[0]?.id || '');
      imageSelect.value = state.imageModelId;
      applySelectedImageModel();
    }
    renderTasks();
  } catch (err) {
    console.error('读取模型列表失败', err);
  }
}

function selectedModel() {
  return state.models.find((model) => model.id === ($('#modelSelect')?.value || state.selectedModelId));
}

// ---- 价格（可选）：峰谷价格 + 按分辨率价格，单位 元/秒 ----
function beijingHour(value) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
    const hour = parts.find((part) => part.type === 'hour');
    return hour ? Number(hour.value) : null;
  } catch (_) { return null; }
}

// 取费率：分辨率设置了专属价格就按它计；否则谷值时段内取谷价，时段外取峰价。
function priceSymbol(pricing) {
  return pricing && pricing.currency === 'USD' ? '$' : '¥';
}

function rateByTimeSlot(prices, atValue) {
  const hour = beijingHour(atValue || new Date().toISOString());
  const start = Number(String(prices.valley_start || '00:00').slice(0, 2));
  const end = Number(String(prices.valley_end || '08:00').slice(0, 2));
  if (hour == null || !Number.isFinite(start) || !Number.isFinite(end)) return prices.peak != null ? prices.peak : prices.valley;
  const inValley = start <= end ? hour >= start && hour < end : hour >= start || hour < end;
  if (inValley) return prices.valley != null ? prices.valley : prices.peak;
  return prices.peak != null ? prices.peak : prices.valley;
}

function modelRateFor(pricing, resolution, atValue) {
  if (!pricing) return null;
  if (resolution && pricing.by_resolution) {
    const entry = pricing.by_resolution[resolution];
    if (entry != null) {
      if (typeof entry === 'object') return rateByTimeSlot(entry, atValue);
      return entry;
    }
  }
  if (pricing.peak == null && pricing.valley == null) return null;
  return rateByTimeSlot(pricing, atValue);
}

function beijingDayKey(value) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
  } catch (_) { return ''; }
}

function formatTaskCost(task) {
  if (typeof task.cost !== 'number') return '—';
  return `${task.cost_currency === 'USD' ? '$' : '¥'}${task.cost.toFixed(2)}`;
}

// 按当前时间判断峰谷，在提交行显示当前适用的价格；每 30 秒自动刷新。
function pricingBreakdown(pricing) {
  const symbol = priceSymbol(pricing);
  const perSecond = pricing.unit !== 'per_image';
  const unitText = perSecond ? '/秒' : '/张';
  const parts = [];
  if (pricing.peak != null) parts.push(`峰值 ${symbol}${pricing.peak}${unitText}`);
  if (pricing.valley != null) parts.push(`谷值 ${symbol}${pricing.valley}${unitText}（${pricing.valley_start || '00:00'}-${pricing.valley_end || '08:00'}）`);
  if (pricing.by_resolution) {
    for (const [resolution, value] of Object.entries(pricing.by_resolution)) {
      if (value && typeof value === 'object') parts.push(`${resolution} 峰${symbol}${value.peak != null ? value.peak : '—'}${unitText} / 谷${symbol}${value.valley != null ? value.valley : '—'}${unitText}`);
      else parts.push(`${resolution} ${symbol}${value}${unitText}`);
    }
  }
  return parts.join(' · ') || '未配置价格';
}

function renderCurrentPrice() {
  const el = $('#currentPrice');
  if (!el) return;
  const lines = $('#videoPriceLines');
  const showEmpty = (text) => {
    el.classList.add('is-empty');
    el.innerHTML = `<small>${escapeHtml(text)}</small>`;
    if (lines) lines.innerHTML = '';
  };
  // 价格面板改成「大号总额 + 时段标签 + 拆分行」，避免长句换行把等号挤到下一行
  el.classList.remove('is-empty');
  const pricing = (selectedModel() || {}).pricing;
  if (!pricing || (pricing.peak == null && pricing.valley == null && !pricing.by_resolution)) {
    el.title = '当前模型未配置价格，可在「模型管理」里设置';
    showEmpty('当前模型未配置价格');
    return;
  }
  const resolution = genValues.video.values.resolution || '';
  const duration = Math.max(1, Math.round(Number(genValues.video.values.duration) || 5));
  const rate = modelRateFor(pricing, resolution, new Date().toISOString());
  if (rate == null) {
    el.title = '';
    showEmpty('');
    return;
  }
  let tag;
  if (resolution && pricing.by_resolution && pricing.by_resolution[resolution] != null) tag = { text: resolution, cls: '' };
  else if (pricing.valley != null && rate === pricing.valley) tag = { text: '谷值', cls: 'valley' };
  else tag = { text: '峰值', cls: '' };
  const symbol = priceSymbol(pricing);
  const total = (rate * duration).toFixed(2);
  el.title = pricingBreakdown(pricing);
  el.innerHTML = `<b>${escapeHtml(symbol + total)}</b>`
    + `<span class="price-tag ${tag.cls}">${escapeHtml(tag.text)}</span>`
    + `<small>${escapeHtml(`${symbol}${rate} / 秒 × ${duration} 秒`)}</small>`;
  if (lines) {
    const rows = [
      ['清晰度', resolution ? resolution.replace(/(竖|横|\(1:1\))$/, '') : '默认'],
      ['画幅', resolution.includes('竖') ? '竖屏' : resolution.includes('横') ? '横屏' : resolution.includes('1:1') ? '1:1' : '默认'],
      ['时长', `${duration} 秒`],
      ['单价', `${symbol}${rate} / 秒`],
    ];
    lines.innerHTML = rows.map(([key, value]) => `<div><span>${escapeHtml(key)}</span><b>${escapeHtml(value)}</b></div>`).join('');
  }
}
const modelUI = {
  search: '',
  kind: '',
  provider: '',
  token: '',
  status: '',
  sort: 'name',
  page: 1,
  pageSize: 10,
  selected: new Set(),
  editingId: null,
  dirty: false,
  fieldsMode: 'visual',
  drawerFields: [],
  drawerTags: [],
  drawerPricing: null,
  loadedFieldsSnapshot: '[]',
  savedAt: null,
};
const FIELD_TYPE_META = {
  text: { label: '单行文本', params: ['placeholder', 'default', 'maxLength'] },
  textarea: { label: '多行文本', params: ['placeholder', 'default', 'maxLength'] },
  number: { label: '数字', params: ['min', 'max', 'step', 'default'] },
  select: { label: '下拉选择', params: ['options', 'default'] },
  images: { label: '图片选择', params: ['accept', 'multiple', 'maxFiles'] },
};
const FIELD_TYPE_OPTIONS = Object.entries(FIELD_TYPE_META).map(([value, meta]) => ({ value, label: meta.label }));

function normalizeModel(model) {
  const m = model && typeof model === 'object' ? model : {};
  return {
    ...m,
    id: m.id || '',
    name: m.name || '未命名模型',
    workflow: m.workflow || m.id || '',
    kind: m.kind === 'image' ? 'image' : m.kind === 'text' ? 'text' : 'video',
    request_url: m.request_url || '',
    query_url: m.query_url || '',
    edit_url: m.edit_url || '',
    token_id: m.token_id || '',
    provider: m.provider || '',
    tags: Array.isArray(m.tags)
      ? m.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 8)
      : (String(m.type || '').trim() ? [String(m.type).trim()] : []),
    description: m.description || '',
    enabled: m.enabled !== false,
    visible: m.visible !== false,
    sort: Number.isFinite(Number(m.sort)) ? Number(m.sort) : 0,
    timeout_seconds: Number.isFinite(Number(m.timeout_seconds)) ? Number(m.timeout_seconds) : 300,
    poll_interval: Number.isFinite(Number(m.poll_interval)) ? Number(m.poll_interval) : 3,
    max_concurrency: Number.isFinite(Number(m.max_concurrency)) ? Number(m.max_concurrency) : 5,
    max_retry: Number.isFinite(Number(m.max_retry)) ? Number(m.max_retry) : 0,
    debug: m.debug === true,
    pricing: m.pricing || null,
    created_at: m.created_at || null,
    updated_at: m.updated_at || null,
  };
}

const MODEL_TYPE_OPTIONS = [
  { value: 'image', label: '图片生成', cls: 'tag-image' },
  { value: 'video', label: '视频生成', cls: 'tag-video' },
  { value: 'img2vid', label: '图生视频', cls: 'tag-img2vid' },
  { value: 'multi_ref', label: '多图参考', cls: 'tag-multiref' },
  { value: 'first_last', label: '首尾帧', cls: 'tag-firstlast' },
  { value: 'text', label: '文本生成', cls: 'tag-text' },
  { value: 'other', label: '其他', cls: 'tag-other' },
];

// 单个标签的展示样式：命中预设用预设样式，自定义文本按原样展示
function modelTagMeta(tag) {
  const text = String(tag || '').trim();
  if (!text) return { value: 'unknown', label: UNKNOWN_TYPE, cls: 'tag-unknown' };
  const preset = MODEL_TYPE_OPTIONS.find((option) => option.value === text || option.label === text);
  return preset || { value: text, label: text, cls: 'tag-other' };
}

// 类型标签：一个模型可以有多个；没有任何标签时展示「未知类型」
function modelTags(model) {
  const list = (Array.isArray(model.tags) ? model.tags : []).map((tag) => String(tag || '').trim()).filter(Boolean);
  const metas = list.map(modelTagMeta);
  return metas.length ? metas : [{ value: 'unknown', label: UNKNOWN_TYPE, cls: 'tag-unknown' }];
}

const UNKNOWN_PROVIDER = '未知供应商';
const UNKNOWN_TYPE = '未知类型';

// 供应商只取保存值，不再按名称/地址猜测（避免列表与编辑界面不一致）
function modelProvider(model) {
  return String(model.provider || '').trim();
}

function modelProviderLabel(model) {
  return modelProvider(model) || UNKNOWN_PROVIDER;
}

function tokenById(id) {
  return state.tokens.find((token) => token.id === id) || null;
}

function tokenNameFor(model) {
  const token = tokenById(model.token_id);
  return token ? token.name : '未绑定';
}

function modelStatusOf(model) {
  if (model.enabled === false) return 'disabled';
  if (!model.request_url) return 'error';
  // 启动阶段令牌可能还没加载完，此时先不误报「配置异常」，加载完成后会重新渲染
  if (!tokenById(model.token_id)) return state.tokensLoaded ? 'error' : 'enabled';
  return 'enabled';
}

const MODEL_STATUS_META = {
  enabled: { label: '已启用', cls: 'status-enabled' },
  disabled: { label: '已停用', cls: 'status-disabled' },
  error: { label: '配置异常', cls: 'status-error' },
};

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '—';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function defaultFieldsFor(kind) {
  if (kind === 'image') {
    return [
      { key: 'prompt', label: '提示词', type: 'textarea', required: true, maxLength: 500000 },
      { key: 'size', label: '尺寸', type: 'select', options: ['1024x1024', '2048x2048', '4096x4096'], default: '1024x1024' },
      { key: 'n', label: '数量', type: 'number', min: 1, max: 4, default: 1 },
      { key: 'reference_images', label: '参考图片（可选）', type: 'images', required: false, min: 0, max: 10 },
    ];
  }
  if (kind === 'text') {
    return [
      { key: 'prompt', label: '提示词', type: 'textarea', required: true, maxLength: 500000 },
      { key: 'max_tokens', label: '最大长度', type: 'number', min: 1, max: 32768, default: 2048 },
    ];
  }
  return [
    { key: 'prompt', label: '提示词', type: 'textarea', required: true, max: 500000 },
    { key: 'duration', label: '视频时长', type: 'number', min: 1, max: 15, default: 5 },
    { key: 'resolution', label: '分辨率', type: 'select', options: ['480p竖', '768p竖', '480p横', '768p横', '480p(1:1)', '768p(1:1)'], default: '768p竖' },
    { key: 'seed', label: 'seed', type: 'number', min: 1, max: 999999999999999 },
    { key: 'reference_images', label: '参考图片', type: 'images', required: true, min: 1, max: 10 },
  ];
}

function openSettings() {
  showView('settings');
  renderModelPage();
}

function renderModelPage() {
  renderModelStats();
  renderModelProviderOptions();
  renderModelTypeOptions();
  renderModelTokenOptions();
  renderModelTable();
}

function renderModelStats() {
  const models = state.models.map(normalizeModel);
  $('#statAllModels').textContent = String(models.length);
  $('#statImageModels').textContent = String(models.filter((m) => m.kind === 'image').length);
  $('#statVideoModels').textContent = String(models.filter((m) => m.kind === 'video').length);
  $('#statDisabledModels').textContent = String(models.filter((m) => m.enabled === false).length);
}

function renderModelProviderOptions() {
  const select = $('#modelFilterProvider');
  if (!select) return;
  const current = select.value;
  const providers = [...new Set(state.models.map((model) => modelProviderLabel(model)))].sort((a, b) => a.localeCompare(b, 'zh'));
  select.innerHTML = '<option value="">全部供应商</option>' + providers.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  if (providers.includes(current)) select.value = current;
}

// 类型筛选与类型候选（候选取已用类型 + 预设标签，输入框可自由填写）
function renderModelTypeOptions() {
  const labelSet = new Set();
  let hasUntagged = false;
  // 用规范化后的模型读取标签，兼容只存了旧 type 字段的历史数据
  state.models.map(normalizeModel).forEach((model) => {
    const labels = (Array.isArray(model.tags) ? model.tags : []).map((tag) => modelTagMeta(tag).label).filter(Boolean);
    if (labels.length) labels.forEach((label) => labelSet.add(label));
    else hasUntagged = true;
  });
  const labels = [...labelSet].sort((a, b) => a.localeCompare(b, 'zh'));
  const select = $('#modelFilterKind');
  if (select) {
    const current = select.value;
    select.innerHTML = '<option value="">全部类型</option>'
      + labels.map((label) => `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`).join('')
      + (hasUntagged ? `<option value="unknown">${UNKNOWN_TYPE}</option>` : '');
    if (labels.includes(current) || current === 'unknown') select.value = current;
  }
  const datalist = $('#modelTypeList');
  if (datalist) {
    const names = [...new Set([...labels, ...MODEL_TYPE_OPTIONS.map((option) => option.label)])];
    datalist.innerHTML = names.map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');
  }
}

function renderModelTokenOptions() {
  const select = $('#modelFilterToken');
  if (!select) return;
  const current = select.value;
  const usedIds = [...new Set(state.models.map((model) => model.token_id).filter(Boolean))];
  const options = usedIds
    .map((id) => ({ value: id, label: tokenById(id)?.name || '未绑定' }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh'));
  const hasUnbound = state.models.some((model) => !tokenById(model.token_id));
  select.innerHTML = '<option value="">全部调用配置</option>'
    + options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('')
    + (hasUnbound ? '<option value="none">未绑定</option>' : '');
  if (current === 'none' || options.some((option) => option.value === current)) select.value = current;
}

function modelListFiltered() {
  const keyword = modelUI.search.trim().toLowerCase();
  let list = state.models.map(normalizeModel);
  if (keyword) list = list.filter((m) => [m.name, m.id, m.workflow, modelProviderLabel(m), (m.tags || []).join(' ')].join(' ').toLowerCase().includes(keyword));
  if (modelUI.kind) {
    const tagsOf = (m) => (Array.isArray(m.tags) ? m.tags : []).map((tag) => modelTagMeta(tag).label);
    if (modelUI.kind === 'unknown') list = list.filter((m) => tagsOf(m).length === 0);
    else list = list.filter((m) => tagsOf(m).includes(modelUI.kind));
  }
  if (modelUI.provider) list = list.filter((m) => modelProviderLabel(m) === modelUI.provider);
  if (modelUI.token === 'none') list = list.filter((m) => !tokenById(m.token_id));
  else if (modelUI.token) list = list.filter((m) => m.token_id === modelUI.token);
  if (modelUI.status) list = list.filter((m) => modelStatusOf(m) === modelUI.status);
  if (modelUI.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  else if (modelUI.sort === 'created') list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  else if (modelUI.sort === 'updated') list.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  else list.sort((a, b) => (a.sort || 0) - (b.sort || 0));
  return list;
}

// 供应商候选纯动态且相互独立：模型候选取模型的供应商，令牌候选取令牌的供应商（官方/中转站）
function renderProviderOptions() {
  const modelDatalist = $('#providerList');
  if (modelDatalist) {
    modelDatalist.innerHTML = [...new Set(state.models.map((model) => model.provider).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'zh'))
      .map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');
  }
  const tokenDatalist = $('#providerOptions');
  if (tokenDatalist) {
    tokenDatalist.innerHTML = [...new Set(state.tokens.map((token) => token.provider).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'zh'))
      .map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');
  }
}

function renderModelTable() {
  renderProviderOptions();
  const tbody = $('#modelTableBody');
  if (!tbody) return;
  const list = modelListFiltered();
  const pages = Math.max(1, Math.ceil(list.length / modelUI.pageSize));
  if (modelUI.page > pages) modelUI.page = pages;
  const start = (modelUI.page - 1) * modelUI.pageSize;
  const rows = list.slice(start, start + modelUI.pageSize);

  tbody.innerHTML = '';
  rows.forEach((model) => {
    const status = modelStatusOf(model);
    const statusMeta = MODEL_STATUS_META[status];
    const tags = modelTags(model);
    const provider = modelProvider(model);
    const providerLabel = modelProviderLabel(model);
    const tr = document.createElement('tr');
    tr.dataset.modelId = model.id;
    tr.draggable = modelUI.sort === 'manual';
    tr.className = `${modelUI.selected.has(model.id) ? 'selected' : ''} ${status === 'disabled' ? 'model-disabled' : ''}`;
    tr.innerHTML = `
      <td class="drag-col"><span class="drag-handle" title="拖拽排序" aria-hidden="true">⋮⋮</span></td>
      <td class="check-col"><input type="checkbox" data-model-check="${escapeHtml(model.id)}" ${modelUI.selected.has(model.id) ? 'checked' : ''} aria-label="选择模型" /></td>
      <td class="model-info-cell">
        <div class="model-info"><span class="model-avatar" data-provider="${escapeHtml(provider)}">${escapeHtml(provider ? provider.charAt(0).toUpperCase() : '?')}</span><div class="model-info-copy"><b title="${escapeHtml(model.name)}">${escapeHtml(model.name)}</b><small title="${escapeHtml(model.id)}">${escapeHtml(model.id.length > 34 ? model.id.slice(0, 34) + '…' : model.id)}</small></div></div>
      </td>
      <td><div class="tag-list">${tags.map((tag) => `<span class="model-tag ${tag.cls}">${escapeHtml(tag.label)}</span>`).join('')}</div></td>
      <td class="col-provider">${escapeHtml(providerLabel)}</td>
      <td><span class="model-status ${statusMeta.cls}"><i></i>${statusMeta.label}</span></td>
      <td class="col-token" title="${escapeHtml(tokenById(model.token_id)?.masked || '未绑定令牌')}">${escapeHtml(tokenNameFor(model))}</td>
      <td class="col-actions">
        <div class="model-row-actions">
          <button type="button" class="model-action-button primary" data-model-edit="${escapeHtml(model.id)}">编辑</button>
          <button type="button" class="model-action-button more" data-model-more="${escapeHtml(model.id)}" aria-label="更多操作">···</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  });

  $('#modelTotal').textContent = String(list.length);
  renderModelPager(pages);
  renderModelBatchBar();
  bindModelRowEvents(tbody);
}

function renderModelPager(pages) {
  const wrap = $('#modelPager');
  wrap.innerHTML = '';
  if (pages <= 1) return;
  const addButton = (label, page, disabled, current) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (current) button.classList.add('current');
    if (disabled) button.disabled = true;
    else button.addEventListener('click', () => { modelUI.page = page; renderModelTable(); });
    wrap.appendChild(button);
  };
  addButton('‹', modelUI.page - 1, modelUI.page <= 1, false);
  for (let p = 1; p <= pages; p += 1) addButton(String(p), p, false, p === modelUI.page);
  addButton('›', modelUI.page + 1, modelUI.page >= pages, false);
}

function renderModelBatchBar() {
  const bar = $('#modelBatchBar');
  bar.hidden = modelUI.selected.size === 0;
  $('#modelSelectedCount').textContent = String(modelUI.selected.size);
  $('#modelSelectAll').checked = false;
}

function bindModelRowEvents(tbody) {
  tbody.querySelectorAll('[data-model-check]').forEach((input) => input.addEventListener('change', () => {
    if (input.checked) modelUI.selected.add(input.dataset.modelCheck);
    else modelUI.selected.delete(input.dataset.modelCheck);
    input.closest('tr').classList.toggle('selected', input.checked);
    renderModelBatchBar();
  }));
  tbody.querySelectorAll('[data-model-edit]').forEach((button) => button.addEventListener('click', () => openModelDrawer(button.dataset.modelEdit)));
  tbody.querySelectorAll('[data-model-more]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = button.nextElementSibling ? button.parentElement.querySelector('.model-more-menu') : null;
    if (!menu) return;
    menu.hidden = !menu.hidden;
  }));
  tbody.querySelectorAll('[data-model-duplicate]').forEach((button) => button.addEventListener('click', () => duplicateModel(button.dataset.modelDuplicate)));
  tbody.querySelectorAll('[data-model-toggle]').forEach((button) => button.addEventListener('click', () => toggleModelEnabled(button.dataset.modelToggle)));
  tbody.querySelectorAll('[data-model-delete]').forEach((button) => button.addEventListener('click', () => deleteModelConfirm(button.dataset.modelDelete)));
  // 每行的更多菜单
  tbody.querySelectorAll('tr[data-model-id]').forEach((row) => {
    const id = row.dataset.modelId;
    const moreButton = row.querySelector('[data-model-more]');
    if (!moreButton || row.querySelector('.model-more-menu')) return;
    const menu = document.createElement('div');
    menu.className = 'model-more-menu';
    menu.hidden = true;
    menu.innerHTML = `<button type="button" data-model-duplicate="${escapeHtml(id)}">复制模型</button><button type="button" data-model-toggle="${escapeHtml(id)}">${row.classList.contains('model-disabled') || normalizeModel(state.models.find((m) => m.id === id)).enabled === false ? '启用模型' : '停用模型'}</button><button type="button" class="danger" data-model-delete="${escapeHtml(id)}">删除模型</button>`;
    moreButton.after(menu);
  });
  // 拖拽排序（手动排序时启用）
  let draggingId = null;
  tbody.addEventListener('dragstart', (event) => {
    const row = event.target.closest('tr[data-model-id]');
    if (!row || modelUI.sort !== 'manual') return;
    draggingId = row.dataset.modelId;
    event.dataTransfer.effectAllowed = 'move';
  });
  tbody.addEventListener('dragover', (event) => {
    if (!draggingId) return;
    event.preventDefault();
    const row = event.target.closest('tr[data-model-id]');
    if (!row || row.dataset.modelId === draggingId) return;
    const draggingRow = tbody.querySelector(`tr[data-model-id="${draggingId}"]`);
    if (draggingRow) tbody.insertBefore(draggingRow, row);
  });
  tbody.addEventListener('drop', (event) => { event.preventDefault(); saveModelOrder(tbody); });
  tbody.addEventListener('dragend', () => { if (draggingId) saveModelOrder(tbody); draggingId = null; });
}

async function saveModelOrder(tbody) {
  const ids = [...tbody.querySelectorAll('tr[data-model-id]')].map((row) => row.dataset.modelId);
  try {
    const res = await fetch(`${settings.apiBase}/api/models/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    const ordered = [];
    ids.forEach((id) => {
      const model = state.models.find((m) => m.id === id);
      if (model) { model.sort = ordered.length; ordered.push(model); }
    });
    const rest = state.models.filter((m) => !ids.includes(m.id));
    state.models = [...ordered, ...rest];
    renderModelTable();
  } catch (err) { console.warn('保存排序失败', err); }
}

async function duplicateModel(id) {
  const source = state.models.find((m) => m.id === id);
  if (!source) return;
  const copy = normalizeModel(source);
  copy.id = `${source.id}-copy-${Date.now().toString(36).slice(-4)}`;
  copy.name = `${source.name} 副本`;
  copy.enabled = false;
  copy.created_at = new Date().toISOString();
  copy.updated_at = copy.created_at;
  try {
    const res = await fetch(`${settings.apiBase}/api/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: copy, mode: 'create' }) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    state.models.push(normalizeModel(data.model));
    renderModelPage();
  } catch (err) { alert(`复制模型失败：${err.message}`); }
}

async function toggleModelEnabled(id) {
  const model = state.models.find((m) => m.id === id);
  if (!model) return;
  const next = normalizeModel({ ...model, enabled: model.enabled === false });
  try {
    const res = await fetch(`${settings.apiBase}/api/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: next }) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    const index = state.models.findIndex((m) => m.id === id);
    if (index >= 0) state.models[index] = normalizeModel(data.model);
    renderModelPage();
    await initializeModels();
  } catch (err) { alert(`操作失败：${err.message}`); }
}

async function deleteModelConfirm(id) {
  const model = state.models.find((m) => m.id === id);
  if (!model) return;
  if (!window.confirm(`确定删除模型「${model.name}」吗？此操作不可恢复。`)) return;
  await deleteModelById(id);
}

async function deleteModelById(id) {
  const res = await fetch(`${settings.apiBase}/api/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await res.json();
  if (!data.ok) return alert(`删除失败：${data.msg}`);
  state.models = state.models.filter((m) => m.id !== id);
  modelUI.selected.delete(id);
  if (modelUI.editingId === id) closeModelDrawer();
  renderModelPage();
  await initializeModels();
}

async function batchUpdateEnabled(enabled) {
  const ids = [...modelUI.selected];
  for (const id of ids) {
    const model = state.models.find((m) => m.id === id);
    if (!model) continue;
    const next = normalizeModel({ ...model, enabled });
    try {
      const res = await fetch(`${settings.apiBase}/api/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: next }) });
      const data = await res.json();
      if (data.ok) {
        const index = state.models.findIndex((m) => m.id === id);
        if (index >= 0) state.models[index] = normalizeModel(data.model);
      }
    } catch (_) { /* 单个失败继续 */ }
  }
  modelUI.selected.clear();
  renderModelPage();
  await initializeModels();
}

async function batchDeleteSelected() {
  const ids = [...modelUI.selected];
  if (!ids.length) return;
  if (!window.confirm(`确定删除选中的 ${ids.length} 个模型吗？此操作不可恢复。`)) return;
  for (const id of ids) {
    try { await fetch(`${settings.apiBase}/api/models/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (_) { /* 继续 */ }
  }
  state.models = state.models.filter((m) => !ids.includes(m.id));
  modelUI.selected.clear();
  renderModelPage();
  await initializeModels();
}

// ---- 抽屉编辑器 ----
// preset：由「AI 自动配置」生成的模型草稿，复用同一条编辑器与保存路径
function openModelDrawer(id, preset) {
  const banner = $('#aiDraftBanner');
  if (banner) banner.hidden = true;
  const source = id ? state.models.find((m) => m.id === id) : null;
  const draft = normalizeModel(source || preset || {
    kind: modelUI.kind === 'image' || modelUI.kind === 'text' ? modelUI.kind : 'video',
    fields: defaultFieldsFor(modelUI.kind === 'image' || modelUI.kind === 'text' ? modelUI.kind : 'video'),
    pricing: { unit: 'per_second', peak: 0.04, valley: 0.03, valley_start: '00:00', valley_end: '08:00' },
  });
  if (!source) {
    const presetFields = preset && Array.isArray(preset.fields) ? preset.fields : null;
    draft.fields = presetFields && presetFields.length ? presetFields : defaultFieldsFor(draft.kind);
    draft.pricing = preset ? (preset.pricing || null) : draft.pricing;
  }
  modelUI.editingId = id || null;
  modelUI.drawerFields = JSON.parse(JSON.stringify(draft.fields || []));
  modelUI.drawerPricing = draft.pricing ? JSON.parse(JSON.stringify(draft.pricing)) : null;
  modelUI.loadedFieldsSnapshot = JSON.stringify(draft.fields || []);
  modelUI.dirty = false;
  modelUI.fieldsMode = 'visual';
  populateDrawer(draft);
  // AI 草稿的模型 ID 允许改，方便自己调整
  if (!source && preset) $('#modelId').readOnly = false;
  setDrawerTab('basic');
  setFieldsMode('visual');
  $('#modelEditorBackdrop').hidden = false;
  updateDrawerSavedAt();
}

function populateDrawer(model) {
  $('#drawerModelName').textContent = model.name || '—';
  const status = modelStatusOf(model);
  const statusEl = $('#drawerStatus');
  statusEl.className = `state ${status === 'enabled' ? 'enabled' : status === 'disabled' ? 'disabled' : 'failed'}`;
  statusEl.innerHTML = `<i></i>${MODEL_STATUS_META[status].label}`;
  $('#modelName').value = model.name;
  $('#modelId').value = model.id;
  $('#modelId').readOnly = Boolean(model.id);
  $('#modelWorkflow').value = model.workflow;
  $('#modelKind').value = model.kind;
  $('#modelProvider').value = String(model.provider || '').trim();
  modelUI.drawerTags = (Array.isArray(model.tags) ? model.tags : []).map((tag) => String(tag || '').trim()).filter(Boolean);
  renderModelTagChips();
  $('#modelDescription').value = model.description || '';
  $('#modelVisible').checked = model.visible !== false;
  $('#requestUrl').value = model.request_url;
  $('#queryUrl').value = model.query_url;
  $('#queryUrlField').hidden = model.kind !== 'video';
  $('#editUrlField').hidden = model.kind !== 'image';
  $('#modelEditUrl').value = model.edit_url || '';
  renderModelTokenOptionsForDrawer(model.token_id);
  $('#modelTimeout').value = String(model.timeout_seconds);
  $('#modelPollInterval').value = String(model.poll_interval);
  $('#modelConcurrency').value = String(model.max_concurrency);
  $('#advEnabled').checked = model.enabled !== false;
  $('#advVisible').checked = model.visible !== false;
  $('#advMaxRetry').value = String(model.max_retry || 0);
  $('#advDebug').checked = model.debug === true;
  renderFieldBuilder();
  renderPricingPane(model.pricing);
}

function renderModelTokenOptionsForDrawer(selectedId) {
  const select = $('#modelToken');
  select.innerHTML = '<option value="">请选择令牌</option>' + state.tokens.map((token) => `<option value="${escapeHtml(token.id)}">${escapeHtml(token.name)} · ${escapeHtml(token.masked)}</option>`).join('');
  select.value = selectedId || '';
}

function setDrawerTab(tab) {
  $$('.drawer-tabs [data-model-tab]').forEach((button) => button.classList.toggle('active', button.dataset.modelTab === tab));
  $$('.model-drawer-body .drawer-pane').forEach((pane) => { pane.hidden = pane.dataset.modelPane !== tab; });
}

function requestCloseModelDrawer() {
  if (modelUI.dirty && !window.confirm('有未保存的修改，确定关闭吗？')) return;
  closeModelDrawer();
}
function closeModelDrawer() {
  $('#modelEditorBackdrop').hidden = true;
  modelUI.editingId = null;
  modelUI.dirty = false;
}

function updateDrawerSavedAt() {
  const model = modelUI.editingId ? state.models.find((m) => m.id === modelUI.editingId) : null;
  const stamp = model && model.updated_at ? relativeTime(model.updated_at) : (modelUI.savedAt ? '刚刚' : '—');
  $('#drawerSavedAt').textContent = `上次保存：${stamp}`;
}

// ---- 表单字段构建器 ----
function fieldTypeLabel(type) {
  return (FIELD_TYPE_META[type] || {}).label || type || '—';
}

function renderFieldBuilder() {
  const wrap = $('#fieldBuilder');
  if (!wrap) return;
  wrap.innerHTML = '';
  modelUI.drawerFields.forEach((field, index) => {
    const card = document.createElement('div');
    card.className = 'field-card';
    card.draggable = true;
    card.dataset.index = String(index);
    const summary = [];
    summary.push(`key：${field.key || '—'}`);
    summary.push(`类型：${fieldTypeLabel(field.type)}`);
    if (field.required) summary.push('必填');
    if (field.default != null && field.default !== '') summary.push(`默认：${field.default}`);
    card.innerHTML = `
      <div class="field-card-head">
        <span class="field-handle" title="拖拽排序">☰</span>
        <div class="field-card-copy"><b>${escapeHtml(field.label || field.key || '字段')}</b><small>${escapeHtml(summary.join(' · '))}</small></div>
        <div class="field-card-actions">
          <button type="button" data-field-edit="${index}">编辑</button>
          <button type="button" data-field-copy="${index}">复制</button>
          <button type="button" data-field-del="${index}">删除</button>
        </div>
      </div>
      <div class="field-card-form" hidden></div>`;
    wrap.appendChild(card);
  });
  bindFieldBuilderEvents(wrap);
}

function fieldFormHtml(field) {
  const type = field.type || 'text';
  const meta = FIELD_TYPE_META[type] || FIELD_TYPE_META.text;
  const has = (key) => meta.params.includes(key);
  return `
    <div class="drawer-grid">
      <label class="field"><span>key <i class="req">*</i></span><input data-f="key" type="text" value="${escapeHtml(field.key || '')}" /></label>
      <label class="field"><span>显示名称</span><input data-f="label" type="text" value="${escapeHtml(field.label || '')}" /></label>
      <label class="field"><span>类型</span><select data-f="type">${FIELD_TYPE_OPTIONS.map((option) => `<option value="${option.value}" ${option.value === type ? 'selected' : ''}>${option.label}</option>`).join('')}</select></label>
      <label class="field switch-line"><span>必填</span><label class="switch"><input data-f="required" type="checkbox" ${field.required ? 'checked' : ''} /><span></span></label></label>
      ${has('default') ? `<label class="field"><span>默认值</span><input data-f="default" type="text" value="${escapeHtml(field.default != null ? String(field.default) : '')}" /></label>` : ''}
      ${has('placeholder') ? `<label class="field"><span>占位提示</span><input data-f="placeholder" type="text" value="${escapeHtml(field.placeholder || '')}" /></label>` : ''}
      ${has('min') ? `<label class="field"><span>最小值</span><input data-f="min" type="number" value="${escapeHtml(field.min != null ? String(field.min) : '')}" /></label>` : ''}
      ${has('max') ? `<label class="field"><span>最大值</span><input data-f="max" type="number" value="${escapeHtml(field.max != null ? String(field.max) : '')}" /></label>` : ''}
      ${has('step') ? `<label class="field"><span>步长</span><input data-f="step" type="number" value="${escapeHtml(field.step != null ? String(field.step) : '')}" /></label>` : ''}
      ${has('maxLength') ? `<label class="field"><span>最大长度</span><input data-f="maxLength" type="number" value="${escapeHtml(field.maxLength != null ? String(field.maxLength) : '')}" /></label>` : ''}
      ${has('options') ? `<label class="field field-wide"><span>选项（每行一个）</span><textarea data-f="options" rows="3">${escapeHtml((field.options || []).join('\n'))}</textarea></label>` : ''}
      ${has('accept') ? `<label class="field"><span>允许的图片类型</span><input data-f="accept" type="text" value="${escapeHtml(field.accept || 'image/jpeg,image/png,image/webp')}" /></label>` : ''}
      ${has('multiple') ? `<label class="field switch-line"><span>允许多选</span><label class="switch"><input data-f="multiple" type="checkbox" ${field.multiple ? 'checked' : ''} /><span></span></label></label>` : ''}
      ${has('maxFiles') ? `<label class="field"><span>最大文件数</span><input data-f="maxFiles" type="number" min="1" value="${escapeHtml(field.maxFiles != null ? String(field.maxFiles) : '10')}" /></label>` : ''}
    </div>
    <div class="field-card-edit-actions"><button type="button" class="primary-button" data-field-save>保存字段</button><button type="button" class="outline-button" data-field-cancel>取消</button></div>`;
}

function collectFieldForm(form) {
  const value = (selector) => { const el = form.querySelector(selector); return el ? el.value : undefined; };
  const checked = (selector) => { const el = form.querySelector(selector); return el ? el.checked : false; };
  const field = { key: value('[data-f="key"]').trim(), label: value('[data-f="label"]').trim(), type: value('[data-f="type"]') || 'text' };
  if (!field.key) throw new Error('字段 key 不能为空');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.key)) throw new Error('字段 key 只能包含字母、数字与下划线，且以字母开头');
  field.required = checked('[data-f="required"]');
  const assignNumber = (key) => { const text = value(`[data-f="${key}"]`); if (text != null && text.trim() !== '') { const num = Number(text); if (!Number.isFinite(num)) throw new Error(`${key} 必须是数字`); field[key] = num; } };
  ['min', 'max', 'step', 'maxLength', 'maxFiles'].forEach(assignNumber);
  ['default', 'placeholder', 'accept'].forEach((key) => { const text = value(`[data-f="${key}"]`); if (text != null && text.trim() !== '') field[key] = text; });
  if (FIELD_TYPE_META[field.type].params.includes('options')) {
    const options = value('[data-f="options"]').split('\n').map((line) => line.trim()).filter(Boolean);
    if (options.length) field.options = options;
  }
  if (checked('[data-f="multiple"]')) field.multiple = true;
  return field;
}

function bindFieldBuilderEvents(wrap) {
  wrap.querySelectorAll('.field-card').forEach((card) => {
    const index = Number(card.dataset.index);
    const editButton = card.querySelector('[data-field-edit]');
    const form = card.querySelector('.field-card-form');
    editButton.addEventListener('click', () => {
      form.hidden = !form.hidden;
      if (!form.hidden && !form.dataset.filled) {
        form.dataset.filled = '1';
        form.innerHTML = fieldFormHtml(modelUI.drawerFields[index] || {});
        form.querySelector('[data-f="key"]').focus();
        form.querySelector('[data-field-save]').addEventListener('click', () => {
          try {
            modelUI.drawerFields[index] = collectFieldForm(form);
            markDrawerDirty();
            renderFieldBuilder();
          } catch (err) { alert(err.message); }
        });
        form.querySelector('[data-field-cancel]').addEventListener('click', () => { form.hidden = true; });
      }
    });
    card.querySelector('[data-field-copy]').addEventListener('click', () => {
      const copy = JSON.parse(JSON.stringify(modelUI.drawerFields[index] || {}));
      copy.key = `${copy.key || 'field'}_copy`;
      modelUI.drawerFields.splice(index + 1, 0, copy);
      markDrawerDirty();
      renderFieldBuilder();
    });
    card.querySelector('[data-field-del]').addEventListener('click', () => {
      modelUI.drawerFields.splice(index, 1);
      markDrawerDirty();
      renderFieldBuilder();
    });
    card.addEventListener('dragstart', (event) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', (event) => {
      event.preventDefault();
      const dragging = wrap.querySelector('.field-card.dragging');
      if (!dragging || dragging === card) return;
      const rect = card.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      wrap.insertBefore(dragging, before ? card : card.nextSibling);
    });
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      const order = [...wrap.querySelectorAll('.field-card')].map((node) => Number(node.dataset.index));
      modelUI.drawerFields = order.map((i) => modelUI.drawerFields[i]).filter(Boolean);
      markDrawerDirty();
      renderFieldBuilder();
    });
  });
}

function setFieldsMode(mode) {
  modelUI.fieldsMode = mode;
  const visual = mode === 'visual';
  $('#fieldBuilder').hidden = !visual;
  $('#addField').hidden = !visual;
  $('#fieldJsonWrap').hidden = visual;
  $('#toggleFieldsJson').innerHTML = visual ? '&lt;&gt; JSON 模式' : '☰ 可视化模式';
  if (!visual) {
    $('#modelFields').value = JSON.stringify(modelUI.drawerFields, null, 2);
    $('#fieldsJsonError').hidden = true;
  } else {
    try {
      modelUI.drawerFields = JSON.parse($('#modelFields').value);
      renderFieldBuilder();
    } catch (_) { /* JSON 无效时保留原字段 */ }
  }
}

// ---- 价格配置面板 ----
function renderPricingPane(pricing) {
  const p = pricing || {};
  $('#pricingUnit').value = p.unit || 'per_second';
  $('#priceTierEnabled').checked = p.valley != null;
  $('#pricePeak').value = p.peak != null ? String(p.peak) : '';
  $('#priceValley').value = p.valley != null ? String(p.valley) : '';
  $('#priceValleyStart').value = p.valley_start || '00:00';
  $('#priceValleyEnd').value = p.valley_end || '08:00';
  $('#priceResEnabled').checked = p.by_resolution != null && Object.keys(p.by_resolution).length > 0;
  syncPricingPaneVisibility();
  renderPriceResRows(p.by_resolution || {});
  renderPricingPreview();
}

function syncPricingPaneVisibility() {
  const unit = $('#pricingUnit').value;
  const tierOn = $('#priceTierEnabled').checked;
  const perUnit = unit === 'per_image' ? '张' : unit === 'per_call' ? '次' : unit === 'per_token' ? '1K Token' : unit === 'fixed' ? '次' : '秒';
  $('#priceUnitPeak').textContent = `¥ / ${perUnit}`;
  $('#priceUnitValley').textContent = `¥ / ${perUnit}`;
  $$('#peakValleyFields .field').forEach((field, index) => { if (index === 1 || index === 2 || index === 3) field.hidden = !tierOn; });
  const resOn = $('#priceResEnabled').checked;
  $('#priceResWrap').hidden = !resOn;
  $$('#priceResRows [data-res-valley]').forEach((input) => { input.hidden = !tierOn; });
}

function renderPriceResRows(byResolution) {
  const wrap = $('#priceResRows');
  wrap.innerHTML = '';
  const options = drawerResolutionOptions();
  Object.entries(byResolution).forEach(([resolution, value]) => addPriceResRow(resolution, value, options));
  if (!wrap.children.length) addPriceResRow('', { peak: '', valley: '' }, options);
}

function drawerResolutionOptions() {
  try {
    const fields = modelUI.drawerFields || [];
    const field = fields.find((item) => item && item.key === 'resolution' && Array.isArray(item.options));
    return field ? field.options.filter((option) => typeof option === 'string') : [];
  } catch (_) { return []; }
}

function addPriceResRow(resolution, value, options) {
  const entry = value && typeof value === 'object' ? value : { peak: value != null ? value : '', valley: '' };
  const wrap = $('#priceResRows');
  const row = document.createElement('div');
  row.className = 'price-res-row';
  row.innerHTML = `
    <input class="price-res-name" list="priceResOptions" type="text" placeholder="分辨率，如 480p竖" value="${escapeHtml(resolution)}" />
    <input type="number" min="0" step="0.001" placeholder="峰价" data-res-peak value="${escapeHtml(entry.peak != null ? String(entry.peak) : '')}" />
    <input type="number" min="0" step="0.001" placeholder="谷价" data-res-valley value="${escapeHtml(entry.valley != null ? String(entry.valley) : '')}" />
    <button type="button" class="price-res-del" title="删除">×</button>`;
  row.querySelector('.price-res-del').addEventListener('click', () => row.remove());
  wrap.appendChild(row);
}

function collectDrawerPricing() {
  const unit = $('#pricingUnit').value;
  const tierOn = $('#priceTierEnabled').checked;
  const resOn = $('#priceResEnabled').checked;
  const toPrice = (text) => {
    if (text === '' || text == null) return null;
    const num = Number(text);
    if (!Number.isFinite(num) || num < 0) throw new Error('价格必须是 ≥ 0 的数字');
    return Math.round(num * 1000) / 1000;
  };
  const pricing = { unit };
  const peak = toPrice($('#pricePeak').value.trim());
  if (peak != null) pricing.peak = peak;
  if (tierOn) {
    const valley = toPrice($('#priceValley').value.trim());
    if (valley != null) {
      pricing.valley = valley;
      pricing.valley_start = $('#priceValleyStart').value || '00:00';
      pricing.valley_end = $('#priceValleyEnd').value || '08:00';
    }
  }
  if (resOn) {
    const byResolution = {};
    $$('#priceResRows .price-res-row').forEach((row) => {
      const resolution = row.querySelector('.price-res-name').value.trim();
      if (!resolution) return;
      const peak = toPrice(row.querySelector('[data-res-peak]').value.trim());
      const valley = tierOn ? toPrice(row.querySelector('[data-res-valley]').value.trim()) : null;
      if (peak == null) return;
      byResolution[resolution] = valley != null && valley !== peak ? { peak, valley } : peak;
    });
    if (Object.keys(byResolution).length) pricing.by_resolution = byResolution;
  }
  return Object.keys(pricing).length > 1 || pricing.peak != null ? pricing : undefined;
}

function renderPricingPreview() {
  const pricing = (() => {
    try { return collectDrawerPricing() || null; } catch (_) { return null; }
  })();
  const preview = (duration, resolution, when) => {
    if (!pricing) return '未配置价格';
    const rate = modelRateFor(pricing, resolution, when);
    if (rate == null) return '—';
    const unit = pricing.unit === 'per_image' ? '张' : pricing.unit === 'per_call' ? '次' : pricing.unit === 'per_token' ? 'Token' : '秒';
    const symbol = pricing.currency === 'USD' ? '$' : '¥';
    return `${symbol}${(rate * duration).toFixed(2)}`;
  };
  const options = drawerResolutionOptions();
  const res1 = options[0] || '';
  const res2 = options[1] || options[0] || '';
  $('#preview1Label').textContent = `5 秒 / ${res1 || '默认规格'} / 峰值时段`;
  $('#preview1Value').textContent = preview(pricing && pricing.unit === 'per_image' ? 1 : 5, res1, '2026-06-01T02:00:00Z');
  $('#preview2Label').textContent = `10 秒 / ${res2 || '默认规格'} / 谷值时段`;
  $('#preview2Value').textContent = preview(pricing && pricing.unit === 'per_image' ? 2 : 10, res2, '2026-06-01T17:00:00Z');
}

// ---- 保存 / 删除 / 关闭 ----
function collectDrawerModel() {
  const base = modelUI.editingId ? state.models.find((m) => m.id === modelUI.editingId) || {} : {};
  const model = {
    ...base,
    id: $('#modelId').value.trim(),
    name: $('#modelName').value.trim(),
    workflow: $('#modelWorkflow').value.trim(),
    kind: $('#modelKind').value,
    provider: $('#modelProvider').value.trim(),
    description: $('#modelDescription').value.trim(),
    visible: $('#modelVisible').checked,
    sort: Number(base.sort) || 0,
    tags: [...modelUI.drawerTags],
    request_url: $('#requestUrl').value.trim(),
    query_url: $('#modelKind').value === 'video' ? $('#queryUrl').value.trim() : '',
    token_id: $('#modelToken').value,
    timeout_seconds: Number($('#modelTimeout').value) || 300,
    poll_interval: Number($('#modelPollInterval').value) || 3,
    max_concurrency: Number($('#modelConcurrency').value) || 5,
    enabled: $('#advEnabled').checked,
    max_retry: Number($('#advMaxRetry').value) || 0,
    debug: $('#advDebug').checked,
    fields: modelUI.drawerFields,
    ...(modelUI.drawerPricing && Object.keys(modelUI.drawerPricing).length ? { pricing: modelUI.drawerPricing } : {}),
  };
  if (!model.name || !model.id) throw new Error('模型名称和模型 ID 为必填');
  if (!model.workflow) throw new Error('工作流 ID 为必填');
  if (!model.request_url) throw new Error('提交地址为必填');
  if (model.kind === 'video' && !model.query_url) throw new Error('视频模型的查询地址为必填');
  if (!model.token_id) throw new Error('请选择使用令牌');
  // 新增时不允许撞已有 ID：服务端也会拦，这里先给更直白的提示。
  // 修改已有模型（modelUI.editingId 有值）或启用/停用等更新不受影响。
  if (!modelUI.editingId && state.models.some((m) => m.id === model.id)) {
    throw new Error(`模型 ID「${model.id}」已经配置过了，不能重复配置；要修改它请在列表里打开该模型`);
  }
  return model;
}

async function saveSettings() {
  try {
    modelUI.drawerPricing = collectDrawerPricing();
    modelUI.drawerFields = [...modelUI.drawerFields];
    if (modelUI.fieldsMode === 'json') {
      modelUI.drawerFields = JSON.parse($('#modelFields').value);
    }
    const model = collectDrawerModel();
    // 明确告诉服务端这是新增还是修改：新增时服务端会拒绝撞已有 ID，避免静默覆盖旧配置
    const writeMode = modelUI.editingId ? 'update' : 'create';
    const res = await fetch(`${settings.apiBase}/api/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, mode: writeMode }) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    const saved = normalizeModel(data.model);
    const index = state.models.findIndex((m) => m.id === saved.id);
    if (index >= 0) state.models[index] = saved;
    else state.models.push(saved);
    modelUI.editingId = saved.id;
    modelUI.dirty = false;
    modelUI.savedAt = saved.updated_at;
    renderModelPage();
    await initializeModels();
    closeModelDrawer();
    showToast('保存成功', 'ok');
  } catch (err) {
    alert(`保存失败：${err.message}`);
  }
}

// ---------------- AI 自动配置 ----------------
// 给一个接口文档链接 → 抓取 + 解析 → 得到模型草稿 → 填进模型编辑器让用户核对。
// 解析固定用 DeepSeek：填一把 DeepSeek Key 即可；拿不到 Key 或调用失败时后端会退回内置规则兜底。

// 是否已经存过 DeepSeek 令牌：存过就不必每次再填 Key
function hasDeepSeekToken() {
  return state.tokens.some((token) => /deepseek/i.test(`${token.provider || ''} ${token.name || ''}`));
}

function syncAutoDsKey() {
  const requiredMark = $('#autoDsKeyReq');
  const hint = $('#autoDsKeyHint');
  const saved = hasDeepSeekToken();
  if (requiredMark) requiredMark.hidden = saved;
  if (hint) {
    hint.textContent = saved
      ? '已保存 DeepSeek 令牌，这里可以留空；填了就用这次填的'
      : '用于让 DeepSeek 读文档生成配置；会自动存成令牌，下次不用再填';
  }
}

// 把面板里填的 DeepSeek Key 存成令牌（同一个 Key 服务端会复用，不会重复）
async function ensureDeepSeekToken(key) {
  if (!key || hasDeepSeekToken()) return false;
  try {
    const res = await fetch(`${settings.apiBase}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'DeepSeek Key', value: key, provider: 'DeepSeek' }),
    });
    const data = await res.json();
    if (!data.ok) return false;
    await loadTokensCache();
    syncAutoDsKey();
    return true;
  } catch (_) {
    return false;
  }
}

function openAutoConfigPanel() {
  setAutoConfigStatus('');
  const dup = $('#autoConfigDuplicate');
  if (dup) { dup.hidden = true; dup.innerHTML = ''; }
  renderAutoNameHint();
  syncAutoDsKey();
  $('#autoConfigBackdrop').hidden = false;
  document.body.classList.add('modal-open');
  setTimeout(() => { const el = $('#autoDocUrl'); if (el) el.focus(); }, 60);
}

function closeAutoConfigPanel() {
  $('#autoConfigBackdrop').hidden = true;
  document.body.classList.remove('modal-open');
}

function setAutoConfigStatus(text, kind) {
  const el = $('#autoConfigStatus');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = kind === false ? 'var(--danger)' : kind === true ? 'var(--ok)' : '';
}

// 面板里填了 Key 就先落成令牌，随后自动绑定到新模型。
// 服务端对同一个 Key 会复用已有令牌，这里把 reused 带回去用于提示。
async function createTokenForAutoConfig(name, value, provider) {
  const res = await fetch(`${settings.apiBase}/api/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${name} Key`.slice(0, 40), value, provider: provider || '' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
  return { id: data.token.id, reused: data.reused === true };
}

// ---------------- 防重复配置 ----------------

function slugifyClient(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

// 按 ID 优先、其次按名称，找已经配置过的同一个模型
function findDuplicateModel(draft) {
  if (!draft) return null;
  const byId = state.models.find((m) => m.id === String(draft.id || ''));
  if (byId) return { model: normalizeModel(byId), by: 'id' };
  const name = String(draft.name || '').trim().toLowerCase();
  if (!name) return null;
  const byName = state.models.find((m) => String(m.name || '').trim().toLowerCase() === name);
  return byName ? { model: normalizeModel(byName), by: 'name' } : null;
}

function suggestNewModelId(baseId) {
  const base = String(baseId || 'model').replace(/-\d+$/, '') || 'model';
  let n = 2;
  while (state.models.some((m) => m.id === `${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// 输入模型名称时先给个提示，省得解析完才发现已经有了
function renderAutoNameHint() {
  const hint = $('#autoNameHint');
  const input = $('#autoModelName');
  if (!hint || !input) return;
  const raw = input.value.trim();
  const hit = raw
    ? (state.models.find((m) => m.id === slugifyClient(raw))
      || state.models.find((m) => String(m.name || '').trim().toLowerCase() === raw.toLowerCase()))
    : null;
  if (!hit) { hint.hidden = true; hint.textContent = ''; return; }
  hint.textContent = `已经配置过「${hit.name}」（ID ${hit.id}），解析后会提示，不会重复创建`;
  hint.hidden = false;
}

function renderAutoDuplicate(dup, draft) {
  const el = $('#autoConfigDuplicate');
  if (!el) return;
  const reason = dup.by === 'id'
    ? `模型 ID 相同：${dup.model.id}`
    : `模型名称相同：${dup.model.name}`;
  const suggestion = suggestNewModelId(draft.id || dup.model.id);
  el.innerHTML = '<b>⚠ 这个模型已经配置过了</b>'
    + `<p>${escapeHtml(reason)}。已存在的是「${escapeHtml(dup.model.name)}」（ID ${escapeHtml(dup.model.id)}）。`
    + '为避免覆盖已有配置，这里没有再新建。</p>'
    + '<div class="auto-dup-actions">'
    + `<button type="button" class="outline-button" id="autoDupEdit">打开已有模型</button>`
    + `<button type="button" class="outline-button" id="autoDupNewId">以新 ID「${escapeHtml(suggestion)}」新建</button>`
    + '</div>';
  el.hidden = false;
  const editButton = $('#autoDupEdit');
  if (editButton) {
    editButton.addEventListener('click', () => {
      closeAutoConfigPanel();
      openModelDrawer(dup.model.id);
      showToast('已打开该模型，可直接修改', 'ok');
    });
  }
  const newIdButton = $('#autoDupNewId');
  if (newIdButton) {
    newIdButton.addEventListener('click', () => {
      closeAutoConfigPanel();
      openModelDrawer(null, { ...draft, id: suggestion });
      renderAiDraftBanner({ source: 'rules', warnings: [`因为原 ID 已存在，这里改成了 ${suggestion}，请确认`] });
      showToast('已换成新 ID，请确认后保存', 'ok');
    });
  }
}

const AI_CONFIDENCE_LABEL = { high: '置信度高', medium: '置信度中', low: '置信度低' };

function renderAiDraftBanner(info) {
  const el = $('#aiDraftBanner');
  if (!el) return;
  const bits = [info.source === 'llm' ? '✨ AI 解析' : '⚙ 内置规则'];
  if (info.confidence && AI_CONFIDENCE_LABEL[info.confidence]) bits.push(AI_CONFIDENCE_LABEL[info.confidence]);
  if (info.chat) bits.push(`解析模型 ${info.chat.model}`);
  if (info.doc && info.doc.chars) bits.push(`文档 ${info.doc.chars} 字`);
  if (info.tokenReused) bits.push('复用了已有的同 Key 令牌');
  else if (info.tokenId) bits.push('已按你填的 Key 新建令牌并绑定');
  if (info.dsKeySaved) bits.push('已把 DeepSeek Key 存成令牌，下次不用再填');
  const lines = [];
  if (info.notes) lines.push(info.notes);
  (info.warnings || []).forEach((w) => lines.push(w));
  el.innerHTML = `<div class="ai-draft-head"><b>${escapeHtml(bits.join(' · '))}</b><button type="button" class="text-button" id="aiDraftDismiss">知道了</button></div>`
    + (lines.length ? `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : '');
  el.hidden = false;
  const dismiss = $('#aiDraftDismiss');
  if (dismiss) dismiss.addEventListener('click', () => { el.hidden = true; });
}

async function runAutoConfig() {
  const docUrl = $('#autoDocUrl').value.trim();
  const modelName = $('#autoModelName').value.trim();
  const modelKey = $('#autoApiKey').value.trim();
  const dsKey = $('#autoDsKey').value.trim();
  if (!docUrl) { setAutoConfigStatus('请填写接口文档链接', false); $('#autoDocUrl').focus(); return; }
  if (!modelName) { setAutoConfigStatus('请填写模型名称', false); $('#autoModelName').focus(); return; }
  // 解析固定走 DeepSeek：要么这次填 Key，要么之前已经存过 DeepSeek 令牌
  if (!dsKey && !hasDeepSeekToken()) {
    setAutoConfigStatus('请填写 DeepSeek API Key —— AI 解析需要它', false);
    $('#autoDsKey').focus();
    return;
  }

  const button = $('#runAutoConfig');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '解析中…';
  setAutoConfigStatus('正在抓取文档并交给 DeepSeek 解析，可能要十几秒…');
  try {
    const res = await fetch(`${settings.apiBase}/api/models/auto-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        doc_url: docUrl,
        model_name: modelName,
        api_key: modelKey,
        chat_key: dsKey,
        chat_model: $('#autoChatModel').value.trim(),
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);

    // 已经有这个模型了就不再走后面的流程，连令牌都不用建
    const duplicate = findDuplicateModel(data.draft);
    if (duplicate) {
      renderAutoDuplicate(duplicate, data.draft);
      setAutoConfigStatus(`已存在模型「${duplicate.model.name}」（ID ${duplicate.model.id}），没有重复配置`, true);
      return;
    }

    let tokenId = '';
    let tokenReused = false;
    if (modelKey) {
      setAutoConfigStatus('正在保存模型令牌…');
      const created = await createTokenForAutoConfig(modelName, modelKey, data.draft.provider);
      tokenId = created.id;
      tokenReused = created.reused;
      await loadTokensCache();
    }
    // 解析成功说明这把 DeepSeek Key 可用，顺手存成令牌，下次不用再填
    const dsKeySaved = data.source === 'llm' ? await ensureDeepSeekToken(dsKey) : false;

    closeAutoConfigPanel();
    openModelDrawer(null, { ...data.draft, token_id: tokenId });
    renderAiDraftBanner({ ...data, tokenId, tokenReused, dsKeySaved });
    showToast(data.source === 'llm' ? 'DeepSeek 已生成配置，请核对后保存' : '已按内置规则生成配置，请核对后保存', data.source === 'llm' ? 'ok' : 'error');
  } catch (err) {
    setAutoConfigStatus(`解析失败：${err.message}`, false);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function deleteModelFromDrawer() {
  if (!modelUI.editingId) return;
  const model = state.models.find((m) => m.id === modelUI.editingId);
  if (!model) return;
  if (!window.confirm(`确定删除模型「${model.name}」吗？此操作不可恢复。`)) return;
  await deleteModelById(modelUI.editingId);
}



function renderModelTagChips() {
  const wrap = $('#modelTagChips');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!modelUI.drawerTags.length) {
    const empty = document.createElement('span');
    empty.className = 'tag-empty';
    empty.textContent = '暂无标签（不添加则显示为未知类型）';
    wrap.appendChild(empty);
    return;
  }
  modelUI.drawerTags.forEach((tag, index) => {
    const meta = modelTagMeta(tag);
    const chip = document.createElement('span');
    chip.className = `model-tag ${meta.cls}`;
    chip.innerHTML = `${escapeHtml(meta.label)}<button type="button" class="tag-remove" data-tag-remove="${index}" aria-label="移除标签" title="移除">×</button>`;
    wrap.appendChild(chip);
  });
}

function addModelTag(value) {
  const text = String(value || '').trim().slice(0, 24);
  if (!text) return;
  if (modelUI.drawerTags.some((tag) => tag.toLowerCase() === text.toLowerCase())) return;
  if (modelUI.drawerTags.length >= 8) { alert('最多添加 8 个类型标签'); return; }
  modelUI.drawerTags.push(text);
  markDrawerDirty();
  renderModelTagChips();
}

function markDrawerDirty() {
  modelUI.dirty = true;
}

function showFieldsJsonError(message) {
  const el = $('#fieldsJsonError');
  if (!el) return;
  el.hidden = false;
  el.classList.add('json-error');
  el.textContent = message;
}

function addPriceResRowFromButton() {
  const existing = {};
  $$('#priceResRows .price-res-row').forEach((row) => {
    const name = row.querySelector('.price-res-name').value.trim();
    if (!name) return;
    existing[name] = { peak: row.querySelector('[data-res-peak]').value, valley: row.querySelector('[data-res-valley]').value };
  });
  addPriceResRow('', { peak: '', valley: '' }, drawerResolutionOptions());
}


const GEN_FIELD_LABELS = { duration: '时长', resolution: '分辨率', seed: '随机种子', size: '尺寸', n: '生成数量' };
function applySelectedModel() {
  const model = selectedModel();
  if (!model) return;
  state.selectedModelId = model.id;
  renderGenFields('video', model);
  renderCurrentPrice();
}
function renderGenFields(kind, model) {
  const wrap = $(kind === 'image' ? '#imageExtraFields' : '#videoExtraFields');
  if (!wrap) return;
  wrap.innerHTML = '';
  const fields = Array.isArray(model.fields) ? model.fields : [];
  fields.forEach((field) => {
    if (!field || !field.key) return;
    if (field.key === 'prompt' || field.key === 'reference_images') return;
    wrap.appendChild(buildGenField(kind, model, field));
  });
  const dropzone = $(kind === 'image' ? '#imageRefDropzone' : '#refDropzone');
  if (dropzone) {
    const section = dropzone.closest('.gen-section');
    if (section) section.hidden = !fields.some((field) => field && field.key === 'reference_images');
  }
}
function buildGenField(kind, model, field) {
  const block = document.createElement('div');
  block.className = 'gen-field';
  const head = document.createElement('div');
  head.className = 'gen-field-head';
  head.innerHTML = `<b>${escapeHtml(GEN_FIELD_LABELS[field.key] || field.label || field.key)}</b>${field.required ? '<i class="req">*</i>' : '<small>可选</small>'}`;
  block.appendChild(head);
  const body = document.createElement('div');
  body.className = 'gen-field-body';
  const type = field.type || 'text';
  if (field.key === 'resolution' && type === 'select' && (field.options || []).every((option) => parseResolutionOption(option))) {
    body.appendChild(buildResolutionSegments(kind, field));
    const hint = document.createElement('small');
    hint.className = 'field-help';
    hint.textContent = '选择清晰度与画幅组合';
    body.appendChild(hint);
  } else if (type === 'number') {
    body.appendChild(buildStepper(kind, field));
    const hint = document.createElement('small');
    hint.className = 'field-help';
    hint.textContent = `值范围：${field.min != null ? field.min : 1} - ${field.max != null ? field.max : '∞'}`;
    body.appendChild(hint);
  } else if (type === 'select' && (field.options || []).length && (field.options || []).length <= 6) {
    body.appendChild(buildOptionButtons(kind, field));
  } else if (type === 'select') {
    const select = document.createElement('select');
    select.className = 'gen-select';
    select.innerHTML = '<option value="">请选择</option>' + (field.options || []).map((option) => `<option value="${escapeHtml(option)}" ${genValues[kind].values[field.key] === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('');
    select.addEventListener('change', () => { setGenFieldValue(kind, field.key, select.value); });
    body.appendChild(select);
  } else if (type === 'textarea') {
    const textarea = document.createElement('textarea');
    textarea.rows = 3;
    textarea.className = 'gen-input';
    if (field.maxLength) textarea.maxLength = field.maxLength;
    textarea.value = genValues[kind].values[field.key] || '';
    textarea.addEventListener('input', () => setGenFieldValue(kind, field.key, textarea.value));
    body.appendChild(textarea);
  } else {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'gen-input';
    if (field.placeholder) input.placeholder = field.placeholder;
    input.value = genValues[kind].values[field.key] || '';
    input.addEventListener('input', () => setGenFieldValue(kind, field.key, input.value));
    body.appendChild(input);
  }
  // 分辨率的分段控件较宽，让它独占一整行（时长 / seed 之类两列并排）
  if (body.querySelector('.seg-stack')) block.classList.add('gen-field-wide');
  block.appendChild(body);
  return block;
}
function buildResolutionSegments(kind, field) {
  const wrap = document.createElement('div');
  wrap.className = 'seg-stack';
  const parsed = (field.options || []).map(parseResolutionOption).filter(Boolean);
  const clarities = [...new Set(parsed.map((p) => p.clarity))];
  const shapes = [...new Set(parsed.map((p) => p.shape))];
  const current = genValues[kind].values.resolution || field.default || '';
  const cur = parseResolutionOption(current) || {};
  let selClarity = cur.clarity || clarities[0];
  let selShape = cur.shape || shapes[0];
  const sync = () => {
    const option = pickResolution(parsed, selClarity, selShape);
    setGenFieldValue(kind, 'resolution', option || '');
    wrap.querySelectorAll('.seg-btn').forEach((btn) => {
      const active = btn.dataset.clarity != null ? btn.dataset.clarity === selClarity : btn.dataset.shape === selShape;
      btn.classList.toggle('active', active);
    });
    renderCurrentPrice();
    saveForm();
  };
  const clarityRow = document.createElement('div');
  clarityRow.className = 'seg-row';
  clarityRow.innerHTML = '<span class="seg-label">清晰度</span>';
  clarities.forEach((clarity) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn';
    btn.textContent = clarity.toUpperCase();
    btn.dataset.clarity = clarity;
    if (clarity === selClarity) btn.classList.add('active');
    btn.addEventListener('click', () => { selClarity = clarity; sync(); });
    clarityRow.appendChild(btn);
  });
  wrap.appendChild(clarityRow);
  const shapeRow = document.createElement('div');
  shapeRow.className = 'seg-row';
  shapeRow.innerHTML = '<span class="seg-label">画幅</span>';
  shapes.forEach((shape) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn';
    btn.textContent = shape;
    btn.dataset.shape = shape;
    if (shape === selShape) btn.classList.add('active');
    btn.addEventListener('click', () => { selShape = shape; sync(); });
    shapeRow.appendChild(btn);
  });
  wrap.appendChild(shapeRow);
  setTimeout(sync, 0);
  return wrap;
}
function buildStepper(kind, field) {
  const wrap = document.createElement('div');
  wrap.className = 'stepper';
  const dec = document.createElement('button');
  dec.type = 'button';
  dec.className = 'step-btn';
  dec.textContent = '−';
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'step-input';
  if (field.min != null) input.min = field.min;
  if (field.max != null) input.max = field.max;
  if (field.step != null) input.step = field.step;
  const current = genValues[kind].values[field.key];
  input.value = current != null && current !== '' ? current : (field.default != null ? field.default : '');
  const inc = document.createElement('button');
  inc.type = 'button';
  inc.className = 'step-btn';
  inc.textContent = '+';
  const step = Number(field.step) > 0 ? Number(field.step) : 1;
  const clamp = (v) => {
    let n = Number(v);
    if (!Number.isFinite(n)) n = Number(field.default) || Number(field.min) || 0;
    if (input.min !== '' && n < Number(input.min)) n = Number(input.min);
    if (input.max !== '' && n > Number(input.max)) n = Number(input.max);
    return n;
  };
  dec.addEventListener('click', () => { input.value = clamp(Number(input.value) - step); input.dispatchEvent(new Event('input', { bubbles: true })); });
  inc.addEventListener('click', () => { input.value = clamp(Number(input.value) + step); input.dispatchEvent(new Event('input', { bubbles: true })); });
  input.addEventListener('input', () => setGenFieldValue(kind, field.key, input.value));
  wrap.append(dec, input, inc);
  return wrap;
}
function buildOptionButtons(kind, field) {
  const wrap = document.createElement('div');
  wrap.className = 'option-buttons';
  const current = genValues[kind].values[field.key] || field.default || '';
  (field.options || []).forEach((option) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn' + (option === current ? ' active' : '');
    btn.textContent = option;
    btn.addEventListener('click', () => {
      setGenFieldValue(kind, field.key, option);
      wrap.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderCurrentPrice();
    });
    wrap.appendChild(btn);
  });
  return wrap;
}
function getGenParams(kind, model) {
  const params = {};
  const values = genValues[kind].values;
  const fields = Array.isArray(model.fields) ? model.fields : [];
  fields.forEach((field) => {
    if (!field || !field.key || field.key === 'reference_images') return;
    if (field.key === 'resolution') {
      if (values.resolution) params.resolution = values.resolution;
      else if (field.default) params.resolution = field.default;
      return;
    }
    const raw = values[field.key] != null && values[field.key] !== '' ? values[field.key] : field.default;
    if (field.type === 'number') {
      if (raw != null && raw !== '' && Number.isFinite(Number(raw))) params[field.key] = Number(raw);
      return;
    }
    if (raw != null && raw !== '') params[field.key] = raw;
  });
  return params;
}
function updateGenStatCards() {
  const videoModel = selectedModel();
  const imageModel = selectedImageModel();
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  set('#videoStatModel', videoModel ? videoModel.name : '—');
  set('#videoStatModelId', videoModel ? videoModel.workflow : '—');
  set('#imageStatModel', imageModel ? imageModel.name : '—');
  set('#imageStatModelId', imageModel ? imageModel.workflow : '—');
  const monthKey = (beijingDayKey(new Date().toISOString()) || '').slice(0, 7);
  set('#videoStatMonth', `${state.tasks.filter((t) => t.kind !== 'image' && (beijingDayKey(t.created_at) || '').slice(0, 7) === monthKey).length} 条`);
  set('#imageStatMonth', `${state.tasks.filter((t) => t.kind === 'image' && (beijingDayKey(t.created_at) || '').slice(0, 7) === monthKey).length} 张`);
}
function updateCharCount(id) {
  const el = $(`#${id}`);
  const counter = $(`#${id}Count`);
  if (el && counter) counter.textContent = String(el.value.length);
}
const DOWNLOAD_DIR_KEYS = { video: 'wenvedio-download-dir-video', image: 'wenvedio-download-dir-image' };
const DOWNLOAD_DIR_LABELS = { video: '视频', image: '图片' };

function readSavedDownloadDir(kind) {
  try { return JSON.parse(localStorage.getItem(DOWNLOAD_DIR_KEYS[kind]) || 'null'); } catch (_) { return null; }
}

function writeSavedDownloadDir(kind, value) {
  try {
    if (value) localStorage.setItem(DOWNLOAD_DIR_KEYS[kind], JSON.stringify(value));
    else localStorage.removeItem(DOWNLOAD_DIR_KEYS[kind]);
  } catch (_) { /* 存储失败不影响下载 */ }
}

async function defaultDownloadDir(kind) {
  if (desktopBridge?.defaultDownloadDirectory) {
    try { return await desktopBridge.defaultDownloadDirectory(kind); } catch (_) { return null; }
  }
  return null;
}

// 已设置则用设置值；未设置则回退到默认目录（默认值不写入存储，保持“未设置”状态）
async function resolveDownloadDir(kind) {
  const saved = state.downloadDirs[kind] || readSavedDownloadDir(kind);
  if (saved?.path) return { path: saved.path, name: saved.name, isDefault: false };
  const fallback = await defaultDownloadDir(kind);
  return fallback ? { ...fallback, isDefault: true } : null;
}

async function initializeDownloadDirectories() {
  state.downloadDirs.video = readSavedDownloadDir('video');
  state.downloadDirs.image = readSavedDownloadDir('image');
  if (!desktopBridge) {
    try { state.downloadDirs.video = state.downloadDirs.video || await readBrowserValue('download-directory-video'); } catch (_) { /* 忽略 */ }
    try { state.downloadDirs.image = state.downloadDirs.image || await readBrowserValue('download-directory-image'); } catch (_) { /* 忽略 */ }
  }
  await renderDownloadDirs();
}

async function renderDownloadDirs() {
  for (const kind of ['video', 'image']) {
    const el = $(kind === 'video' ? '#settingVideoDownloadDir' : '#settingImageDownloadDir');
    if (!el) continue;
    const dir = await resolveDownloadDir(kind);
    if (!dir) { el.textContent = '未设置（当前环境不支持）'; el.title = ''; el.classList.remove('is-default'); continue; }
    el.textContent = dir.isDefault ? `${dir.path}（默认）` : dir.path;
    el.title = dir.path;
    el.classList.toggle('is-default', dir.isDefault);
  }
}

async function chooseDownloadDirectory(kind) {
  const target = kind === 'image' ? 'image' : 'video';
  if (desktopBridge) {
    try {
      const current = (await resolveDownloadDir(target))?.path || '';
      const directory = await desktopBridge.chooseDirectory({ kind: target, current });
      if (!directory?.path) return null;
      state.downloadDirs[target] = directory;
      writeSavedDownloadDir(target, directory);
      await renderDownloadDirs();
      return directory;
    } catch (err) {
      alert(`选择${DOWNLOAD_DIR_LABELS[target]}下载路径失败：${err.message}`);
      return null;
    }
  }
  if (!window.showDirectoryPicker) {
    alert('当前浏览器不支持选择下载文件夹，请使用 Chrome 或 Edge。');
    return null;
  }
  try {
    const directory = await window.showDirectoryPicker({
      id: `wenvedio-download-directory-${target}`,
      mode: 'readwrite',
      startIn: state.downloadDirs[target] || 'downloads',
    });
    state.downloadDirs[target] = directory;
    try { await writeBrowserValue(`download-directory-${target}`, directory); }
    catch (err) { console.warn('下载路径记忆失败，本次仍可正常下载', err); }
    await renderDownloadDirs();
    return directory;
  } catch (err) {
    if (err.name !== 'AbortError') alert(`选择下载路径失败：${err.message}`);
    return null;
  }
}

async function resetDownloadDirectory(kind) {
  const target = kind === 'image' ? 'image' : 'video';
  state.downloadDirs[target] = null;
  writeSavedDownloadDir(target, null);
  await renderDownloadDirs();
  showToast(`${DOWNLOAD_DIR_LABELS[target]}下载路径已恢复默认`, 'ok');
}

// 记录任务已下载到本地的文件，供「文件位置」定位
function rememberTaskFile(task, filePath) {
  if (!task || !filePath) return;
  if (!Array.isArray(task.localPaths)) task.localPaths = [];
  if (!task.localPaths.includes(filePath)) task.localPaths.push(filePath);
}

function imageSourceCount() {
  return state.imageItems.filter((item) => item.value.trim()).length;
}

function imageId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function renderImageInputs() {
  const wrap = $('#imageLinks');
  wrap.innerHTML = '';
  const links = state.imageItems.filter((item) => item.kind === 'link');
  if (!links.length) {
    state.imageItems.unshift({ id: imageId('link'), kind: 'link', value: '' });
    return renderImageInputs();
  }
  links.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'image-link-row';

    const index = document.createElement('span');
    index.className = 'image-link-label';
    index.textContent = i === 0 ? '图片链接' : `链接 ${i + 1}`;

    const input = document.createElement('input');
    input.value = item.value;
    input.placeholder = '输入图片 URL 或 base64';
    input.type = 'text';
    input.addEventListener('input', (e) => {
      item.value = e.target.value;
      saveForm();
      updateImageMeta();
    });

    const remove = document.createElement('button');
    remove.className = 'remove-image-link';
    remove.type = 'button';
    remove.title = '删除图片链接';
    remove.textContent = '×';
    remove.disabled = links.length === 1;
    remove.addEventListener('click', () => {
      state.imageItems = state.imageItems.filter((candidate) => candidate.id !== item.id);
      renderImageInputs();
      renderImagePreviews();
      saveForm();
    });

    row.append(index, input, remove);
    wrap.appendChild(row);
  });
  updateImageMeta();
}

function renderImagePreviews() {
  const wrap = $('#imagePreviews');
  if (!wrap) return;
  wrap.innerHTML = '';
  const items = state.imageItems.filter((item) => item.value.trim());
  items.forEach((item, index) => {
    const tile = document.createElement('div');
    tile.className = 'ref-tile';
    tile.draggable = true;
    tile.dataset.imageId = item.id;
    const image = document.createElement('img');
    image.src = item.kind === 'file' || /^(https?:|data:|blob:)/i.test(item.value) ? item.value : `data:image/png;base64,${item.value}`;
    image.alt = item.name || '参考图';
    image.title = `参考图 ${index + 1}（拖拽调整顺序）`;
    const order = document.createElement('span');
    order.className = 'ref-order';
    order.textContent = String(index + 1);
    const remove = document.createElement('button');
    remove.className = 'ref-remove';
    remove.type = 'button';
    remove.title = '删除图片';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      state.imageItems = state.imageItems.filter((candidate) => candidate.id !== item.id);
      renderImageInputs();
      renderImagePreviews();
      saveForm();
    });
    tile.append(image, order, remove);
    wrap.appendChild(tile);
  });
  updateImageMeta();
}
function updateImageMeta() {
  const note = $('#refCountNote');
  if (note) note.textContent = `已填写图片 ${imageSourceCount()} / 10`;
  const addLink = $('#addImageLink');
  if (addLink) addLink.disabled = state.imageItems.length >= 10;
  const upload = $('#localImageUpload');
  if (upload) upload.disabled = imageSourceCount() >= 10;
}
function renderImageRows() {
  renderImageInputs();
  renderImagePreviews();
}

function addImageLink() {
  if (state.imageItems.length >= 10) return;
  state.imageItems.push({ id: imageId('link'), kind: 'link', value: '' });
  renderImageInputs();
  saveForm();
  const inputs = $$('#imageLinks input');
  inputs[inputs.length - 1]?.focus();
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 点击选择时文件在 target.files，拖拽放入时在 dataTransfer.files
function filesFromEvent(event) {
  const list = event?.dataTransfer?.files ?? event?.target?.files;
  return list ? [...list] : [];
}

async function addLocalImages(event) {
  const files = filesFromEvent(event)
    .filter((file) => ['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    .slice(0, 10 - imageSourceCount());
  if (!files.length) { showToast('未识别到可用的图片（支持 JPG / PNG / WebP）', 'error'); return; }
  if (files.length) {
    const values = await Promise.all(files.map((file) => readImageFile(file)));
    values.forEach((value, i) => state.imageItems.push({ id: imageId('file'), kind: 'file', value, name: files[i].name }));
    renderImagePreviews();
    saveForm();
  }
  if (event.target && 'value' in event.target) event.target.value = '';
}

function taskStatus(task) {
  const status = String(task.status || 'queued').toLowerCase();
  if (status === 'scheduled') return 'scheduled';
  if (['timeout', 'timed_out'].includes(status)) return 'timeout';
  if (status === 'expired') return 'expired';
  if (['success', 'succeeded', 'complete', 'completed', 'finished', 'done'].includes(status)) return 'completed';
  if (['failure', 'failed', 'error', 'cancelled', 'canceled'].includes(status)) return 'failed';
  if (['running', 'processing', 'generating', 'executing', 'in_progress'].includes(status)) return 'processing';
  if (status === 'submitting') return 'submitting';
  return 'queued';
}

function statusBadgeHtml(task) {
  const map = {
    completed: ['已完成', 'badge-green'],
    processing: ['生成中', 'badge-blue'],
    queued: ['排队中', 'badge-amber'],
    submitting: ['排队中', 'badge-amber'],
    scheduled: ['已预约', 'badge-purple'],
    failed: ['失败', 'badge-red'],
    timeout: ['失败', 'badge-red'],
    expired: ['已过期', 'badge-gray'],
  };
  const entry = map[taskStatus(task)] || ['排队中', 'badge-amber'];
  return `<span class="badge ${entry[1]}">${entry[0]}</span>`;
}
function typeBadgeHtml(task) {
  return task.kind === 'image' ? '<span class="badge badge-type-image">图片</span>' : '<span class="badge badge-type-video">视频</span>';
}
function taskPreviewHtml(task) {
  if (task.kind === 'image' && (task.image_files || []).length) {
    return `<img class="task-thumb" src="${settings.apiBase}/api/tasks/${encodeURIComponent(task.id)}/image/0" alt="" loading="lazy" />`;
  }
  return `<span class="task-thumb task-thumb-icon">${task.kind === 'image' ? '▣' : '▶'}</span>`;
}
function renderTasks() {
  renderRecentTasks();
  renderTaskCenter();
  renderUsageStats();
  updateGenStatCards();
  syncVideoSubmitLabel();
}
function renderRecentTasks() {
  // 图片/视频为独立页面时，只显示对应侧的最近任务面板
  const imgPanel = $('#recentImageTable')?.closest('.panel');
  if (imgPanel) imgPanel.hidden = state.recordsKind === 'video';
  const vidPanel = $('#recentVideoTable')?.closest('.panel');
  if (vidPanel) vidPanel.hidden = state.recordsKind === 'image';
  const imageTasks = state.tasks.filter((t) => t.kind === 'image').sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 4);
  const videoTasks = state.tasks.filter((t) => t.kind !== 'image').sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 4);
  const imgBody = $('#recentImageTable');
  if (imgBody) {
    imgBody.innerHTML = '';
    imageTasks.forEach((task) => imgBody.appendChild(recentImageRow(task)));
    const empty = $('#recentImageEmpty');
    if (empty) empty.hidden = imageTasks.length > 0;
  }
  const vidBody = $('#recentVideoTable');
  if (vidBody) {
    vidBody.innerHTML = '';
    videoTasks.forEach((task) => vidBody.appendChild(recentVideoRow(task)));
    const empty = $('#recentVideoEmpty');
    if (empty) empty.hidden = videoTasks.length > 0;
  }
}
function recentImageRow(task) {
  const tr = document.createElement('tr');
  const size = (task.params && task.params.size) || task.resolution || '—';
  const count = (task.image_files || []).length || Number(task.params && task.params.n) || '—';
  tr.innerHTML = `
    <td>${taskPreviewHtml(task)}</td>
    <td class="task-name-cell"><b>${escapeHtml(task.name)}</b><small>${escapeHtml(String(task.prompt || '').slice(0, 60))}</small></td>
    <td>${statusBadgeHtml(task)}</td>
    <td class="mono">${escapeHtml(String(size))}</td>
    <td>${escapeHtml(String(count))}</td>
    <td class="mono">${escapeHtml(task.time || taskTime(task.created_at))}</td>
    <td><button type="button" class="text-button" data-recent-download="${escapeHtml(task.id)}" ${(task.image_files || []).length ? '' : 'hidden'}>⇩ 下载</button></td>`;
  const download = tr.querySelector('[data-recent-download]');
  if (download) download.addEventListener('click', () => downloadImageTask(task));
  tr.querySelector('.task-name-cell').addEventListener('click', () => openTaskDetailDrawer(task.id));
  return tr;
}
function recentVideoRow(task) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${taskPreviewHtml(task)}</td>
    <td class="task-name-cell"><b>${escapeHtml(task.name)}</b><small>${escapeHtml(String(task.prompt || '').slice(0, 60))}</small></td>
    <td>${statusBadgeHtml(task)}</td>
    <td>${task.duration ? `${task.duration} 秒` : '—'}</td>
    <td class="mono">${escapeHtml(task.resolution || '—')}</td>
    <td class="mono">${escapeHtml(task.time || taskTime(task.created_at))}</td>
    <td><button type="button" class="text-button" data-recent-download="${escapeHtml(task.id)}" ${task.status === 'completed' && task.video_url ? '' : 'hidden'}>⇩ 下载</button></td>`;
  const download = tr.querySelector('[data-recent-download]');
  if (download) download.addEventListener('click', () => downloadTasks([task]));
  tr.querySelector('.task-name-cell').addEventListener('click', () => openTaskDetailDrawer(task.id));
  return tr;
}
function tcMatches(task) {
  const f = state.tc;
  const status = taskStatus(task);
  if (f.filter === 'processing' && !['submitting', 'queued', 'processing'].includes(status)) return false;
  if (f.filter === 'scheduled' && status !== 'scheduled') return false;
  if (f.filter === 'completed' && status !== 'completed') return false;
  if (f.filter === 'failed' && !['failed', 'timeout', 'expired'].includes(status)) return false;
  if (f.model && task.model_id !== f.model) return false;
  if (f.date && (beijingDayKey(task.created_at) || '') !== f.date) return false;
  if (f.search) {
    const kw = f.search.toLowerCase();
    if (!`${task.name || ''}${task.prompt || ''}`.toLowerCase().includes(kw)) return false;
  }
  return true;
}
// 当前任务中心页面作用域：图片任务 / 视频任务 / 全部
function taskCenterScoped() {
  return state.recordsKind === 'image' || state.recordsKind === 'video'
    ? state.tasks.filter((task) => task.kind === state.recordsKind)
    : state.tasks;
}

function filterTaskCenter() {
  return taskCenterScoped().filter((task) => tcMatches(task)).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}
function renderTaskCenter() {
  const wrap = $('#tcTable');
  if (!wrap) return;
  // 图片任务 / 视频任务是独立页面，统计只针对当前页面
  const scopeText = state.recordsKind === 'image' ? '图片' : state.recordsKind === 'video' ? '视频' : '';
  const scoped = taskCenterScoped();
  const counts = {
    all: scoped.length,
    processing: scoped.filter((t) => ['submitting', 'queued', 'processing'].includes(taskStatus(t))).length,
    scheduled: scoped.filter((t) => taskStatus(t) === 'scheduled').length,
    completed: scoped.filter((t) => taskStatus(t) === 'completed').length,
    failed: scoped.filter((t) => ['failed', 'timeout', 'expired'].includes(taskStatus(t))).length,
  };
  const title = $('#tcTitle');
  if (title) title.textContent = scopeText ? `${scopeText}任务` : '任务中心';
  const subtitle = $('#tcSubtitle');
  if (subtitle) subtitle.textContent = scopeText
    ? `仅显示并统计${scopeText}任务的进度与花费，可切换左侧子菜单查看另一类。`
    : '查看和管理所有生成任务，包括进行中、已预约和已完成任务。';
  const costLabel = $('#tcCostLabel');
  if (costLabel) costLabel.textContent = scopeText ? `${scopeText}总花费` : '总花费';
  const monthCostLabel = $('#tcMonthCostLabel');
  if (monthCostLabel) monthCostLabel.textContent = scopeText ? `${scopeText}本月花费` : '本月花费';
  // 统计数字只在筛选标签页上出现一次（页头原来那排重复的统计卡已移除）
  const tabLabels = { all: '全部任务', processing: '进行中', scheduled: '已预约', completed: '已完成', failed: '失败' };
  $$('.tc-tabs [data-tc-filter]').forEach((button) => {
    const key = button.dataset.tcFilter;
    const value = key === 'all' ? counts.all : counts[key] != null ? counts[key] : 0;
    button.innerHTML = `${tabLabels[key] || key}<span class="tc-tab-count">${value}</span>`;
  });
  const tasks = filterTaskCenter();
  wrap.innerHTML = '';
  tasks.forEach((task, index) => wrap.appendChild(taskCenterRow(task, index)));
  const empty = $('#tcEmpty');
  if (empty) {
    empty.hidden = tasks.length > 0;
    const titleEl = empty.querySelector('b');
    const descEl = empty.querySelector('p');
    if (titleEl) titleEl.textContent = scopeText ? `还没有${scopeText}任务记录` : '还没有任务记录';
    if (descEl) descEl.textContent = scopeText ? `提交${scopeText}任务后，记录会出现在这里` : '提交任务后，记录会出现在这里';
  }
}
function taskCenterRow(task, index) {
  const tr = document.createElement('tr');
  tr.dataset.taskId = task.id;
  const status = taskStatus(task);
  const progress = status === 'processing' ? Math.max(5, Math.min(100, Number(task.progress) || 8)) : null;
  const progressHtml = progress != null ? `<div class="tc-progress"><div class="tc-progress-bar" style="width:${progress}%"></div></div><small>${progress}%</small>` : '<span class="mono">—</span>';
  const actions = [];
  if (status === 'completed' && (task.kind === 'image' ? (task.image_files || []).length : task.video_url)) {
    actions.push(`<button type="button" data-tc-download="${escapeHtml(task.id)}">⇩ 下载</button>`);
  }
  if (status === 'scheduled') {
    actions.push(`<button type="button" data-tc-run="${escapeHtml(task.id)}">立即执行</button>`);
    actions.push(`<button type="button" class="danger" data-tc-cancel="${escapeHtml(task.id)}">取消预约</button>`);
  }
  if (['failed', 'timeout', 'expired'].includes(status)) actions.push(`<button type="button" data-tc-retry="${escapeHtml(task.id)}">↻ 重新提交</button>`);
  actions.push(`<button type="button" data-tc-locate="${escapeHtml(task.id)}">📁 文件位置</button>`);
  actions.push(`<button type="button" data-tc-view="${escapeHtml(task.id)}">👁 查看</button>`);
  actions.push(`<button type="button" class="danger" data-tc-delete="${escapeHtml(task.id)}">🗑 删除</button>`);
  tr.innerHTML = `
    <td class="check-col"><div class="tc-check-cell"><input type="checkbox" data-tc-check="${escapeHtml(task.id)}" ${state.selected.has(task.id) ? 'checked' : ''} aria-label="选择任务" /><span class="tc-index">${index + 1}</span></div></td>
    <td>${taskPreviewHtml(task)}</td>
    <td class="task-name-cell"><b>${escapeHtml(task.name)}</b><small>${escapeHtml(String(task.prompt || '').slice(0, 50))}</small>${typeof task.cost === 'number' ? `<small class="tc-cost">费用 ${formatTaskCost(task)}</small>` : ''}</td>
    <td>${typeBadgeHtml(task)}</td>
    <td class="tc-model">${escapeHtml(task.model_name || '—')}</td>
    <td>${statusBadgeHtml(task)}</td>
    <td>${progressHtml}</td>
    <td class="mono">${escapeHtml(task.time || taskTime(task.created_at))}</td>
    <td class="col-actions"><div class="tc-actions-wrap"><button type="button" class="tc-action-btn" data-tc-menu="${escapeHtml(task.id)}">操作 ▾</button><div class="row-action-menu" hidden>${actions.join('')}</div></div></td>`;
  const menuButton = tr.querySelector('[data-tc-menu]');
  const menu = tr.querySelector('.row-action-menu');
  if (menuButton && menu) {
    menuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const willShow = menu.hidden;
      $$('.row-action-menu').forEach((item) => { item.hidden = true; });
      menu.hidden = !willShow;
    });
    menu.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => { menu.hidden = true; }));
  }
  tr.querySelectorAll('[data-tc-check]').forEach((input) => input.addEventListener('change', () => {
    if (input.checked) state.selected.add(task.id);
    else state.selected.delete(task.id);
    tr.classList.toggle('selected', input.checked);
    updateSelection();
  }));
  tr.querySelectorAll('[data-tc-locate]').forEach((button) => button.addEventListener('click', () => showTaskFileLocation(task)));
  tr.querySelectorAll('[data-tc-delete]').forEach((button) => button.addEventListener('click', () => deleteTasks([task.id])));
  tr.querySelectorAll('[data-tc-view]').forEach((button) => button.addEventListener('click', () => openTaskDetailDrawer(task.id)));
  tr.querySelectorAll('[data-tc-download]').forEach((button) => button.addEventListener('click', () => task.kind === 'image' ? downloadImageTask(task) : downloadTasks([task])));
  tr.querySelectorAll('[data-tc-run]').forEach((button) => button.addEventListener('click', () => runScheduledAction(task.id, 'submit')));
  tr.querySelectorAll('[data-tc-cancel]').forEach((button) => button.addEventListener('click', () => runScheduledAction(task.id, 'cancel')));
  tr.querySelectorAll('[data-tc-retry]').forEach((button) => button.addEventListener('click', () => retryTask(task)));
  tr.querySelector('.task-name-cell').addEventListener('click', () => openTaskDetailDrawer(task.id));
  return tr;
}
async function retryTask(task) {
  try {
    const res = await fetch(`${settings.apiBase}/api/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: task.name,
        model_id: task.model_id,
        tasks: [{ prompt: task.prompt, duration: task.duration, resolution: task.resolution, params: task.params || {}, reference_images: task.reference_images || [] }],
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    (data.tasks || []).forEach((record) => {
      state.tasks.unshift(record.kind === 'image' ? imageTaskFromRecord(record) : {
        id: record.local_id, kind: 'video', name: record.name, prompt: record.prompt || '', status: record.status || 'submitting', progress: 8, duration: record.duration, resolution: record.resolution, model_id: record.model_id, model_name: record.model_name, cost: typeof record.cost === 'number' ? record.cost : null, cost_currency: record.cost_currency || 'CNY', created_at: record.created_at, time: taskTime(record.created_at),
      });
      if (record.local_id) pollTask(record.local_id);
    });
    renderTasks();
    showToast('已重新提交任务', 'ok');
  } catch (err) {
    alert(`重新提交失败：${err.message}`);
  }
}
function scheduledTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

async function runScheduledAction(id, action) {
  const isSubmit = action === 'submit';
  const message = isSubmit
    ? '确定立即提交这条预约任务吗？提交后将立即产生费用。'
    : '确定取消这条预约吗？取消后会删除该预约记录。';
  if (!window.confirm(message)) return;
  try {
    const res = await fetch(`${settings.apiBase}/api/scheduled/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    if (isSubmit) {
      const task = state.tasks.find((item) => item.id === id);
      if (task) {
        Object.assign(task, data.task, { id: data.task.local_id, time: task.time });
        pollTask(id);
      }
    } else {
      state.tasks = state.tasks.filter((item) => item.id !== id);
      state.selected.delete(id);
      state.pollingTasks.delete(id);
    }
    renderTasks();
  } catch (err) {
    alert(`${isSubmit ? '立即提交' : '取消预约'}失败：${err.message}`);
  }
}

function taskTime(createdAt) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

async function loadTasks() {
  try {
    const res = await fetch(`${settings.apiBase}/api/tasks`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    state.tasks = data.tasks.map((task) => ({
      id: task.local_id,
      name: task.name || '提示词任务',
      prompt: task.prompt || '',
      duration: task.duration,
      image_count: task.image_count || 0,
      resolution: task.resolution || '',
      seed: task.seed,
      status: task.status || 'queued',
      progress: task.progress || 0,
      error: task.error || null,
      provider_task_id: task.provider_task_id,
      model_id: task.model_id,
      model_name: task.model_name,
      video_url: task.video_url,
      created_at: task.created_at,
      submitted_at: task.submitted_at,
      scheduled_at: task.scheduled_at,
      kind: task.kind || 'video',
      image_files: task.image_files || null,
      cost: typeof task.cost === 'number' ? task.cost : null,
      cost_currency: task.cost_currency || 'CNY',
      time: taskTime(task.created_at),
    })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    renderTasks();
    state.tasks
      .filter((task) => !['completed', 'failed', 'timeout', 'expired'].includes(taskStatus(task)))
      .forEach((task) => pollTask(task.id));
    // 失败/超时但缺少原因的历史任务：启动时补拉一次，让失败原因可见
    state.tasks
      .filter((task) => ['failed', 'timeout'].includes(taskStatus(task)) && !task.error && task.provider_task_id)
      .slice(0, 10)
      .forEach(async (task) => {
        try {
          const res = await fetch(`${settings.apiBase}/api/tasks/${encodeURIComponent(task.id)}`);
          const data = await res.json();
          if (data.ok && data.task) {
            task.error = data.task.error || task.error;
            task.status = data.task.status || task.status;
            task.video_url = data.task.video_url || task.video_url;
          }
        } catch (_) { /* 忽略单条刷新失败 */ }
        renderTasks();
      });
  } catch (err) {
    console.error('读取任务记录失败', err);
    renderTasks();
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function updateSelection() {
  const n = state.selected.size;
  const count = $('#selectedCount');
  if (count) count.textContent = String(n);
  const downloadButton = $('#downloadSelected');
  if (downloadButton) downloadButton.disabled = !n;
  const deleteButton = $('#deleteSelected');
  if (deleteButton) deleteButton.disabled = !n;
  const filtered = filterTaskCenter();
  const visibleSelected = filtered.filter((t) => state.selected.has(t.id)).length;
  const selectAll = $('#selectAll');
  if (selectAll) selectAll.checked = filtered.length > 0 && visibleSelected === filtered.length;
}
// 演示模式：模拟任务从排队到完成
function simulateTask(localId) {
  const t = state.tasks.find((x) => x.id === localId);
  if (!t) return;
  let p = 8;
  const timer = setInterval(() => {
    p += Math.floor(Math.random() * 18) + 8;
    if (p >= 100) { p = 100; clearInterval(timer); t.status = 'completed'; }
    else { t.status = 'processing'; t.progress = p; }
    renderTasks();
  }, 600);
  state.pollTimers.push(timer);
}

async function submitBatch() {
  const model = selectedModel();
  if (!model) { alert('请选择生成模型'); return; }
  const taskName = ($('#taskName').value || '未命名任务').trim() || '未命名任务';
  const sequence = Number($('#taskSequence').value);
  if (!Number.isInteger(sequence) || sequence < 1) { alert('序号必须是从 1 开始的整数'); $('#taskSequence').focus(); return; }
  const prompt = ($('#prompt').value || '').trim();
  if (!prompt) { alert('请填写提示词'); $('#prompt').focus(); return; }
  const params = getGenParams('video', model);
  const duration = Number(params.duration) || 5;
  const scheduled = $('#scheduleSubmit').checked;
  const seed = genValues.video.values.seed;
  const refs = state.imageItems.filter((item) => item.value.trim()).map((item) => item.value.trim());
  const refField = (model.fields || []).find((field) => field && field.key === 'reference_images');
  const refsRequired = !refField || refField.required !== false;
  if (refsRequired && !refs[0]) { alert('请添加至少一张参考图片'); return; }
  // 参考图为可选项时，未添加任何参考图先确认：这类多图参考工作流缺图会在平台侧执行失败
  if (!refsRequired && !refs.length
    && !window.confirm('当前没有添加参考图片。\n若该工作流需要参考图，任务提交后会在平台侧生成失败。\n确定继续提交吗？')) return;
  $('#submitBatch').disabled = true;
  try {
    const res = await fetch(`${settings.apiBase}/api/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${taskName}_${sequence}`,
        model_id: model.id,
        scheduled,
        tasks: [{
          prompt,
          duration,
          resolution: params.resolution || '',
          seed: seed != null && seed !== '' && Number.isFinite(Number(seed)) ? Number(seed) : undefined,
          reference_images: refs,
          params,
        }],
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    (data.tasks || []).forEach((record) => {
      state.tasks.unshift({
        id: record.local_id,
        kind: 'video',
        name: record.name,
        prompt: record.prompt || '',
        status: record.status || 'submitting',
        progress: 8,
        duration: record.duration,
        resolution: record.resolution,
        image_files: null,
        model_id: record.model_id,
        model_name: record.model_name,
        cost: typeof record.cost === 'number' ? record.cost : null,
        cost_currency: record.cost_currency || 'CNY',
        created_at: record.created_at,
        time: taskTime(record.created_at),
      });
      if (record.local_id) pollTask(record.local_id);
    });
    renderTasks();
    $('#taskSequence').value = String(sequence + 1);
    saveForm();
    showToast(`已提交生成（${(data.tasks || []).length} 条）`, 'ok');
  } catch (err) {
    alert(`提交失败：${err.message}`);
  } finally {
    $('#submitBatch').disabled = false;
    syncVideoSubmitLabel();
  }
}
function syncVideoSubmitLabel() {
  const scheduled = $('#scheduleSubmit') && $('#scheduleSubmit').checked;
  const label = $('#videoSubmitText');
  if (label) label.textContent = scheduled ? '预约生成' : '提交任务';
  const icon = $('#videoSubmitIcon');
  if (icon) icon.textContent = scheduled ? '🕑' : '▶';
}
function notifyTaskFinished(task, ok) {
  if (!appSettings.notifyOnFinish) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(ok ? '视频生成完成' : '视频任务失败', { body: `${task.name || task.id}\n${String(task.prompt || '').slice(0, 60)}` });
  } catch (_) { /* 通知失败不影响任务 */ }
}

// 轮询单个任务状态
function pollTask(localId) {
  const t = state.tasks.find((x) => x.id === localId);
  if (!t || state.pollingTasks.has(localId) || ['completed', 'failed', 'timeout', 'expired'].includes(taskStatus(t))) return;
  state.pollingTasks.add(localId);
  const poll = async () => {
    if (!state.tasks.some((task) => task.id === localId)) {
      state.pollingTasks.delete(localId);
      return;
    }
    try {
      const res = await fetch(`${settings.apiBase}/api/tasks/${localId}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
      const remote = data.task;
      t.status = remote.status || t.status;
      t.error = remote.error || null;
      t.query_error = remote.query_error || null;
      t.scheduled_at = remote.scheduled_at || null;
      t.submitted_at = remote.submitted_at || t.submitted_at;
      if (remote.video_url) { t.video_url = remote.video_url; }
      if (remote.image_files) t.image_files = remote.image_files;
      if (remote.cost != null) { t.cost = remote.cost; t.cost_currency = remote.cost_currency || 'CNY'; }
      const status = taskStatus(t);
      if (status === 'completed') { t.progress = 100; state.pollingTasks.delete(localId); notifyTaskFinished(t, true); showToast('生成完成', 'ok'); }
      else if (['failed', 'timeout'].includes(status)) { state.pollingTasks.delete(localId); notifyTaskFinished(t, false); showToast('生成失败，可在任务中心查看详情', 'error'); }
      else if (status === 'expired') { state.pollingTasks.delete(localId); notifyTaskFinished(t, false); showToast('任务已超过 24 小时未完成，判定为过期', 'error'); }
      else { t.progress = remote.progress || t.progress || 8; }
      renderTasks();
      if (!['completed', 'failed', 'timeout', 'expired'].includes(status)) scheduleNext();
    } catch (_) {
      // 网络或鉴权异常不会误判任务失败，一分钟后继续查询。
      scheduleNext();
    }
  };
  const scheduleNext = () => {
    const timer = setTimeout(poll, Math.max(5, Number(appSettings.pollIntervalSeconds) || 60) * 1000);
    state.pollTimers.push(timer);
  };
  poll();
}

function safeDownloadName(task, index) {
  const base = `${task.name || `视频_${index + 1}`}`
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
  return `${base || `video_${index + 1}`}.mp4`;
}

async function availableDownloadName(directory, desiredName) {
  const dot = desiredName.lastIndexOf('.');
  const base = dot > 0 ? desiredName.slice(0, dot) : desiredName;
  const extension = dot > 0 ? desiredName.slice(dot) : '';
  let number = 1;
  while (true) {
    const candidate = number === 1 ? desiredName : `${base}(${number})${extension}`;
    try {
      await directory.getFileHandle(candidate);
      number += 1;
    } catch (err) {
      if (err.name === 'NotFoundError') return candidate;
      if (err.name === 'TypeMismatchError') { number += 1; continue; }
      throw err;
    }
  }
}

async function downloadSelected() {
  const selected = [...state.selected]
    .map((id) => state.tasks.find((task) => task.id === id))
    .filter(Boolean);
  const videos = selected.filter((task) => task.kind !== 'image' && (task.video_url || settings.mock));
  const images = selected.filter((task) => task.kind === 'image' && (task.image_files || []).length > 0);
  if (!videos.length && !images.length) {
    alert('选中的任务还没有可下载的文件。');
    return;
  }
  if (videos.length) await downloadTasks(videos);
  if (images.length) await downloadImageTasks(images);
}

// 图片批量下载：每个任务的多张图逐张保存到图片下载路径
async function downloadImageTasks(tasks) {
  if (!desktopBridge) {
    for (const task of tasks) await downloadImageTask(task);
    return;
  }
  const directory = (await resolveDownloadDir('image')) || (await chooseDownloadDirectory('image'));
  if (!directory?.path) { alert('未配置图片下载路径，下载已取消。'); return; }
  const button = $('#downloadSelected');
  const original = button.innerHTML;
  let completed = 0;
  let failed = 0;
  try {
    const total = tasks.reduce((sum, task) => sum + (task.image_files || []).length, 0);
    let index = 0;
    for (const task of tasks) {
      const files = task.image_files || [];
      const safeName = String(task.name || task.id).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80);
      for (let i = 0; i < files.length; i += 1) {
        index += 1;
        button.textContent = `下载中 ${index} / ${total}`;
        const ext = String(files[i]).split('.').pop() || 'png';
        try {
          const res = await fetch(`${settings.apiBase}/api/tasks/${encodeURIComponent(task.id)}/image/${i}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const saved = await desktopBridge.saveFile({ directory: directory.path, name: `${safeName}_${i + 1}.${ext}`, data: await blob.arrayBuffer() });
          rememberTaskFile(task, saved?.path);
          completed += 1;
        } catch (_) {
          failed += 1;
        }
      }
    }
    showToast(failed ? `已下载 ${completed} 张图片，${failed} 张失败` : `已下载 ${completed} 张图片到 ${directory.name || directory.path}`, failed ? 'error' : 'ok');
  } finally {
    button.innerHTML = original;
    updateSelection();
  }
}

async function downloadTasks(tasks) {
  if (desktopBridge) return downloadTasksDesktop(tasks);
  if (!window.showDirectoryPicker) {
    for (const task of tasks) {
      if (settings.mock) continue;
      const link = document.createElement('a');
      link.href = `${settings.apiBase}/api/tasks/${encodeURIComponent(task.id)}/download`;
      link.download = safeDownloadName(task, 0);
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
    return;
  }

  let directory = state.downloadDirs.video;
  let justChosen = false;
  if (!directory) {
    directory = await chooseDownloadDirectory('video');
    if (!directory) return;
    justChosen = true;
  }

  // showDirectoryPicker({ mode: 'readwrite' }) 返回的新句柄已有写权限，
  // 此时再请求权限会因用户激活时机结束而被部分浏览器拒绝。
  const permissionPromise = !justChosen && typeof directory.requestPermission === 'function'
    ? directory.requestPermission({ mode: 'readwrite' })
    : Promise.resolve('granted');
  const button = $('#downloadSelected');
  const original = button.innerHTML;
  try {
    const permission = await permissionPromise;
    if (permission !== 'granted') throw new Error('下载目录权限已失效，请重新选择路径');

    let completed = 0;
    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i];
      button.textContent = `下载中 ${i + 1} / ${tasks.length}`;
      const blob = settings.mock
        ? new Blob([`wenVedio demo video\nTask: ${task.id}\nPrompt: ${task.prompt}`], { type: 'video/mp4' })
        : await fetch(`${settings.apiBase}/api/tasks/${encodeURIComponent(task.id)}/download`).then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.msg || `HTTP ${res.status}`);
          }
          return res.blob();
        });
      const fileName = await availableDownloadName(directory, safeDownloadName(task, i));
      const file = await directory.getFileHandle(fileName, { create: true });
      const writable = await file.createWritable();
      await writable.write(blob);
      await writable.close();
      completed += 1;
    }
    showToast(`已下载 ${completed} 个视频到所选文件夹`, 'ok');
  } catch (err) {
    if (err.name !== 'AbortError') alert(`批量下载失败：${err.message}`);
  } finally {
    button.innerHTML = original;
    updateSelection();
  }
}

// 桌面客户端下载：目录由主进程原生对话框选择，文件经 IPC 直接写入磁盘。
async function downloadTasksDesktop(tasks) {
  let directory = await resolveDownloadDir('video');
  if (!directory?.path) {
    directory = await chooseDownloadDirectory('video');
    if (!directory?.path) return;
  }
  const button = $('#downloadSelected');
  const original = button.innerHTML;
  try {
    let completed = 0;
    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i];
      button.textContent = `下载中 ${i + 1} / ${tasks.length}`;
      const blob = settings.mock
        ? new Blob([`wenVedio demo video
Task: ${task.id}
Prompt: ${task.prompt}`], { type: 'video/mp4' })
        : await fetch(`${settings.apiBase}/api/tasks/${encodeURIComponent(task.id)}/download`).then(async (res) => {
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              throw new Error(data.msg || `HTTP ${res.status}`);
            }
            return res.blob();
          });
      const saved = await desktopBridge.saveFile({ directory: directory.path, name: safeDownloadName(task, i), data: await blob.arrayBuffer() });
      rememberTaskFile(task, saved?.path);
      completed += 1;
    }
    showToast(`已下载 ${completed} 个视频到 ${directory.name || directory.path}`, 'ok');
  } catch (err) {
    alert(`批量下载失败：${err.message}`);
  } finally {
    button.innerHTML = original;
    updateSelection();
  }
}

async function deleteTasks(ids) {
  const uniqueIds = [...new Set(ids)].filter((id) => state.tasks.some((task) => task.id === id));
  if (!uniqueIds.length) return;
  if (!window.confirm(`确定删除选中的 ${uniqueIds.length} 条任务记录吗？\n这不会删除平台上的任务和视频。`)) return;
  try {
    const res = await fetch(`${settings.apiBase}/api/tasks`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: uniqueIds }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    const deleted = new Set(data.deleted || []);
    state.tasks = state.tasks.filter((task) => !deleted.has(task.id));
    deleted.forEach((id) => {
      state.selected.delete(id);
      state.pollingTasks.delete(id);
    });
    renderTasks();
  } catch (err) {
    alert(`删除任务记录失败：${err.message}`);
  }
}

// 启动时预取令牌：模型「状态 / 调用配置」列依赖它，避免加载完成前误报配置异常
async function loadTokensCache() {
  try {
    const res = await fetch(`${settings.apiBase}/api/tokens`);
    const data = await res.json();
    if (data.ok) {
      state.tokens = data.tokens || [];
      state.tokensLoaded = true;
    }
  } catch (_) { /* 服务未就绪时忽略，打开令牌页会重试 */ }
}

// ---------------- 提示词管理 ----------------
const promptUI = { editingId: null, items: [] };
const PROMPT_COLLAPSED_KEY = 'wenvedio-prompt-collapsed';

// 记录列表的折叠状态（记住上次的选择）
function promptCollapsedSet() {
  if (!(promptUI.collapsed instanceof Set)) {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(PROMPT_COLLAPSED_KEY) || '[]'); } catch (_) { saved = []; }
    promptUI.collapsed = new Set(Array.isArray(saved) ? saved.map(String) : []);
  }
  return promptUI.collapsed;
}

function savePromptCollapsed() {
  try { localStorage.setItem(PROMPT_COLLAPSED_KEY, JSON.stringify([...promptCollapsedSet()])); } catch (_) { /* 忽略 */ }
}

function togglePromptCollapsed(id, collapsed) {
  const set = promptCollapsedSet();
  const next = collapsed == null ? !set.has(id) : collapsed;
  if (next) set.add(id); else set.delete(id);
  savePromptCollapsed();
  renderPrompts();
}
const PROMPT_MAX_ITEMS = 50;

async function loadPromptsCache() {
  try {
    const res = await fetch(`${settings.apiBase}/api/prompts`);
    const data = await res.json();
    if (data.ok) state.prompts = data.prompts || [];
  } catch (_) { /* 服务未就绪时忽略，进入页面会重试 */ }
}

async function openPrompts() {
  showView('prompts');
  try {
    const res = await fetch(`${settings.apiBase}/api/prompts`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    state.prompts = data.prompts || [];
    renderPrompts();
  } catch (err) {
    alert(`读取提示词失败：${err.message}`);
  }
}

function renderPrompts() {
  const wrap = $('#promptRecords');
  if (!wrap) return;
  wrap.innerHTML = '';
  state.prompts.forEach((record) => wrap.appendChild(promptRecordCard(record)));
  const empty = $('#promptsEmpty');
  if (empty) empty.hidden = state.prompts.length > 0;
}

// 复制图标：内联 SVG，避免依赖字体（图形字符在不同字体下会显示成奇怪方块）
const EXPAND_ICON_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M9.5 2.5h4v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.5 2.5 9.2 6.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M6.5 13.5h-4v-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 13.5l4.3-4.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const COPY_ICON_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><rect x="5.6" y="5.6" width="8.4" height="8.4" rx="1.7" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.4 3.7v-.5A1.7 1.7 0 0 0 8.7 1.5H3.2A1.7 1.7 0 0 0 1.5 3.2v5.5a1.7 1.7 0 0 0 1.7 1.7h.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

function promptRecordCard(record) {
  const card = document.createElement('section');
  card.className = `panel prompt-card${promptCollapsedSet().has(record.id) ? ' collapsed' : ''}`;
  card.dataset.promptId = record.id;
  const items = Array.isArray(record.items) ? record.items : [];
  const collapsed = promptCollapsedSet().has(record.id);
  card.innerHTML = `
    <header class="prompt-card-head" data-prompt-toggle="${escapeHtml(record.id)}" title="${collapsed ? '展开' : '收起'}这组提示词">
      <span class="prompt-chevron" aria-hidden="true">${collapsed ? '›' : '⌄'}</span>
      <div class="prompt-card-title"><b>${escapeHtml(record.name || '未命名记录')}</b><small>${items.length} 条提示词 · 更新于 ${escapeHtml(relativeTime(record.updated_at || record.created_at) || '—')}</small></div>
      <div class="prompt-card-actions">
        <button type="button" class="model-action-button primary" data-prompt-edit="${escapeHtml(record.id)}">编辑</button>
        <button type="button" class="model-action-button" data-prompt-del="${escapeHtml(record.id)}">删除</button>
      </div>
    </header>
    <div class="prompt-items">${items.map((item, index) => `
      <div class="prompt-card-item">
        <button type="button" class="prompt-copy-btn" data-prompt-copy="${escapeHtml(record.id)}:${index}" title="复制提示词" aria-label="复制提示词">${COPY_ICON_SVG}</button>
        ${item.title ? `<b class="prompt-item-title-label">${escapeHtml(item.title)}</b>` : ''}
        <p class="prompt-text">${escapeHtml(item.text || '')}</p>
        <div class="prompt-meta">
          <span class="prompt-duration">${Number(item.duration) > 0 ? `${escapeHtml(String(item.duration))} 秒` : '时长未设置'}</span>
          <button type="button" class="text-button" data-prompt-use="${escapeHtml(record.id)}:${index}">填入生成页</button>
        </div>
      </div>`).join('') || '<div class="prompt-empty-hint">该记录还没有提示词</div>'}</div>`;
  return card;
}

function expandAllPrompts() {
  promptCollapsedSet().clear();
  savePromptCollapsed();
  renderPrompts();
  showToast('已展开全部提示词', 'ok');
}

function collapseAllPrompts() {
  const set = promptCollapsedSet();
  state.prompts.forEach((record) => set.add(record.id));
  savePromptCollapsed();
  renderPrompts();
  showToast('已收起全部提示词', 'ok');
}

function promptItemAt(token) {
  const [recordId, index] = String(token || '').split(':');
  const record = state.prompts.find((item) => item.id === recordId);
  const prompt = (record?.items || [])[Number(index)];
  return prompt || null;
}

async function copyPromptText(text) {
  const value = String(text || '');
  if (!value.trim()) { showToast('该提示词为空', 'error'); return; }
  try {
    await navigator.clipboard.writeText(value);
    showToast('提示词已复制', 'ok');
  } catch (_) {
    const area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); showToast('提示词已复制', 'ok'); }
    catch (err) { alert('复制失败，请手动选择文本复制'); }
    area.remove();
  }
}

// 把提示词与时长带到视频生成页
function applyPromptToVideo(prompt) {
  showView('workspace');
  const promptEl = $('#prompt');
  if (promptEl) { promptEl.value = String(prompt.text || ''); updateCharCount('prompt'); }
  const duration = Number(prompt.duration);
  if (Number.isFinite(duration) && duration > 0) {
    genValues.video.values.duration = duration;
    saveGenValues();
    const stepper = document.querySelector('#videoExtraFields .stepper input');
    if (stepper) stepper.value = String(duration);
  }
  renderCurrentPrice();
  saveForm();
  showToast('已填入视频生成页', 'ok');
}

let promptFullscreenIndex = null;

function updatePromptFullscreenCount() {
  const el = $('#promptFullscreenCount');
  const area = $('#promptFullscreenText');
  if (el && area) el.textContent = `${area.value.length} 字`;
}

function openPromptFullscreen(index) {
  const item = promptUI.items[index];
  if (!item) return;
  promptFullscreenIndex = index;
  $('#promptFullscreenTitle').textContent = `编辑提示词 ${index + 1}`;
  $('#promptFullscreenText').value = String(item.text || '');
  updatePromptFullscreenCount();
  $('#promptFullscreen').hidden = false;
  setTimeout(() => $('#promptFullscreenText').focus(), 30);
}

function closePromptFullscreen() {
  $('#promptFullscreen').hidden = true;
  promptFullscreenIndex = null;
}

// 保存回写到抽屉里对应的输入框（仍需在抽屉里点保存才会写入记录）
function savePromptFullscreen() {
  if (promptFullscreenIndex == null) return closePromptFullscreen();
  const text = $('#promptFullscreenText').value;
  const item = promptUI.items[promptFullscreenIndex];
  if (item) item.text = text;
  closePromptFullscreen();
  renderPromptItems();
  showToast('已写回提示词（别忘了点保存）', 'ok');
}

function bindPromptRecords() {
  const wrap = $('#promptRecords');
  if (!wrap) return;
  wrap.addEventListener('click', async (event) => {
    const head = event.target.closest('[data-prompt-toggle]');
    if (head && !event.target.closest('.prompt-card-actions')) {
      togglePromptCollapsed(head.dataset.promptToggle);
      return;
    }
    const copyBtn = event.target.closest('[data-prompt-copy]');
    if (copyBtn) {
      const prompt = promptItemAt(copyBtn.dataset.promptCopy);
      if (prompt) await copyPromptText(prompt.text);
      return;
    }
    const useBtn = event.target.closest('[data-prompt-use]');
    if (useBtn) {
      const prompt = promptItemAt(useBtn.dataset.promptUse);
      if (prompt) applyPromptToVideo(prompt);
      return;
    }
    const editBtn = event.target.closest('[data-prompt-edit]');
    if (editBtn) { openPromptDrawer(editBtn.dataset.promptEdit); return; }
    const delBtn = event.target.closest('[data-prompt-del]');
    if (delBtn) deletePromptRecord(delBtn.dataset.promptDel);
  });
}

function openPromptDrawer(id) {
  const record = id ? state.prompts.find((item) => item.id === id) : null;
  promptUI.editingId = record ? record.id : null;
  promptUI.items = (record?.items || []).map((item) => ({
    title: String(item.title || ''),
    text: String(item.text || ''),
    duration: Number(item.duration) > 0 ? String(item.duration) : '',
  }));
  if (!promptUI.items.length) promptUI.items.push({ title: '', text: '', duration: '5' });
  $('#promptDrawerTitle').textContent = record ? '编辑记录' : '新增记录';
  $('#promptDrawerMeta').textContent = record ? record.id : '新建';
  $('#promptRecordName').value = record?.name || '';
  renderPromptItems();
  $('#promptDrawerBackdrop').hidden = false;
  closePromptFullscreen();
}

function closePromptDrawer() {
  $('#promptDrawerBackdrop').hidden = true;
  promptUI.editingId = null;
  promptUI.items = [];
}

function renderPromptItems() {
  const wrap = $('#promptItems');
  if (!wrap) return;
  wrap.innerHTML = '';
  promptUI.items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'prompt-item-row';
    row.innerHTML = `
      <div class="prompt-item-head"><span>提示词 ${index + 1}</span><button type="button" class="prompt-item-remove" data-prompt-item-remove="${index}" title="删除这条" aria-label="删除这条">×</button></div>
      <input class="prompt-item-title" type="text" maxlength="40" placeholder="小标题（可选，例如：镜头1 / 开场）" value="${escapeHtml(item.title || '')}" />
      <div class="prompt-item-text-wrap">
        <textarea class="prompt-item-text" rows="4" placeholder="粘贴或输入提示词">${escapeHtml(item.text)}</textarea>
        <button type="button" class="prompt-item-copy" data-prompt-item-copy="${index}" title="复制这条提示词" aria-label="复制这条提示词">${COPY_ICON_SVG}</button>
        <button type="button" class="prompt-item-expand" data-prompt-item-expand="${index}" title="全屏编辑" aria-label="全屏编辑">${EXPAND_ICON_SVG}</button>
      </div>
      <div class="prompt-item-foot"><label>时长 <input class="prompt-item-duration" type="number" min="1" max="600" step="1" value="${escapeHtml(item.duration)}" /> 秒</label></div>`;
    row.querySelector('.prompt-item-title').addEventListener('input', (event) => { promptUI.items[index].title = event.target.value; });
    row.querySelector('.prompt-item-text').addEventListener('input', (event) => { promptUI.items[index].text = event.target.value; });
    row.querySelector('.prompt-item-duration').addEventListener('input', (event) => { promptUI.items[index].duration = event.target.value; });
    // 复制当前输入框内容（含尚未保存的修改）
    row.querySelector('[data-prompt-item-copy]').addEventListener('click', () => {
      copyPromptText(row.querySelector('.prompt-item-text').value);
    });
    row.querySelector('[data-prompt-item-expand]').addEventListener('click', () => {
      openPromptFullscreen(Number(row.querySelector('[data-prompt-item-expand]').dataset.promptItemExpand));
    });
    row.querySelector('[data-prompt-item-remove]').addEventListener('click', () => {
      promptUI.items.splice(index, 1);
      if (!promptUI.items.length) promptUI.items.push({ title: '', text: '', duration: '5' });
      renderPromptItems();
    });
    wrap.appendChild(row);
  });
  const count = $('#promptItemCount');
  if (count) count.textContent = `${promptUI.items.length} 条`;
}

function addPromptItemRow() {
  if (promptUI.items.length >= PROMPT_MAX_ITEMS) { alert(`单条记录最多 ${PROMPT_MAX_ITEMS} 条提示词`); return; }
  promptUI.items.push({ title: '', text: '', duration: '5' });
  renderPromptItems();
  const rows = document.querySelectorAll('#promptItems .prompt-item-row');
  const last = rows[rows.length - 1];
  if (last) { last.querySelector('.prompt-item-text').focus(); last.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

async function savePromptRecord() {
  const name = $('#promptRecordName').value.trim();
  if (!name) { alert('记录名称不能为空'); $('#promptRecordName').focus(); return; }
  const items = promptUI.items
    .map((item) => ({
      title: String(item.title || '').trim(),
      text: String(item.text || '').trim(),
      duration: Number(item.duration) > 0 ? Number(item.duration) : null,
    }))
    .filter((item) => item.text);
  if (!items.length) { alert('至少填写一条提示词'); return; }
  try {
    const res = await fetch(`${settings.apiBase}/api/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: promptUI.editingId || '', name, items }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    closePromptDrawer();
    await openPrompts();
    showToast('提示词记录已保存', 'ok');
  } catch (err) {
    alert(`保存失败：${err.message}`);
  }
}

async function deletePromptRecord(id) {
  const record = state.prompts.find((item) => item.id === id);
  if (!record) return;
  const count = (record.items || []).length;
  if (!window.confirm(`确定删除记录「${record.name}」及其中的 ${count} 条提示词吗？`)) return;
  try {
    const res = await fetch(`${settings.apiBase}/api/prompts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    await openPrompts();
    showToast('记录已删除', 'ok');
  } catch (err) {
    alert(`删除失败：${err.message}`);
  }
}

async function openTokens() {
  showView('tokens');
  try {
    const res = await fetch(`${settings.apiBase}/api/tokens`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    state.tokens = data.tokens || [];
    state.tokensLoaded = true;
    renderTokens();
  } catch (err) { $('#tokenStatus').textContent = `读取令牌失败：${err.message}`; }
}

function renderTokens() {
  renderProviderOptions();
  const tbody = $('#tokenTable');
  if (!tbody) return;
  tbody.innerHTML = '';
  state.tokens.forEach((token) => {
    const bound = state.models.filter((model) => model.token_id === token.id).length;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${escapeHtml(token.name)}</b>${token.remark ? `<small class="token-remark">${escapeHtml(token.remark)}</small>` : ''}</td>
      <td>${escapeHtml(token.provider || '自定义')}</td>
      <td class="mono">${escapeHtml(token.masked)}</td>
      <td>${bound}</td>
      <td class="mono">${token.updated_at ? relativeTime(token.updated_at) : '—'}</td>
      <td class="col-actions"><div class="model-row-actions">
        <button type="button" class="model-action-button primary" data-token-edit="${escapeHtml(token.id)}">编辑</button>
        <button type="button" class="model-action-button" data-token-del="${escapeHtml(token.id)}">删除</button>
      </div></td>`;
    tr.title = '双击编辑名称、供应商、Key 和备注';
    tr.addEventListener('dblclick', () => editToken(token.id));
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('[data-token-edit]').forEach((button) => button.addEventListener('click', () => editToken(button.dataset.tokenEdit)));
  tbody.querySelectorAll('[data-token-del]').forEach((button) => button.addEventListener('click', () => deleteToken(button.dataset.tokenDel)));
}
function addToken() {
  const name = $('#tokenName').value.trim();
  const provider = $('#tokenProvider').value;
  const value = $('#tokenValue').value.trim();
  const remark = $('#tokenRemark').value.trim();
  if (!name || !value) return alert('令牌名称和 API Key 不能为空');
  fetch(`${settings.apiBase}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, provider, value, remark }) })
    .then(async (res) => {
      const data = await res.json();
      if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
      $('#tokenName').value = '';
      $('#tokenValue').value = '';
      $('#tokenRemark').value = '';
      await openTokens();
      showToast('令牌已添加，并已自动绑定到未配置令牌的模型', 'ok');
    })
    .catch((err) => alert(`添加失败：${err.message}`));
}
function editToken(id) {
  const token = state.tokens.find((item) => item.id === id);
  if (!token) return;
  $('#tokenEditName').value = token.name;
  $('#tokenEditProvider').value = token.provider || '自定义';
  const remarkInput = $('#tokenEditRemark');
  if (remarkInput) remarkInput.value = token.remark || '';
  $('#tokenEditValue').value = '';
  $('#tokenEditValue').placeholder = token.masked || '••••••••';
  const bound = state.models.filter((model) => model.token_id === id);
  const list = $('#tokenBoundModels');
  if (list) list.innerHTML = bound.length ? bound.map((model) => `<div class="token-bound-item">${escapeHtml(model.name)}</div>`).join('') : '<div class="token-bound-item">暂无绑定模型</div>';
  const backdrop = $('#tokenDrawerBackdrop');
  backdrop.hidden = false;
  backdrop.dataset.editId = id;
}
async function saveTokenEdit() {
  const backdrop = $('#tokenDrawerBackdrop');
  const id = backdrop.dataset.editId;
  const name = $('#tokenEditName').value.trim();
  const provider = $('#tokenEditProvider').value;
  const remark = $('#tokenEditRemark') ? $('#tokenEditRemark').value.trim() : '';
  const value = $('#tokenEditValue').value.trim();
  if (!name) return alert('令牌名称不能为空');
  const res = await fetch(`${settings.apiBase}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name, provider, remark, value }) });
  const data = await res.json();
  if (!data.ok) return alert(`保存失败：${data.msg}`);
  backdrop.hidden = true;
  await openTokens();
  showToast('令牌已更新', 'ok');
}
async function deleteToken(id) {
  const bound = state.models.filter((model) => model.token_id === id);
  const message = bound.length
    ? `该令牌正在被 ${bound.length} 个模型使用：\n${bound.map((m) => `· ${m.name}`).join('\n')}\n删除后这些模型将无法调用。确定删除吗？`
    : '确定删除这个令牌吗？';
  if (!window.confirm(message)) return;
  const res = await fetch(`${settings.apiBase}/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await res.json();
  if (!data.ok) return alert(`删除失败：${data.msg}`);
  await openTokens();
  showToast('令牌已删除', 'ok');
}
async function openAppSettingsPanel() {
  $('#settingNotify').checked = Boolean(appSettings.notifyOnFinish);
  $('#settingPollInterval').value = String(appSettings.pollIntervalSeconds);
  syncThemeSwitch();
  const desktopRows = $$('[data-desktop-only]');
  if (desktopBridge?.getAppSettings) {
    try {
      const cfg = await desktopBridge.getAppSettings();
      $('#settingOpenAtLogin').checked = Boolean(cfg.openAtLogin);
      $('#settingMinimizeToTray').checked = Boolean(cfg.minimizeToTray);
      desktopRows.forEach((row) => { row.hidden = false; });
    } catch (_) {
      desktopRows.forEach((row) => { row.hidden = true; });
    }
  } else {
    desktopRows.forEach((row) => { row.hidden = true; });
  }
  const status = $('#appSettingsStatus');
  if (status) status.textContent = '';
  try {
    const res = await fetch(`${settings.apiBase}/api/settings`);
    const data = await res.json();
    if (data.ok) $('#settingScheduleInterval').value = String(data.settings.schedule_interval_seconds);
  } catch (_) { /* 读取失败时保留空值 */ }
  await renderDownloadDirs();
  $('#appSettingsModal').hidden = false;
  document.body.classList.add('modal-open');
}

function closeAppSettingsPanel() {
  $('#appSettingsModal').hidden = true;
  document.body.classList.remove('modal-open');
}

async function saveScheduleIntervalSeconds(value) {
  const seconds = Math.round(Number(value));
  const status = $('#appSettingsStatus');
  const fail = (msg) => { if (status) { status.textContent = msg; status.style.color = 'var(--danger)'; } };
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) return fail('预约提交间隔必须是 1-600 的整数秒');
  try {
    const res = await fetch(`${settings.apiBase}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule_interval_seconds: seconds }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    if (status) { status.textContent = '预约提交间隔已保存'; status.style.color = 'var(--ok)'; }
  } catch (err) {
    fail(`保存失败：${err.message}`);
  }
}

// ---- 图片生成 ----
function selectedImageModel() {
  return state.models.find((model) => model.kind === 'image' && model.id === ($('#imageModelSelect')?.value || state.imageModelId));
}

function applySelectedImageModel() {
  const model = selectedImageModel();
  if (!model) return;
  state.imageModelId = model.id;
  renderGenFields('image', model);
  renderImagePricePanel();
}
function getImageParams(model) {
  const params = {};
  const values = genValues.image.values;
  const fields = Array.isArray(model.fields) ? model.fields : [];
  fields.forEach((field) => {
    if (!field || !field.key || field.key === 'reference_images') return;
    const raw = values[field.key] != null && values[field.key] !== '' ? values[field.key] : field.default;
    if (field.type === 'number') {
      if (raw != null && raw !== '' && Number.isFinite(Number(raw))) params[field.key] = Number(raw);
      return;
    }
    if (raw != null && raw !== '') params[field.key] = raw;
  });
  return params;
}
function renderImagePricePanel() {
  const model = selectedImageModel();
  const pricing = model ? model.pricing : null;
  const params = getImageParams(model || {});
  const big = $('#imageCurrentPrice');
  const lines = $('#imagePriceLines');
  if (!big) return;
  const showEmpty = (text) => {
    big.classList.add('is-empty');
    big.innerHTML = `<small>${escapeHtml(text)}</small>`;
    if (lines) lines.innerHTML = '';
  };
  big.classList.remove('is-empty');
  if (!pricing || (pricing.peak == null && pricing.valley == null && !pricing.by_resolution)) {
    showEmpty('当前模型未配置价格');
    return;
  }
  const symbol = priceSymbol(pricing);
  const size = typeof params.size === 'string' ? params.size : '';
  const rate = modelRateFor(pricing, size, new Date().toISOString());
  if (rate == null) { showEmpty(''); return; }
  const n = Math.max(1, Math.round(Number(params.n) || 1));
  big.innerHTML = `<b>${escapeHtml(symbol + (rate * n).toFixed(2))}</b>`
    + (size ? `<span class="price-tag">${escapeHtml(size)}</span>` : '')
    + `<small>${escapeHtml(`${symbol}${rate} / 张 × ${n} 张`)}</small>`;
  if (lines) {
    const rows = [
      ['尺寸', size || '默认'],
      ['数量', `${n} 张`],
      ['单价', `${symbol}${rate} / 张`],
    ];
    lines.innerHTML = rows.map(([key, value]) => `<div><span>${escapeHtml(key)}</span><b>${escapeHtml(value)}</b></div>`).join('');
  }
}
// 图片参数：旧的表单字段已由 genValues 驱动的参数字段替代
function imageFormParams() {
  return getImageParams(selectedImageModel() || {});
}

function imageFormParamsSnapshot() {
  return imageFormParams();
}

function saveImageForm() {
  const payload = {
    taskName: $('#imageTaskName')?.dataset.savedValue || $('#imageTaskName')?.value || '未命名图片任务',
    sequence: $('#imageTaskSequence')?.value || '1',
    modelId: $('#imageModelSelect')?.value || state.imageModelId || '',
    prompt: $('#imagePrompt')?.value || '',
    params: imageFormParamsSnapshot(),
  };
  try { localStorage.setItem(IMAGE_FORM_KEY, JSON.stringify(payload)); } catch (_) { /* 保存失败不影响使用 */ }
}

function restoreImageForm() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(IMAGE_FORM_KEY) || '{}'); } catch (_) { saved = {}; }
  if (typeof saved.taskName === 'string' && saved.taskName.trim()) $('#imageTaskName').value = saved.taskName.trim();
  $('#imageTaskName').dataset.savedValue = $('#imageTaskName').value.trim() || '未命名图片任务';
  if (saved.sequence != null) $('#imageTaskSequence').value = String(saved.sequence);
  if (typeof saved.modelId === 'string' && saved.modelId && state.models.some((model) => model.kind === 'image' && model.id === saved.modelId)) {
    $('#imageModelSelect').value = saved.modelId;
    state.imageModelId = saved.modelId;
    applySelectedImageModel();
  }
  if (typeof saved.prompt === 'string') $('#imagePrompt').value = saved.prompt;
  if (saved.params && typeof saved.params === 'object') {
    genValues.image.values = { ...genValues.image.values, ...saved.params };
    saveGenValues();
    renderGenFields('image', selectedImageModel() || {});
  }
  renderImagePricePanel();
}

function imageRefCount() {
  return state.imageRefItems.filter((item) => item.value.trim()).length;
}

function renderImageRefInputs() {
  const wrap = $('#imageRefLinks');
  if (!wrap) return;
  wrap.innerHTML = '';
  const links = state.imageRefItems.filter((item) => item.kind === 'link');
  if (!links.length) {
    state.imageRefItems.unshift({ id: imageId('link'), kind: 'link', value: '' });
    return renderImageRefInputs();
  }
  links.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'image-link-row';
    const label = document.createElement('span');
    label.className = 'image-link-label';
    label.textContent = i === 0 ? '参考图链接' : `链接 ${i + 1}`;
    const input = document.createElement('input');
    input.value = item.value;
    input.placeholder = '输入图片 URL 或 base64';
    input.type = 'text';
    input.addEventListener('input', (event) => { item.value = event.target.value; renderImageRefPreviews(); saveImageRefDraftSoon(); });
    const remove = document.createElement('button');
    remove.className = 'remove-image-link';
    remove.type = 'button';
    remove.title = '删除图片链接';
    remove.textContent = '×';
    remove.disabled = links.length === 1;
    remove.addEventListener('click', () => {
      state.imageRefItems = state.imageRefItems.filter((candidate) => candidate.id !== item.id);
      renderImageRefInputs();
      renderImageRefPreviews();
      saveImageRefDraftSoon();
    });
    row.append(label, input, remove);
    wrap.appendChild(row);
  });
  updateImageRefMeta();
}

function renderImageRefPreviews() {
  const wrap = $('#imageRefPreviews');
  if (!wrap) return;
  wrap.innerHTML = '';
  state.imageRefItems.filter((item) => item.value.trim()).forEach((item) => {
    const tile = document.createElement('div');
    tile.className = 'image-preview-tile';
    const image = document.createElement('img');
    image.src = item.kind === 'file' || /^(https?:|data:|blob:)/i.test(item.value) ? item.value : `data:image/png;base64,${item.value}`;
    image.alt = item.name || '参考图';
    const remove = document.createElement('button');
    remove.className = 'image-preview-remove';
    remove.type = 'button';
    remove.title = '删除图片';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      state.imageRefItems = state.imageRefItems.filter((candidate) => candidate.id !== item.id);
      renderImageRefInputs();
      renderImageRefPreviews();
      saveImageRefDraftSoon();
    });
    tile.append(image, remove);
    wrap.appendChild(tile);
  });
  updateImageRefMeta();
}

function updateImageRefMeta() {
  const count = imageRefCount();
  const note = $('#imageRefNote');
  if (note) note.textContent = count >= 10 ? '已达到 10 张上限，可删除后重新添加。' : '支持 JPG / PNG / WebP，可多选本地图片；添加参考图后按图生图方式生成。';
}

async function addImageRefFiles(event) {
  const files = filesFromEvent(event)
    .filter((file) => ['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    .slice(0, 10 - imageRefCount());
  if (!files.length) { showToast('未识别到可用的图片（支持 JPG / PNG / WebP）', 'error'); return; }
  if (files.length) {
    const values = await Promise.all(files.map((file) => readImageFile(file)));
    values.forEach((value, i) => state.imageRefItems.push({ id: imageId('file'), kind: 'file', value, name: files[i].name }));
    renderImageRefPreviews();
    saveImageRefDraftSoon();
  }
  if (event.target && 'value' in event.target) event.target.value = '';
}

async function writeImageRefDraft() {
  const db = await openFormDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(FORM_DB_STORE, 'readwrite');
    transaction.objectStore(FORM_DB_STORE).put(state.imageRefItems.map(({ id, kind, value, name }) => ({ id, kind, value, name })), 'image-refs');
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function readImageRefDraft() {
  const db = await openFormDb();
  const result = await new Promise((resolve, reject) => {
    const request = db.transaction(FORM_DB_STORE).objectStore(FORM_DB_STORE).get('image-refs');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return Array.isArray(result) ? result : null;
}

let imageRefDraftTimer = null;
function saveImageRefDraftSoon() {
  clearTimeout(imageRefDraftTimer);
  imageRefDraftTimer = setTimeout(() => { writeImageRefDraft().catch((err) => console.warn('参考图草稿保存失败', err)); }, 250);
}

function clearImageRefDraft() {
  state.imageRefItems = [{ id: imageId('link'), kind: 'link', value: '' }];
  clearTimeout(imageRefDraftTimer);
  openFormDb().then(async (db) => {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(FORM_DB_STORE, 'readwrite');
      transaction.objectStore(FORM_DB_STORE).delete('image-refs');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }).catch(() => {});
  renderImageRefInputs();
  renderImageRefPreviews();
}

function initializeImageFormDraft() {
  readImageRefDraft().then((refs) => {
    if (refs && refs.length) {
      state.imageRefItems = refs.slice(0, 10).map((item, i) => ({
        id: String(item.id || `link-${i}`),
        kind: item.kind === 'file' ? 'file' : 'link',
        value: String(item.value || ''),
        name: String(item.name || ''),
      }));
    }
    renderImageRefInputs();
    renderImageRefPreviews();
  }).catch(() => {
    renderImageRefInputs();
    renderImageRefPreviews();
  });
  restoreImageForm();
  saveImageForm();
}

function imageTaskFromRecord(record) {
  return {
    id: record.local_id,
    kind: 'image',
    name: record.name || '图片任务',
    prompt: record.prompt || '',
    status: record.status || 'processing',
    image_files: record.image_files || null,
    image_count: record.image_count || 0,
    model_id: record.model_id,
    model_name: record.model_name,
    resolution: '',
    created_at: record.created_at,
    submitted_at: record.submitted_at || record.created_at,
    time: taskTime(record.created_at),
  };
}

async function submitImageBatch() {
  const model = selectedImageModel();
  if (!model) { alert('请选择生图模型'); return; }
  const taskName = ($('#imageTaskName').value || '未命名图片任务').trim() || '未命名图片任务';
  const sequence = Number($('#imageTaskSequence').value);
  if (!Number.isInteger(sequence) || sequence < 1) { alert('序号必须是从 1 开始的整数'); $('#imageTaskSequence').focus(); return; }
  const prompt = ($('#imagePrompt').value || '').trim();
  if (!prompt) { alert('请填写提示词'); $('#imagePrompt').focus(); return; }
  const params = getImageParams(model);
  const refs = state.imageRefItems.filter((item) => item.value.trim()).map((item) => item.value.trim());
  $('#submitImageBatch').disabled = true;
  try {
    const res = await fetch(`${settings.apiBase}/api/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${taskName}_${sequence}`,
        model_id: model.id,
        tasks: [{ prompt, params, ...(refs.length ? { reference_images: refs } : {}) }],
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    (data.tasks || []).forEach((record) => {
      state.tasks.unshift({
        id: record.local_id,
        kind: 'image',
        name: record.name,
        prompt: record.prompt || '',
        status: record.status || 'processing',
        image_files: record.image_files || null,
        image_count: record.image_count || 0,
        params: record.params || params,
        model_id: record.model_id,
        model_name: record.model_name,
        cost: typeof record.cost === 'number' ? record.cost : null,
        cost_currency: record.cost_currency || 'CNY',
        created_at: record.created_at,
        time: taskTime(record.created_at),
      });
      if (record.local_id) pollTask(record.local_id);
    });
    renderTasks();
    $('#imageTaskSequence').value = String(sequence + 1);
    saveImageForm();
    showToast(`已提交生成（${(data.tasks || []).length} 张）`, 'ok');
  } catch (err) {
    alert(`提交失败：${err.message}`);
  } finally {
    $('#submitImageBatch').disabled = false;
  }
}
// 清空视频表单：仅清除提示词与已填写的参考图片，时长/分辨率等参数保持不变
function clearVideoForm() {
  const promptEl = $('#prompt');
  if (promptEl) { promptEl.value = ''; updateCharCount('prompt'); }
  state.imageItems = [{ id: 'link-0', kind: 'link', value: '' }];
  const upload = $('#localImageUpload');
  if (upload) upload.value = '';
  renderImageInputs();
  renderImagePreviews();
  updateImageMeta();
  saveForm();
  renderCurrentPrice();
  showToast('已清空提示词与参考图片', 'ok');
}

function clearImageForm() {
  $('#imagePrompt').value = '';
  genValues.image.values = {};
  saveGenValues();
  clearImageRefDraft();
  renderGenFields('image', selectedImageModel() || {});
  renderImagePricePanel();
  updateCharCount('imagePrompt');
}
async function downloadImageTask(task) {
  const files = task.image_files || [];
  if (!files.length) { alert('该任务还没有生成的图片'); return; }
  const safeName = String(task.name || task.id).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80);
  for (let i = 0; i < files.length; i += 1) {
    const ext = String(files[i]).split('.').pop() || 'png';
    try {
      const res = await fetch(`${settings.apiBase}/api/tasks/${encodeURIComponent(task.id)}/image/${i}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (desktopBridge?.saveFile) {
        let directory = await resolveDownloadDir('image');
        if (!directory?.path) {
          directory = await chooseDownloadDirectory('image');
          if (!directory?.path) return;
        }
        const saved = await desktopBridge.saveFile({ directory: directory.path, name: `${safeName}_${i + 1}.${ext}`, data: await blob.arrayBuffer() });
        rememberTaskFile(task, saved?.path);
      } else {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${safeName}_${i + 1}.${ext}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      }
    } catch (err) {
      alert(`下载图片失败：${err.message}`);
      return;
    }
  }
  showToast(`已下载 ${files.length} 张图片`, 'ok');
}

// 用量统计：总花费 / 本月花费 / 本月任务与成功率 / 按模型花费
function renderUsageStats() {
  const totalEl = $('#statTotalCost');
  if (!totalEl) return;
  const scoped = taskCenterScoped();
  const monthKey = (beijingDayKey(new Date().toISOString()) || '').slice(0, 7);
  const monthTasks = scoped.filter((task) => (beijingDayKey(task.created_at) || '').slice(0, 7) === monthKey);
  const sumCosts = (tasks) => {
    const sums = {};
    tasks.forEach((task) => {
      if (typeof task.cost !== 'number') return;
      const cur = task.cost_currency === 'USD' ? 'USD' : 'CNY';
      sums[cur] = Math.round(((sums[cur] || 0) + task.cost) * 100) / 100;
    });
    return Object.entries(sums).map(([cur, value]) => `${cur === 'USD' ? '$' : '¥'}${value.toFixed(2)}`).join(' + ') || null;
  };
  totalEl.textContent = sumCosts(scoped) || '—';
  const monthEl = $('#statMonthCost');
  if (monthEl) monthEl.textContent = sumCosts(monthTasks) || '—';
  const table = $('#usageModelTable');
  if (!table) return;
  const byModel = new Map();
  scoped.forEach((task) => {
    if (typeof task.cost !== 'number') return;
    const key = task.model_id || task.model_name || '未知模型';
    const entry = byModel.get(key) || { name: task.model_name || key, count: 0, sums: {} };
    entry.count += 1;
    const cur = task.cost_currency === 'USD' ? 'USD' : 'CNY';
    entry.sums[cur] = Math.round(((entry.sums[cur] || 0) + task.cost) * 100) / 100;
    byModel.set(key, entry);
  });
  table.innerHTML = [...byModel.values()].map((entry) => `<tr><td>${escapeHtml(entry.name)}</td><td>${entry.count}</td><td>${Object.entries(entry.sums).map(([cur, value]) => `${cur === 'USD' ? '$' : '¥'}${value.toFixed(2)}`).join(' + ')}</td></tr>`).join('') || '<tr><td colspan="3" class="usage-empty">暂无花费数据，新提交的任务完成后会计入</td></tr>';
}
const GROUP_KEYS = { tasks: 'wenvedio-tasks-group-collapsed', admin: 'wenvedio-admin-group-collapsed', ai: 'wenvedio-ai-group-collapsed' };
const GROUP_DOM = {
  tasks: { group: '#tasksGroup', nav: '#navTasks' },
  admin: { group: '#adminGroup', nav: '#navAdmin' },
  ai: { group: '#aiGroup', nav: '#navAi' },
};

function isGroupCollapsed(name) {
  try { return localStorage.getItem(GROUP_KEYS[name]) === 'true'; } catch (_) { return false; }
}

function applyGroupCollapsed(name, collapsed) {
  $('#sidebar').classList.toggle(`${name}-collapsed`, collapsed);
  const dom = GROUP_DOM[name];
  const chevron = dom ? $(dom.nav + ' .nav-chevron') : null;
  if (chevron) chevron.textContent = collapsed ? '⌄' : '⌃';
}

function toggleGroupCollapse(name) {
  const collapsed = !isGroupCollapsed(name);
  try { localStorage.setItem(GROUP_KEYS[name], String(collapsed)); } catch (_) { /* 忽略 */ }
  applyGroupCollapsed(name, collapsed);
}

// 跳转到某个分组内的页面时自动展开该分组
function expandGroup(name) {
  if (!isGroupCollapsed(name)) return;
  try { localStorage.setItem(GROUP_KEYS[name], 'false'); } catch (_) { /* 忽略 */ }
  applyGroupCollapsed(name, false);
}

// 图片任务 / 视频任务 / 全部：各自独立页面
function setRecordsKind(kind) {
  state.recordsKind = kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'all';
  syncRecordsKindHighlight();
  renderTasks();
  showView('tasks');
}
// 子菜单高亮：汇总任务 / 图片任务 / 视频任务 三选一
function syncRecordsKindHighlight() {
  const map = { all: 'navTasksAll', image: 'navTasksImage', video: 'navTasksVideo' };
  const activeId = map[state.recordsKind] || 'navTasksAll';
  $$('.nav-sub-item').forEach((item) => item.classList.toggle('active', item.id === activeId));
}

function showView(view) {
  const isQuery = view === 'query';
  const isImage = view === 'image';
  const isRecords = view === 'tasks';
  const isSettings = view === 'settings';
  const isTokens = view === 'tokens';
  const isPrompts = view === 'prompts';
  const imageView = $('#imageView');
  const workspaceView = $('#workspaceView');
  const recordsView = $('#recordsView');
  const queryView = $('#queryView');
  const settingsView = $('#settingsView');
  const tokensView = $('#tokensView');
  const promptsView = $('#promptsView');
  const pageEyebrow = $('#pageEyebrow');
  workspaceView.hidden = isQuery || isRecords || isSettings || isTokens || isPrompts || isImage;
  imageView.hidden = !isImage;
  recordsView.hidden = !isRecords;
  queryView.hidden = !isQuery;
  settingsView.hidden = !isSettings;
  tokensView.hidden = !isTokens;
  promptsView.hidden = !isPrompts;
  // 页面标题由各视图内的 h2 承担，顶栏只留一行面包屑，避免同一句话出现两三次
  const crumbs = {
    image: 'AI 工具 / 图片生成',
    workspace: 'AI 工具 / 视频生成',
    tasks: '任务记录',
    query: '查询入口',
    settings: '后台管理 / 模型管理',
    tokens: '后台管理 / 令牌管理',
    prompts: '提示词管理',
  };
  if (pageEyebrow) pageEyebrow.textContent = crumbs[view] || crumbs.workspace;
  $$('.main-nav .nav-item, .main-nav .nav-sub-item').forEach((item) => item.classList.remove('active'));
  const activeId = isImage ? 'navImage' : isQuery ? 'navQuery' : isSettings ? 'openSettings' : isTokens ? 'openTokens' : isPrompts ? 'openPrompts' : isRecords ? '' : 'navWorkspace';
  const activeEl = activeId ? $(`#${activeId}`) : null;
  if (activeEl) activeEl.classList.add('active');
  if (isRecords) { expandGroup('tasks'); syncRecordsKindHighlight(); }
  if (isImage || (!isQuery && !isRecords && !isSettings && !isTokens && !isImage)) expandGroup('ai');
  if (isSettings || isTokens) expandGroup('admin');
  $$('.mobile-nav button').forEach((item) => item.classList.remove('active'));
  $(`#${isImage ? 'mobileImage' : isQuery ? 'mobileQuery' : isRecords ? 'mobileTasks' : (isSettings || isTokens) ? 'mobileApi' : 'mobileWorkspace'}`).classList.add('active');
  // 内容区是独立滚动容器（标题栏固定），所以滚它而不是 window
  const scroller = document.querySelector('.main-content');
  if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
  else window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initializeSidebar() {
  const collapsed = localStorage.getItem('wenvedio-sidebar-collapsed') === 'true';
  $('#sidebar').classList.toggle('collapsed', collapsed);
  // 折叠按钮画在标题栏上，不在 sidebar 内部，所以状态同时挂到 body
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  $('#sidebarToggle').title = collapsed ? '展开侧边栏' : '收起侧边栏';
  $('#sidebarToggle').setAttribute('aria-label', $('#sidebarToggle').title);
}

function toggleSidebar() {
  const collapsed = $('#sidebar').classList.toggle('collapsed');
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  localStorage.setItem('wenvedio-sidebar-collapsed', String(collapsed));
  $('#sidebarToggle').title = collapsed ? '展开侧边栏' : '收起侧边栏';
  $('#sidebarToggle').setAttribute('aria-label', $('#sidebarToggle').title);
}

// 打开任务文件的所在位置：已下载则定位到文件，否则打开该类型下载目录
async function showTaskFileLocation(task) {
  if (!task) return;
  if (!desktopBridge?.reveal) { alert('仅桌面客户端支持打开文件位置。'); return; }
  const kind = task.kind === 'image' ? 'image' : 'video';
  const directory = await resolveDownloadDir(kind);
  const localPath = (task.localPaths || [])[0] || '';
  const result = await desktopBridge.reveal({ path: localPath, directory: directory?.path || '' });
  if (!result?.ok) alert(result?.msg || '打开文件位置失败');
}

let taskDrawerCurrentId = null;
function openTaskDetailDrawer(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  taskDrawerCurrentId = id;
  $('#taskDrawerName').textContent = task.name || '任务详情';
  $('#taskDrawerId').textContent = task.id;
  const statusMeta = {
    completed: ['已完成', 'enabled'], processing: ['生成中', 'enabled'], queued: ['排队中', 'enabled'],
    submitting: ['提交中', 'enabled'], scheduled: ['已预约', 'enabled'], failed: ['失败', 'failed'], timeout: ['失败', 'failed'], expired: ['已过期', 'failed'],
  }[taskStatus(task)] || ['—', 'enabled'];
  const statusEl = $('#taskDrawerStatus');
  statusEl.className = `state ${statusMeta[1]}`;
  statusEl.innerHTML = `<i></i>${statusMeta[0]}`;
  $('#taskDrawerPreview').innerHTML = taskPreviewHtml(task);
  $('#taskDrawerPrompt').textContent = task.prompt || '—';
  const facts = [];
  facts.push(['类型', task.kind === 'image' ? '图片生成' : '视频生成']);
  facts.push(['模型', task.model_name || task.model_id || '—']);
  if (task.kind === 'image') {
    facts.push(['尺寸', (task.params && task.params.size) || '—']);
    facts.push(['数量', String((task.image_files || []).length || (task.params && task.params.n) || '—')]);
  } else {
    facts.push(['分辨率', task.resolution || '—']);
    facts.push(['时长', task.duration ? `${task.duration} 秒` : '—']);
    if (task.seed != null) facts.push(['seed', String(task.seed)]);
  }
  if (typeof task.cost === 'number') facts.push(['费用', formatTaskCost(task)]);
  facts.push(['创建时间', task.created_at ? taskTime(task.created_at) : '—']);
  if (task.completed_at) facts.push(['完成时间', taskTime(task.completed_at)]);
  if (task.error) facts.push(['错误', task.error]);
  $('#taskDrawerFacts').innerHTML = facts.map(([k, v]) => `<div class="task-fact"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`).join('');
  const errorGroup = $('#taskDrawerErrorGroup');
  if (errorGroup) errorGroup.hidden = !task.error;
  $('#taskDrawerError').textContent = task.error || '';
  const downloadable = task.status === 'completed' && (task.kind === 'image' ? (task.image_files || []).length : task.video_url);
  $('#taskDrawerDownload').hidden = !downloadable;
  $('#taskDrawerRetry').hidden = !['failed', 'timeout', 'expired'].includes(taskStatus(task));
  const note = $('#taskDrawerFootNote');
  if (note) note.textContent = task.kind === 'image' && (task.image_files || []).length > 1 ? `共 ${(task.image_files || []).length} 张图片，下载将逐张保存` : '';
  $('#taskDrawerBackdrop').hidden = false;
}
function closeTaskDetail() {
  $('#taskDrawerBackdrop').hidden = true;
  taskDrawerCurrentId = null;
}
function downloadFromTaskDrawer() {
  const task = state.tasks.find((t) => t.id === taskDrawerCurrentId);
  if (!task) return;
  if (task.kind === 'image') downloadImageTask(task);
  else downloadTasks([task]);
}
function retryFromTaskDrawer() {
  const task = state.tasks.find((t) => t.id === taskDrawerCurrentId);
  if (!task) return;
  closeTaskDetail();
  retryTask(task);
}
function showToast(message, type = 'ok') {
  const wrap = $('#toastWrap');
  if (!wrap) return;
  const life = type === 'error' ? 6000 : 4200;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.style.setProperty('--toast-life', `${life}ms`);
  toast.textContent = message;
  wrap.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 700);
  }, life);
}

document.addEventListener('DOMContentLoaded', () => {
  // 平台类名：macOS 的红绿灯在左上角，标题栏需要给它留位置
  if (desktopBridge?.platform) document.body.classList.add(`is-${desktopBridge.platform}`);
  // 主题：内联脚本已定好首帧，这里只同步按钮状态并接上切换事件
  applyTheme();
  const themeSwitch = $('#themeSwitch');
  if (themeSwitch) {
    themeSwitch.addEventListener('click', (event) => {
      const button = event.target.closest('[data-theme-set]');
      if (button) setThemeMode(button.dataset.themeSet);
    });
  }
  startServiceWatch();
  loadGenValues();
  loadTasks();
  initializeSidebar();
  applyGroupCollapsed('ai', isGroupCollapsed('ai'));
  applyGroupCollapsed('tasks', isGroupCollapsed('tasks'));
  applyGroupCollapsed('admin', isGroupCollapsed('admin'));
  showView('workspace');

  // 视频生成
  $('#modelSelect').addEventListener('change', () => { applySelectedModel(); saveForm(); updateGenStatCards(); });
  $('#clearVideoForm').addEventListener('click', clearVideoForm);
  $('#submitBatch').addEventListener('click', submitBatch);
  $('#scheduleSubmit').addEventListener('change', () => { saveForm(); syncVideoSubmitLabel(); });
  $('#videoSeed').addEventListener('input', () => { genValues.video.values.seed = $('#videoSeed').value; saveGenValues(); });
  // 图片生成
  $('#submitImageBatch').addEventListener('click', submitImageBatch);
  $('#imageModelSelect').addEventListener('change', () => { applySelectedImageModel(); saveImageForm(); });
  $('#imagePrompt').addEventListener('input', () => { updateCharCount('imagePrompt'); saveImageForm(); });
  $('#imageTaskName').addEventListener('input', saveImageForm);
  $('#imageTaskSequence').addEventListener('input', saveImageForm);
  $('#clearImageForm').addEventListener('click', clearImageForm);
  $('#imageHelpBtn').addEventListener('click', () => showToast('使用更具体的提示词，可以获得更稳定的生成效果。添加参考图后按图生图方式生成。', 'ok'));
  $('#videoHelpBtn').addEventListener('click', () => showToast('使用清晰主体和连续场景描述，视频稳定性更好。', 'ok'));
  // 参考图上传（图片页 + 视频页拖拽上传区）
  $('#imageRefUpload').addEventListener('change', addImageRefFiles);
  $('#imageRefDropzone').addEventListener('click', () => $('#imageRefUpload').click());
  ['dragover', 'dragenter'].forEach((type) => $('#imageRefDropzone').addEventListener(type, (event) => { event.preventDefault(); $('#imageRefDropzone').classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((type) => $('#imageRefDropzone').addEventListener(type, (event) => { event.preventDefault(); $('#imageRefDropzone').classList.remove('dragging'); }));
  $('#imageRefDropzone').addEventListener('drop', addImageRefFiles);
  $('#localImageUpload').addEventListener('change', addLocalImages);
  $('#refDropzone').addEventListener('click', () => $('#localImageUpload').click());
  ['dragover', 'dragenter'].forEach((type) => $('#refDropzone').addEventListener(type, (event) => { event.preventDefault(); $('#refDropzone').classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((type) => $('#refDropzone').addEventListener(type, (event) => { event.preventDefault(); $('#refDropzone').classList.remove('dragging'); }));
  $('#refDropzone').addEventListener('drop', addLocalImages);
  $('#addImageLink').addEventListener('click', addImageLink);

  // 任务中心
  $('#downloadSelected').addEventListener('click', downloadSelected);
  $('#deleteSelected').addEventListener('click', () => deleteTasks([...state.selected]));
  $('#tcSearch').addEventListener('input', () => { state.tc.search = $('#tcSearch').value; renderTaskCenter(); });
  $('#tcModel').addEventListener('change', () => { state.tc.model = $('#tcModel').value; renderTaskCenter(); });
  $('#tcDate').addEventListener('change', () => { state.tc.date = $('#tcDate').value; renderTaskCenter(); });
  $$('.tc-tabs [data-tc-filter]').forEach((button) => button.addEventListener('click', () => {
    state.tc.filter = button.dataset.tcFilter;
    $$('.tc-tabs [data-tc-filter]').forEach((b) => b.classList.toggle('active', b === button));
    renderTaskCenter();
  }));
  $('#selectAll').addEventListener('change', (event) => {
    filterTaskCenter().forEach((task) => {
      if (event.target.checked) state.selected.add(task.id);
      else state.selected.delete(task.id);
    });
    renderTaskCenter();
    updateSelection();
  });

  // 模型管理
  // 模型列表工具栏：搜索 / 类型 / 供应商 / 状态 / 排序 / 每页条数和批量操作
  $('#modelSearch').addEventListener('input', () => { modelUI.search = $('#modelSearch').value; modelUI.page = 1; renderModelTable(); });
  $('#modelFilterKind').addEventListener('change', () => { modelUI.kind = $('#modelFilterKind').value; modelUI.page = 1; renderModelTable(); });
  $('#modelFilterProvider').addEventListener('change', () => { modelUI.provider = $('#modelFilterProvider').value; modelUI.page = 1; renderModelTable(); });
  $('#modelFilterStatus').addEventListener('change', () => { modelUI.status = $('#modelFilterStatus').value; modelUI.page = 1; renderModelTable(); });
  $('#modelFilterToken').addEventListener('change', () => { modelUI.token = $('#modelFilterToken').value; modelUI.page = 1; renderModelTable(); });
  $('#modelSort').addEventListener('change', () => { modelUI.sort = $('#modelSort').value; modelUI.page = 1; renderModelTable(); });
  $('#modelPageSize').addEventListener('change', () => { modelUI.pageSize = Number($('#modelPageSize').value) || 10; modelUI.page = 1; renderModelTable(); });
  $('#modelSelectAll').addEventListener('change', (event) => {
    document.querySelectorAll('#modelTableBody [data-model-check]').forEach((input) => {
      input.checked = event.target.checked;
      if (input.checked) modelUI.selected.add(input.dataset.modelCheck);
      else modelUI.selected.delete(input.dataset.modelCheck);
      input.closest('tr').classList.toggle('selected', input.checked);
    });
    renderModelBatchBar();
  });
  $('#modelBatchEnable').addEventListener('click', () => batchUpdateEnabled(true));
  $('#modelBatchDisable').addEventListener('click', () => batchUpdateEnabled(false));
  $('#modelBatchDelete').addEventListener('click', batchDeleteSelected);
  $('#openSettings').addEventListener('click', openSettings);
  $('#addModel').addEventListener('click', () => openModelDrawer(null));
  // AI 自动配置
  $('#autoConfigModel').addEventListener('click', openAutoConfigPanel);
  $('#closeAutoConfig').addEventListener('click', closeAutoConfigPanel);
  $('#cancelAutoConfig').addEventListener('click', closeAutoConfigPanel);
  $('#autoConfigBackdrop').addEventListener('click', (event) => { if (event.target === $('#autoConfigBackdrop')) closeAutoConfigPanel(); });
  $('#runAutoConfig').addEventListener('click', runAutoConfig);
  const autoNameInput = $('#autoModelName');
  if (autoNameInput) autoNameInput.addEventListener('input', renderAutoNameHint);
  ['autoDocUrl', 'autoModelName', 'autoApiKey'].forEach((id) => {
    const el = $(`#${id}`);
    if (el) el.addEventListener('keydown', (event) => { if (event.key === 'Enter') runAutoConfig(); });
  });
  $('#saveSettings').addEventListener('click', saveSettings);
  $('#deleteModel').addEventListener('click', deleteModelFromDrawer);
  $('#closeModelEditor').addEventListener('click', requestCloseModelDrawer);
  $('#cancelModelEditor').addEventListener('click', requestCloseModelDrawer);
  $('#modelEditorBackdrop').addEventListener('click', (event) => { if (event.target === $('#modelEditorBackdrop')) requestCloseModelDrawer(); });
  $('#modelDrawer').addEventListener('input', () => { modelUI.dirty = true; const pane = $('#modelDrawer').querySelector('[data-model-pane="pricing"]'); if (pane && !pane.hidden) renderPricingPreview(); });
  $('#modelDrawer').addEventListener('change', () => { modelUI.dirty = true; });
  $('#modelTagAdd').addEventListener('click', () => { addModelTag($('#modelTagInput').value); $('#modelTagInput').value = ''; });
  $('#modelTagInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
      event.preventDefault();
      addModelTag($('#modelTagInput').value);
      $('#modelTagInput').value = '';
    }
  });
  $('#modelTagInput').addEventListener('blur', () => {
    if ($('#modelTagInput').value.trim()) { addModelTag($('#modelTagInput').value); $('#modelTagInput').value = ''; }
  });
  $('#modelTagChips').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tag-remove]');
    if (!button) return;
    modelUI.drawerTags.splice(Number(button.dataset.tagRemove), 1);
    markDrawerDirty();
    renderModelTagChips();
  });
  $$('.drawer-tabs [data-model-tab]').forEach((button) => button.addEventListener('click', () => setDrawerTab(button.dataset.modelTab)));
  $('#toggleFieldsJson').addEventListener('click', () => setFieldsMode(modelUI.fieldsMode === 'visual' ? 'json' : 'visual'));
  $('#formatFieldsJson').addEventListener('click', () => {
    try { $('#modelFields').value = JSON.stringify(JSON.parse($('#modelFields').value), null, 2); showFieldsJsonError(''); }
    catch (err) { showFieldsJsonError(`JSON 无效：${err.message}`); }
  });
  $('#validateFieldsJson').addEventListener('click', () => {
    try { JSON.parse($('#modelFields').value); showFieldsJsonError(''); }
    catch (err) { showFieldsJsonError(`JSON 无效：${err.message}`); }
  });
  $('#restoreFieldsJson').addEventListener('click', () => { $('#modelFields').value = modelUI.loadedFieldsSnapshot; showFieldsJsonError(''); });
  $('#copyFieldsJson').addEventListener('click', () => {
    navigator.clipboard.writeText($('#modelFields').value).then(() => showFieldsJsonError('已复制到剪贴板')).catch(() => {});
  });
  $('#addField').addEventListener('click', () => {
    modelUI.drawerFields.push({ key: `field_${Date.now().toString(36)}`, label: '新字段', type: 'text' });
    markDrawerDirty();
    renderFieldBuilder();
    const cards = document.querySelectorAll('#fieldBuilder .field-card');
    const last = cards[cards.length - 1];
    if (last) { last.querySelector('[data-field-edit]').click(); last.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  });
  $('#addPriceRes').addEventListener('click', addPriceResRowFromButton);
  $('#priceTierEnabled').addEventListener('change', () => { markDrawerDirty(); syncPricingPaneVisibility(); renderPricingPreview(); });
  $('#priceResEnabled').addEventListener('change', () => { markDrawerDirty(); syncPricingPaneVisibility(); renderPricingPreview(); });
  $('#pricingUnit').addEventListener('change', () => { markDrawerDirty(); syncPricingPaneVisibility(); renderPricingPreview(); });
  $('#disableModelBtn').addEventListener('click', () => { $('#advEnabled').checked = false; saveSettings(); });

  // 令牌管理
  $('#openTokens').addEventListener('click', openTokens);
  $('#saveToken').addEventListener('click', addToken);
  $('#closeTokenDrawer').addEventListener('click', () => { $('#tokenDrawerBackdrop').hidden = true; });
  $('#cancelTokenEdit').addEventListener('click', () => { $('#tokenDrawerBackdrop').hidden = true; });
  $('#saveTokenEdit').addEventListener('click', saveTokenEdit);
  $('#tokenDrawerBackdrop').addEventListener('click', (event) => { if (event.target === $('#tokenDrawerBackdrop')) $('#tokenDrawerBackdrop').hidden = true; });

  // 提示词管理
  $('#openPrompts').addEventListener('click', (event) => { event.preventDefault(); openPrompts(); });
  $('#expandAllPrompts').addEventListener('click', expandAllPrompts);
  $('#collapseAllPrompts').addEventListener('click', collapseAllPrompts);
  $('#addPromptRecord').addEventListener('click', () => openPromptDrawer(null));
  $('#addPromptItem').addEventListener('click', addPromptItemRow);
  $('#savePromptRecord').addEventListener('click', savePromptRecord);
  $('#closePromptDrawer').addEventListener('click', closePromptDrawer);
  $('#cancelPromptDrawer').addEventListener('click', closePromptDrawer);
  $('#promptDrawerBackdrop').addEventListener('click', (event) => { if (event.target === $('#promptDrawerBackdrop')) closePromptDrawer(); });
  $('#promptFullscreenSave').addEventListener('click', savePromptFullscreen);
  $('#promptFullscreenCancel').addEventListener('click', closePromptFullscreen);
  $('#promptFullscreenClose').addEventListener('click', closePromptFullscreen);
  $('#promptFullscreenText').addEventListener('input', updatePromptFullscreenCount);
  $('#promptFullscreenText').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); savePromptFullscreen(); }
  });
  $('#promptFullscreen').addEventListener('click', (event) => { if (event.target === $('#promptFullscreen')) closePromptFullscreen(); });
  bindPromptRecords();

  // 应用设置
  $('#openAppSettings').addEventListener('click', openAppSettingsPanel);
  $('#closeAppSettings').addEventListener('click', closeAppSettingsPanel);
  $('#appSettingsModal').addEventListener('click', (event) => { if (event.target === $('#appSettingsModal')) closeAppSettingsPanel(); });
  $('#settingOpenAtLogin').addEventListener('change', async (event) => { if (desktopBridge?.setAppSettings) await desktopBridge.setAppSettings({ openAtLogin: event.target.checked }); });
  $('#settingMinimizeToTray').addEventListener('change', async (event) => { if (desktopBridge?.setAppSettings) await desktopBridge.setAppSettings({ minimizeToTray: event.target.checked }); });
  $('#settingNotify').addEventListener('change', async (event) => {
    saveAppSettings({ notifyOnFinish: event.target.checked });
    if (event.target.checked && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      try { await Notification.requestPermission(); } catch (_) { /* 用户拒绝通知 */ }
    }
  });
  $('#settingPollInterval').addEventListener('change', (event) => saveAppSettings({ pollIntervalSeconds: Number(event.target.value) || 60 }));
  $('#settingScheduleInterval').addEventListener('change', (event) => saveScheduleIntervalSeconds(event.target.value));
  $('#chooseVideoDownloadDir').addEventListener('click', () => chooseDownloadDirectory('video'));
  $('#chooseImageDownloadDir').addEventListener('click', () => chooseDownloadDirectory('image'));
  $('#resetVideoDownloadDir').addEventListener('click', () => resetDownloadDirectory('video'));
  $('#resetImageDownloadDir').addEventListener('click', () => resetDownloadDirectory('image'));

  // 任务详情抽屉
  $('#closeTaskDetail').addEventListener('click', closeTaskDetail);
  $('#taskDrawerClose2').addEventListener('click', closeTaskDetail);
  $('#taskDrawerDownload').addEventListener('click', downloadFromTaskDrawer);
  $('#taskDrawerRetry').addEventListener('click', retryFromTaskDrawer);
  $('#taskDrawerBackdrop').addEventListener('click', (event) => { if (event.target === $('#taskDrawerBackdrop')) closeTaskDetail(); });

  // 导航
  $('#navImage').addEventListener('click', (event) => { event.preventDefault(); showView('image'); });
  $('#navWorkspace').addEventListener('click', (event) => { event.preventDefault(); showView('workspace'); });
  $('#navAi').addEventListener('click', (event) => { event.preventDefault(); toggleGroupCollapse('ai'); });
  $('#navTasks').addEventListener('click', (event) => { event.preventDefault(); toggleGroupCollapse('tasks'); });
  $('#navAdmin').addEventListener('click', (event) => { event.preventDefault(); toggleGroupCollapse('admin'); });
  $('#navTasksAll').addEventListener('click', (event) => { event.preventDefault(); setRecordsKind('all'); });
  $('#navTasksImage').addEventListener('click', (event) => { event.preventDefault(); setRecordsKind('image'); });
  $('#navTasksVideo').addEventListener('click', (event) => { event.preventDefault(); setRecordsKind('video'); });
  $('#navQuery').addEventListener('click', (event) => { event.preventDefault(); showView('query'); });
  $('#gotoImageRecords').addEventListener('click', () => { setRecordsKind('image'); showView('tasks'); });
  $('#gotoVideoRecords').addEventListener('click', () => { setRecordsKind('video'); showView('tasks'); });
  $('#mobileImage').addEventListener('click', () => showView('image'));
  $('#mobileWorkspace').addEventListener('click', () => showView('workspace'));
  $('#mobileTasks').addEventListener('click', () => setRecordsKind('all'));
  $('#mobileQuery').addEventListener('click', () => showView('query'));
  $('#mobileApi').addEventListener('click', openSettings);

  // 通用
  document.addEventListener('click', () => $$('.row-action-menu').forEach((menu) => { menu.hidden = true; }));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('#taskDrawerBackdrop').hidden) closeTaskDetail();
    if (!$('#modelEditorBackdrop').hidden) requestCloseModelDrawer();
    if (!$('#tokenDrawerBackdrop').hidden) $('#tokenDrawerBackdrop').hidden = true;
    if (!$('#autoConfigBackdrop').hidden) { closeAutoConfigPanel(); return; }
    if (!$('#promptFullscreen').hidden) { closePromptFullscreen(); return; }
    if (!$('#promptDrawerBackdrop').hidden) closePromptDrawer();
  });
  ['prompt', 'taskName', 'taskSequence'].forEach((id) => {
    const el = $(`#${id}`);
    if (!el) return;
    el.addEventListener('input', () => { saveForm(); updateCharCount(id === 'prompt' ? 'prompt' : id); });
    el.addEventListener('change', saveForm);
  });
  $('#sidebarToggle').addEventListener('click', toggleSidebar);
  setInterval(() => { renderCurrentPrice(); renderImagePricePanel(); }, 30 * 1000);
  initializeDownloadDirectories();
  bootApp();
});

// 启动流程：先加载配置（令牌 / 任务 / 模型），完成后再关闭启动动画
async function bootApp() {
  const bootEl = $('#appBoot');
  const startedAt = Date.now();
  document.body.classList.add('booting');
  const setText = (text) => { const el = $('#appBootText'); if (el) el.textContent = text; };
  try {
    setText('正在加载令牌与任务…');
    await Promise.all([loadTokensCache(), loadPromptsCache(), loadTasks()]);
    setText('正在加载模型配置…');
    await initializeModels();
    setText('正在准备界面…');
    initializeFormDraft();
    initializeImageFormDraft();
    renderTasks();
  } catch (err) {
    console.error('启动加载失败', err);
    setText('配置加载失败，请检查本地服务是否正常');
  } finally {
    // 至少展示 0.7 秒，避免动画一闪而过
    const wait = Math.max(0, 700 - (Date.now() - startedAt));
    setTimeout(() => {
      if (!bootEl) return;
      bootEl.classList.add('done');
      document.body.classList.remove('booting');
      setTimeout(() => bootEl.remove(), 400);
    }, wait);
  }
}
