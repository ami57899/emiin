/* =============================================================
   ЭмИИн — логика интерфейса
   ============================================================= */

'use strict';

const LS = { chats: 'emiin.chats', settings: 'emiin.settings' };

const PROVIDERS = [
  { id: 'anthropic', name: 'Claude' },
  { id: 'gemini', name: 'Gemini' },
  { id: 'openai', name: 'OpenAI' },
];

const MODEL_OPTIONS = {
  anthropic: [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-1',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
  ],
  gemini: [
    'gemini-3.8-flash',
    'gemini-4-argon',
    'gemini-3.6-flash',
    'gemini-3.1-pro-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
  ],
  openai: [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4.1',
    'gpt-4.1-mini',
    'o4-mini',
  ],
};

const SUGGESTIONS = [
  'Составь план на сегодня',
  'Объясни простыми словами, что такое нейросеть',
  'Придумай идею для нового проекта',
  'Напиши текст поздравления с днём рождения',
];

const defaultSettings = {
  provider: 'anthropic',
  model: '',
  system: 'Ты — ЭмИИн, дружелюбный и полезный помощник. Отвечай на русском языке, понятно и по делу.',
  temperature: 0.7,
  maxTokens: 8192,
  theme: 'dark',
};

// ---------------------------------------------------------------
//  Состояние
// ---------------------------------------------------------------

let config = { providers: {}, defaults: {} };
let chats = [];
let currentId = null;
let settings = { ...defaultSettings };
let pendingImages = []; // [{ mime, data }]
let streaming = false;
let abortCtrl = null;
let streamEl = null; // DOM-элемент, куда идёт потоковый текст

// ---------------------------------------------------------------
//  Короткие утилиты
// ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getCurrentChat() {
  return chats.find((c) => c.id === currentId) || null;
}

function providerName() {
  return PROVIDERS.find((p) => p.id === settings.provider)?.name || settings.provider;
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function saveChats() {
  try {
    localStorage.setItem(LS.chats, JSON.stringify(chats));
  } catch {
    toast('Не удалось сохранить чаты (память браузера заполнена)');
  }
}

function saveSettings() {
  try {
    localStorage.setItem(LS.settings, JSON.stringify(settings));
  } catch {}
}

// ---------------------------------------------------------------
//  Тема
// ---------------------------------------------------------------

function applyTheme(choice) {
  let t = choice === 'auto'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : choice;
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0b0b12' : '#f5f6fa');
}

// ---------------------------------------------------------------
//  Рендер: markdown, сообщения, список чатов
// ---------------------------------------------------------------

function addCopyBtn(pre) {
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.textContent = 'Копировать';
  btn.onclick = async () => {
    const code = pre.querySelector('code')?.innerText || pre.innerText;
    await copyText(code);
    btn.textContent = 'Скопировано ✓';
    setTimeout(() => (btn.textContent = 'Копировать'), 1500);
  };
  pre.appendChild(btn);
}

function renderMarkdown(text) {
  const div = document.createElement('div');
  if (window.marked) {
    let html;
    try {
      html = window.marked.parse(text || '');
    } catch {
      html = escapeHtml(text);
    }
    div.innerHTML = html;
    div.querySelectorAll('pre code').forEach((code) => {
      try {
        if (window.hljs) window.hljs.highlightElement(code);
      } catch {}
    });
    div.querySelectorAll('pre').forEach(addCopyBtn);
  } else {
    div.classList.add('plain-text');
    div.textContent = text || '';
  }
  return div;
}

function makeToolBtn(label, onclick) {
  const b = document.createElement('button');
  b.className = 'msg-tool';
  b.textContent = label;
  b.onclick = onclick;
  return b;
}

function speak(text) {
  if (!('speechSynthesis' in window)) {
    toast('Озвучивание не поддерживается этим браузером');
    return;
  }
  speechSynthesis.cancel();
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>\[\]()~]/g, '')
    .slice(0, 2500);
  const u = new SpeechSynthesisUtterance(plain);
  u.lang = 'ru-RU';
  speechSynthesis.speak(u);
}

