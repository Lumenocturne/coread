// llm.js — LLM 后端适配。任何 OpenAI 兼容端点都能用(OpenAI/OpenRouter/DeepSeek/本地vLLM/Ollama…)。
// 环境变量:
//   LLM_BASE_URL   如 https://api.openai.com/v1  或 https://openrouter.ai/api/v1
//   LLM_API_KEY
//   LLM_MODEL      主聊天模型(共读对话)
//   DIGEST_MODEL   可选,章节摘要用的便宜模型(缺省用 LLM_MODEL)
//
// ⚠️ 防踩坑 #4(见 README):收响应体绝不能 `d += chunk` 逐块拼字符串——
// 一个中文字 3 字节,被网络分块切在边界就碎成 �。流式用 TextDecoder/StringDecoder,
// 非流式用 Buffer.concat 攒齐再解码。
const https = require('https');
const http = require('http');
const { StringDecoder } = require('string_decoder');

function _req(pathname, body, onChunk) {
  return new Promise((resolve, reject) => {
    const base = process.env.LLM_BASE_URL;
    const key = process.env.LLM_API_KEY;
    if (!base || !key) return reject(new Error('LLM_BASE_URL / LLM_API_KEY 未配置'));
    const u = new URL(base.replace(/\/$/, '') + pathname);
    const mod = u.protocol === 'http:' ? http : https;
    const payload = JSON.stringify(body);
    const rq = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'Content-Length': Buffer.byteLength(payload) },
      timeout: 300000,
    }, (res) => {
      if (onChunk) {                       // 流式:逐块交给上层解析 SSE
        const sd = new StringDecoder('utf8');
        res.on('data', (c) => onChunk(sd.write(c)));
        res.on('end', () => resolve(null));
      } else {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('LLM 响应不是 JSON: ' + text.slice(0, 200))); }
        });
      }
    });
    rq.on('error', reject);
    rq.on('timeout', () => { rq.destroy(); reject(new Error('LLM 超时')); });
    rq.write(payload); rq.end();
  });
}

// 非流式一问一答(digest 用)
async function ask(prompt, { model, maxTokens } = {}) {
  const d = await _req('/chat/completions', {
    model: model || process.env.DIGEST_MODEL || process.env.LLM_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens || 300, temperature: 0.3,
  });
  return String(d.choices[0].message.content || '').trim();
}

// 流式对话:onDelta(增量文本)一路回调,resolve(全文)。
// ⚠️ 防踩坑 #5:SSE 按空行(\n\n)分帧,帧可能被网络切成任意块——必须自己攒 buf 再切。
function chatStream(messages, onDelta) {
  return new Promise((resolve, reject) => {
    let buf = '', full = '';
    _req('/chat/completions', {
      model: process.env.LLM_MODEL, messages, stream: true, temperature: 0.8,
    }, (textChunk) => {
      buf += textChunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = /^data: (.*)$/m.exec(frame);
        if (!m || m[1] === '[DONE]') continue;
        try {
          const delta = JSON.parse(m[1]).choices?.[0]?.delta?.content;
          if (delta) { full += delta; if (onDelta) onDelta(delta, full); }
        } catch (e) { /* 半截帧,忽略 */ }
      }
    }).then(() => resolve(full)).catch(reject);
  });
}

module.exports = { ask, chatStream };
