// 工作流 · 变量解析
// 变量写成 {{节点ID.字段}}，例如 {{start.product_image}}、{{llm_1.output}}
// 参数取值有两种形态：
//   1. 字符串里含 {{}}  → 做模板插值，结果是字符串
//   2. {$var: 'a.b'}    → 取原始值，保留类型（数字/数组/对象不会被转成字符串）
'use strict';

function getPath(root, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    if (Array.isArray(acc) && /^\d+$/.test(key)) return acc[Number(key)];
    return acc[key];
  }, root);
}

const VAR_RE = /\{\{\s*([A-Za-z0-9_$.[\]-]+)\s*\}\}/g;
// 整个字符串只有一个变量时按「取值」处理，保留原始类型；
// 夹在其它文字里才按「插值」处理，转成字符串。变量选择器统一插入 {{路径}} 即可。
const EXACT_RE = /^\s*\{\{\s*([A-Za-z0-9_$.[\]-]+)\s*\}\}\s*$/;

// 找不到的变量保留 {{原文}}，让人一眼看出哪里没接上
function interpolate(text, scope) {
  return String(text == null ? '' : text).replace(VAR_RE, (all, path) => {
    const value = getPath(scope, path);
    if (value === undefined || value === null) return all;
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function isVarRef(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.$var === 'string';
}

function resolveParam(value, scope) {
  if (isVarRef(value)) return getPath(scope, value.$var);
  if (typeof value === 'string') {
    const exact = value.match(EXACT_RE);
    if (exact) return getPath(scope, exact[1]);
    return interpolate(value, scope);
  }
  if (Array.isArray(value)) return value.map((item) => resolveParam(item, scope));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveParam(item, scope);
    return out;
  }
  return value;
}

// 把一个节点参数里引用到的变量路径都列出来（用于「谁引用了谁」的展示与校验）
function collectRefs(value, out = []) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(VAR_RE)) out.push(match[1]);
  } else if (isVarRef(value)) {
    out.push(value.$var);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectRefs(item, out));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectRefs(item, out));
  }
  return out;
}

module.exports = { getPath, interpolate, resolveParam, isVarRef, collectRefs, VAR_RE };