function buildMessageEl(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (msg.role === 'user' ? 'user' : 'ai');

  if (msg.role === 'assistant') {
    const avatar = document.createElement('img');
    avatar.className = 'msg-avatar';
    avatar.src = 'icon.svg';
    avatar.alt = 'ЭмИИн';
    wrap.appendChild(avatar);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  if (msg.error) bubble.classList.add('err');

  if (msg.role === 'user' && msg.images && msg.images.length) {
    const imgs = document.createElement('div');
    imgs.className = 'msg-imgs';
    for (const img of msg.images) {
      const im = document.createElement('img');
      im.src = `data:${img.mime || 'image/jpeg'};base64,${img.data}`;
      im.alt = '';
      imgs.appendChild(im);
    }
    bubble.appendChild(imgs);
  }

  const content = document.createElement('div');
  content.className = 'markdown';

  if (msg.role === 'user') {
    content.classList.add('plain-text');
    content.textContent = msg.content || '';
  } else if (msg.streaming) {
    content.classList.add('plain-text');
    content.textContent = (msg.content || '') + ' ';
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    content.appendChild(cursor);
    streamEl = content;
  } else {
    content.appendChild(renderMarkdown(msg.content || ''));
  }

  bubble.appendChild(content);

  if (msg.errorText) {
    const err = document.createElement('div');
    err.className = 'err-note';
    err.textContent = '⚠ ' + msg.errorText;
    bubble.appendChild(err);
  }

  if (msg.role === 'assistant' && !msg.streaming && msg.content && !msg.error) {
    const tools = document.createElement('div');
    tools.className = 'msg-tools';
    const speakBtn = makeToolBtn('🔊 Озвучить', () => speak(msg.content));
    const copyBtn = makeToolBtn('⧉ Копировать', async () => {
      await copyText(msg.content);
      copyBtn.textContent = '✓ Скопировано';
      setTimeout(() => (copyBtn.textContent = '⧉ Копировать'), 1500);
    });
    tools.appendChild(speakBtn);
    tools.appendChild(copyBtn);
    bubble.appendChild(tools);
  }

  wrap.appendChild(bubble);
  return wrap;
}

function welcomeEl(anyProvider) {
  const frag = document.createDocumentFragment();

  const w = document.createElement('div');
  w.className = 'welcome';
  w.innerHTML =
    '<img src="icon.svg" class="welcome-logo" alt="ЭмИИн">' +
    '<h1>Привет, я ЭмИИн</h1>' +
    '<p>Твой личный ИИ-ассистент. Задай вопрос, прикрепи фото или просто поболтай.</p>';

  const sug = document.createElement('div');
  sug.className = 'suggestions';
  SUGGESTIONS.forEach((s) => {
    const b = document.createElement('button');
    b.className = 'suggestion';
    b.textContent = s;
    b.onclick = () => {
      $('input').value = s;
      $('input').focus();
      autoResize();
    };
    sug.appendChild(b);
  });
  w.appendChild(sug);
  frag.appendChild(w);

  if (!anyProvider) {
    const banner = document.createElement('div');
    banner.className = 'setup-banner';
    banner.innerHTML =
      '<h3>Остался один шаг — добавь API-ключ</h3>' +
      '<ol>' +
      '<li>Открой файл <code>.env.example</code>, сохрани копию под именем <code>.env</code>.</li>' +
      '<li>Вставь ключ одного из сервисов (инструкция в файле <code>README.md</code>).</li>' +
      '<li>Перезапусти сервер — закрой и снова открой <code>start.bat</code>.</li>' +
      '</ol>' +
      '<p>Бесплатнее всего начать с <b>Google Gemini</b> — ключ выдаётся сразу и бесплатно.</p>';
    frag.appendChild(banner);
  }

  return frag;
}

function renderMessages() {
  const container = $('messages');
  container.innerHTML = '';
  streamEl = null;

  const inner = document.createElement('div');
  inner.className = 'messages-inner';

  const chat = getCurrentChat();
  const anyProvider = Object.values(config.providers || {}).some(Boolean);

  if (!chat || chat.messages.length === 0) {
    inner.appendChild(welcomeEl(anyProvider));
    container.appendChild(inner);
    return;
  }

  for (const msg of chat.messages) {
    inner.appendChild(buildMessageEl(msg));
  }
  container.appendChild(inner);
  scrollToBottom(true);
}

function renderChatList() {
  const list = $('chatList');
  list.innerHTML = '';

  if (!chats.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-item';
    empty.style.pointerEvents = 'none';
    empty.innerHTML = '<span class="chat-item-title">Пока нет чатов</span>';
    list.appendChild(empty);
    return;
  }

  for (const c of chats) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (c.id === currentId ? ' active' : '');

    const title = document.createElement('span');
    title.className = 'chat-item-title';
    title.textContent = c.title || 'Новый чат';
    item.appendChild(title);

    const del = document.createElement('button');
    del.className = 'chat-item-del';
    del.textContent = '✕';
    del.title = 'Удалить чат';
    del.onclick = (e) => {
      e.stopPropagation();
      deleteChat(c.id);
    };
    item.appendChild(del);

    item.onclick = () => {
      currentId = c.id;
      renderAll();
      closeSidebar();
    };
    list.appendChild(item);
  }
}

