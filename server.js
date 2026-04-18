const express = require('express');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const session = require('express-session');
const MemoryStoreFactory = require('memorystore');
const MemoryStore = MemoryStoreFactory(session);
const authLib = require('./auth');
const { createAuthRouter, requireAuth } = require('./routes-auth');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const DATA_FILE = path.join(__dirname, 'data', 'monitors.json');
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
const HISTORY_FILE = path.join(__dirname, 'data', 'history.json');

// Garantir diretório data/ antes de tentar ler auth.json
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

app.set('trust proxy', 1); // atrás do Traefik / reverse proxy
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Sessão ──────────────────────────────────────────────────────────────────
// O secret é lido do auth.json quando disponível, ou gerado em memória até o
// setup ser concluído. Reiniciar o container rotaciona o secret provisório.
const bootAuth = authLib.loadAuth();
const sessionSecret = (bootAuth && bootAuth.sessionSecret) || authLib.generateSessionSecret();

app.use(session({
  name: 'uptime.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  store: new MemoryStore({ checkPeriod: 24 * 60 * 60 * 1000 }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
  },
}));

// ─── Rotas de autenticação (públicas) ────────────────────────────────────────
app.use('/api/auth', createAuthRouter());

// ─── Proteção: tudo abaixo de /api requer sessão ─────────────────────────────
app.use('/api', requireAuth);

// ─── Utilitários de dados ─────────────────────────────────────────────────────

function loadData(file, defaultValue) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {}
  return defaultValue;
}

function saveData(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let monitors = loadData(DATA_FILE, []);
let config = loadData(CONFIG_FILE, {
  evolutionApiUrl: '',
  evolutionInstance: '',
  evolutionApiKey: '',
  notifyNumbers: [],
  telegramBotToken: '',
  telegramChatIds: []
});
let history = loadData(HISTORY_FILE, {});

// ─── Tradução de erros de rede ───────────────────────────────────────────────

function traduzirErro(msg) {
  if (!msg) return msg;
  const map = {
    'ECONNREFUSED': 'Conexão recusada',
    'Connection refused': 'Conexão recusada',
    'ECONNRESET': 'Conexão encerrada pelo servidor',
    'ETIMEDOUT': 'Tempo de conexão esgotado',
    'ENOTFOUND': 'Host não encontrado',
    'EADDRNOTAVAIL': 'Endereço indisponível',
    'ENETUNREACH': 'Rede inacessível',
    'EHOSTUNREACH': 'Host inacessível',
    'ECONNABORTED': 'Conexão abortada',
    'CERT_HAS_EXPIRED': 'Certificado SSL expirado',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE': 'Certificado SSL inválido',
    'ERR_SSL_WRONG_VERSION_NUMBER': 'Erro de versão SSL',
    'socket hang up': 'Conexão encerrada abruptamente',
    'read ECONNRESET': 'Conexão encerrada pelo servidor',
  };
  for (const [en, pt] of Object.entries(map)) {
    if (msg.includes(en)) return msg.replace(en, pt);
  }
  return msg;
}

// ─── Verificadores de conectividade ──────────────────────────────────────────

function checkTCP(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(Number(timeout)); // garantir número
    socket.on('connect', () => {
      const latency = Date.now() - start;
      socket.destroy();
      resolve({ up: true, latency, detail: `TCP ON em ${latency}ms` });
    });
    socket.on('error', (err) => {
      socket.destroy();
      resolve({ up: false, latency: null, detail: `TCP OFF — ${traduzirErro(err.message)}` });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ up: false, latency: null, detail: 'TCP OFF — Timeout na conexão' });
    });
    socket.connect(Number(port), host);
  });
}

function checkHTTP(urlStr, timeout = 10000, expectedStatus = null) {
  return new Promise((resolve) => {
    const start = Date.now();
    let parsed;
    try {
      parsed = new URL(urlStr.startsWith('http') ? urlStr : 'http://' + urlStr);
    } catch (e) {
      return resolve({ up: false, latency: null, detail: 'URL inválida' });
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: Number(timeout), // garantir número
      headers: { 'User-Agent': 'UptimeMonitor/1.0' }
    };

    const req = lib.request(options, (res) => {
      const latency = Date.now() - start;
      res.resume();
      const statusOk = expectedStatus ? res.statusCode === Number(expectedStatus) : res.statusCode < 500;
      resolve({
        up: statusOk,
        latency,
        statusCode: res.statusCode,
        detail: `HTTP ${res.statusCode} em ${latency}ms`
      });
    });

    req.on('error', (err) => resolve({ up: false, latency: null, detail: traduzirErro(err.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ up: false, latency: null, detail: 'Timeout HTTP' }); });
    req.end();
  });
}

