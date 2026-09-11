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
  downloadDirectory: null,
  models: [],
  selectedModelId: '',
  adminModelId: '',
  tokens: [],
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

function randomSeed() {
  if (window.crypto?.getRandomValues) {
    const values = new Uint32Array(2);
    window.crypto.getRandomValues(values);
    const combined = (BigInt(values[0]) << 32n) | BigInt(values[1]);
    return Number((combined % BigInt(MAX_SEED)) + 1n);
  }
  return Math.floor(Math.random() * MAX_SEED) + 1;
}

function saveForm() {
  const payload = {
    taskName: $('#taskName')?.dataset.savedValue || $('#taskName')?.value || '未命名任务',
    taskSequence: $('#taskSequence')?.value || '1',
    scheduleSubmit: Boolean($('#scheduleSubmit')?.checked),
    modelId: $('#modelSelect')?.value || state.selectedModelId || '',
    modelParams: Object.fromEntries($$('[data-model-field]').map((input) => [input.dataset.modelField, input.value])),
    prompt: $('#prompt')?.value || '',
    duration: $('#duration')?.value || '5',
    resolution: $('#resolution')?.value || '',
    seed: $('#seed')?.value || '',
    // Base64 本地图片改存 IndexedDB，避免撑爆 localStorage 导致整份表单丢失。
    imageItems: state.imageItems
      .filter((item) => item.kind === 'link')
      .map(({ id, kind, value, name }) => ({ id, kind, value, name })),
  };
  try {
    localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(payload));
  } catch (_) { /* 浏览器禁用本地存储时不影响提交 */ }
  scheduleImageDraftSave();
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
    const select = $('#modelSelect');
    select.innerHTML = state.models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}</option>`).join('');
    state.selectedModelId = state.models.some((model) => model.id === previousModelId) ? previousModelId : (state.models[0]?.id || '');
    select.value = state.selectedModelId;
    applySelectedModel();
  } catch (err) {
    console.error('读取模型列表失败', err);
  }
}

function selectedModel() {
  return state.models.find((model) => model.id === ($('#modelSelect')?.value || state.selectedModelId));
}

function applySelectedModel() {
  const model = selectedModel();
  if (!model) return;
  state.selectedModelId = model.id;
  $('#activeModelName').textContent = model.name;
  $('#activeModelDescription').textContent = model.workflow;
  $('#activeWorkflow').textContent = model.workflow;
  const fields = Array.isArray(model.fields) ? model.fields : [];
  const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));
  ['prompt', 'duration', 'resolution', 'seed'].forEach((key) => {
    const input = $(`#${key}`);
    if (!input) return;
    const field = byKey[key];
    input.closest('label').hidden = !field;
    if (!field) return;
    if (field.min != null) input.min = field.min;
    if (field.max != null) input.max = field.max;
    if (field.step != null) input.step = field.step;
    if (field.required != null) input.required = Boolean(field.required);
    if (key === 'resolution' && Array.isArray(field.options)) {
      const current = input.value;
      input.innerHTML = '<option value="">请选择</option>' + field.options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('');
      if (field.options.includes(current)) input.value = current;
    }
  });
  $('.image-input-panel').hidden = !byKey.reference_images;
  renderExtraModelFields(fields.filter((field) => !['prompt', 'duration', 'resolution', 'seed', 'reference_images'].includes(field.key)));
}

function renderExtraModelFields(fields) {
  const wrap = $('#extraModelFields');
  wrap.innerHTML = '';
  fields.forEach((field) => {
    const label = document.createElement('label');
    label.className = 'field';
    label.innerHTML = `<span><b class="param-key">${escapeHtml(field.label || field.key)}</b>${field.required ? '<i>必填</i>' : '<small>可选</small>'}</span>`;
    let input;
    if (field.type === 'select') {
      input = document.createElement('select');
      input.innerHTML = '<option value="">请选择</option>' + (field.options || []).map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('');
    } else if (field.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = field.rows || 4;
    } else {
      input = document.createElement('input');
      input.type = field.type === 'number' ? 'number' : 'text';
    }
    input.dataset.modelField = field.key;
    input.required = Boolean(field.required);
    if (field.default != null) input.value = field.default;
    if (field.min != null) input.min = field.min;
    if (field.max != null) input.max = field.max;
    input.addEventListener('input', saveForm);
    label.appendChild(input);
    wrap.appendChild(label);
  });
  wrap.hidden = fields.length === 0;
}

async function initializeDownloadDirectory() {
  if (desktopBridge) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('wenvedio-download-dir') || 'null'); } catch (_) { saved = null; }
    try { state.downloadDirectory = saved?.path ? saved : await desktopBridge.defaultDownloadDirectory(); }
    catch (_) { state.downloadDirectory = null; }
    renderDownloadLocation();
    return;
  }
  try { state.downloadDirectory = await readBrowserValue('download-directory'); }
  catch (_) { state.downloadDirectory = null; }
  renderDownloadLocation();
}

