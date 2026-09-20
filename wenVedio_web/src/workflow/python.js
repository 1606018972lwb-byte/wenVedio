// 工作流 · Python 运行环境
// 职责：
//   1) 发现本机的 conda 环境、系统 Python，以及我们自己创建的虚拟环境
//   2) 默认优先级：conda base → conda 的第一个环境 → 自建虚拟环境 → 系统 Python
//   3) pip 缺失时自动补装（ensurepip → 各镜像的 get-pip.py）
//   4) 一个都没有时，按多条镜像线路自动下载安装 Python 3.12 并建好隔离环境
//   5) 用选中的解释器执行代码节点的 Python 代码
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const ENV_CACHE_MS = 5000;
const MAX_CODE_BYTES = 200000;

// 下载线路：按顺序尝试，失败自动切换下一条
function minicondaRoutes() {
  const file = IS_WIN
    ? 'Miniconda3-latest-Windows-x86_64.exe'
    : (process.platform === 'darwin'
      ? (process.arch === 'arm64' ? 'Miniconda3-latest-MacOSX-arm64.sh' : 'Miniconda3-latest-MacOSX-x86_64.sh')
      : 'Miniconda3-latest-Linux-x86_64.sh');
  return [
    { name: '清华镜像', url: `https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/${file}` },
    { name: '北外镜像', url: `https://mirrors.bfsu.edu.cn/anaconda/miniconda/${file}` },
    { name: '南大镜像', url: `https://mirror.nju.edu.cn/anaconda/miniconda/${file}` },
    { name: '中科大镜像', url: `https://mirrors.ustc.edu.cn/anaconda/miniconda/${file}` },
    { name: '官方源', url: `https://repo.anaconda.com/miniconda/${file}` },
  ];
}

function getPipRoutes() {
  return [
    { name: '清华镜像', url: 'https://mirrors.tuna.tsinghua.edu.cn/pypi/web/packages/get-pip.py' },
    { name: '阿里镜像', url: 'https://mirrors.aliyun.com/pypi/get-pip.py' },
    { name: '官方源', url: 'https://bootstrap.pypa.io/get-pip.py' },
  ];
}