function deleteChat(id) {
  chats = chats.filter((c) => c.id !== id);
  if (currentId === id) currentId = chats[0]?.id ?? null;
  saveChats();
  renderAll();
}

function renderAll() {
  renderChatList();
  renderMessages();
  updateBadge();
}

function updateBadge() {
  $('modelBadge').textContent = providerName() + ' · ' + (settings.model || '—');
}

function scrollToBottom(force) {
  const m = $('messages');
  if (force) {
    m.scrollTop = m.scrollHeight;
    return;
  }
  const near = m.scrollHeight - m.scrollTop - m.clientHeight < 180;
  if (near) m.scrollTop = m.scrollHeight;
}

function updateStreamingBubble(text) {
  if (!streamEl) return;
  streamEl.textContent = text;
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  streamEl.appendChild(cursor);
  scrollToBottom(false);
}

// ---------------------------------------------------------------
//  Отправка сообщений и стриминг
// ---------------------------------------------------------------

function ensureChat() {
  let chat = getCurrentChat();
  if (!chat) {
    chat = { id: uid(), title: 'Новый чат', createdAt: Date.now(), messages: [] };
    chats.unshift(chat);
    currentId = chat.id;
  }
  return chat;
}

function updateSendBtn() {
  const b = $('sendBtn');
  b.textContent = streaming ? '⏹' : '➤';
  b.title = streaming ? 'Остановить' : 'Отправить';
  b.classList.toggle('stop', streaming);
}

function stopStreaming() {
  if (abortCtrl) abortCtrl.abort();
}

async function sendMessage() {
  if (streaming) {
    stopStreaming();
    return;
  }

  if (!config.providers || !config.providers[settings.provider]) {
    toast('Сначала добавь API-ключ для «' + providerName() + '» в файле .env');
    return;
  }

  const text = $('input').value.trim();
  if (!text && pendingImages.length === 0) return;

  const images = pendingImages;
  pendingImages = [];
  renderPreview();

  $('input').value = '';
  autoResize();

  const chat = ensureChat();
  if (chat.title === 'Новый чат') {
    chat.title = (text || 'Изображение').slice(0, 48);
  }

  chat.messages.push({ role: 'user', content: text, images: images.length ? images : undefined });
  chat.messages.push({ role: 'assistant', content: '', streaming: true });
  saveChats();
  renderAll();

  await streamResponse(chat);
}

