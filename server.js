// =============================================================
//  ЭмИИн — сервер личного ИИ-ассистента
//  Принимает сообщения из браузера и стримит ответы от одного из
//  трёх движков: Claude (Anthropic), OpenAI (ChatGPT) или Google Gemini.
//
//  Запуск:  node server.js   (по умолчанию порт 3000)
// =============================================================

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Простая загрузка переменных из .env (без сторонних библиотек) ---
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-3.6-flash',
};

const MAX_TOKENS = {
  anthropic: 64000,
  openai: 8192,
  gemini: 8192,
};

// ---------------------------------------------------------------
//  Вспомогательные функции
// ---------------------------------------------------------------

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readJson(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new Error('Запрос слишком большой'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch (e) {
        reject(new Error('Неверный JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function safeText(resp) {
  try {
    return (await resp.text()).slice(0, 400);
  } catch {
    return '';
  }
}

function friendlyError(err, provider) {
  const name = err?.name || '';
  const msg = String(err?.message || err || '');

  if (name === 'AbortError') return 'Соединение прервано.';

  if (
    err instanceof Anthropic.AuthenticationError ||
    /401|authentication|invalid x-api-key|incorrect api key/i.test(msg)
  ) {
    return 'Неверный API-ключ. Проверь его в файле .env';
  }
  if (
    err instanceof Anthropic.RateLimitError ||
    /429|rate ?limit|quota|too many requests/i.test(msg)
  ) {
    return 'Слишком много запросов или исчерпана бесплатная квота. Подожди немного и попробуй снова.';
  }
  if (/402|insufficient_quota|billing|has not been enabled|API key not valid/i.test(msg)) {
    return 'На этом API-аккаунте нет оплаты или сервис не включён. Проверь настройки аккаунта.';
  }
  if (/400|invalid|not found|model/i.test(msg) && /gemini/i.test(provider)) {
    return 'Не удалось обратиться к Gemini: проверь название модели и ключ.';
  }
  return msg || 'Неизвестная ошибка';
}

// ---------------------------------------------------------------
//  Приведение сообщений к формату каждого провайдера
// ---------------------------------------------------------------

function toAnthropicMessage(m) {
  if (m.images && m.images.length) {
    const blocks = m.images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mime || 'image/png', data: img.data },
    }));
    if (m.content) blocks.push({ type: 'text', text: m.content });
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: blocks };
  }
  return {
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content || '',
  };
}

function toOpenAIMessage(m) {
  if (m.images && m.images.length) {
    const parts = m.images.map((img) => ({
      type: 'image_url',
      image_url: { url: `data:${img.mime || 'image/png'};base64,${img.data}` },
    }));
    if (m.content) parts.push({ type: 'text', text: m.content });
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: parts };
  }
  return {
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content || '',
  };
}

function toGeminiContent(m) {
  const parts = [];
  if (m.images && m.images.length) {
    for (const img of m.images) {
      parts.push({ inlineData: { mimeType: img.mime || 'image/png', data: img.data } });
    }
  }
  if (m.content) parts.push({ text: m.content });
  return { role: m.role === 'assistant' ? 'model' : 'user', parts };
}

// ---------------------------------------------------------------
//  Стриминг от каждого провайдера
//  send({ delta }) — кусок текста, send({ usage }) — статистика
// ---------------------------------------------------------------

async function streamAnthropic({ model, messages, system, maxTokens }, send, signal) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const params = {
    model: model || DEFAULT_MODELS.anthropic,
    max_tokens: maxTokens || MAX_TOKENS.anthropic,
    messages: messages.map(toAnthropicMessage),
  };
  if (system) params.system = system;

  const stream = client.messages.stream(params, { signal });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      send({ delta: event.delta.text });
    }
  }

  const final = await stream.finalMessage();
  if (final?.usage) {
    send({ usage: { input: final.usage.input_tokens, output: final.usage.output_tokens } });
  }
}

async function streamOpenAI({ model, messages, system, temperature, maxTokens }, send, signal) {
  const apiMessages = [];
  if (system) apiMessages.push({ role: 'system', content: system });
  for (const m of messages) apiMessages.push(toOpenAIMessage(m));

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODELS.openai,
      messages: apiMessages,
      temperature: typeof temperature === 'number' ? temperature : 0.7,
      max_tokens: maxTokens || MAX_TOKENS.openai,
      stream: true,
    }),
  });

  if (!resp.ok) throw new Error(`OpenAI: ${resp.status} ${await safeText(resp)}`);

  let usage = null;
  await readSSE(resp.body, (data) => {
    if (data.usage) usage = data.usage;
    const delta = data.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') send({ delta });
  });
  if (usage) send({ usage: { input: usage.prompt_tokens, output: usage.completion_tokens } });
}

