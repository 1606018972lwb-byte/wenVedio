// 工作流 · 节点注册表与执行器
// 每个节点声明：分类、图标、参数表单（供右侧配置栏自动渲染）、输出字段（供变量选择器使用）、执行函数。
// 新增节点类型只需要在这里加一条，前端无需改动。
'use strict';

const vm = require('vm');
const { resolveParam } = require('./vars');

const NODE_DEFS = {
  // ---------------- 基础 ----------------
  start: {
    label: '开始', icon: '▶', group: '基础', color: 'green',
    description: '定义工作流的输入参数，运行时的入口',
    inputs: [],
    outputs: [{ key: 'output', label: '全部输入', type: 'object' }],
    params: [{ key: 'fields', label: '输入参数', type: 'fields', required: true }],
    run(ctx) {
      const fields = Array.isArray(ctx.params.fields) ? ctx.params.fields : [];
      const out = {};
      fields.forEach((field) => {
        const key = String(field?.key || '').trim();
        if (key) out[key] = ctx.rawInputs?.[key] !== undefined ? ctx.rawInputs[key] : (field.default ?? null);
      });
      // 开始节点的输出直接展开到自己的命名空间下，方便 {{start.xxx}} 取用
      return { output: out, ...out };
    },
  },

  end: {
    label: '结束', icon: '⏹', group: '基础', color: 'green',
    description: '定义工作流最终返回的内容',
    inputs: ['main'],
    outputs: [],
    params: [{ key: 'outputs', label: '输出映射', type: 'outputs' }],
    run(ctx) {
      const rows = Array.isArray(ctx.params.outputs) ? ctx.params.outputs : [];
      const out = {};
      rows.forEach((row) => {
        const key = String(row?.key || '').trim();
        if (key) out[key] = row?.value;
      });
      return out;
    },
  },

  variable: {
    label: '变量', icon: '𝑥', group: '基础', color: 'violet',
    description: '创建或修改变量，供后面的节点引用',
    inputs: ['main'],
    outputs: [{ key: 'output', label: '变量集合', type: 'object' }],
    params: [{ key: 'assignments', label: '赋值', type: 'assignments' }],
    run(ctx) {
      const rows = Array.isArray(ctx.params.assignments) ? ctx.params.assignments : [];
      const out = {};
      rows.forEach((row) => {
        const key = String(row?.key || '').trim();
        if (key) out[key] = row?.value;
      });
      // 同时写进全局变量表：后面的节点既能用 {{变量节点.key}}，也能用 {{vars.key}}
      if (ctx.run && ctx.run.variables && typeof ctx.run.variables === 'object') {
        Object.assign(ctx.run.variables, out);
      }
      return out;
    },
  },

  // ---------------- 逻辑 ----------------
  condition: {
    label: '条件分支', icon: '⑂', group: '逻辑', color: 'violet',
    description: '按条件把流程分到不同出口，只有命中那条继续跑，其余整条跳过',
    inputs: ['main'],
    // branches: true → 画布上按分支渲染多个出口（Coze 的选择器节点）
    branches: true,
    outputs: [
      { key: 'branch', label: '命中的出口名', type: 'string' },
      { key: 'index', label: '命中序号', type: 'number' },
    ],
    params: [
      { key: 'branches', label: '出口与条件', type: 'branches', required: true,
        default: [{ key: '条件1', expr: '' }],
        help: '从上往下判断，命中第一个就停下；都不命中走「否则」出口' },
      { key: 'input_fields', label: '判断用的输入', type: 'pairs',
        help: '不填就用上游节点的输出；填了之后表达式里用 input.名称 取' },
    ],
    run(ctx) {
      // 判断用的输入：优先用节点自己声明的映射，否则用上游节点的输出
      const inputRows = Array.isArray(ctx.params.input_fields) ? ctx.params.input_fields : [];
      let judgeInput = ctx.input;
      if (inputRows.length) {
        const mapped = {};
        for (const row of inputRows) {
          const key = String(row?.key || '').trim();
          if (key) mapped[key] = resolveParam(row?.value, ctx.scope);
        }
        judgeInput = mapped;
      }
      const rows = Array.isArray(ctx.params.branches) ? ctx.params.branches : [];
      let hit = null;
      let hitIndex = -1;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const expr = String(row?.expr || '').trim();
        if (!expr) continue;
        let value = false;
        try {
          value = evaluateExpression(expr, { ...ctx, input: judgeInput });
        } catch (err) {
          throw new Error(`分支「${row?.key || index + 1}」的条件求值失败：${err.message}`);
        }
        if (value) { hit = String(row.key || `分支${index + 1}`); hitIndex = index + 1; break; }
      }
      if (hit === null) { hit = 'else'; hitIndex = 0; }
      ctx.log(`条件分支命中：${hit}`);
      return { branch: hit, index: hitIndex, is_else: hit === 'else', judged: judgeInput };
    },
  },

  merge: {
    label: '变量聚合', icon: '⊕', group: '逻辑', color: 'violet',
    description: '把多个分支的输出合并到一起，哪个分支跑了就聚合哪个',
    inputs: ['main'],
    outputs: [{ key: 'output', label: '聚合结果', type: 'object' }],
    params: [
      { key: 'fields', label: '聚合哪些字段', type: 'pairs',
        help: '留空则把上游输出的所有字段合并进来；填了只取这些字段' },
    ],
    run(ctx) {
      const upstreams = Array.isArray(ctx.upstreams) ? ctx.upstreams : [];
      const merged = {};
      for (const item of upstreams) {
        if (item && item.output && typeof item.output === 'object') Object.assign(merged, item.output);
      }
      if (!Object.keys(merged).length && ctx.input && typeof ctx.input === 'object') Object.assign(merged, ctx.input);
      const rows = Array.isArray(ctx.params.fields) ? ctx.params.fields : [];
      if (rows.length) {
        const picked = {};
        for (const row of rows) {
          const key = String(row?.key || '').trim();
          if (key) picked[key] = resolveParam(row?.value, ctx.scope);
        }
        return { output: picked, ...picked, merged_from: upstreams.map((item) => item.id) };
      }
      return { output: merged, ...merged, merged_from: upstreams.map((item) => item.id) };
    },
  },

  loop: {
    label: '循环', icon: '↻', group: '逻辑', color: 'violet',
    description: '对一个数组的每一项都执行同一个子工作流，把结果收成一个数组',
    inputs: ['main'],
    outputs: [
      { key: 'results', label: '结果数组', type: 'array' },
      { key: 'count', label: '成功条数', type: 'number' },
      { key: 'failed', label: '失败明细', type: 'array' },
    ],
    params: [
      { key: 'items', label: '要遍历的数组', type: 'prompt', rows: 2, required: true,
        placeholder: '{{code_1.list}}，也可以直接写 ["a","b"]' },
      { key: 'workflow_id', label: '重复执行的子工作流', type: 'workflow', required: true,
        help: '每一项都会用同一个子工作流跑一遍' },
      { key: 'item_key', label: '每项传进去的字段名', type: 'text', default: 'item',
        help: '子工作流的「开始」节点里定义同名输入项即可接住当前这一项' },
      { key: 'concurrency', label: '并发数', type: 'number', min: 1, max: 5, default: 1,
        help: '1 表示一条一条跑；调大可加速，但会同时占用模型配额' },
      { key: 'fail_fast', label: '遇到失败就整体中止', type: 'switch', default: false },
      { key: 'timeout_ms', label: '每项超时(毫秒)', type: 'number', min: 1000, max: 3600000, default: 600000 },
    ],
    async run(ctx) {
      const raw = ctx.params.items;
      let list = [];
      if (Array.isArray(raw)) list = raw;
      else if (typeof raw === 'string' && raw.trim()) {
        try { const parsed = JSON.parse(raw); list = Array.isArray(parsed) ? parsed : [parsed]; }
        catch (_) { list = raw.split('\n').map((line) => line.trim()).filter(Boolean); }
      } else if (raw !== undefined && raw !== null && raw !== '') list = [raw];
      if (!list.length) return { results: [], count: 0, failed: [], total: 0 };

      const workflowId = String(ctx.params.workflow_id || '').trim();
      if (!workflowId) throw new Error('循环节点需要先选一个要重复执行的子工作流');
      const itemKey = String(ctx.params.item_key || 'item').trim() || 'item';
      const concurrency = Math.max(1, Math.min(5, Number(ctx.params.concurrency) || 1));
      const timeoutMs = Math.max(1000, Math.min(3600000, Number(ctx.params.timeout_ms) || 600000));
      const results = new Array(list.length).fill(null);
      const failed = [];
      let cursor = 0;
      let done = 0;

      const worker = async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= list.length) return;
          if (ctx.isCancelled && ctx.isCancelled()) throw new Error('运行已被取消');
          const inputs = { [itemKey]: list[index], index, total: list.length };
          try {
            const sub = await ctx.bridge.runWorkflow(workflowId, inputs, { timeoutMs, parentRunId: ctx.run.id });
            results[index] = sub.outputs;
          } catch (err) {
            results[index] = null;
            failed.push({ index, item: list[index], error: err.message });
            ctx.log(`第 ${index + 1} 项失败：${err.message}`);
            if (ctx.params.fail_fast === true) throw err;
          }
          done += 1;
          ctx.progress(Math.round((done / list.length) * 100));
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
      if (failed.length && ctx.params.fail_fast === true) {
        throw new Error(`${failed.length} 项失败，已按「遇到失败就中止」停止`);
      }
      return { results, count: results.filter((item) => item !== null).length, failed, total: list.length };
    },
  },

  // ---------------- AI 能力 ----------------
  llm: {
    label: '大模型', icon: '✦', group: 'AI 能力', color: 'blue',
    description: '调用大模型生成文本，Prompt 里可以插入上游变量',
    inputs: ['main'],
    outputs: [
      { key: 'output', label: '文本结果', type: 'string' },
      { key: 'total_tokens', label: 'Token 消耗', type: 'number' },
    ],
    params: [
      { key: 'source', label: '调用方式', type: 'select', default: 'deepseek', options: [
        { value: 'deepseek', label: 'DeepSeek（默认）' },
        { value: 'model', label: '使用已配置的模型' },
      ] },
      { key: 'model_id', label: '模型', type: 'model', kinds: ['text'], showWhen: { source: 'model' } },
      { key: 'chat_model', label: '对话模型名', type: 'text', placeholder: '留空 = deepseek-chat', showWhen: { source: 'deepseek' } },
      { key: 'system_prompt', label: 'System Prompt', type: 'textarea', rows: 3 },
      { key: 'user_prompt', label: 'User Prompt', type: 'prompt', rows: 5, placeholder: '支持 {{节点.字段}} 变量' },
      { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.1, default: 0.7 },
      { key: 'max_tokens', label: 'Max Tokens', type: 'number', min: 1, max: 32768, default: 2048 },
      { key: 'json_mode', label: '结构化输出(JSON)', type: 'switch', default: false },
    ],
    async run(ctx) {
      const messages = [];
      if (ctx.params.system_prompt) messages.push({ role: 'system', content: String(ctx.params.system_prompt) });
      const userText = String(ctx.params.user_prompt || '');
      const images = await collectImages(ctx.params.images, ctx.bridge);
      if (images.length) {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: userText }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))],
        });
      } else {
        messages.push({ role: 'user', content: userText });
      }
      const target = await ctx.bridge.resolveChatTarget(ctx.params);
      const result = await ctx.bridge.callChat({
        target,
        messages,
        temperature: Number(ctx.params.temperature ?? 0.7),
        maxTokens: Number(ctx.params.max_tokens || 2048),
        jsonMode: ctx.params.json_mode === true,
      });
      return {
        output: result.text,
        text: result.text,
        model: result.model,
        prompt_tokens: result.usage?.prompt_tokens ?? null,
        completion_tokens: result.usage?.completion_tokens ?? null,
        total_tokens: result.usage?.total_tokens ?? null,
        raw: result.raw,
      };
    },
  },

  vision: {
    label: '图片理解', icon: '👁', group: 'AI 能力', color: 'blue',
    description: '把图片交给视觉模型分析，输出结构化描述',
    inputs: ['main'],
    outputs: [
      { key: 'output', label: '分析结果', type: 'string' },
      { key: 'total_tokens', label: 'Token 消耗', type: 'number' },
    ],
    params: [
      { key: 'source', label: '调用方式', type: 'select', default: 'model', options: [
        { value: 'model', label: '使用已配置的模型' },
        { value: 'deepseek', label: 'DeepSeek（默认）' },
      ] },
      { key: 'model_id', label: '模型', type: 'model', kinds: ['text', 'image'], showWhen: { source: 'model' } },
      { key: 'chat_model', label: '对话模型名', type: 'text', placeholder: '留空 = deepseek-chat', showWhen: { source: 'deepseek' } },
      { key: 'images', label: '输入图片', type: 'image-list', required: true },
      { key: 'user_prompt', label: '分析要求', type: 'prompt', rows: 4, default: '描述这张图片的主体、场景、风格与可用于生成的提示词要点。' },
      { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.1, default: 0.3 },
      { key: 'max_tokens', label: 'Max Tokens', type: 'number', min: 1, max: 32768, default: 1024 },
    ],
    async run(ctx) {
      const images = await collectImages(ctx.params.images, ctx.bridge);
      if (!images.length) throw new Error('图片理解节点需要至少一张图片，请在上游节点传图或直接填图片地址');
      const messages = [];
      if (ctx.params.system_prompt) messages.push({ role: 'system', content: String(ctx.params.system_prompt) });
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: String(ctx.params.user_prompt || '') },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      });
      const target = await ctx.bridge.resolveChatTarget(ctx.params);
      const result = await ctx.bridge.callChat({
        target,
        messages,
        temperature: Number(ctx.params.temperature ?? 0.3),
        maxTokens: Number(ctx.params.max_tokens || 1024),
      });
      return {
        output: result.text,
        text: result.text,
        model: result.model,
        total_tokens: result.usage?.total_tokens ?? null,
        raw: result.raw,
      };
    },
  },

  image: {
    label: '图片生成', icon: '▣', group: 'AI 能力', color: 'orange',
    description: '调用已配置的图片模型生成图片，产物会进入任务中心',
    inputs: ['main'],
    outputs: [
      { key: 'images', label: '图片地址数组', type: 'array' },
      { key: 'image_url', label: '第一张图片', type: 'string' },
      { key: 'task_id', label: '任务号', type: 'string' },
      { key: 'count', label: '张数', type: 'number' },
    ],
    params: [
      { key: 'model_id', label: '图片模型', type: 'model', kinds: ['image'], required: true },
      { key: 'prompt', label: 'Prompt', type: 'prompt', rows: 4, required: true },
      { key: 'negative_prompt', label: 'Negative Prompt', type: 'prompt', rows: 2 },
      { key: 'size', label: '尺寸', type: 'text', placeholder: '留空用模型默认，如 1024x1024' },
      { key: 'count', label: '数量', type: 'number', min: 1, max: 10, default: 1 },
      { key: 'reference_images', label: '参考图片', type: 'image-list' },
    ],
    async run(ctx) {
      const modelId = String(ctx.params.model_id || '');
      const bridge = ctx.bridge;
      // 已有 pending 说明是重启后续跑：任务记录就是上一次建的那条
      let record = ctx.pending?.record_id ? bridge.tasks.get(ctx.pending.record_id) : null;
      if (!record) {
        const model = bridge.models.get(modelId);
        if (!model) throw new Error(`图片模型不存在：${modelId}`);
        const refs = await collectImages(ctx.params.reference_images, bridge);
        const params = {};
        if (ctx.params.size) params.size = String(ctx.params.size);
        if (ctx.params.negative_prompt) params.negative_prompt = String(ctx.params.negative_prompt);
        params.n = Math.max(1, Math.min(10, Number(ctx.params.count) || 1));
        record = {
          local_id: bridge.helpers.newLocalId(),
          kind: 'image',
          name: `工作流 · ${ctx.node.title || '图片生成'}`,
          model_id: modelId,
          model_name: model.name,
          prompt: String(ctx.params.prompt || ''),
          params,
          reference_images: refs,
          image_count: 0,
          status: 'processing',
          provider_task_id: null,
          error: null,
          workflow_id: ctx.run.workflow_id,
          workflow_run_id: ctx.run.id,
          workflow_node_id: ctx.node.id,
          created_at: new Date().toISOString(),
        };
        bridge.tasks.set(record.local_id, record);
        bridge.helpers.saveStore();
        ctx.setPending({ record_id: record.local_id, kind: 'image' });
        await bridge.helpers.runImageGeneration(record);
      } else if (record.status === 'processing') {
        // 生成过程中进程退出过，图片接口没有可续查的任务号
        throw new Error('图片生成在进程退出时被中断，请重新运行该节点（图片任务已保留在任务中心）');
      }
      if (record.status === 'failed') throw new Error(record.error || '图片生成失败');
      const files = Array.isArray(record.image_files) ? record.image_files : [];
      if (!files.length) throw new Error('图片生成没有返回结果');
      const base = bridge.localBase();
      const urls = files.map((name, index) => `${base}/api/tasks/${encodeURIComponent(record.local_id)}/image/${index}?file=${encodeURIComponent(name)}`);
      return {
        images: urls,
        files,
        image_url: urls[0],
        task_id: record.local_id,
        count: files.length,
        cost: record.cost ?? null,
        cost_currency: record.cost_currency || 'CNY',
      };
    },
  },

  video: {
    label: '视频生成', icon: '▶', group: 'AI 能力', color: 'orange',
    description: '调用已配置的视频模型生成视频，自动等待平台完成',
    inputs: ['main'],
    outputs: [
      { key: 'video_url', label: '视频地址', type: 'string' },
      { key: 'task_id', label: '任务号', type: 'string' },
    ],
    params: [
      { key: 'model_id', label: '视频模型', type: 'model', kinds: ['video'], required: true },
      { key: 'prompt', label: 'Prompt', type: 'prompt', rows: 4, required: true },
      { key: 'duration', label: '时长(秒)', type: 'number', min: 1, max: 15, default: 5 },
      { key: 'resolution', label: '分辨率', type: 'text', placeholder: '留空用模型默认，如 768p竖' },
      { key: 'seed', label: 'Seed', type: 'number', min: 1 },
      { key: 'reference_images', label: '参考图片', type: 'image-list' },
      { key: 'wait_seconds', label: '最长等待(秒)', type: 'number', min: 30, max: 3600, default: 900 },
    ],
    async run(ctx) {
      const bridge = ctx.bridge;
      let record = ctx.pending?.record_id ? bridge.tasks.get(ctx.pending.record_id) : null;
      if (!record) {
        const modelId = String(ctx.params.model_id || '');
        const model = bridge.models.get(modelId);
        if (!model) throw new Error(`视频模型不存在：${modelId}`);
        const refs = await collectImages(ctx.params.reference_images, bridge);
        record = {
          local_id: bridge.helpers.newLocalId(),
          kind: 'video',
          name: `工作流 · ${ctx.node.title || '视频生成'}`,
          model_id: modelId,
          model_name: model.name,
          prompt: String(ctx.params.prompt || ''),
          duration: Number(ctx.params.duration) || 5,
          resolution: String(ctx.params.resolution || ''),
          seed: Number.isInteger(Number(ctx.params.seed)) ? Number(ctx.params.seed) : undefined,
          params: {},
          reference_images: refs,
          status: 'submitting',
          provider_task_id: null,
          error: null,
          workflow_id: ctx.run.workflow_id,
          workflow_run_id: ctx.run.id,
          workflow_node_id: ctx.node.id,
          created_at: new Date().toISOString(),
        };
        bridge.tasks.set(record.local_id, record);
        bridge.helpers.saveStore();
        // 先落 pending，之后即使进程重启也能从这条记录继续查
        ctx.setPending({ record_id: record.local_id, kind: 'video' });
        await bridge.helpers.performSubmission(record);
      }
      if (record.status === 'failed') throw new Error(record.error || '视频任务提交失败');
      if (!record.provider_task_id && !bridge.isMock()) {
        throw new Error('平台没有返回任务号，无法继续等待');
      }
      const deadline = Date.now() + Math.max(30, Number(ctx.params.wait_seconds) || 900) * 1000;
      const interval = Math.max(2000, Number(bridge.pollIntervalMs()) || 5000);
      let lastProgress = -1;
      for (;;) {
        await delay(interval);
        if (ctx.isCancelled && ctx.isCancelled()) throw new Error('运行已被取消');
        await bridge.helpers.syncTaskFromProvider(record);
        if (record.status === 'completed' || record.status === 'failed' || record.status === 'expired') break;
        if (record.progress != null && record.progress !== lastProgress) {
          lastProgress = record.progress;
          ctx.progress(record.progress);
        }
        if (Date.now() > deadline) throw new Error(`等待视频生成超时（超过 ${ctx.params.wait_seconds || 900} 秒仍未完成，任务号 ${record.local_id}）`);
      }
      if (record.status !== 'completed') throw new Error(record.error || `视频生成未成功（${record.status}）`);
      if (!record.video_url) throw new Error('平台返回完成但没有视频地址');
      return { video_url: record.video_url, task_id: record.local_id, cost: record.cost ?? null, cost_currency: record.cost_currency || 'CNY' };
    },
  },

  // ---------------- 工具 ----------------
  http: {
    label: 'HTTP 请求', icon: '⇄', group: '工具', color: 'slate',
    description: '调用第三方接口，支持变量插值',
    inputs: ['main'],
    outputs: [
      { key: 'status', label: '状态码', type: 'number' },
      { key: 'body', label: '响应文本', type: 'string' },
      { key: 'json', label: '响应 JSON', type: 'object' },
      { key: 'ok', label: '是否成功', type: 'boolean' },
    ],
    params: [
      { key: 'method', label: '方法', type: 'select', default: 'GET', options: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((value) => ({ value, label: value })) },
      { key: 'url', label: 'URL', type: 'prompt', required: true, placeholder: 'https://... 支持变量' },
      { key: 'headers', label: 'Headers (JSON)', type: 'json', rows: 3, placeholder: '{"Authorization":"Bearer xxx"}' },
      { key: 'query', label: 'Query (JSON)', type: 'json', rows: 2 },
      { key: 'body', label: 'Body', type: 'prompt', rows: 4, placeholder: 'POST 时作为请求体，支持变量' },
      { key: 'timeout', label: '超时(秒)', type: 'number', min: 1, max: 300, default: 60 },
    ],
    async run(ctx) {
      const url = String(ctx.params.url || '').trim();
      if (!url) throw new Error('HTTP 节点缺少 URL');
      const query = ctx.params.query && typeof ctx.params.query === 'object' ? ctx.params.query : {};
      const target = new URL(url);
      for (const [key, value] of Object.entries(query)) {
        if (value != null && value !== '') target.searchParams.set(key, String(value));
      }
      const headers = ctx.params.headers && typeof ctx.params.headers === 'object' ? ctx.params.headers : {};
      const method = String(ctx.params.method || 'GET').toUpperCase();
      // 超时与「运行被取消」都要能立刻中断请求
      const controller = new AbortController();
      const timeoutMs = Math.max(1, Number(ctx.params.timeout) || 60) * 1000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // 用完要摘掉：否则循环 / 多次执行会往 run 级 signal 上线性累积监听
      const onAbort = () => controller.abort();
      if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });
      const init = {
        method,
        headers: { ...headers },
        signal: controller.signal,
      };
      if (method !== 'GET' && method !== 'DELETE' && ctx.params.body != null && ctx.params.body !== '') {
        init.body = typeof ctx.params.body === 'string' ? ctx.params.body : JSON.stringify(ctx.params.body);
        if (!Object.keys(init.headers).some((key) => key.toLowerCase() === 'content-type')) {
          init.headers['Content-Type'] = 'application/json';
        }
      }
      const res = await fetch(target.toString(), init)
        .catch((err) => {
          if (controller.signal.aborted && !ctx.isCancelled()) throw new Error(`请求超时（超过 ${ctx.params.timeout || 60} 秒）`);
          throw err;
        })
        .finally(() => {
          clearTimeout(timer);
          if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
        });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* 不是 JSON 就只留文本 */ }
      return {
        status: res.status,
        ok: res.ok,
        headers: Object.fromEntries(res.headers.entries()),
        body: text.slice(0, 200000),
        json,
      };
    },
  },

  code: {
    label: '代码', icon: '{ }', group: '工具', color: 'slate',
    description: '用 JavaScript 或 Python 处理上游数据',
    inputs: ['main'],
    outputs: [
      { key: 'output', label: '返回结果', type: 'any' },
      { key: 'printed', label: 'print/console 输出', type: 'string' },
    ],
    params: [
      { key: 'language', label: '语言', type: 'select', default: 'javascript', options: [
        { value: 'javascript', label: 'JavaScript' },
        { value: 'python', label: 'Python' },
      ] },
      { key: 'env_id', label: 'Python 环境', type: 'python-env', showWhen: { language: 'python' },
        help: '默认按 conda base → conda 第一个环境 → 自建环境 的顺序选择' },
      { key: 'code', label: '代码', type: 'code', rows: 12, required: true,
        placeholder: 'JavaScript：写 return 返回结果\nPython：给 result 赋值' },
      { key: 'timeout_ms', label: '超时(毫秒)', type: 'number', min: 500, max: 300000, default: 30000 },
    ],
    async run(ctx) {
      const language = String(ctx.params.language || 'javascript').toLowerCase();
      const code = String(ctx.params.code || '').trim();
      if (!code) throw new Error('代码节点缺少代码');

      if (language === 'python') {
        const out = await ctx.bridge.runPython({
          envId: ctx.params.env_id,
          code,
          payload: { input: ctx.input, outputs: ctx.scope, vars: ctx.run.variables || {} },
          timeoutMs: Math.max(500, Math.min(300000, Number(ctx.params.timeout_ms) || 30000)),
          signal: ctx.signal,
        });
        const value = out.result;
        const printed = out.printed || '';
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return { output: value, ...value, printed, interpreter: out.interpreter, env_name: out.env_name };
        }
        return { output: value === undefined ? null : value, printed, interpreter: out.interpreter, env_name: out.env_name };
      }

      // 只让「字符串」跨越宿主与沙箱的边界：
      // 输入用 JSON 字符串传进去、在上下文内 JSON.parse，日志与结果也在上下文内序列化出来。
      // 这样沙箱里拿到的 Object/Function 都是上下文自己的（受 VM_OPTIONS 约束），
      // 堵住 input.constructor.constructor('return process')() 这类沿原型链爬到宿主 realm 的逃逸。
      const sandbox = {
        __input: JSON.stringify(ctx.input ?? null),
        __outputs: JSON.stringify(ctx.scope ?? {}),
        __vars: JSON.stringify(ctx.run.variables || {}),
      };
      vm.createContext(sandbox, VM_OPTIONS);
      const logs = [];
      const wrapper = `(function(){
  var __log = [];
  var input = JSON.parse(__input);
  var outputs = JSON.parse(__outputs);
  var vars = JSON.parse(__vars);
  var console = { log: function(){ var parts = []; for (var i = 0; i < arguments.length; i += 1) { var a = arguments[i]; try { parts.push(typeof a === 'string' ? a : JSON.stringify(a)); } catch (_) { parts.push(String(a)); } } __log.push(parts.join(' ')); } };
  var __value;
  try {
    __value = (function(input, outputs, vars, console){${code}\n})(input, outputs, vars, console);
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err), logs: __log });
  }
  var __text;
  try { __text = JSON.stringify({ ok: true, value: __value === undefined ? null : __value, logs: __log }); }
  catch (err) { return JSON.stringify({ ok: false, error: '返回值无法序列化：' + String(err && err.message ? err.message : err), logs: __log }); }
  return __text;
})()`;
      let packed;
      try {
        packed = vm.runInContext(wrapper, sandbox, {
          timeout: Math.max(500, Math.min(300000, Number(ctx.params.timeout_ms) || 30000)),
        });
      } catch (err) {
        // 沙箱外的执行错误（语法错误、超时打断等）
        throw new Error(err && err.message ? err.message : String(err));
      }
      let parsed;
      try {
        parsed = JSON.parse(packed);
      } catch (_) {
        throw new Error('代码返回值解析失败');
      }
      for (const line of parsed.logs || []) logs.push(line);
      if (logs.length) ctx.log(logs.join(' / '));
      if (parsed.ok === false) throw new Error(parsed.error || '代码执行失败');
      const value = parsed.value;
      if (value === undefined) throw new Error('代码没有 return 任何值');
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return { output: value, ...value, printed: logs.join('\n') };
      }
      return { output: value, printed: logs.join('\n') };
    },
  },

  text: {
    label: '文本处理', icon: '≡', group: '工具', color: 'slate',
    description: '拼接、替换、截取文本',
    inputs: ['main'],
    outputs: [{ key: 'output', label: '结果文本', type: 'string' }],
    params: [
      { key: 'mode', label: '操作', type: 'select', default: 'template', options: [
        { value: 'template', label: '模板拼接' },
        { value: 'replace', label: '查找替换' },
        { value: 'slice', label: '截取' },
        { value: 'regex', label: '正则提取' },
        { value: 'json', label: 'JSON 取值' },
      ] },
      { key: 'template', label: '模板', type: 'prompt', rows: 4, showWhen: { mode: 'template' }, placeholder: '{{start.name}} 的卖点：{{llm.output}}' },
      { key: 'source', label: '源文本', type: 'prompt', rows: 3, showWhen: { mode: ['replace', 'slice', 'regex', 'json'] } },
      { key: 'search', label: '查找', type: 'text', showWhen: { mode: 'replace' } },
      { key: 'replacement', label: '替换为', type: 'text', showWhen: { mode: 'replace' } },
      { key: 'start', label: '起始位置', type: 'number', default: 0, showWhen: { mode: 'slice' } },
      { key: 'length', label: '长度', type: 'number', default: 100, showWhen: { mode: 'slice' } },
      { key: 'pattern', label: '正则', type: 'text', showWhen: { mode: 'regex' }, placeholder: '如 "price":\\s*(\\d+)' },
      { key: 'path', label: 'JSON 路径', type: 'text', showWhen: { mode: 'json' }, placeholder: '如 data.items.0.title' },
    ],
    run(ctx) {
      const mode = String(ctx.params.mode || 'template');
      const source = ctx.params.source == null ? '' : String(ctx.params.source);
      if (mode === 'template') return { output: String(ctx.params.template || '') };
      if (mode === 'replace') {
        const search = String(ctx.params.search || '');
        return { output: search ? source.split(search).join(String(ctx.params.replacement || '')) : source };
      }
      if (mode === 'slice') {
        const start = Math.max(0, Number(ctx.params.start) || 0);
        const length = Number(ctx.params.length);
        return { output: Number.isFinite(length) && length > 0 ? source.slice(start, start + length) : source.slice(start) };
      }
      if (mode === 'regex') {
        const pattern = String(ctx.params.pattern || '');
        if (!pattern) throw new Error('正则模式需要填写正则表达式');
        const match = new RegExp(pattern).exec(source);
        return { output: match ? (match[1] !== undefined ? match[1] : match[0]) : '' , matched: Boolean(match), groups: match ? match.slice(1) : [] };
      }
      if (mode === 'json') {
        const parsed = JSON.parse(source || 'null');
        const path = String(ctx.params.path || '').trim();
        const value = path ? path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[/^\d+$/.test(key) ? Number(key) : key]), parsed) : parsed;
        return { output: value === undefined ? '' : (typeof value === 'string' ? value : JSON.stringify(value)), value };
      }
      throw new Error(`不支持的文本操作：${mode}`);
    },
  },
};