async function streamResponse(chat) {
  streaming = true;
  updateSendBtn();

  const aiMsg = chat.messages[chat.messages.length - 1];
  const historyMsgs = chat.messages.slice(0, -1).map((m) => ({
    role: m.role,
    content: m.content || '',
    images: m.images,
  })).slice(-40);

  abortCtrl = new AbortController();
  aiMsg.content = '';

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortCtrl.signal,
      body: JSON.stringify({
        provider: settings.provider,
        model: settings.model,
        system: settings.system,
        temperature: Number(settings.temperature),
        maxTokens: Number(settings.maxTokens),
        messages: historyMsgs,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Ошибка ' + resp.status }));
      throw new Error(err.error || 'Ошибка ' + resp.status);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let lastRender = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = sseBuffer.indexOf('\n')) !== -1) {
        const line = sseBuffer.slice(0, idx).trim();
        sseBuffer = sseBuffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;

        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }

        if (obj.delta) {
          aiMsg.content += obj.delta;
          const now = Date.now();
          if (now - lastRender > 70) {
            lastRender = now;
            updateStreamingBubble(aiMsg.content);
          }
        } else if (obj.error) {
          throw new Error(obj.error);
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      if (!aiMsg.content) aiMsg.content = '⏹ Остановлено.';
    } else {
      aiMsg.error = true;
      aiMsg.errorText = e.message || 'Неизвестная ошибка';
    }
  } finally {
    aiMsg.streaming = false;
    streaming = false;
    abortCtrl = null;
    saveChats();
    renderAll();
    updateSendBtn();
  }
}

// ---------------------------------------------------------------
//  Изображения
// ---------------------------------------------------------------

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function processImage(file) {
  const dataUrl = await readFileAsDataURL(file);
  const img = await loadImage(dataUrl);

  const MAX = 1024;
  let { width, height } = img;
  if (width > MAX || height > MAX) {
    const scale = Math.min(MAX / width, MAX / height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);

  const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const data = canvas.toDataURL(mime, 0.85).split(',')[1];
  return { mime, data };
}

function renderPreview() {
  const box = $('attachPreview');
  box.innerHTML = '';
  box.hidden = pendingImages.length === 0;
  pendingImages.forEach((img, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const im = document.createElement('img');
    im.src = `data:${img.mime};base64,${img.data}`;
    thumb.appendChild(im);
    const x = document.createElement('button');
    x.className = 'thumb-x';
    x.textContent = '✕';
    x.onclick = () => {
      pendingImages.splice(i, 1);
      renderPreview();
    };
    thumb.appendChild(x);
    box.appendChild(thumb);
  });
}

// ---------------------------------------------------------------
//  Настройки
// ---------------------------------------------------------------

function renderProviderTabs() {
  const box = $('providerTabs');
  box.innerHTML = '';
  for (const p of PROVIDERS) {
    const b = document.createElement('button');
    b.className = 'tab' + (settings.provider === p.id ? ' active' : '');
    b.textContent = p.name + (config.providers?.[p.id] ? '' : ' 🔒');
    b.title = config.providers?.[p.id]
      ? 'Использовать ' + p.name
      : p.name + ' — нет API-ключа (добавь в .env)';
    b.disabled = !config.providers?.[p.id];
    b.onclick = () => {
      settings.provider = p.id;
      settings.model = config.defaults?.[p.id] || MODEL_OPTIONS[p.id]?.[0] || '';
      saveSettings();
      renderProviderTabs();
      renderModelList();
      updateBadge();
    };
    box.appendChild(b);
  }
}

function renderModelList() {
  const input = $('modelInput');
  const list = $('modelList');
  list.innerHTML = '';
  for (const m of MODEL_OPTIONS[settings.provider] || []) {
    const opt = document.createElement('option');
    opt.value = m;
    list.appendChild(opt);
  }
  input.value = settings.model || '';
}

function markThemeActive() {
  document.querySelectorAll('#themeSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeChoice === settings.theme);
  });
}

function openSettings() {
  renderProviderTabs();
  renderModelList();
  $('systemInput').value = settings.system;
  $('tempInput').value = settings.temperature;
  $('tempVal').textContent = settings.temperature;
  $('maxTokensInput').value = settings.maxTokens;
  markThemeActive();
  $('settingsModal').hidden = false;
}

function closeSettings() {
  $('settingsModal').hidden = true;
}