function renderDownloadLocation() {
  const label = $('#downloadLocation');
  if (!label) return;
  if (desktopBridge) label.textContent = state.downloadDirectory?.name || '未选择';
  else if (!window.showDirectoryPicker) label.textContent = '当前浏览器不支持自定义路径';
  else label.textContent = state.downloadDirectory?.name || '未选择';
  label.title = state.downloadDirectory?.path || label.textContent;
}

async function chooseDownloadDirectory() {
  if (desktopBridge) {
    try {
      const directory = await desktopBridge.chooseDirectory();
      if (!directory?.path) return null;
      state.downloadDirectory = directory;
      renderDownloadLocation();
      try { localStorage.setItem('wenvedio-download-dir', JSON.stringify(directory)); } catch (_) { /* 存储失败不影响下载 */ }
      return directory;
    } catch (err) {
      alert(`选择下载路径失败：${err.message}`);
      return null;
    }
  }
  if (!window.showDirectoryPicker) {
    alert('当前浏览器不支持选择下载文件夹，请使用 Chrome 或 Edge。');
    return null;
  }
  try {
    const directory = await window.showDirectoryPicker({
      id: 'wenvedio-download-directory',
      mode: 'readwrite',
      startIn: state.downloadDirectory || 'downloads',
    });
    state.downloadDirectory = directory;
    renderDownloadLocation();
    try { await writeBrowserValue('download-directory', directory); }
    catch (err) { console.warn('下载路径记忆失败，本次仍可正常下载', err); }
    return directory;
  } catch (err) {
    if (err.name !== 'AbortError') alert(`选择下载路径失败：${err.message}`);
    return null;
  }
}

