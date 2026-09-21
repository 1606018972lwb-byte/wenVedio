// 工作流 · HTTP 接口
// 挂到现有 server.js 的 /api 路由前面：命中就处理，没命中返回 false 交回给原路由。
'use strict';

function create({ store, engine, host, python, triggers, writeLog, sendJson, readBody, nodeMeta }) {
  const readJson = async (req) => {
    try {
      const text = await readBody(req);
      return text ? JSON.parse(text) : {};
    } catch (_) {
      return {};
    }
  };

  // 运行前检查开始节点的必填输入
  function validateInputs(workflow, inputs) {
    const startNode = (workflow.nodes || []).find((node) => node.type === 'start');
    if (!startNode) throw new Error('工作流缺少「开始」节点，无法确定输入');
    const fields = Array.isArray(startNode.params?.fields) ? startNode.params.fields : [];
    const missing = [];
    for (const field of fields) {
      const key = String(field?.key || '').trim();
      if (!key || field.required === false) continue;
      const value = inputs?.[key];
      if (value === undefined || value === null || value === '') missing.push(key);
    }
    if (missing.length) throw new Error(`缺少必填输入：${missing.join('、')}`);
  }

  async function handle(req, res, url) {
    const route = url.pathname;
    const known = route.startsWith('/api/workflows')
      || route.startsWith('/api/workflow-runs')
      || route.startsWith('/api/workflow-templates')
      || route.startsWith('/api/workflow-workspaces');
    if (!known) return false;
    const method = req.method;

    // ---------------- 工作区（分类） ----------------
    if (route === '/api/workflow-workspaces' && method === 'GET') {
      sendJson(res, 200, { ok: true, workspaces: store.listWorkspaces() });
      return true;
    }
    if (route === '/api/workflow-workspaces' && method === 'POST') {
      const payload = await readJson(req);
      try {
        const workspaces = store.createWorkspace(payload.name);
        writeLog('info', `新建工作区：${String(payload.name || '').slice(0, 40)}`);
        sendJson(res, 200, { ok: true, workspaces });
      } catch (err) {
        sendJson(res, 400, { ok: false, msg: err.message });
      }
      return true;
    }
    if (route === '/api/workflow-workspaces/rename' && method === 'POST') {
      const payload = await readJson(req);
      try {
        const workspaces = store.renameWorkspace(payload.from, payload.to);
        sendJson(res, 200, { ok: true, workspaces });
      } catch (err) {
        sendJson(res, 400, { ok: false, msg: err.message });
      }
      return true;
    }
    if (route === '/api/workflow-workspaces/delete' && method === 'POST') {
      const payload = await readJson(req);
      const result = store.deleteWorkspace(payload.name);
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    // ---------------- 模板库 ----------------
    if (route === '/api/workflow-templates' && method === 'GET') {
      sendJson(res, 200, { ok: true, templates: store.listTemplates() });
      return true;
    }

    if (route === '/api/workflow-templates' && method === 'POST') {
      const payload = await readJson(req);
      try {
        const template = store.saveTemplate(payload);
        writeLog('info', `保存工作流模板：${template.name}（${template.nodes.length} 个节点）`);
        sendJson(res, 200, { ok: true, template: { id: template.id, name: template.name, node_count: template.nodes.length, edge_count: template.edges.length } });
      } catch (err) {
        sendJson(res, 400, { ok: false, msg: err.message });
      }
      return true;
    }

    const templateMatch = route.match(/^\/api\/workflow-templates\/([^/]+)(?:\/(export))?$/);
    if (templateMatch) {
      const template = store.getTemplate(decodeURIComponent(templateMatch[1]));
      if (!template) { sendJson(res, 404, { ok: false, msg: '模板不存在' }); return true; }
      if (templateMatch[2] === 'export' && method === 'GET') {
        // 与工作流导出用同一种结构：拿到的文件直接走「导入」就能用
        sendJson(res, 200, {
          ok: true,
          kind: 'wenvedio-workflow',
          exported_at: new Date().toISOString(),
          workflow: {
            name: template.name,
            description: template.description || '',
            nodes: template.nodes,
            edges: template.edges,
            variables: template.variables || [],
          },
        });
        return true;
      }
      if (!templateMatch[2] && method === 'GET') {
        sendJson(res, 200, { ok: true, template });
        return true;
      }
      if (!templateMatch[2] && method === 'DELETE') {
        store.deleteTemplate(template.id);
        writeLog('info', `删除工作流模板：${template.name}`);
        sendJson(res, 200, { ok: true, deleted: template.id });
        return true;
      }
    }

    // 节点元信息（前端节点库与参数面板都靠它自动渲染）
    if (route === '/api/workflows/meta' && method === 'GET') {
      sendJson(res, 200, { ok: true, nodes: nodeMeta, chat_ready: host.hasChatToken(), engine_ready: true });
      return true;
    }

    // ---------------- Python 运行环境 ----------------
    if (route === '/api/workflows/python/envs' && method === 'GET') {
      const envs = await python.listEnvs();
      const fallback = python.pickDefault(envs);
      sendJson(res, 200, {
        ok: true,
        envs: envs.map((env) => ({
          id: env.id, kind: env.kind, name: env.name, prefix: env.prefix, python: env.python,
          version: env.version, pip: env.pip, pip_version: env.pip_version || '', error: env.error || '',
        })),
        selected: python.getSelected(),
        default_env: fallback ? fallback.id : '',
        install: python.installStatus(),
        root: python.pythonRoot,
      });
      return true;
    }

    if (route === '/api/workflows/python/select' && method === 'POST') {
      const payload = await readJson(req);
      const id = python.selectEnv(payload.env_id);
      sendJson(res, 200, { ok: true, selected: id });
      return true;
    }

    // pip 缺失时补装（ensurepip → 各镜像的 get-pip.py）
    if (route === '/api/workflows/python/pip' && method === 'POST') {
      const payload = await readJson(req);
      try {
        const env = await python.resolveEnv(payload.env_id);
        if (!env) { sendJson(res, 400, { ok: false, msg: '没有可用的 Python 环境' }); return true; }
        const result = await python.ensurePip(env, (message) => writeLog('info', `pip：${message}`));
        sendJson(res, 200, { ok: true, ...result, env_id: env.id });
      } catch (err) {
        sendJson(res, 200, { ok: false, msg: err.message });
      }
      return true;
    }

    // 一个 Python 都没有时，按多条镜像线路下载安装 3.12 并建好隔离环境
    if (route === '/api/workflows/python/install' && method === 'POST') {
      const status = await python.installPython();
      sendJson(res, 200, { ok: true, install: status });
      return true;
    }

    if (route === '/api/workflows/python/status' && method === 'GET') {
      sendJson(res, 200, { ok: true, install: python.installStatus() });
      return true;
    }

    // 导入工作流：接受导出文件原样，或 { workflow: {...} }
    if (route === '/api/workflows/import' && method === 'POST') {
      const payload = await readJson(req);
      const source = payload?.workflow && typeof payload.workflow === 'object' ? payload.workflow : payload;
      if (!source || !Array.isArray(source.nodes) || !source.nodes.length) {
        sendJson(res, 400, { ok: false, msg: '导入内容里没有节点，可能不是工作流导出文件' });
        return true;
      }
      const record = store.saveWorkflow({
        name: `${String(source.name || '导入的工作流').slice(0, 50)}（导入）`,
        description: String(source.description || '').slice(0, 200),
        workspace: String(source.workspace || '').slice(0, 40),
        nodes: source.nodes,
        edges: source.edges,
        variables: source.variables,
      });
      writeLog('info', `导入工作流：${record.name}（${record.nodes.length} 个节点）`);
      // 代码节点会真的执行里面的代码，导入别人的工作流时要让用户知道
      const codeNodes = record.nodes.filter((node) => node.type === 'code').length;
      sendJson(res, 200, { ok: true, workflow: record, code_nodes: codeNodes });
      return true;
    }

    if (route === '/api/workflows' && method === 'GET') {
      sendJson(res, 200, { ok: true, workflows: store.listWorkflows() });
      return true;
    }

    if (route === '/api/workflows' && method === 'POST') {
      const payload = await readJson(req);
      const record = store.saveWorkflow(payload || {});
      sendJson(res, 200, { ok: true, workflow: record });
      return true;
    }

    if (route === '/api/workflow-runs' && method === 'DELETE') {
      // 只清已结束的，正在跑的不动
      const removed = store.clearFinishedRuns();
      writeLog('info', `清空工作流运行记录：删除 ${removed} 条已结束记录`);
      sendJson(res, 200, { ok: true, removed });
      return true;
    }

    if (route === '/api/workflow-runs' && method === 'GET') {
      const workflowId = url.searchParams.get('workflow_id') || '';
      const limit = Number(url.searchParams.get('limit')) || 50;
      sendJson(res, 200, { ok: true, runs: store.listRuns(workflowId, limit) });
      return true;
    }

    let match = route.match(/^\/api\/workflow-runs\/([^/]+)(?:\/(cancel|pause|resume|rerun))?$/);
    if (match) {
      const runId = decodeURIComponent(match[1]);
      const action = match[2];
      if (!action && method === 'GET') {
        const run = store.getRun(runId);
        if (!run) { sendJson(res, 404, { ok: false, msg: '运行记录不存在' }); return true; }
        sendJson(res, 200, { ok: true, run, advancing: engine.isAdvancing(runId) });
        return true;
      }
      if (action === 'rerun' && method === 'POST') {
        // 用这条运行当时的输入，按当前的工作流定义再跑一次
        const source = store.getRun(runId);
        if (!source) { sendJson(res, 404, { ok: false, msg: '运行记录不存在' }); return true; }
        const workflow = store.getWorkflow(source.workflow_id);
        if (!workflow) { sendJson(res, 404, { ok: false, msg: '这条运行对应的工作流已被删除' }); return true; }
        try {
          validateInputs(workflow, source.inputs);
        } catch (err) {
          sendJson(res, 400, { ok: false, msg: err.message });
          return true;
        }
        const rerun = engine.startRun(workflow, source.inputs, 'draft');
        writeLog('info', `重跑 ${runId} → ${rerun.id}`);
        sendJson(res, 200, { ok: true, run_id: rerun.id, run: rerun, inputs: source.inputs });
        return true;
      }
      if (action && method === 'POST') {
        const run = action === 'cancel' ? engine.cancelRun(runId)
          : action === 'pause' ? engine.pauseRun(runId)
            : engine.resumeRun(runId);
        if (!run) { sendJson(res, 404, { ok: false, msg: '运行记录不存在' }); return true; }
        sendJson(res, 200, { ok: true, run });
        return true;
      }
    }

    // 触发器：Webhook 地址与令牌、定时计划的读写（两段路径，要在通用规则之前匹配）
    const triggerMatch = route.match(/^\/api\/workflows\/([^/]+)\/(triggers|hook-token)$/);
    if (triggerMatch) {
      const workflow = store.getWorkflow(decodeURIComponent(triggerMatch[1]));
      if (!workflow) { sendJson(res, 404, { ok: false, msg: '工作流不存在' }); return true; }
      const base = `${url.protocol}//${url.host}`;
      const current = () => store.getWorkflow(workflow.id) || workflow;
      if (triggerMatch[2] === 'triggers' && method === 'GET') {
        sendJson(res, 200, { ok: true, ...triggers.describe(current(), base) });
        return true;
      }
      if (triggerMatch[2] === 'triggers' && method === 'POST') {
        const payload = await readJson(req);
        triggers.saveSchedules(current(), payload.schedules);
        sendJson(res, 200, { ok: true, ...triggers.describe(current(), base) });
        return true;
      }
      if (triggerMatch[2] === 'hook-token' && method === 'POST') {
        triggers.resetToken(current());
        sendJson(res, 200, { ok: true, ...triggers.describe(current(), base) });
        return true;
      }
    }

    // 单个版本的完整内容：版本对比要拿它和当前草稿逐项比（GET，两段路径）
    const versionMatch = route.match(/^\/api\/workflows\/([^/]+)\/versions\/([^/]+)$/);
    if (versionMatch && method === 'GET') {
      const snapshot = store.getVersion(decodeURIComponent(versionMatch[1]), decodeURIComponent(versionMatch[2]));
      if (!snapshot) { sendJson(res, 404, { ok: false, msg: '版本不存在' }); return true; }
      sendJson(res, 200, { ok: true, version: snapshot });
      return true;
    }

    // 恢复历史版本：/api/workflows/:id/versions/:version/restore（三段路径，要在通用规则之前匹配）
    const restoreMatch = route.match(/^\/api\/workflows\/([^/]+)\/versions\/([^/]+)\/restore$/);
    if (restoreMatch && method === 'POST') {
      const workflow = store.restoreVersion(decodeURIComponent(restoreMatch[1]), decodeURIComponent(restoreMatch[2]));
      if (!workflow) { sendJson(res, 404, { ok: false, msg: '版本不存在' }); return true; }
      sendJson(res, 200, { ok: true, workflow });
      return true;
    }

    match = route.match(/^\/api\/workflows\/([^/]+)(?:\/([a-z-]+)(?:\/([^/]+))?)?$/);
    if (!match) return false;
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    const param = match[3];

    if (!action && method === 'GET') {
      const workflow = store.getWorkflow(id);
      if (!workflow) { sendJson(res, 404, { ok: false, msg: '工作流不存在' }); return true; }
      sendJson(res, 200, { ok: true, workflow });
      return true;
    }

    if (!action && method === 'DELETE') {
      const ok = store.deleteWorkflow(id);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true, deleted: id } : { ok: false, msg: '工作流不存在' });
      return true;
    }

    if (action === 'publish' && method === 'POST') {
      const workflow = store.publishWorkflow(id);
      if (!workflow) { sendJson(res, 404, { ok: false, msg: '工作流不存在' }); return true; }
      sendJson(res, 200, { ok: true, workflow });
      return true;
    }

    if (action === 'duplicate' && method === 'POST') {
      const workflow = store.duplicateWorkflow(id);
      sendJson(res, workflow ? 200 : 404, workflow ? { ok: true, workflow } : { ok: false, msg: '工作流不存在' });
      return true;
    }

    // 归类到工作区（列表页按工作区整理用）
    if (action === 'workspace' && method === 'POST') {
      const payload = await readJson(req);
      const updated = store.setWorkspace(id, payload.workspace);
      if (!updated) { sendJson(res, 404, { ok: false, msg: '工作流不存在' }); return true; }
      sendJson(res, 200, { ok: true, workflow: updated });
      return true;
    }

    if (action === 'export' && method === 'GET') {
      const workflow = store.getWorkflow(id);
      if (!workflow) { sendJson(res, 404, { ok: false, msg: '工作流不存在' }); return true; }
      sendJson(res, 200, {
        ok: true,
        kind: 'wenvedio-workflow',
        exported_at: new Date().toISOString(),
        workflow: {
          name: workflow.name,
          description: workflow.description || '',
          workspace: workflow.workspace || '',
          nodes: workflow.nodes,
          edges: workflow.edges,
          variables: workflow.variables || [],
        },
      });
      return true;
    }

    if (action === 'versions' && method === 'GET') {
      const workflow = store.getWorkflow(id);
      if (!workflow) { sendJson(res, 404, { ok: false, msg: '工作流不存在' }); return true; }
      sendJson(res, 200, {
        ok: true,
        versions: store.listVersions(id),
        published_version: workflow.published_version || 0,
        // 当前草稿的规模，界面用来显示「草稿 12 节点 / 13 连线」
        draft: {
          node_count: (workflow.nodes || []).length,
          edge_count: (workflow.edges || []).length,
          variable_count: (workflow.variables || []).length,
          updated_at: workflow.updated_at || '',
        },
      });
      return true;
    }

    if (action === 'restore' && method === 'POST') {
      const workflow = store.restoreVersion(id, param);
      if (!workflow) { sendJson(res, 404, { ok: false, msg: '版本不存在' }); return true; }
      sendJson(res, 200, { ok: true, workflow });
      return true;
    }

    if (action === 'run' && method === 'POST') {
      const payload = await readJson(req);
      const workflow = store.getWorkflow(id);
      if (!workflow) { sendJson(res, 404, { ok: false, msg: '工作流不存在' }); return true; }
      const fromNode = String(payload.from_node || '').trim();
      if (fromNode) {
        // 从中间节点开始：需要一个历史运行来提供上游的输出
        if (!workflow.nodes.some((node) => node.id === fromNode)) {
          sendJson(res, 400, { ok: false, msg: `节点不存在：${fromNode}` });
          return true;
        }
        const base = (payload.base_run_id ? store.getRun(String(payload.base_run_id)) : null)
          || store.listRuns(id, 1)[0] || null;
        if (!base) {
          sendJson(res, 400, { ok: false, msg: '从中间节点开始需要一次历史运行提供上游结果，请先完整跑一次' });
          return true;
        }
        const seedOutputs = {};
        for (const [nodeId, state] of Object.entries(base.nodes || {})) {
          if (state && state.output !== undefined) seedOutputs[nodeId] = state.output;
        }
        const inputs = payload.inputs && Object.keys(payload.inputs).length ? payload.inputs : (base.inputs || {});
        const started = engine.startRun(workflow, inputs, 'draft', { fromNode, seedOutputs });
        writeLog('info', `从节点 ${fromNode} 开始运行（沿用 ${base.id} 的上游结果）`);
        sendJson(res, 200, { ok: true, run_id: started.id, run: started, from_node: fromNode, base_run_id: base.id });
        return true;
      }
      try {
        validateInputs(workflow, payload.inputs);
      } catch (err) {
        sendJson(res, 400, { ok: false, msg: err.message });
        return true;
      }
      const run = engine.startRun(workflow, payload.inputs, payload.mode === 'published' ? 'published' : 'draft');
      sendJson(res, 200, { ok: true, run_id: run.id, run });
      return true;
    }

    // 单节点调试：只跑这一个节点，inputs 当作上游输出喂进去
    if (action === 'hook' && method === 'POST') {
      // Webhook：请求体（JSON）就是这次运行的输入，query 参数也能当输入用
      const workflow = store.getWorkflow(id);
      if (!workflow) { sendJson(res, 404, { ok: false, msg: 'Webhook 地址无效' }); return true; }
      const payload = await readJson(req);
      for (const [key, value] of url.searchParams) {
        if (payload[key] === undefined) payload[key] = value;
      }
      const result = triggers.fireHook(workflow, param, payload);
      if (!result.ok) { sendJson(res, result.status || 400, { ok: false, msg: result.msg }); return true; }
      sendJson(res, 200, { ok: true, run_id: result.run.id, status: result.run.status, workflow_id: workflow.id });
      return true;
    }

    if (action === 'test-node' && method === 'POST') {
      const payload = await readJson(req);
      const node = payload.node;
      if (!node || !node.type) { sendJson(res, 400, { ok: false, msg: '缺少节点定义' }); return true; }
      try {
        const result = await engine.testNode(node, payload.inputs || {});
        sendJson(res, 200, { ok: true, output: result.output, duration_ms: result.duration_ms });
      } catch (err) {
        writeLog('warn', `工作流单节点调试失败：${err.message}`);
        sendJson(res, 200, { ok: false, msg: err.message });
      }
      return true;
    }

    return false;
  }

  return { handle };
}

module.exports = { create };