function bindSettingsEvents() {
  $('modelInput').addEventListener('input', () => {
    settings.model = $('modelInput').value.trim();
    saveSettings();
    updateBadge();
  });

  $('systemInput').addEventListener('input', () => {
    settings.system = $('systemInput').value;
    saveSettings();
  });

  $('tempInput').addEventListener('input', () => {
    settings.temperature = Number($('tempInput').value);
    $('tempVal').textContent = settings.temperature;
    saveSettings();
  });

  $('maxTokensInput').addEventListener('input', () => {
    settings.maxTokens = Number($('maxTokensInput').value) || 8192;
    saveSettings();
  });

  document.querySelectorAll('#themeSeg button').forEach((b) => {
    b.onclick = () => {
      settings.theme = b.dataset.themeChoice;
      applyTheme(settings.theme);
      markThemeActive();
      saveSettings();
    };
  });

  $('clearChatsBtn').onclick = () => {
    if (!chats.length) return toast('Чатов и так нет');
    if (!confirm('Удалить все чаты? Это действие нельзя отменить.')) return;
    chats = [];
    currentId = null;
    saveChats();
    renderAll();
    toast('Все чаты удалены');
  };
}

// ---------------------------------------------------------------
//  Композитор, голос, боковое меню
// ---------------------------------------------------------------

function autoResize() {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 180) + 'px';
}

function bindComposerEvents() {
  const input = $('input');

  input.addEventListener('input', autoResize);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  $('sendBtn').onclick = sendMessage;
  $('attachBtn').onclick = () => $('fileInput').click();

  $('fileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) {
      try {
        pendingImages.push(await processImage(f));
      } catch {
        toast('Не удалось обработать изображение');
      }
    }
    renderPreview();
  });

  // Голосовой ввод (если поддерживается)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    const rec = new SR();
    rec.lang = 'ru-RU';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (ev) => {
      input.value = ev.results[0][0].transcript;
      autoResize();
      input.focus();
    };
    rec.onerror = () => $('micBtn').classList.remove('active');
    rec.onend = () => $('micBtn').classList.remove('active');
    $('micBtn').onclick = () => {
      if ($('micBtn').classList.contains('active')) {
        rec.stop();
      } else {
        $('micBtn').classList.add('active');
        try { rec.start(); } catch {}
      }
    };
  } else {
    $('micBtn').style.display = 'none';
  }
}

function openSidebar() {
  $('sidebar').classList.add('open');
  $('backdrop').classList.add('show');
}

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('backdrop').classList.remove('show');
}

// ---------------------------------------------------------------
//  Инициализация
// ---------------------------------------------------------------

async function init() {
  try {
    chats = JSON.parse(localStorage.getItem(LS.chats) || '[]');
  } catch {
    chats = [];
  }
  try {
    settings = { ...defaultSettings, ...JSON.parse(localStorage.getItem(LS.settings) || '{}') };
  } catch {
    settings = { ...defaultSettings };
  }

  applyTheme(settings.theme || 'dark');

  try {
    const r = await fetch('/api/config');
    config = await r.json();
  } catch {
    config = { providers: {}, defaults: {} };
  }

  // Если выбранный провайдер без ключа — переключаемся на первый доступный
  const available = PROVIDERS.filter((p) => config.providers?.[p.id]);
  if (available.length && !config.providers?.[settings.provider]) {
    settings.provider = available[0].id;
  }
  if (!settings.model) {
    settings.model = config.defaults?.[settings.provider] || MODEL_OPTIONS[settings.provider]?.[0] || '';
  }

  // События
  $('menuBtn').onclick = openSidebar;
  $('closeSidebarBtn').onclick = closeSidebar;
  $('backdrop').onclick = closeSidebar;
  $('newChatBtn').onclick = () => {
    currentId = null;
    renderAll();
    closeSidebar();
    $('input').focus();
  };
  $('settingsBtn').onclick = openSettings;
  $('topSettingsBtn').onclick = openSettings;
  $('closeSettingsBtn').onclick = closeSettings;
  $('settingsModal').addEventListener('click', (e) => {
    if (e.target === $('settingsModal')) closeSettings();
  });

  bindComposerEvents();
  bindSettingsEvents();
  renderAll();
  updateSendBtn();

  // PWA
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  $('input').focus();
}

document.addEventListener('DOMContentLoaded', init);
