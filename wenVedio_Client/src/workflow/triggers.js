// 工作流 · 触发器（Webhook + 定时）
// 两种让工作流「自己跑起来」的方式：
//   1) Webhook：每个工作流一把随机令牌，POST /api/workflows/<id>/hook/<token> 即可，
//      请求体（JSON）就是这次运行的输入。令牌可以随时重置。
//   2) 定时：按「每 N 分钟」或「每天 HH:MM」触发，输入可以预先写好。
// 时间基准统一用北京时间（和客户端的任务调度一致），不依赖宿主的 server.js。
'use strict';

const crypto = require('crypto');

const TICK_MS = 20000;
const MAX_SCHEDULES = 8;
const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

const nowIso = () => new Date().toISOString();

// 北京时间当天 0 点对应的绝对毫秒
function dayStartMs(ms) {
  return Math.floor((ms + CN_OFFSET_MS) / 86400000) * 86400000 - CN_OFFSET_MS;
}

function hhmmToMinutes(text) {
  const match = String(text || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 9 * 60;
  const hh = Math.min(23, Math.max(0, Number(match[1])));
  const mm = Math.min(59, Math.max(0, Number(match[2])));
  return hh * 60 + mm;
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

// 存下来的计划可能来自旧版本或被人手改过，读写都要收一遍
function normalizeSchedules(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_SCHEDULES).map((raw, index) => {
    const item = raw && typeof raw === 'object' ? raw : {};
    const mode = item.mode === 'daily' ? 'daily' : 'interval';
    return {
      id: String(item.id || `sch_${index + 1}`).slice(0, 40),
      mode,
      every_minutes: Math.max(1, Math.min(10080, Number(item.every_minutes) || 60)),
      at: /^\d{1,2}:\d{2}$/.test(String(item.at || '')) ? String(item.at) : '09:00',
      enabled: item.enabled !== false,
      inputs: item.inputs && typeof item.inputs === 'object' && !Array.isArray(item.inputs) ? item.inputs : {},
      created_at: item.created_at || nowIso(),
      last_fired_at: item.last_fired_at || null,
      last_run_id: item.last_run_id || '',
      last_status: String(item.last_status || ''),
    };
  });
}

// 下一次该触发的时间；已过期的返回过去的时间，由调用方决定补不补跑
function nextFireAt(schedule, fromMs) {
  if (schedule.mode === 'daily') {
    let target = dayStartMs(fromMs) + hhmmToMinutes(schedule.at) * 60000;
    if (target <= fromMs) target += 86400000;
    return target;
  }
  const base = schedule.last_fired_at ? new Date(schedule.last_fired_at).getTime()
    : (schedule.created_at ? new Date(schedule.created_at).getTime() : fromMs);
  return (Number.isFinite(base) ? base : fromMs) + schedule.every_minutes * 60000;
}

function create({ store, engine, writeLog }) {
  let timer = null;

  const hookUrl = (workflow, base) => `${base || ''}/api/workflows/${encodeURIComponent(workflow.id)}/hook/${workflow.hook_token || ''}`;

  function ensureToken(workflow) {
    if (workflow.hook_token) return workflow.hook_token;
    const token = newToken();
    store.patchWorkflow(workflow.id, { hook_token: token });
    return token;
  }

  function resetToken(workflow) {
    const token = newToken();
    // 重置后旧地址立刻失效（这就是「重置」的意义）
    store.patchWorkflow(workflow.id, { hook_token: token });
    writeLog('info', `工作流 ${workflow.name} 的 Webhook 令牌已重置`);
    return token;
  }

  function saveSchedules(workflow, list) {
    const schedules = normalizeSchedules(list);
    store.patchWorkflow(workflow.id, { triggers: schedules });
    return schedules;
  }

  // Webhook 触发：令牌不对一律拒绝，不泄露这个工作流是否存在
  function fireHook(workflow, token, inputs) {
    const expected = workflow.hook_token;
    if (!expected || String(token) !== expected) return { ok: false, status: 404, msg: 'Webhook 地址无效' };
    const missing = missingInputs(workflow, inputs);
    if (missing.length) return { ok: false, status: 400, msg: `缺少必填输入：${missing.join('、')}` };
    try {
      const run = engine.startRun(workflow, inputs && typeof inputs === 'object' ? inputs : {}, 'hook');
      store.patchWorkflow(workflow.id, {
        hook_last_at: nowIso(),
        hook_runs: Number(workflow.hook_runs || 0) + 1,
      });
      writeLog('info', `Webhook 触发 ${workflow.name} → ${run.id}`);
      return { ok: true, run };
    } catch (err) {
      return { ok: false, status: 400, msg: err.message };
    }
  }

  // 开始节点的必填项检查（和手动运行同一套规则，放在这里避免 api.js 反向依赖）
  function missingInputs(workflow, inputs) {
    const start = (workflow.nodes || []).find((node) => node.type === 'start');
    const fields = Array.isArray(start?.params?.fields) ? start.params.fields : [];
    return fields.filter((field) => {
      const key = String(field?.key || '').trim();
      if (!key || field.required === false) return false;
      const value = (inputs || {})[key];
      return value === undefined || value === null || value === '';
    }).map((field) => String(field.key));
  }

  // 定时：每个计划到点就跑一次；上一个run 没结束就跳过这一次，不叠着跑
  async function tick(now = Date.now()) {
    for (const workflow of store.listWorkflows()) {
      const schedules = Array.isArray(workflow.triggers) ? workflow.triggers : [];
      if (!schedules.length) continue;
      let dirty = false;
      for (const schedule of schedules) {
        if (schedule.enabled === false) continue;
        if (nextFireAt(schedule, now) > now) continue;
        // 同一条计划上次还没跑完：跳过，等下一轮（避免每 20 秒堆一个 run）
        if (schedule.last_run_id && engine.hasActiveRun(workflow.id)) {
          schedule.last_status = '上次运行还没结束，本次跳过';
          dirty = true;
          continue;
        }
        try {
          const run = engine.startRun(workflow, schedule.inputs || {}, 'schedule');
          schedule.last_fired_at = nowIso();
          schedule.last_run_id = run.id;
          schedule.last_status = '已触发';
          writeLog('info', `定时触发 ${workflow.name}（${schedule.mode === 'daily' ? `每天 ${schedule.at}` : `每 ${schedule.every_minutes} 分钟`}）→ ${run.id}`);
        } catch (err) {
          schedule.last_fired_at = nowIso();
          schedule.last_status = `触发失败：${err.message}`;
          writeLog('warn', `定时触发失败 ${workflow.name}：${err.message}`);
        }
        dirty = true;
      }
      if (dirty) store.patchWorkflow(workflow.id, { triggers: schedules });
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch((err) => writeLog('error', `定时触发检查失败：${err.message}`));
    }, TICK_MS);
    if (timer.unref) timer.unref();
    // 启动时先补一次：客户端关着的时候错过的计划，开起来 20 秒内会补上
    tick().catch((err) => writeLog('error', `定时触发检查失败：${err.message}`));
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // 给界面用的状态：地址、令牌、每个计划的下一次时间
  function describe(workflow, base) {
    const token = ensureToken(workflow);
    const now = Date.now();
    return {
      webhook: {
        enabled: Boolean(token),
        url: hookUrl({ id: workflow.id, hook_token: token }, base),
        token,
        runs: Number(workflow.hook_runs || 0),
        last_at: workflow.hook_last_at || null,
      },
      schedules: normalizeSchedules(workflow.triggers).map((schedule) => ({
        ...schedule,
        next_at: schedule.enabled ? new Date(nextFireAt(schedule, now)).toISOString() : null,
        due: schedule.enabled ? nextFireAt(schedule, now) <= now : false,
      })),
      tick_ms: TICK_MS,
    };
  }

  return { start, stop, tick, describe, ensureToken, resetToken, saveSchedules, fireHook, hookUrl, nextFireAt, normalizeSchedules };
}

module.exports = { create, normalizeSchedules, nextFireAt };