function create({ dataDir, configDir, writeLog }) {
  const SETTINGS_FILE = path.join(configDir, 'python.json');
  const PY_ROOT = path.join(dataDir, 'python');
  const VENV_DIR = path.join(PY_ROOT, 'venvs');
  const TMP_DIR = path.join(PY_ROOT, 'tmp');
  const MINICONDA_DIR = path.join(PY_ROOT, 'miniconda3');

  let selectedId = '';
  let cache = { at: 0, envs: [] };
  let installJob = null;

  // ---------------- 基础工具 ----------------

  function readSettings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      selectedId = String(parsed?.python_env_id || '');
    } catch (_) { /* 首次运行没有该文件 */ }
  }

  function writeSettings() {
    try {
      fs.mkdirSync(configDir, { recursive: true });
      const temporary = `${SETTINGS_FILE}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ python_env_id: selectedId }, null, 2));
      fs.renameSync(temporary, SETTINGS_FILE);
    } catch (err) {
      writeLog('error', `保存 Python 环境选择失败: ${err.message}`);
    }
  }

  function exec(cmd, args, { timeout = 15000, input = null, env = {} } = {}) {
    return new Promise((resolve) => {
      const child = execFile(cmd, args, {
        timeout,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...env },
      }, (err, stdout, stderr) => {
        resolve({
          code: err ? (err.code === undefined ? -1 : (typeof err.code === 'number' ? err.code : 1)) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          failed: Boolean(err),
        });
      });
      if (input != null) {
        child.stdin.end(input);
      } else {
        child.stdin.end();
      }
    });
  }

  const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };

  function firstExisting(paths) {
    return paths.find((p) => p && exists(p)) || '';
  }

  async function probe(env) {
    const python = env.python;
    const info = { ...env, version: '', pip: false, error: '' };
    if (!exists(python)) { info.error = '解释器不存在'; return info; }
    const ver = await exec(python, ['-c', 'import sys;print(sys.version.split()[0])'], { timeout: 12000 });
    if (ver.code === 0) info.version = ver.stdout.trim().split('\n').pop().trim();
    else info.error = (ver.stderr || '无法执行').trim().split('\n').pop().slice(0, 200);
    const pip = await exec(python, ['-m', 'pip', '--version'], { timeout: 20000 });
    info.pip = pip.code === 0;
    if (info.pip) {
      const match = pip.stdout.match(/pip\s+([\d.]+)/);
      info.pip_version = match ? match[1] : '';
    }
    return info;
  }

  // ---------------- 环境发现 ----------------

  function condaCandidates() {
    const home = os.homedir();
    const list = [
      process.env.CONDA_EXE || '',
      path.join(home, 'anaconda3', 'Scripts', 'conda.exe'),
      path.join(home, 'miniconda3', 'Scripts', 'conda.exe'),
      path.join(home, 'miniforge3', 'Scripts', 'conda.exe'),
      path.join(home, 'Anaconda3', 'Scripts', 'conda.exe'),
      process.env.ProgramData ? path.join(process.env.ProgramData, 'Anaconda3', 'Scripts', 'conda.exe') : '',
      process.env.ProgramData ? path.join(process.env.ProgramData, 'miniconda3', 'Scripts', 'conda.exe') : '',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Continuum', 'anaconda3', 'Scripts', 'conda.exe') : '',
      path.join(MINICONDA_DIR, 'Scripts', 'conda.exe'),
      '/opt/anaconda3/bin/conda',
      '/usr/local/anaconda3/bin/conda',
      '/opt/miniconda3/bin/conda',
    ];
    return list.filter(Boolean);
  }

  function pythonInPrefix(prefix) {
    if (IS_WIN) return firstExisting([path.join(prefix, 'python.exe'), path.join(prefix, 'Scripts', 'python.exe')]);
    return firstExisting([path.join(prefix, 'bin', 'python3'), path.join(prefix, 'bin', 'python')]);
  }

  async function detectCondaEnvs() {
    const out = [];
    const condaExe = firstExisting(condaCandidates());
    const condaCmd = condaExe || 'conda';
    const result = await exec(condaCmd, ['env', 'list', '--json'], { timeout: 25000 });
    if (result.code !== 0) {
      if (condaExe) writeLog('warn', `conda 环境枚举失败: ${(result.stderr || '').slice(0, 200)}`);
      return out;
    }
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch (_) { return out; }
    const envs = Array.isArray(parsed?.envs) ? parsed.envs : [];
    // envs_details 自带 name 与 base 标记，比按路径猜可靠（这个机器上 conda 的 base 在 E:\anaconda，
    // 而 D:\condaEnv\envs\* 是具名环境，只看 envs[0] 会把第一个具名环境误认成 base）
    const details = parsed?.envs_details && typeof parsed.envs_details === 'object' ? parsed.envs_details : {};
    for (const prefix of envs) {
      const python = pythonInPrefix(prefix);
      if (!python) continue;
      const detail = details[prefix] || {};
      const isBase = detail.base === true;
      out.push({
        id: `conda:${prefix}`,
        kind: 'conda',
        name: isBase ? 'base' : String(detail.name || path.basename(prefix)),
        prefix,
        python,
        conda: condaExe || condaCmd,
        is_base: isBase,
      });
    }
    // base 排最前，其余保持 conda 给出的顺序
    out.sort((a, b) => (a.is_base === b.is_base ? 0 : a.is_base ? -1 : 1));
    return out;
  }

  async function detectSystemPythons() {
    const out = [];
    const seen = new Set();
    const push = (python, name) => {
      if (!python || seen.has(python.toLowerCase())) return;
      seen.add(python.toLowerCase());
      out.push({ id: `system:${python}`, kind: 'system', name, prefix: path.dirname(path.dirname(python)), python });
    };
    if (IS_WIN) {
      const launcher = await exec('py', ['-0p'], { timeout: 10000 });
      if (launcher.code === 0) {
        for (const line of launcher.stdout.split('\n')) {
          const match = line.match(/([A-Za-z]:\\[^\s].*?python\.exe)/i);
          if (match) push(match[1], `系统 Python（${path.basename(path.dirname(match[1]))}）`);
        }
      }
      const where = await exec('where', ['python'], { timeout: 8000 });
      if (where.code === 0) where.stdout.split('\n').map((s) => s.trim()).filter(Boolean).forEach((p) => push(p, 'PATH 中的 Python'));
      const localPrograms = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python') : '';
      if (localPrograms && exists(localPrograms)) {
        for (const dir of fs.readdirSync(localPrograms)) {
          push(firstExisting([path.join(localPrograms, dir, 'python.exe')]), `系统 Python（${dir}）`);
        }
      }
      for (const dir of ['C:\\Python312', 'C:\\Python311', 'C:\\Python310']) {
        push(firstExisting([path.join(dir, 'python.exe')]), `系统 Python（${path.basename(dir)}）`);
      }
    } else {
      const which = await exec('sh', ['-lc', 'command -v python3 || command -v python'], { timeout: 8000 });
      if (which.code === 0) push(which.stdout.trim().split('\n').pop().trim(), 'PATH 中的 python3');
    }
    return out;
  }

  function detectOwnVenvs() {
    const out = [];
    if (!exists(VENV_DIR)) return out;
    for (const name of fs.readdirSync(VENV_DIR)) {
      const prefix = path.join(VENV_DIR, name);
      const python = pythonInPrefix(prefix);
      if (python) out.push({ id: `venv:${prefix}`, kind: 'venv', name: `自建环境 ${name}`, prefix, python });
    }
    return out;
  }

  async function listEnvs({ force = false } = {}) {
    if (!force && cache.envs.length && Date.now() - cache.at < ENV_CACHE_MS) return cache.envs;
    const raw = [...await detectCondaEnvs(), ...detectOwnVenvs(), ...await detectSystemPythons()];

    // 同一个解释器可能被多条路径发现（例如 conda 的 base 也会出现在系统 Python 里），
    // 按解释器路径去重，conda 与自建环境优先
    const rank = { conda: 0, venv: 1, system: 2 };
    const picked = new Map();
    for (const item of raw) {
      if (!item.python) continue;
      if (/[\\/]WindowsApps[\\/]/i.test(item.python)) continue; // 微软商店的占位 python，不是真的解释器
      const key = path.resolve(item.python).toLowerCase();
      const prev = picked.get(key);
      if (!prev || rank[item.kind] < rank[prev.kind]) picked.set(key, item);
    }
    // 探测要起子进程，分批并发，避免一次拉起几十个
    const list = [...picked.values()];
    const envs = [];
    for (let i = 0; i < list.length; i += 5) {
      envs.push(...await Promise.all(list.slice(i, i + 5).map((item) => probe(item))));
    }
    envs.sort((a, b) => (rank[a.kind] - rank[b.kind]) || (a.is_base === b.is_base ? 0 : a.is_base ? -1 : 1));
    cache = { at: Date.now(), envs };
    return envs;
  }

  // 默认优先级：conda base → conda 的第一个 → 自建虚拟环境 → 系统 Python
  function pickDefault(envs) {
    const conda = envs.filter((e) => e.kind === 'conda' && !e.error);
    const base = conda.find((e) => e.is_base === true) || conda.find((e) => e.name === 'base');
    if (base) return base;
    if (conda.length) return conda[0];
    const venv = envs.find((e) => e.kind === 'venv' && !e.error);
    if (venv) return venv;
    return envs.find((e) => !e.error) || null;
  }

  async function resolveEnv(envId) {
    const envs = await listEnvs();
    const wanted = String(envId || selectedId || '').trim();
    if (wanted) {
      const hit = envs.find((e) => e.id === wanted);
      if (hit) return hit;
    }
    return pickDefault(envs);
  }

  function selectEnv(id) {
    selectedId = String(id || '');
    writeSettings();
    return selectedId;
  }

  // ---------------- pip ----------------

  async function downloadToFile(routes, target, onProgress) {
    const errors = [];
    for (const route of routes) {
      try {
        onProgress?.(`正在从${route.name}下载…`);
        const res = await fetch(route.url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length')) || 0;
        const chunks = [];
        let received = 0;
        for await (const chunk of res.body) {
          chunks.push(chunk);
          received += chunk.length;
          if (total) onProgress?.(`正在从${route.name}下载… ${Math.round((received / total) * 100)}%`);
        }
        const buffer = Buffer.concat(chunks);
        if (buffer.length < 1024) throw new Error('文件过小，可能是错误页面');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buffer);
        writeLog('info', `Python 安装包已从${route.name}下载：${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
        return { route: route.name, bytes: buffer.length };
      } catch (err) {
        const message = `${route.name}失败：${err.message}`;
        errors.push(message);
        writeLog('warn', `Python 安装包 ${message}`);
        onProgress?.(`${message}，切换到下一条线路…`);
      }
    }
    throw new Error(`所有下载线路都失败了：${errors.join('；')}`);
  }

  async function ensurePip(env, onProgress) {
    if (!env) throw new Error('没有可用的 Python 环境');
    const check = await exec(env.python, ['-m', 'pip', '--version'], { timeout: 20000 });
    if (check.code === 0) return { ok: true, installed: false, version: (check.stdout.match(/pip\s+([\d.]+)/) || [])[1] || '' };
    onProgress?.('未检测到 pip，正在用 ensurepip 安装…');
    const ensure = await exec(env.python, ['-m', 'ensurepip', '--upgrade'], { timeout: 180000 });
    if (ensure.code === 0) {
      const again = await exec(env.python, ['-m', 'pip', '--version'], { timeout: 20000 });
      if (again.code === 0) { cache.at = 0; return { ok: true, installed: true, via: 'ensurepip' }; }
    }
    onProgress?.('ensurepip 不可用，改用 get-pip.py…');
    const scriptPath = path.join(TMP_DIR, 'get-pip.py');
    await downloadToFile(getPipRoutes(), scriptPath, onProgress);
    const run = await exec(env.python, [scriptPath, '--no-warn-script-location'], { timeout: 300000 });
    cache.at = 0;
    if (run.code !== 0) throw new Error(`get-pip.py 安装失败：${(run.stderr || '').slice(-300)}`);
    return { ok: true, installed: true, via: 'get-pip.py' };
  }

  // ---------------- 自动安装 ----------------

  function setJob(patch) {
    installJob = { ...(installJob || { started_at: new Date().toISOString() }), ...patch, updated_at: new Date().toISOString() };
  }

  function installStatus() {
    return installJob || { running: false, stage: 'idle', message: '', percent: 0 };
  }

  async function installPython() {
    if (installJob?.running) return installStatus();
    installJob = {
      running: true, stage: 'download', percent: 0, message: '准备下载…',
      error: '', started_at: new Date().toISOString(), updated_at: new Date().toISOString(), routes_tried: [],
    };
    (async () => {
      try {
        const installer = path.join(PY_ROOT, IS_WIN ? 'miniconda-installer.exe' : 'miniconda-installer.sh');
        const progress = (message) => {
          const match = message.match(/(\d+)%/);
          setJob({ stage: 'download', message, percent: match ? Math.min(95, Number(match[1])) : (installJob?.percent || 5) });
        };
        const downloaded = await downloadToFile(minicondaRoutes(), installer, progress);
        setJob({ stage: 'install', percent: 96, message: `已从${downloaded.route}下载完成，正在静默安装…` });

        if (IS_WIN) {
          // Miniconda 的 NSIS 安装包支持 /S 静默与 /D= 指定目录（必须放在最后且不带引号）
          const result = await exec(installer, ['/S', `/D=${MINICONDA_DIR}`], { timeout: 30 * 60 * 1000 });
          if (result.code !== 0 && !exists(path.join(MINICONDA_DIR, 'python.exe'))) {
            throw new Error(`静默安装失败：${(result.stderr || result.stdout || '').slice(-300)}`);
          }
        } else {
          fs.chmodSync(installer, 0o755);
          const result = await exec('sh', [installer, '-b', '-p', MINICONDA_DIR], { timeout: 30 * 60 * 1000 });
          if (result.code !== 0) throw new Error(`安装失败：${(result.stderr || '').slice(-300)}`);
        }

        const basePython = firstExisting([path.join(MINICONDA_DIR, 'python.exe'), path.join(MINICONDA_DIR, 'bin', 'python3')]);
        const condaExe = firstExisting([path.join(MINICONDA_DIR, 'Scripts', 'conda.exe'), path.join(MINICONDA_DIR, 'bin', 'conda')]);
        if (!basePython) throw new Error('安装完成但找不到 python 解释器');

        setJob({ stage: 'venv', percent: 97, message: '正在创建 Python 3.12 隔离环境…' });
        const target = path.join(VENV_DIR, 'wenvedio-312');
        let created = false;
        if (condaExe) {
          const envName = `wenvedio-${Date.now().toString(36)}`;
          const create = await exec(condaExe, ['create', '-y', '-p', target, 'python=3.12'], { timeout: 45 * 60 * 1000 });
          created = create.code === 0 && Boolean(pythonInPrefix(target));
          if (!created) {
            writeLog('warn', `conda 创建环境失败，改用 venv：${(create.stderr || '').slice(-200)}`);
            setJob({ stage: 'venv', percent: 97, message: `conda 创建失败，改用 venv（${envName}）…` });
          }
        }
        if (!created) {
          const venv = await exec(basePython, ['-m', 'venv', target], { timeout: 10 * 60 * 1000 });
          if (venv.code !== 0) throw new Error(`创建虚拟环境失败：${(venv.stderr || '').slice(-300)}`);
          created = true;
        }

        setJob({ stage: 'pip', percent: 98, message: '正在确认 pip…' });
        const python = pythonInPrefix(target);
        await ensurePip({ python }, (message) => setJob({ stage: 'pip', percent: 98, message }));

        cache.at = 0;
        const envs = await listEnvs({ force: true });
        const fresh = envs.find((e) => e.prefix === target) || envs.find((e) => e.kind === 'venv' && e.prefix === target);
        if (fresh) selectEnv(fresh.id);
        setJob({ running: false, stage: 'done', percent: 100, message: `已安装并选中：${fresh ? fresh.name : target}`, error: '' });
        writeLog('info', `Python 自动安装完成：${target}`);
      } catch (err) {
        setJob({ running: false, stage: 'failed', percent: 100, message: '安装失败', error: err.message });
        writeLog('error', `Python 自动安装失败：${err.message}`);
      }
    })();
    return installStatus();
  }

  // ---------------- 执行 Python ----------------

  const MARKER = '__WENVEDIO_RESULT__';

  function buildScript(code) {
    return [
      '# -*- coding: utf-8 -*-',
      'import json, sys',
      '_payload = json.loads(sys.stdin.read() or "{}")',
      'input = _payload.get("input")',
      'outputs = _payload.get("outputs", {})',
      'vars = _payload.get("vars", {})',
      'result = None',
      '# ------- 用户代码开始 -------',
      code,
      '# ------- 用户代码结束 -------',
      'try:',
      `    _text = json.dumps({"ok": True, "result": result}, ensure_ascii=False, default=str)`,
      'except Exception as _err:',
      `    _text = json.dumps({"ok": False, "error": "result 无法序列化: %s" % _err}, ensure_ascii=False)`,
      `print("${MARKER}" + _text)`,
    ].join('\n');
  }

  async function runCode({ envId, code, payload, timeoutMs = 60000, signal = null }) {
    const env = await resolveEnv(envId);
    if (!env) throw new Error('没有可用的 Python 环境，请先在「工作流 → Python 环境」里安装或选择');
    const source = String(code || '');
    if (!source.trim()) throw new Error('Python 代码为空');
    if (Buffer.byteLength(source) > MAX_CODE_BYTES) throw new Error('代码过长');

    fs.mkdirSync(TMP_DIR, { recursive: true });
    const scriptPath = path.join(TMP_DIR, `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.py`);
    fs.writeFileSync(scriptPath, buildScript(source), 'utf8');

    return new Promise((resolve, reject) => {
      const child = spawn(env.python, ['-u', scriptPath], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
      let stdout = '';
      let stderr = '';
      let finished = false;
      const kill = () => { if (!finished) { try { child.kill(); } catch (_) { /* 已退出 */ } } };
      const timer = setTimeout(() => { kill(); reject(new Error(`Python 执行超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`)); }, Math.max(1000, timeoutMs));
      if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); kill(); reject(new Error('运行已被取消')); }, { once: true });

      child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 2 * 1024 * 1024) kill(); });
      child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 512 * 1024) kill(); });
      child.on('error', (err) => { clearTimeout(timer); finished = true; reject(new Error(`无法启动 Python：${err.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        finished = true;
        try { fs.unlinkSync(scriptPath); } catch (_) { /* 临时文件清理失败不影响结果 */ }
        const markerIndex = stdout.lastIndexOf(MARKER);
        if (markerIndex < 0) {
          const detail = (stderr || stdout || '').trim().split('\n').slice(-6).join('\n');
          return reject(new Error(`Python 执行失败（退出码 ${code}）：\n${detail}`));
        }
        let parsed;
        try {
          parsed = JSON.parse(stdout.slice(markerIndex + MARKER.length).split('\n')[0]);
        } catch (err) {
          return reject(new Error(`无法解析 Python 返回值：${err.message}`));
        }
        const printed = stdout.slice(0, markerIndex).trim();
        if (parsed.ok === false) return reject(new Error(parsed.error || 'Python 代码执行失败'));
        resolve({ result: parsed.result, printed: printed ? printed.slice(-4000) : '', stderr: stderr.trim().slice(-4000) || '', interpreter: env.python, env_name: env.name });
      });

      try {
        child.stdin.write(JSON.stringify(payload || {}));
        child.stdin.end();
      } catch (err) {
        reject(new Error(`写入 Python 输入失败：${err.message}`));
      }
    });
  }

  readSettings();

  return {
    listEnvs,
    pickDefault,
    resolveEnv,
    getSelected: () => selectedId,
    selectEnv,
    ensurePip,
    installPython,
    installStatus,
    runCode,
    pythonRoot: PY_ROOT,
    refresh: () => { cache.at = 0; },
  };
}

module.exports = { create };