async function checkMonitor(monitor) {
  const type = monitor.type || 'http';
  let result;

  if (type === 'tcp' || type === 'port') {
    result = await checkTCP(monitor.host, monitor.port, Number(monitor.timeout) || 5000);
  } else {
    const url = monitor.url || `http://${monitor.host}:${monitor.port}`;
    result = await checkHTTP(url, Number(monitor.timeout) || 10000, monitor.expectedStatus);
  }

  return {
    ...result,
    checkedAt: new Date().toISOString(),
    monitorId: monitor.id
  };
}

// ─── Notificações WhatsApp (Evolution API) ────────────────────────────────────

async function sendWhatsApp(number, message) {
  if (!config.evolutionApiUrl || !config.evolutionInstance) return;
  const clean = number.replace(/\D/g, '');
  const jid = clean.includes('@') ? clean : `${clean}@s.whatsapp.net`;

  try {
    const url = new URL(`${config.evolutionApiUrl}/message/sendText/${config.evolutionInstance}`);
    const body = JSON.stringify({ number: jid, text: message });
    const lib = url.protocol === 'https:' ? https : http;

    await new Promise((resolve, reject) => {
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.evolutionApiKey || '',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 10000
      }, (res) => { res.resume(); resolve(); });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
    console.log(`✅ WhatsApp enviado para ${clean}`);
  } catch (err) {
    console.error(`❌ Erro ao enviar WhatsApp para ${number}:`, err.message);
  }
}

async function sendTelegram(chatId, message) {
  if (!config.telegramBotToken) return;
  const token = config.telegramBotToken;
  // Converter formatação WhatsApp (*bold*) para Telegram (*bold* = igual)
  const body = JSON.stringify({
    chat_id: chatId,
    text: message,
    parse_mode: 'Markdown'
  });

  try {
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 10000
      }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          const json = JSON.parse(data);
          if (!json.ok) reject(new Error(json.description));
          else resolve();
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
    console.log(`✅ Telegram enviado para chat ${chatId}`);
  } catch (err) {
    console.error(`❌ Erro ao enviar Telegram para ${chatId}:`, err.message);
  }
}

async function notifyAll(message) {
  const numbers = config.notifyNumbers || [];
  for (const num of numbers) {
    await sendWhatsApp(num, message);
  }
  const chatIds = config.telegramChatIds || [];
  for (const chatId of chatIds) {
    await sendTelegram(chatId, message);
  }
}

// ─── Histórico e estado ────────────────────────────────────────────────────────

function recordHistory(monitorId, result) {
  if (!history[monitorId]) history[monitorId] = [];
  history[monitorId].push({
    up: result.up,
    latency: result.latency,
    detail: result.detail,
    statusCode: result.statusCode,
    checkedAt: result.checkedAt
  });
  // Manter apenas os últimos 500 registros
  if (history[monitorId].length > 500) {
    history[monitorId] = history[monitorId].slice(-500);
  }
  saveData(HISTORY_FILE, history);
}

function getUptimePercent(monitorId, hours = 24) {
  const records = history[monitorId] || [];
  const since = Date.now() - hours * 3600 * 1000;
  const recent = records.filter(r => new Date(r.checkedAt).getTime() > since);
  if (!recent.length) return null;
  const up = recent.filter(r => r.up).length;
  return ((up / recent.length) * 100).toFixed(2);
}

function getAvgLatency(monitorId, hours = 24) {
  const records = history[monitorId] || [];
  const since = Date.now() - hours * 3600 * 1000;
  const recent = records.filter(r => r.up && r.latency && new Date(r.checkedAt).getTime() > since);
  if (!recent.length) return null;
  return Math.round(recent.reduce((s, r) => s + r.latency, 0) / recent.length);
}

// ─── Loop de monitoramento ────────────────────────────────────────────────────

const monitorStatus = {}; // estado atual por ID

async function runCheck(monitor) {
  if (!monitor.active) return;
  const result = await checkMonitor(monitor);
  const prev = monitorStatus[monitor.id];
  monitorStatus[monitor.id] = result;
  recordHistory(monitor.id, result);

  // Detectar mudança de estado
  if (prev !== undefined && prev.up !== result.up) {
    const emoji = result.up ? '✅' : '🔴';
    const nome = monitor.name;
    const target = monitor.url || `${monitor.host}:${monitor.port}`;
    const latencia = result.latency ? ` | Latência: ${result.latency}ms` : '';
    const detalhe = result.detail ? ` | ${result.detail}` : '';
    const msg = `${emoji} *[MONITOR]* ${nome}\n\n*Alvo:* ${target}${latencia}${detalhe}\n*Horário:* ${new Date().toLocaleString('pt-BR')}`;
    await notifyAll(msg);
    const estado = result.up ? 'VOLTOU' : 'CAIU';
    console.log(`[${estado}] ${nome} - ${target}`);
  }
}

const checkIntervals = {};

function startMonitor(monitor) {
  if (checkIntervals[monitor.id]) clearInterval(checkIntervals[monitor.id]);
  runCheck(monitor); // verificação imediata
  const interval = (Number(monitor.interval) || 60) * 1000;
  checkIntervals[monitor.id] = setInterval(() => runCheck(monitor), interval);
}

