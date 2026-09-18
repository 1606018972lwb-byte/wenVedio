// wenVedio 桌面客户端 · Electron 主进程
// 复用与 web 完全相同的 src/server.js 与前端页面：主进程把内置服务拉起来，
// 等 /api/health 通过后再加载 http://127.0.0.1:<port>/，因此功能与界面和 web 一致。
// 与 web 的差异只有两点：数据写入用户数据目录（安装包内是只读的），以及下载目录走原生对话框。

const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');

const APP_NAME = 'wenVedio';
const IS_MAC = process.platform === 'darwin';
const PREFERRED_PORT = Number(process.env.WENVEDIO_PORT || 8787);
// 与前端 CSS 的 --titlebar-h 保持一致：系统窗口按钮的高度必须对得上
const TITLEBAR_HEIGHT = 46;

// 必须在读取 userData 之前固定应用名与数据目录：Electron 会依据包名提前缓存该路径，
// 放到 whenReady 里 setName 已经来不及。
app.setName(APP_NAME);
try {
  app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
} catch (_) { /* 路径不可用时退回 Electron 默认目录 */ }
// 固定任务栏/托盘身份：安装版、解压版、便携版分别从不同路径启动时，
// 不再被 Windows 当成多个应用而显示多个图标。
try { app.setAppUserModelId('com.wenvedio.desktop'); } catch (_) { /* 非 Windows 平台忽略 */ }

let mainWindow = null;
let serverProcess = null;
let serverPort = 0;
let quitting = false;
let tray = null;
let minimizeToTray = false;

// 优先用 8787，被占用时退回系统随机端口。
function findFreePort(preferred) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => {
      const fallback = net.createServer();
      fallback.once('error', () => resolve(0));
      fallback.listen(0, '127.0.0.1', () => {
        const { port } = fallback.address();
        fallback.close(() => resolve(port));
      });
    });
    probe.listen(preferred, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function userDataFile(name) {
  return path.join(app.getPath('userData'), name);
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(userDataFile('config.json'), 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(userDataFile('config.json'), JSON.stringify(next, null, 2));
  return next;
}

// 主进程日志写入同一个 data/log/ 目录（按天一个文件）。
function appendMainLog(line) {
  try {
    const logDir = path.join(userDataFile('data'), 'log');
    fs.mkdirSync(logDir, { recursive: true });
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
    const get = (type) => (parts.find((part) => part.type === type) || {}).value || '';
    const day = `${get('year')}-${get('month')}-${get('day')}`;
    fs.appendFileSync(path.join(logDir, `${day}.log`), `[${day} ${get('hour')}:${get('minute')}:${get('second')}] [main] ${line}\n`);
  } catch (_) { /* 日志失败不影响运行 */ }
}

function startServer(port) {
  const entry = path.join(__dirname, '..', 'src', 'server.js');
  serverProcess = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      // 让 Electron 自身以纯 Node 身份运行内置服务，无需用户另装 Node。
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      HOST: '127.0.0.1',
      WENVEDIO_DATA_DIR: userDataFile('data'),
      WENVEDIO_ENV_FILE: userDataFile('.env'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProcess.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  serverProcess.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  serverProcess.on('error', (err) => {
    appendMainLog(`内置服务启动失败：${err.message}`);
    dialog.showErrorBox(APP_NAME, `内置服务启动失败：${err.message}`);
  });
  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;
    appendMainLog(`内置服务退出（${code ?? signal}）`);
    if (quitting) return;
    dialog.showErrorBox(APP_NAME, `内置服务意外退出（${code ?? signal}），请重新启动 ${APP_NAME}。`);
    app.quit();
  });
}

function waitForServer(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('内置服务启动超时'));
      setTimeout(attempt, 300);
    };
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('timeout', () => { req.destroy(); retry(); });
      req.on('error', retry);
    };
    attempt();
  });
}