function restoreForm() {
  try {
    const saved = JSON.parse(localStorage.getItem(FORM_STORAGE_KEY) || 'null');
    if (!saved) return;
    if (typeof saved.taskName === 'string' && saved.taskName.trim()) $('#taskName').value = saved.taskName.trim();
    if (typeof saved.taskSequence === 'string' || typeof saved.taskSequence === 'number') $('#taskSequence').value = String(saved.taskSequence);
    if (typeof saved.scheduleSubmit === 'boolean') $('#scheduleSubmit').checked = saved.scheduleSubmit;
    if (typeof saved.modelId === 'string' && state.models.some((model) => model.id === saved.modelId)) {
      $('#modelSelect').value = saved.modelId;
      state.selectedModelId = saved.modelId;
      applySelectedModel();
    }
    if (saved.modelParams && typeof saved.modelParams === 'object') {
      $$('[data-model-field]').forEach((input) => {
        if (saved.modelParams[input.dataset.modelField] != null) input.value = String(saved.modelParams[input.dataset.modelField]);
      });
    }
    if (typeof saved.prompt === 'string') $('#prompt').value = saved.prompt;
    if (typeof saved.duration === 'string' || typeof saved.duration === 'number') $('#duration').value = String(saved.duration);
    if (typeof saved.resolution === 'string') $('#resolution').value = saved.resolution;
    if (typeof saved.seed === 'string' || typeof saved.seed === 'number') $('#seed').value = String(saved.seed);
    if (Array.isArray(saved.imageItems)) {
      const items = saved.imageItems
        .filter((item) => item && (item.kind === 'link' || item.kind === 'file'))
        .slice(0, 10)
        .map((item, i) => ({
          id: String(item.id || `${item.kind}-${i}`),
          kind: item.kind,
          value: String(item.value || ''),
          name: String(item.name || ''),
        }));
      if (items.length) state.imageItems = items;
    } else if (Array.isArray(saved.imageRows)) {
      const links = saved.imageRows.map((value, i) => ({ id: `link-${i}`, kind: 'link', value: String(value || '') })).filter((item) => item.value);
      state.imageItems = links.length ? links : [{ id: 'link-0', kind: 'link', value: '' }];
    }
    $('#taskName').dataset.savedValue = $('#taskName').value.trim() || '未命名任务';
  } catch (_) { /* 忽略损坏的历史表单 */ }
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
  wrap.innerHTML = '';
  const filled = state.imageItems.filter((item) => item.value.trim());
  const items = state.imageItems.filter((item) => item.value.trim());
  items.forEach((item) => {
    const tile = document.createElement('div');
    tile.className = 'image-preview-tile';
    tile.draggable = true;
    tile.dataset.imageId = item.id;
    tile.title = '拖动调整图片顺序';

    const image = document.createElement('img');
    image.src = item.kind === 'file' || /^(https?:|data:|blob:)/i.test(item.value)
      ? item.value
      : `data:image/png;base64,${item.value}`;
    image.alt = item.name || '本地图片预览';

    const order = document.createElement('span');
    order.className = 'image-preview-order';
    order.textContent = String(filled.indexOf(item) + 1).padStart(2, '0');

    const remove = document.createElement('button');
    remove.className = 'image-preview-remove';
    remove.type = 'button';
    remove.title = '删除图片';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      state.imageItems = state.imageItems.filter((candidate) => candidate.id !== item.id);
      renderImageInputs();
      renderImagePreviews();
      saveForm();
    });

    tile.addEventListener('dragstart', (event) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', item.id);
      tile.classList.add('is-dragging');
    });
    tile.addEventListener('dragend', () => tile.classList.remove('is-dragging'));
    tile.addEventListener('dragover', (event) => event.preventDefault());
    tile.addEventListener('drop', (event) => {
      event.preventDefault();
      const sourceId = event.dataTransfer.getData('text/plain');
      if (!sourceId || sourceId === item.id) return;
      const sourceItems = state.imageItems.filter((candidate) => candidate.value.trim());
      const from = sourceItems.findIndex((candidate) => candidate.id === sourceId);
      const to = sourceItems.findIndex((candidate) => candidate.id === item.id);
      if (from < 0 || to < 0) return;
      const [moved] = sourceItems.splice(from, 1);
      sourceItems.splice(to, 0, moved);
      state.imageItems = sourceItems.concat(state.imageItems.filter((candidate) => !candidate.value.trim()));
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
  const imageCount = $('#imageCount');
  if (imageCount) imageCount.textContent = `${imageSourceCount()} / 10`;
  const note = $('#imageUploadNote');
  if (note) note.textContent = imageSourceCount() >= 10 ? '已达到 10 张上限，可删除后重新添加。' : '支持 JPG / PNG / WebP，可多选本地图片；超出 10 张时只保留前 10 张。';
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

async function addLocalImages(event) {
  const files = [...event.target.files]
    .filter((file) => ['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    .slice(0, 10 - imageSourceCount());
  if (files.length) {
    const values = await Promise.all(files.map((file) => readImageFile(file)));
    values.forEach((value, i) => state.imageItems.push({ id: imageId('file'), kind: 'file', value, name: files[i].name }));
    renderImagePreviews();
    saveForm();
  }
  event.target.value = '';
}

function statusMarkup(t) {
  const labels = { scheduled: '已预约', submitting: '提交中', queued: '排队中', processing: '生成中', completed: '已完成', failed: '失败', timeout: '已超时' };
  const st = taskStatus(t);
  return `<span class="state ${st}"><i></i>${labels[st]}</span>${st === 'processing' || st === 'submitting' ? `<div class="progress"><i style="width:${t.progress || 8}%"></i></div>` : ''}`;
}

function taskStatus(task) {
  const status = String(task.status || 'queued').toLowerCase();
  if (status === 'scheduled') return 'scheduled';
  if (['timeout', 'timed_out', 'expired'].includes(status)) return 'timeout';
  if (['success', 'succeeded', 'complete', 'completed', 'finished', 'done'].includes(status)) return 'completed';
  if (['failure', 'failed', 'error', 'cancelled', 'canceled'].includes(status)) return 'failed';
  if (['running', 'processing', 'generating', 'executing', 'in_progress'].includes(status)) return 'processing';
  if (status === 'submitting') return 'submitting';
  return 'queued';
}

function matchesTaskFilter(task, filter) {
  const status = taskStatus(task);
  if (filter === 'all') return true;
  if (filter === 'processing') return ['scheduled', 'submitting', 'queued', 'processing'].includes(status);
  if (filter === 'failed') return ['failed', 'timeout'].includes(status);
  return status === filter;
}

function renderTaskRows(tbody, tasks, selectable = false) {
  tbody.innerHTML = '';
  tasks.forEach((t) => {
    const tr = document.createElement('tr');
    tr.dataset.id = t.id;
    const parameters = [t.resolution, Number.isInteger(t.seed) ? `seed ${t.seed}` : ''].filter(Boolean).join(' · ') || '-';
    tr.innerHTML = `${selectable ? `<td class="check-col"><input type="checkbox" ${state.selected.has(t.id) ? 'checked' : ''} /></td>` : ''}<td class="task-summary-cell"><button class="task-copy-button" type="button" title="复制提示词" aria-label="复制提示词">复制</button><div class="task-name">${escapeHtml(t.name)}</div><div class="task-id">${escapeHtml(t.id)} · ${escapeHtml(t.prompt)}</div><button class="task-expand-button" type="button" title="放大查看" aria-label="放大查看">⤢ 放大</button></td><td>${t.image_count || 0} 张</td><td>${escapeHtml(parameters)}</td><td class="progress-cell">${statusMarkup(t)}</td><td>${t.time}</td><td class="row-menu"><button class="row-menu-button" type="button" aria-label="任务操作" title="任务操作">•••</button><div class="row-action-menu" hidden><button class="row-download-action" type="button" ${t.video_url || settings.mock ? '' : 'disabled'}>下载</button><button class="row-delete-action" type="button">删除记录</button></div></td>`;
    tr.querySelector('.task-copy-button').addEventListener('click', () => copyPrompt(t.prompt, tr.querySelector('.task-copy-button')));
    tr.querySelector('.task-expand-button').addEventListener('click', () => openTaskDetail(t));
    const menu = tr.querySelector('.row-action-menu');
    tr.querySelector('.row-menu-button').addEventListener('click', (event) => {
      event.stopPropagation();
      $$('.row-action-menu').forEach((item) => { if (item !== menu) item.hidden = true; });
      menu.hidden = !menu.hidden;
    });
    tr.querySelector('.row-download-action').addEventListener('click', () => {
      menu.hidden = true;
      downloadTasks([t]);
    });
    tr.querySelector('.row-delete-action').addEventListener('click', () => {
      menu.hidden = true;
      deleteTasks([t.id]);
    });
    if (selectable) tr.querySelector('input').addEventListener('change', (e) => {
      e.target.checked ? state.selected.add(t.id) : state.selected.delete(t.id);
      updateSelection();
    });
    tbody.appendChild(tr);
  });
}

async function copyPrompt(prompt, button) {
  try {
    await navigator.clipboard.writeText(prompt || '');
  } catch (_) {
    const input = document.createElement('textarea');
    input.value = prompt || '';
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  const original = button.textContent;
  button.textContent = '已复制';
  setTimeout(() => { button.textContent = original; }, 1200);
}

function openTaskDetail(task) {
  $('#taskDetailTitle').textContent = task.name || '任务详情';
  $('#taskDetailMeta').textContent = `${task.id} · ${task.time || '-'} · ${task.resolution || '未设置分辨率'}`;
  $('#taskDetailPrompt').textContent = task.prompt || '';
  $('#copyTaskDetail').dataset.taskId = task.id;
  $('#taskDetailModal').hidden = false;
  document.body.classList.add('modal-open');
}

function closeTaskDetail() {
  $('#taskDetailModal').hidden = true;
  document.body.classList.remove('modal-open');
}

function renderTasks() {
  const unfinished = state.tasks.filter((t) => !['completed', 'scheduled'].includes(taskStatus(t)));
  const scheduled = state.tasks.filter((t) => taskStatus(t) === 'scheduled')
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  const recordFiltered = state.tasks.filter((t) => matchesTaskFilter(t, state.filter));
  renderTaskRows($('#taskTable'), unfinished);
  renderTaskRows($('#recordTaskTable'), recordFiltered, true);
  renderScheduledTasks(scheduled);
  $('#taskTotal').textContent = unfinished.length;
  const navTaskCount = $('#navTaskCount');
  if (navTaskCount) navTaskCount.textContent = state.tasks.length;
  const counts = state.tasks.reduce((acc, t) => {
    acc.all += 1;
    const status = taskStatus(t);
    if (status === 'scheduled') acc.processing += 1;
    else if (status === 'timeout') acc.failed += 1;
    else if (acc[status] != null) acc[status] += 1;
    return acc;
  }, { all: 0, processing: 0, completed: 0, queued: 0, failed: 0 });
  const setCount = (filter, n) => {
    const el = $(`#record${filter[0].toUpperCase()}${filter.slice(1)}Count`);
    if (el) el.textContent = String(n);
  };
  setCount('all', counts.all);
  setCount('processing', counts.processing);
  setCount('completed', counts.completed);
  setCount('failed', counts.failed);
  $('#recordTaskTotal').textContent = state.tasks.length;
  $('#emptyState').hidden = unfinished.length > 0;
  $('#recordEmptyState').hidden = recordFiltered.length > 0;
  updateSelection(recordFiltered);
}

function scheduledTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

function renderScheduledTasks(tasks) {
  const wrap = $('#scheduledList');
  wrap.innerHTML = '';
  tasks.forEach((task, index) => {
    const item = document.createElement('div');
    item.className = 'scheduled-item';
    item.innerHTML = `<div class="scheduled-item-copy"><b>${escapeHtml(task.name)}</b><p>${escapeHtml(task.prompt)}</p></div><div class="scheduled-time"><span>预约顺序 ${index + 1}</span><b>${scheduledTime(task.scheduled_at)}</b></div><div class="scheduled-actions"><button class="submit-now" type="button">立即提交</button><button class="cancel-schedule" type="button">取消预约</button></div>`;
    item.querySelector('.submit-now').addEventListener('click', () => runScheduledAction(task.id, 'submit'));
    item.querySelector('.cancel-schedule').addEventListener('click', () => runScheduledAction(task.id, 'cancel'));
    wrap.appendChild(item);
  });
  $('#scheduledTotal').textContent = String(tasks.length);
  $('#scheduledEmpty').hidden = tasks.length > 0;
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
    if (!data.ok) throw new Error(data.msg || `HTTP ${modelRes.status}`);
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
      time: taskTime(task.created_at),
    })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    renderTasks();
    state.tasks
      .filter((task) => !['completed', 'failed', 'timeout'].includes(taskStatus(task)))
      .forEach((task) => pollTask(task.id));
  } catch (err) {
    console.error('读取任务记录失败', err);
    renderTasks();
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function updateSelection(filtered = state.tasks.filter((t) => matchesTaskFilter(t, state.filter))) {
  const n = state.selected.size;
  $('#selectedCount').textContent = n;
  $('#downloadSelected').disabled = !n;
  $('#deleteSelected').disabled = !n;
  const visibleSelected = filtered.filter((t) => state.selected.has(t.id)).length;
  $("#selectAll").checked = filtered.length > 0 && visibleSelected === filtered.length;
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
  if (!$('#taskName').readOnly) {
    alert('任务名字正在修改，请先点击“保存”');
    $('#saveTaskName').focus();
    return;
  }
  const taskName = ($('#taskName').dataset.savedValue || $('#taskName').value).trim();
  const sequence = Number($('#taskSequence').value);
  if (!taskName) {
    alert('请先设置并保存任务名字');
    $('#editTaskName').click();
    $('#taskName').focus();
    return;
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    alert('序号必须是从 1 开始的整数');
    $('#taskSequence').focus();
    return;
  }
  const numberedTaskName = `${taskName}_${sequence}`;
  const scheduled = $('#scheduleSubmit').checked;
  const model = selectedModel();
  if (!model) { alert('请选择生成模型'); return; }
  const dynamicParams = {};
  for (const input of $$('[data-model-field]')) {
    if (input.required && input.value.trim() === '') {
      alert(`请填写必填参数：${input.dataset.modelField}`);
      input.focus();
      return;
    }
    if (input.value === '') continue;
    dynamicParams[input.dataset.modelField] = input.type === 'number' ? Number(input.value) : input.value;
  }
  const prompt = $('#prompt').value.trim();
  if (!prompt) { $('#prompt').focus(); return; }
  const images = state.imageItems.filter((item) => item.value.trim()).map((item) => item.value.trim());
  if (!images[0]) {
    alert('请添加至少一张图片或填写图片链接');
    $('#imageLinks input')?.focus?.();
    return;
  }
  const resolution = $('#resolution').value;
  const duration = Number($('#duration').value || 5);
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) {
    alert('duration 必须是 1-15 的整数');
    $('#duration').focus();
    return;
  }
  const seedText = $('#seed').value.trim();
  const enteredSeed = seedText === '' ? NaN : Number(seedText);
  const seed = Number.isInteger(enteredSeed) && enteredSeed >= 1 && enteredSeed <= MAX_SEED
    ? enteredSeed
    : randomSeed();
  $('#seed').value = String(seed);
  saveForm();

  const localTask = {
    id: `WV-${Date.now().toString().slice(-6)}-001`,
    name: numberedTaskName,
    prompt,
    duration,
    resolution,
    seed,
    status: settings.mock ? 'processing' : 'submitting',
    progress: settings.mock ? 8 : 0,
    time: '刚刚',
    reference_images: images,
    image_count: images.filter(Boolean).length,
    model_id: model.id,
    model_name: model.name,
    scheduled_at: null,
  };

  // 演示模式：本地模拟，不请求后端
  if (settings.mock) {
    state.tasks.unshift(localTask);
    renderTasks();
    localTask.status = 'processing';
    simulateTask(localTask.id);
    $('#taskSequence').value = String(sequence + 1);
    saveForm();
    return;
  }

  // 真实模式：提交到本地后端
  try {
    const res = await fetch(`${settings.apiBase}/api/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: numberedTaskName,
        scheduled,
        model_id: model.id,
        tasks: [{
          prompt,
          duration,
          ...(resolution ? { resolution } : {}),
          ...(seed == null ? {} : { seed }),
          reference_images: images,
          params: dynamicParams,
        }],
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);

    // 用后端返回的本地任务 id 重新登记
    const t = data.tasks[0];
    state.tasks.unshift({
      id: t.local_id,
      name: localTask.name,
      prompt: t.prompt,
      duration: t.duration || duration,
      image_count: t.image_count || t.reference_images?.length || images.length,
      resolution: t.resolution || resolution,
      seed: Number.isInteger(t.seed) ? t.seed : seed,
      status: t.status,
      progress: t.status === 'submitting' ? 8 : 0,
      error: t.error,
      provider_task_id: t.provider_task_id,
      model_id: t.model_id || model.id,
      model_name: t.model_name || model.name,
      scheduled_at: t.scheduled_at,
      submitted_at: t.submitted_at,
      time: '刚刚',
    });
    renderTasks();
    $('#taskSequence').value = String(sequence + 1);
    saveForm();
    // 开始轮询真实任务
    if (t.local_id && t.status !== 'failed') pollTask(t.local_id);
  } catch (err) {
    alert(`提交失败：${err.message}`);
  }
}

// 轮询单个任务状态
function pollTask(localId) {
  const t = state.tasks.find((x) => x.id === localId);
  if (!t || state.pollingTasks.has(localId) || ['completed', 'failed', 'timeout'].includes(taskStatus(t))) return;
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
      const status = taskStatus(t);
      if (status === 'completed') { t.progress = 100; state.pollingTasks.delete(localId); }
      else if (['failed', 'timeout'].includes(status)) { state.pollingTasks.delete(localId); }
      else { t.progress = remote.progress || t.progress || 8; }
      renderTasks();
      if (!['completed', 'failed', 'timeout'].includes(status)) scheduleNext();
    } catch (_) {
      // 网络或鉴权异常不会误判任务失败，一分钟后继续查询。
      scheduleNext();
    }
  };
  const scheduleNext = () => {
    const timer = setTimeout(poll, 60 * 1000);
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
  const tasks = [...state.selected]
    .map((id) => state.tasks.find((task) => task.id === id))
    .filter((task) => task && (task.video_url || settings.mock));
  if (!tasks.length) {
    alert('选中的任务还没有可下载的视频。');
    return;
  }
  return downloadTasks(tasks);
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

  let directory = state.downloadDirectory;
  let justChosen = false;
  if (!directory) {
    directory = await chooseDownloadDirectory();
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
    alert(`已下载 ${completed} 个视频到所选文件夹。`);
  } catch (err) {
    if (err.name !== 'AbortError') alert(`批量下载失败：${err.message}`);
  } finally {
    button.innerHTML = original;
    updateSelection();
  }
}

// 桌面客户端下载：目录由主进程原生对话框选择，文件经 IPC 直接写入磁盘。
async function downloadTasksDesktop(tasks) {
  let directory = state.downloadDirectory;
  if (!directory?.path) {
    directory = await chooseDownloadDirectory();
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
      await desktopBridge.saveFile({ directory: directory.path, name: safeDownloadName(task, i), data: await blob.arrayBuffer() });
      completed += 1;
    }
    alert(`已下载 ${completed} 个视频到 ${directory.name || directory.path}。`);
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

async function openSettings() {
  showView('settings');
  try {
    const [modelRes, tokenRes] = await Promise.all([fetch(`${settings.apiBase}/api/models`), fetch(`${settings.apiBase}/api/tokens`)]);
    const data = await modelRes.json();
    const tokenData = await tokenRes.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    state.models = data.models || [];
    state.tokens = tokenData.tokens || [];
    renderModelAdminList();
  } catch (err) {
    $('#settingsStatus').textContent = `读取配置失败：${err.message}`;
    $('#settingsStatus').style.color = '#db5c52';
  }
}

function renderModelAdminList() {
  $('#modelAdminList').innerHTML = state.models.map((model) => `<button type="button" data-model-admin="${escapeHtml(model.id)}"><b>${escapeHtml(model.name)}</b><small>${escapeHtml(model.workflow)}</small><span>${escapeHtml(state.tokens.find((token) => token.id === model.token_id)?.name || '未选择')}</span></button>`).join('');
  $$('[data-model-admin]').forEach((button) => button.addEventListener('dblclick', () => selectAdminModel(button.dataset.modelAdmin)));
}

function selectAdminModel(id) {
  const model = state.models.find((item) => item.id === id);
  if (!model) return;
  state.adminModelId = model.id;
  $('#modelName').value = model.name || '';
  $('#modelId').value = model.id || '';
  $('#modelId').readOnly = true;
  $('#modelWorkflow').value = model.workflow || '';
  $('#requestUrl').value = model.request_url || '';
  $('#queryUrl').value = model.query_url || '';
  $('#modelFields').value = JSON.stringify(model.fields || [], null, 2);
  renderModelTokenOptions(model.token_id);
  $('#modelEditorBackdrop').hidden = false;
}

function newModelDraft() {
  state.adminModelId = '';
  ['modelName', 'modelId', 'modelWorkflow', 'requestUrl'].forEach((id) => { $(`#${id}`).value = ''; });
  $('#modelId').readOnly = false;
  $('#queryUrl').value = 'https://www.autodl.art/api/v1/comfyui/comfyui_workflow/result/{task_id}';
  $('#modelFields').value = JSON.stringify([{ key: 'prompt', label: 'prompt', type: 'textarea', required: true }, { key: 'reference_images', label: '参考图片', type: 'images', required: true, min: 1, max: 10 }], null, 2);
  renderModelTokenOptions(state.tokens[0]?.id || '');
  $('#modelEditorBackdrop').hidden = false;
}

function renderModelTokenOptions(selectedId) {
  $('#modelToken').innerHTML = '<option value="">请选择令牌</option>' + state.tokens.map((token) => `<option value="${escapeHtml(token.id)}">${escapeHtml(token.name)} · ${escapeHtml(token.masked)}</option>`).join('');
  $('#modelToken').value = selectedId || '';
}

async function saveSettings() {
  const status = $('#settingsStatus');
  let fields;
  try { fields = JSON.parse($('#modelFields').value.trim() || '[]'); }
  catch (_) { status.textContent = '保存失败：JSON 格式不正确'; status.style.color = '#db5c52'; return; }
  const model = { id: $('#modelId').value.trim(), name: $('#modelName').value.trim(), workflow: $('#modelWorkflow').value.trim(), request_url: $('#requestUrl').value.trim(), query_url: $('#queryUrl').value.trim(), token_id: $('#modelToken').value, request_params: {}, fields };
  try {
    const res = await fetch(`${settings.apiBase}/api/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    status.textContent = '模型已保存';
    status.style.color = 'var(--green)';
    state.adminModelId = data.model.id;
    await initializeModels();
    renderModelAdminList();
    selectAdminModel(data.model.id);
    $('#modelEditorBackdrop').hidden = true;
  } catch (err) {
    status.textContent = `保存失败：${err.message}`;
    status.style.color = '#db5c52';
  }
}

async function deleteAdminModel() {
  if (!state.adminModelId || !confirm('确定删除这个模型配置吗？')) return;
  const res = await fetch(`${settings.apiBase}/api/models/${encodeURIComponent(state.adminModelId)}`, { method: 'DELETE' });
  const data = await res.json();
  if (!data.ok) return alert(`删除失败：${data.msg}`);
  state.adminModelId = '';
  $('#modelEditorBackdrop').hidden = true;
  await openSettings();
  await initializeModels();
}

async function openTokens() {
  showView('tokens');
  try {
    const res = await fetch(`${settings.apiBase}/api/tokens`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    state.tokens = data.tokens || [];
    renderTokens();
  } catch (err) { $('#tokenStatus').textContent = `读取令牌失败：${err.message}`; }
}

function renderTokens() {
  $('#tokenList').innerHTML = state.tokens.map((token) => `<div class="token-row"><div><b>${escapeHtml(token.name)}</b><small>${escapeHtml(token.masked)}</small></div><button type="button" data-delete-token="${escapeHtml(token.id)}">删除</button></div>`).join('');
  $$('[data-delete-token]').forEach((button) => button.addEventListener('click', () => deleteToken(button.dataset.deleteToken)));
}

async function saveToken() {
  const name = $('#tokenName').value.trim();
  const value = $('#tokenValue').value.trim();
  if (!name || !value) return alert('请填写令牌名称和 API Key');
  const res = await fetch(`${settings.apiBase}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, value }) });
  const data = await res.json();
  if (!data.ok) return alert(`添加令牌失败：${data.msg}`);
  $('#tokenName').value = '';
  $('#tokenValue').value = '';
  await openTokens();
}

async function deleteToken(id) {
  if (!confirm('确定删除这个令牌吗？')) return;
  const res = await fetch(`${settings.apiBase}/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await res.json();
  if (!data.ok) return alert(`删除令牌失败：${data.msg}`);
  await openTokens();
}

function showView(view) {
  const isQuery = view === 'query';
  const isRecords = view === 'tasks';
  const isSettings = view === 'settings';
  const isTokens = view === 'tokens';
  const workspaceView = $('#workspaceView');
  const recordsView = $('#recordsView');
  const queryView = $('#queryView');
  const settingsView = $('#settingsView');
  const tokensView = $('#tokensView');
  const pageTitle = $('#pageTitle');
  const pageEyebrow = $('#pageEyebrow');
  workspaceView.hidden = isQuery || isRecords || isSettings || isTokens;
  recordsView.hidden = !isRecords;
  queryView.hidden = !isQuery;
  settingsView.hidden = !isSettings;
  tokensView.hidden = !isTokens;
  pageTitle.textContent = isQuery ? '访问查询' : isRecords ? '任务记录' : isSettings ? '模型管理' : isTokens ? '令牌管理' : '视频生成工作台';
  pageEyebrow.textContent = isQuery ? 'AUTODL / COMFYUI' : isRecords ? 'WORKSPACE / HISTORY' : isSettings ? 'WORKSPACE / MODELS' : isTokens ? 'WORKSPACE / TOKENS' : 'WORKSPACE / VIDEO LAB';
  $$('.main-nav .nav-item').forEach((item) => item.classList.remove('active'));
  $(`#${isQuery ? 'navQuery' : isRecords ? 'navTasks' : isSettings ? 'openSettings' : isTokens ? 'openTokens' : 'navWorkspace'}`).classList.add('active');
  $$('.mobile-nav button').forEach((item) => item.classList.remove('active'));
  $(`#${isQuery ? 'mobileQuery' : isRecords ? 'mobileTasks' : (isSettings || isTokens) ? 'mobileApi' : 'mobileWorkspace'}`).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initializeSidebar() {
  const collapsed = localStorage.getItem('wenvedio-sidebar-collapsed') === 'true';
  $('#sidebar').classList.toggle('collapsed', collapsed);
  $('#sidebarToggle').title = collapsed ? '展开侧边栏' : '收起侧边栏';
  $('#sidebarToggle').setAttribute('aria-label', $('#sidebarToggle').title);
}

function toggleSidebar() {
  const collapsed = $('#sidebar').classList.toggle('collapsed');
  localStorage.setItem('wenvedio-sidebar-collapsed', String(collapsed));
  $('#sidebarToggle').title = collapsed ? '展开侧边栏' : '收起侧边栏';
  $('#sidebarToggle').setAttribute('aria-label', $('#sidebarToggle').title);
}

document.addEventListener('DOMContentLoaded', () => {
  loadTasks();
  initializeSidebar();

  $('#submitBatch').addEventListener('click', submitBatch);
  $('#downloadSelected').addEventListener('click', downloadSelected);
  $('#deleteSelected').addEventListener('click', () => deleteTasks([...state.selected]));
  $('#openSettings').addEventListener('click', openSettings);
  $('#openTokens').addEventListener('click', openTokens);
  $('#saveSettings').addEventListener('click', saveSettings);
  $('#addModel').addEventListener('click', newModelDraft);
  $('#deleteModel').addEventListener('click', deleteAdminModel);
  $('#closeModelEditor').addEventListener('click', () => { $('#modelEditorBackdrop').hidden = true; });
  $('#modelEditorBackdrop').addEventListener('click', (event) => { if (event.target === $('#modelEditorBackdrop')) $('#modelEditorBackdrop').hidden = true; });
  $('#saveToken').addEventListener('click', saveToken);
  $('#addImageLink').addEventListener('click', addImageLink);
  $('#localImageUpload').addEventListener('change', addLocalImages);
  $('#closeTaskDetail').addEventListener('click', closeTaskDetail);
  $('#taskDetailModal').addEventListener('click', (event) => { if (event.target === $('#taskDetailModal')) closeTaskDetail(); });
  $('#copyTaskDetail').addEventListener('click', () => {
    const task = state.tasks.find((item) => item.id === $('#copyTaskDetail').dataset.taskId);
    if (task) copyPrompt(task.prompt, $('#copyTaskDetail'));
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#taskDetailModal').hidden) closeTaskDetail(); });
  document.addEventListener('click', () => $$('.row-action-menu').forEach((menu) => { menu.hidden = true; }));
  $('#navWorkspace').addEventListener('click', (event) => { event.preventDefault(); showView('workspace'); });
  $('#navTasks').addEventListener('click', (event) => { event.preventDefault(); showView('tasks'); });
  $('#navQuery').addEventListener('click', (event) => { event.preventDefault(); showView('query'); });
  $('#mobileWorkspace').addEventListener('click', () => showView('workspace'));
  $('#mobileTasks').addEventListener('click', () => showView('tasks'));
  $('#mobileQuery').addEventListener('click', () => showView('query'));
  $('#mobileApi').addEventListener('click', openSettings);
  initializeModels().then(initializeFormDraft);
  initializeDownloadDirectory();
  $('#chooseDownloadDirectory').addEventListener('click', chooseDownloadDirectory);
  $('#sidebarToggle').addEventListener('click', toggleSidebar);
  ['prompt', 'duration', 'resolution', 'seed', 'taskSequence'].forEach((id) => {
    $(`#${id}`).addEventListener('input', saveForm);
    $(`#${id}`).addEventListener('change', saveForm);
  });
  $('#scheduleSubmit').addEventListener('change', saveForm);
  $('#modelSelect').addEventListener('change', () => { applySelectedModel(); saveForm(); });
  $('#clearForm').addEventListener('click', async () => {
    $('#prompt').value = '';
    state.imageItems = [{ id: imageId('link'), kind: 'link', value: '' }];
    $('#seed').value = '';
    imageDraftFingerprint = '';
    clearTimeout(imageDraftTimer);
    await clearImageDraft();
    renderImageRows();
    saveForm();
  });
  $('#editTaskName').addEventListener('click', () => {
    $('#taskName').readOnly = false;
    $('#editTaskName').hidden = true;
    $('#saveTaskName').hidden = false;
    $('#taskName').focus();
    $('#taskName').select();
  });
  $('#saveTaskName').addEventListener('click', () => {
    const input = $('#taskName');
    const nextName = input.value.trim();
    if (!nextName) {
      alert('任务名字不能为空');
      input.focus();
      return;
    }
    const previousName = input.dataset.savedValue || '未命名任务';
    input.value = nextName;
    input.dataset.savedValue = nextName;
    input.readOnly = true;
    $('#saveTaskName').hidden = true;
    $('#editTaskName').hidden = false;
    if (nextName !== previousName) $('#taskSequence').value = '1';
    saveForm();
  });
  $('#selectAll').addEventListener('change', (e) => {
    state.tasks.filter((t) => matchesTaskFilter(t, state.filter)).forEach((t) => (e.target.checked ? state.selected.add(t.id) : state.selected.delete(t.id)));
    renderTasks();
  });
  $$('[data-record-filter]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-record-filter]').forEach((x) => x.classList.remove('selected'));
    b.classList.add('selected');
    state.filter = b.dataset.recordFilter;
    renderTasks();
  }));
});