async function streamGemini({ model, messages, system, temperature, maxTokens }, send, signal) {
  const body = {
    contents: messages.map(toGeminiContent),
    generationConfig: {
      temperature: typeof temperature === 'number' ? temperature : 0.7,
      maxOutputTokens: maxTokens || MAX_TOKENS.gemini,
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model || DEFAULT_MODELS.gemini) +
    ':streamGenerateContent?alt=sse&key=' +
    encodeURIComponent(process.env.GOOGLE_API_KEY);

  const resp = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) throw new Error(`Gemini: ${resp.status} ${await safeText(resp)}`);

  let usage = null;
  await readSSE(resp.body, (data) => {
    if (data.usageMetadata) usage = data.usageMetadata;
    const parts = data.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (typeof p.text === 'string') send({ delta: p.text });
      }
    }
  });
  if (usage) {
    send({ usage: { input: usage.promptTokenCount, output: usage.candidatesTokenCount } });
  }
}

// Читает Server-Sent Events из тела ответа и вызывает onData для каждого JSON-события.
async function readSSE(body, onData) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleLine = (raw) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      onData(JSON.parse(payload));
    } catch {
      // пропускаем не-JSON строку
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleLine(line);
    }
  }

  // обрабатываем хвост без завершающего перевода строки
  buffer += decoder.decode();
  if (buffer) handleLine(buffer);
}

// ---------------------------------------------------------------
//  Обработчики запросов
// ---------------------------------------------------------------

async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  const { provider, model, messages = [], system, temperature, maxTokens } = body;

  const keyMap = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    gemini: process.env.GOOGLE_API_KEY,
  };

  if (!keyMap[provider]) {
    const names = { anthropic: 'Claude (ANTHROPIC_API_KEY)', openai: 'OpenAI (OPENAI_API_KEY)', gemini: 'Gemini (GOOGLE_API_KEY)' };
    return sendJson(res, 400, {
      error: `Ключ для «${names[provider] || provider}» не задан. Добавь его в файл .env и перезапусти сервер.`,
    });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return sendJson(res, 400, { error: 'Пустой список сообщений' });
  }

  // Открываем поток Server-Sent Events
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (obj) => {
    if (res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      // клиент отключился — молча выходим
    }
  };

  const abort = new AbortController();
  req.on('close', () => abort.abort());

  try {
    const opts = { model, messages, system, temperature, maxTokens };
    if (provider === 'anthropic') await streamAnthropic(opts, send, abort.signal);
    else if (provider === 'openai') await streamOpenAI(opts, send, abort.signal);
    else if (provider === 'gemini') await streamGemini(opts, send, abort.signal);
    else throw new Error('Неизвестный провайдер: ' + provider);

    send({ done: true });
  } catch (err) {
    send({ error: friendlyError(err, provider) });
  } finally {
    res.end();
  }
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.normalize(path.join(PUBLIC_DIR, rel));

  if (!full.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'Запрещено' });
  }

  fs.readFile(full, (err, data) => {
    if (err) {
      // Для неизвестных путей отдаём главную страницу (удобно для PWA)
      if (rel !== 'index.html' && !path.extname(full)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) return sendJson(res, 404, { error: 'Не найдено' });
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(html);
        });
      }
      return sendJson(res, 404, { error: 'Не найдено' });
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, {
      name: 'ЭмИИн',
      providers: {
        anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
        openai: Boolean(process.env.OPENAI_API_KEY),
        gemini: Boolean(process.env.GOOGLE_API_KEY),
      },
      defaults: DEFAULT_MODELS,
    });
  }

  if (req.method === 'POST' && pathname === '/api/chat') {
    return handleChat(req, res);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Метод не поддерживается' });
  }

  return serveStatic(res, pathname);
}

// ---------------------------------------------------------------
//  Запуск
// ---------------------------------------------------------------

function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('Ошибка сервера:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
    else res.end();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('  ЭмИИн запущен!');
  console.log(`  На этом компьютере:  http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  На телефоне (в той же Wi-Fi сети):  http://${ip}:${PORT}`);
  }
  console.log('============================================');
});