function loadingPage() {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${APP_NAME}</title>
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f3f5f7;color:#44505d;font-family:"Noto Sans SC",system-ui,sans-serif}
.box{text-align:center}.mark{width:52px;height:52px;margin:0 auto 18px;border-radius:13px;background:#202b38;color:#fff;display:grid;place-items:center;font-size:24px;font-weight:800}
p{margin:0;font-size:13px;color:#7b8794}</style></head>
<body><div class="box"><div class="mark">F</div><p>正在启动视频生成工作台…</p></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: APP_NAME,
    backgroundColor: '#f3f5f7',
    autoHideMenuBar: true,
    // 自绘标题栏：Windows/Linux 只保留系统的最小化/最大化/关闭按钮（颜色由前端按主题同步），
    // macOS 用 hiddenInset 保留原生红灯，并给左侧留出交通灯的位置。
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    ...(IS_MAC
      ? { trafficLightPosition: { x: 14, y: 15 } }
      : { titleBarOverlay: { color: '#ffffff', symbolColor: '#4d5b73', height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  // 开启“关闭时最小化到托盘”后，点关闭按钮只是隐藏，从托盘图标退出。
  mainWindow.on('close', (event) => {
    if (minimizeToTray && !quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // 查询入口等外部链接交给系统浏览器，不在客户端内新开窗口。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  await mainWindow.loadURL(loadingPage());
  await waitForServer(port);
  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

function buildMenu() {
  const template = [];
  if (IS_MAC) template.push({ role: 'appMenu' });
  template.push({ role: 'editMenu' });
  template.push({
    label: '视图',
    submenu: [
      { role: 'reload', label: '重新加载' },
      { role: 'forceReload', label: '强制重新加载' },
      { role: 'toggleDevTools', label: '开发者工具' },
      { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' },
    ],
  });
  template.push({ role: 'windowMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function uniqueTargetPath(directory, desiredName) {
  const dot = desiredName.lastIndexOf('.');
  const base = dot > 0 ? desiredName.slice(0, dot) : desiredName;
  const ext = dot > 0 ? desiredName.slice(dot) : '';
  for (let n = 1; n < 10000; n += 1) {
    const candidate = n === 1 ? desiredName : `${base}(${n})${ext}`;
    if (!fs.existsSync(path.join(directory, candidate))) return path.join(directory, candidate);
  }
  return path.join(directory, desiredName);
}

function showMainWindow() {
  if (!mainWindow) {
    if (serverPort) createWindow(serverPort).catch(() => {});
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function ensureTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }) : undefined;
  tray = new Tray(icon);
  tray.setToolTip(`${APP_NAME} · 视频生成工作台`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showMainWindow);
}

function destroyTray() {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

function registerIpc() {
  // 默认下载目录：图片 ./images、视频 ./videos（落在应用数据目录下，稳定可写）
  const defaultDownloadDir = (kind) => {
    const folder = kind === 'image' ? 'images' : 'videos';
    const dir = path.join(app.getPath('userData'), folder);
    try {
      fs.mkdirSync(dir, { recursive: true });
      return { path: dir, name: folder };
    } catch (_) {
      const downloads = app.getPath('downloads');
      return { path: downloads, name: path.basename(downloads) || '下载' };
    }
  };

  ipcMain.handle('wenvedio:default-download-directory', (_event, kind) => defaultDownloadDir(kind === 'image' ? 'image' : 'video'));

  ipcMain.handle('wenvedio:choose-directory', async (_event, payload) => {
    const kind = payload?.kind === 'image' ? 'image' : 'video';
    const label = kind === 'image' ? '图片' : '视频';
    const options = {
      title: `选择${label}下载文件夹`,
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: String(payload?.current || '') || defaultDownloadDir(kind).path,
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths?.length) return null;
    const dir = result.filePaths[0];
    return { path: dir, name: path.basename(dir) || dir };
  });

  // 打开文件所在位置：有本地文件则定位文件，否则打开（并确保存在）对应目录
  ipcMain.handle('wenvedio:reveal', async (_event, payload) => {
    const target = String(payload?.path || '');
    const directory = String(payload?.directory || '');
    try {
      if (target && fs.existsSync(target)) {
        shell.showItemInFolder(target);
        return { ok: true, mode: 'file' };
      }
      const dir = directory || (target ? path.dirname(target) : '');
      if (!dir) return { ok: false, msg: '该任务还没有下载记录，先在设置里配置下载路径' };
      fs.mkdirSync(dir, { recursive: true });
      const err = await shell.openPath(dir);
      return err ? { ok: false, msg: err } : { ok: true, mode: 'dir' };
    } catch (err) {
      return { ok: false, msg: err.message };
    }
  });

  ipcMain.handle('wenvedio:save-file', async (_event, payload) => {
    const directory = String(payload?.directory || '');
    const name = String(payload?.name || 'video.mp4');
    if (!directory) throw new Error('未指定下载目录');
    fs.mkdirSync(directory, { recursive: true });
    const target = uniqueTargetPath(directory, name);
    const data = payload?.data;
    const buffer = Buffer.isBuffer(data) ? data
      : data instanceof ArrayBuffer ? Buffer.from(data)
        : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          : Buffer.from(data || '');
    await fs.promises.writeFile(target, buffer);
    return { name: path.basename(target), path: target };
  });

  ipcMain.handle('wenvedio:get-app-settings', () => ({
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    minimizeToTray,
  }));

  ipcMain.handle('wenvedio:set-app-settings', (_event, payload) => {
    if (payload && typeof payload.openAtLogin === 'boolean') {
      app.setLoginItemSettings({ openAtLogin: payload.openAtLogin });
    }
    if (payload && typeof payload.minimizeToTray === 'boolean') {
      minimizeToTray = payload.minimizeToTray;
      writeConfig({ minimizeToTray });
      if (minimizeToTray) ensureTray();
      else destroyTray();
    }
    return { openAtLogin: app.getLoginItemSettings().openAtLogin, minimizeToTray };
  });

  // 自绘标题栏随主题换色（Windows / Linux 的 titleBarOverlay）
  ipcMain.handle('wenvedio:set-titlebar-theme', (_event, payload) => {
    if (!mainWindow || mainWindow.isDestroyed() || typeof mainWindow.setTitleBarOverlay !== 'function') {
      return { ok: false, msg: '当前平台不支持自定义标题栏配色' };
    }
    try {
      mainWindow.setTitleBarOverlay({
        color: String(payload?.color || '#ffffff'),
        symbolColor: String(payload?.symbolColor || '#4d5b73'),
        height: TITLEBAR_HEIGHT,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, msg: err.message };
    }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    registerIpc();
    buildMenu();
    minimizeToTray = readConfig().minimizeToTray === true;
    if (minimizeToTray) ensureTray();
    appendMainLog(`客户端启动 v${app.getVersion()}`);
    try {
      serverPort = await findFreePort(PREFERRED_PORT);
      startServer(serverPort);
      await createWindow(serverPort);
    } catch (err) {
      dialog.showErrorBox(APP_NAME, `启动失败：${err.message}`);
      app.quit();
    }
  });

  app.on('activate', () => {
    if (!mainWindow && serverPort) createWindow(serverPort).catch(() => {});
    else showMainWindow();
  });

  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    destroyTray();
    if (serverProcess) {
      serverProcess.kill();
      serverProcess = null;
    }
  });
}
