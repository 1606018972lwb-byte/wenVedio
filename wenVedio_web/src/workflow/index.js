// 工作流 · 运行时装配
// 把存储、引擎、接口串起来，并把宿主（server.js）已有的能力包装成引擎需要的 bridge。
// 节点执行器只能通过这个 bridge 触达模型、令牌、任务与生成能力，不直接依赖 server.js。
'use strict';

const fs = require('fs');
const path = require('path');
const { create: createStore } = require('./store');
const { create: createEngine } = require('./engine');
const { create: createApi } = require('./api');
const { create: createPython } = require('./python');
const { create: createTriggers } = require('./triggers');
const { describeNodes } = require('./nodes');

const DEFAULT_CHAT_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_CHAT_MODEL = 'deepseek-chat';

function create(deps) {
  const {
    configDir, dataDir, writeLog, sendJson, readBody,
    config, models, tokens, tasks, imagesDir, tokenValueFor, helpers,
  } = deps;

  const python = createPython({ dataDir, configDir, writeLog });

  const MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif',
  };

  function findDeepSeekToken() {
    for (const token of tokens.values()) {
      if (/deepseek/i.test(`${token.provider || ''} ${token.name || ''}`) && token.value) return token;
    }
    return null;
  }

  const bridge = {
    config,
    models,
    tokens,
    tasks,
    helpers,

    isMock: () => config.mock === true,
    pollIntervalMs: () => 5000,
    localBase: () => `http://127.0.0.1:${config.port}`,
    hasChatToken: () => Boolean(findDeepSeekToken()),

    // 代码节点的 Python 执行能力（环境发现、pip 自愈、自动安装都在 workflow/python.js 里）
    python,
    runPython: (options) => python.runCode(options),

    // 把各种形态的图片引用统一成可直接使用的地址：
    // data:/http(s) 原样返回；本地产物文件名与本地预览地址都直接读文件转 data URL，
    // 避免为了喂给下游再走一次本机 HTTP。
    async toImageUrl(value) {
      const raw = String(value == null ? '' : value).trim();
      if (!raw) return null;
      if (/^data:/i.test(raw)) return raw;
      // 本机预览地址：/api/tasks/<id>/image/<n>?file=<本地文件名>
      // 注意必须限定成「我们自己服务器的地址」——否则第三方 URL 里恰好带 &file=
      // 也会被当成本地文件名去读盘，把本地图片内容当作远程图交出去。
      const localPreview = raw.match(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/api\/tasks\/[^/]+\/image\/\d+\?(?:.*&)?file=([^&]+)/i);
      if (localPreview) {
        const name = path.basename(decodeURIComponent(localPreview[2]));
        const file = path.join(imagesDir, name);
        if (fs.existsSync(file)) {
          const mime = MIME[path.extname(file).toLowerCase()] || 'image/png';
          return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
        }
        return raw;
      }
      if (/^https?:\/\//i.test(raw)) return raw;
      const name = path.basename(raw.split('?')[0]);
      const file = path.join(imagesDir, name);
      if (fs.existsSync(file)) {
        const mime = MIME[path.extname(file).toLowerCase()] || 'image/png';
        return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
      }
      return null;
    },

    // 对话接口取值：显式指定模型 > DeepSeek（默认）
    async resolveChatTarget(params = {}) {
      const chatModel = String(params.chat_model || '').trim() || DEFAULT_CHAT_MODEL;
      if (params.source === 'model' && params.model_id) {
        const model = models.get(String(params.model_id));
        if (!model) throw new Error(`模型不存在：${params.model_id}`);
        const key = tokenValueFor(model);
        if (!key) throw new Error(`模型「${model.name}」没有可用令牌`);
        return { url: model.request_url, model: model.workflow || model.id, key, how: `模型「${model.name}」` };
      }
      const token = findDeepSeekToken();
      const key = token?.value || tokenValueFor({ token_id: 'default' });
      if (!key) {
        throw new Error('没有可用的对话 Key：请在「令牌管理」里添加一条 DeepSeek Key（供应商填 DeepSeek），或把节点切换成「使用已配置的模型」');
      }
      return { url: DEFAULT_CHAT_URL, model: chatModel, key, how: token ? `DeepSeek 令牌「${token.name}」` : '默认 DeepSeek' };
    },

    async callChat({ target, messages, temperature, maxTokens, jsonMode }) {
      const body = {
        model: target.model,
        messages,
        temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.7,
      };
      if (Number.isFinite(Number(maxTokens))) body.max_tokens = Number(maxTokens);
      const send = async (withJsonMode) => {
        const res = await fetch(target.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.key}` },
          body: JSON.stringify(withJsonMode ? { ...body, response_format: { type: 'json_object' } } : body),
          signal: AbortSignal.timeout(180000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const err = new Error(data?.error?.message || data?.msg || `HTTP ${res.status}`);
          err.status = res.status;
          throw err;
        }
        return data;
      };
      let data;
      try {
        data = await send(jsonMode === true);
      } catch (err) {
        // 部分中转不支持 response_format，去掉再试一次
        if (jsonMode === true && (err.status === 400 || /response_format|json_object/i.test(err.message || ''))) {
          data = await send(false);
        } else {
          throw err;
        }
      }
      const message = data?.choices?.[0]?.message;
      const text = typeof message?.content === 'string' ? message.content : '';
      if (!text.trim()) {
        throw new Error('对话接口返回了空内容（若用的是思考类模型，请换成 deepseek-chat 这类非思考模型）');
      }
      return { text, model: data.model || target.model, usage: data.usage || null, raw: data };
    },
  };

  const store = createStore({ configDir, writeLog });
  const engine = createEngine({ store, bridge, writeLog });
  // 触发器（Webhook + 定时）：让工作流能自己跑起来
  const triggers = createTriggers({ store, engine, writeLog });

  // 循环节点用：列出可选子工作流、按 id 把它跑到结束
  bridge.listWorkflows = () => store.listWorkflows().map((item) => ({
    id: item.id, name: item.name, nodes: (item.nodes || []).length, published: item.published === true,
  }));
  bridge.runWorkflow = (workflowId, inputs, options) => {
    const target = store.getWorkflow(workflowId);
    if (!target) throw new Error(`子工作流不存在：${workflowId}`);
    return engine.runToCompletion(target, inputs, options);
  };
  // 循环体：定义是当场从画布拼出来的（不是存在库里的工作流），直接交给引擎跑
  bridge.runWorkflowDefinition = (definition, inputs, options) => engine.runToCompletion(definition, inputs, options);
  const api = createApi({
    store, engine, host: bridge, writeLog, sendJson, readBody,
    nodeMeta: describeNodes(),
    python,
    triggers,
  });

  return {
    handleApi: (req, res, url) => api.handle(req, res, url),
    start: () => { engine.start(); triggers.start(); },
    stop: () => { engine.stop(); triggers.stop(); },
    store,
    engine,
    bridge,
    python,
    triggers,
  };
}

module.exports = { create };
