import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { normalize, validateInput, applyModelEdits } from '../public/dialogue.js';

const prompt = readFileSync(new URL('../rewrite-prompt.txt', import.meta.url), 'utf8');
export const MODEL = 'deepseek-v4-pro';
const BYTE_LIMIT = 24000;
// ponytail: one in-flight call per process; distributed quotas belong in a shared store if usage grows.
let busy = false;
const sameSecret = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function modelRequest(scene, context) {
  return {
    model: MODEL, thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 8192,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: JSON.stringify({ 原稿逐行: normalize(scene).split('\n').map((text, i) => ({ line: i + 1, text })), ...(context ? { 背景: context } : {}) }) }
    ]
  };
}

export async function optimize(scene, context, key, send = fetch) {
  const started = Date.now();
  const response = await send('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(modelRequest(scene, context)), signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) {
    const messages = { 401: '模型连接配置失效，请联系体验提供者。', 402: '模型账户额度不足，请联系体验提供者。', 429: '模型服务繁忙，请稍后重试。' };
    throw fail(messages[response.status] || '模型服务暂时不可用，原稿已保留，请稍后重试。', 502);
  }
  const raw = await response.text();
  if (raw.length > 200000) throw fail('模型响应过长，原稿已保留。', 502);
  let data;
  try { data = JSON.parse(raw); } catch { throw fail('模型响应格式异常，原稿已保留。', 502); }
  if (data.model !== MODEL || data.choices?.[0]?.finish_reason !== 'stop') throw fail('模型未完整生成这场台词，原稿已保留。请缩短场景后重试。', 502);
  let result;
  try { result = applyModelEdits(scene, JSON.parse(data.choices[0].message?.content)); } catch (error) { throw fail(error instanceof SyntaxError ? '模型修改格式异常，原稿已保留。' : error.message, 502); }
  return { ...result, model: MODEL, mode: 'pro-local-edits-high', durationMs: Date.now() - started,
    usage: { input: data.usage?.prompt_tokens ?? null, output: data.usage?.completion_tokens ?? null,
      cached: data.usage?.prompt_cache_hit_tokens ?? null, reasoning: data.usage?.completion_tokens_details?.reasoning_tokens ?? null } };
}

async function readBody(req) {
  if (req.body !== undefined) {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(body) > BYTE_LIMIT) throw fail('输入过长，请按场拆开处理。', 413);
    return JSON.parse(body);
  }
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > BYTE_LIMIT) throw fail('输入过长，请按场拆开处理。', 413);
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const reply = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
  const access = process.env.DEMO_ACCESS_CODE || '';
  const ready = Boolean(process.env.DEEPSEEK_API_KEY && (!process.env.VERCEL || access.length >= 12));
  if (req.method === 'GET') return reply(200, { ready, accessRequired: Boolean(access), model: MODEL });
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return reply(405, { error: '请求方式不支持。' }); }
  let acquired = false;
  try {
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw fail('请从产品页面发起优化。', 403);
    if (!req.headers['content-type']?.startsWith('application/json')) throw fail('请发送 JSON 文本。', 415);
    if (!ready) throw fail('体验服务尚未配置好，请联系体验提供者。', 503);
    if (access && !sameSecret(String(req.headers['x-demo-code'] || ''), access)) throw fail('体验码不正确，请核对后重试。', 401);
    const body = await readBody(req);
    if (!body || Array.isArray(body) || typeof body !== 'object') throw fail('输入格式不正确。');
    const { scene, context = '' } = body;
    validateInput(scene, context);
    if (busy) throw fail('正在处理另一场剧本，请稍后重试。', 429);
    busy = true; acquired = true;
    reply(200, await optimize(normalize(scene), context, process.env.DEEPSEEK_API_KEY));
  } catch (error) {
    const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
    const status = error.status || (timeout ? 504 : error instanceof SyntaxError ? 400 : error instanceof TypeError ? 502 : 400);
    const message = timeout ? '这次等待超过 2 分钟，原稿已保留。可以缩短场景后重试。' : error instanceof SyntaxError ? '输入格式不正确。' : error instanceof TypeError ? '网络连接暂时失败，原稿已保留。' : error.message;
    reply(status, { error: message });
  } finally { if (acquired) busy = false; }
}