// ---------------- 执行期公用 ----------------

const delay = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); if (timer.unref) timer.unref(); });

// 沙箱上下文统一用这个配置建：禁掉「从字符串生成代码」，
// 于是 Object.constructor('return process')() / eval / new Function 统统被挡，
// 经典的 vm 逃逸链就断了。vm 自身不是安全边界，这一层把它收紧到可用范围。
const VM_OPTIONS = { codeGeneration: { strings: false, wasm: false } };

// 条件分支用的表达式求值：在受限沙箱里对 input / outputs / vars 求值
function evaluateExpression(expr, ctx) {
  const sandbox = {
    input: ctx.input,
    outputs: ctx.scope,
    vars: (ctx.run && ctx.run.variables) || {},
    JSON, Math, String, Number, Boolean, Array, Object, Date,
    parseInt, parseFloat, isNaN, isFinite,
    result: undefined,
  };
  vm.createContext(sandbox, VM_OPTIONS);
  vm.runInContext(
    `result = (function(input, outputs, vars){ return (${expr}); })(input, outputs, vars);`,
    sandbox,
    { timeout: 1500 },
  );
  return Boolean(sandbox.result);
}

function safeString(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

// 图片参数可能是 data:/http(s) 地址，也可能是本地上一次生成的产物文件名
async function collectImages(value, bridge) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  const out = [];
  for (const item of list) {
    const url = await bridge.toImageUrl(item);
    if (url) out.push(url);
  }
  return out;
}

// 画布节点卡片空闲时显示哪几个参数（按顺序取第一个有值的），让画布一眼能读懂
const SUMMARY_KEYS = {
  start: ['fields'],
  end: ['outputs'],
  variable: ['assignments'],
  llm: ['model_id', 'chat_model'],
  vision: ['model_id'],
  image: ['model_id'],
  video: ['model_id'],
  condition: ['branches'],
  merge: ['fields'],
  loop: ['workflow_id'],
  http: ['method', 'url'],
  code: ['language'],
  text: ['mode'],
};

// 给前端用的节点元信息（不含执行函数）
function describeNodes() {
  const meta = {};
  for (const [type, def] of Object.entries(NODE_DEFS)) {
    meta[type] = {
      type,
      label: def.label,
      icon: def.icon,
      group: def.group,
      color: def.color,
      description: def.description,
      inputs: def.inputs || [],
      outputs: def.outputs || [],
      params: def.params || [],
      branches: def.branches === true,
      summary_keys: SUMMARY_KEYS[type] || [],
    };
  }
  return meta;
}

module.exports = { NODE_DEFS, describeNodes, delay, safeString };