function stopMonitor(id) {
  if (checkIntervals[id]) {
    clearInterval(checkIntervals[id]);
    delete checkIntervals[id];
  }
}

function reloadMonitors() {
  monitors = loadData(DATA_FILE, []);
  for (const m of monitors) {
    if (m.active) startMonitor(m);
    else stopMonitor(m.id);
  }
}

// ─── Helper para normalizar campos numéricos ──────────────────────────────────

function parseMonitorFields(body) {
  return {
    name: body.name || undefined,
    type: body.type || undefined,
    url: body.url !== undefined ? (body.url || null) : undefined,
    host: body.host !== undefined ? (body.host || null) : undefined,
    port: body.port !== undefined ? (body.port ? parseInt(body.port) : null) : undefined,
    interval: body.interval !== undefined ? parseInt(body.interval) : undefined,
    timeout: body.timeout !== undefined ? parseInt(body.timeout) : undefined,
    expectedStatus: body.expectedStatus !== undefined ? (body.expectedStatus ? parseInt(body.expectedStatus) : null) : undefined,
    active: body.active !== undefined ? body.active : undefined
  };
}

// ─── API REST ─────────────────────────────────────────────────────────────────

// Listar monitores com status atual
app.get('/api/monitors', (req, res) => {
  const result = monitors.map(m => ({
    ...m,
    status: monitorStatus[m.id] || null,
    uptime24h: getUptimePercent(m.id, 24),
    uptime7d: getUptimePercent(m.id, 168),
    avgLatency: getAvgLatency(m.id, 24)
  }));
  res.json(result);
});

// Criar monitor
app.post('/api/monitors', (req, res) => {
  const fields = parseMonitorFields(req.body);
  const m = {
    id: Date.now().toString(),
    name: fields.name || 'Sem nome',
    type: fields.type || 'http',
    url: fields.url !== undefined ? fields.url : null,
    host: fields.host !== undefined ? fields.host : null,
    port: fields.port !== undefined ? fields.port : null,
    interval: fields.interval !== undefined ? fields.interval : 60,
    timeout: fields.timeout !== undefined ? fields.timeout : 10000,
    expectedStatus: fields.expectedStatus !== undefined ? fields.expectedStatus : null,
    active: true,
    createdAt: new Date().toISOString()
  };
  monitors.push(m);
  saveData(DATA_FILE, monitors);
  startMonitor(m);
  res.json(m);
});

// Atualizar monitor
app.put('/api/monitors/:id', (req, res) => {
  const idx = monitors.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });

  const fields = parseMonitorFields(req.body);
  // Remover chaves undefined antes de fazer o merge
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

  monitors[idx] = { ...monitors[idx], ...clean, id: monitors[idx].id };
  saveData(DATA_FILE, monitors);
  if (monitors[idx].active) startMonitor(monitors[idx]);
  else stopMonitor(monitors[idx].id);
  res.json(monitors[idx]);
});

// Deletar monitor
app.delete('/api/monitors/:id', (req, res) => {
  stopMonitor(req.params.id);
  monitors = monitors.filter(m => m.id !== req.params.id);
  saveData(DATA_FILE, monitors);
  res.json({ ok: true });
});

// Forçar verificação manual
app.post('/api/monitors/:id/check', async (req, res) => {
  const m = monitors.find(m => m.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Não encontrado' });
  const result = await checkMonitor(m);
  monitorStatus[m.id] = result;
  recordHistory(m.id, result);
  res.json(result);
});

// Histórico de um monitor
app.get('/api/monitors/:id/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const records = (history[req.params.id] || []).slice(-limit);
  res.json(records);
});

// Configuração
app.get('/api/config', (req, res) => res.json(config));

app.post('/api/config', (req, res) => {
  config = { ...config, ...req.body };
  saveData(CONFIG_FILE, config);
  res.json(config);
});

// Testar Telegram
app.post('/api/test-telegram', async (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'Chat ID obrigatório' });
  try {
    await sendTelegram(chatId, '✅ *Teste de notificação* \- Uptime Monitor configurado com sucesso\! 🎉');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Testar WhatsApp
app.post('/api/test-whatsapp', async (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).json({ error: 'Número obrigatório' });
  try {
    await sendWhatsApp(number, '✅ *Teste de notificação* - Uptime Monitor configurado com sucesso! 🎉');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Status geral
app.get('/api/stats', (req, res) => {
  const total = monitors.length;
  const active = monitors.filter(m => m.active).length;
  const up = monitors.filter(m => monitorStatus[m.id]?.up === true).length;
  const down = monitors.filter(m => monitorStatus[m.id]?.up === false).length;
  res.json({ total, active, up, down, unchecked: active - up - down });
});

// ─── Inicialização ────────────────────────────────────────────────────────────

reloadMonitors();

app.listen(PORT, () => {
  console.log(`🚀 Uptime Monitor rodando em http://localhost:${PORT}`);
  console.log(`📊 ${monitors.length} monitor(es) carregado(s)`);
});
