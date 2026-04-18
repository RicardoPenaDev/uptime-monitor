// routes-auth.js — Rotas de autenticação (setup, login, logout, status, change-password)
const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('./auth');

function createAuthRouter() {
  const router = express.Router();

  // Rate limit para login: 5 tentativas por 15 min por IP
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Muitas tentativas de login. Tente novamente em alguns minutos.' },
  });

  // Status da autenticação (público)
  router.get('/status', (req, res) => {
    const setupComplete = auth.isSetupComplete();
    const current = auth.loadAuth();
    const authenticated = !!(req.session && req.session.user);
    res.json({
      setupComplete,
      authenticated,
      username: authenticated ? req.session.user.username : null,
      configuredUsername: setupComplete && current ? current.username : null,
    });
  });

  // Setup do admin (só funciona se ainda não houver auth.json)
  router.post('/setup', async (req, res) => {
    if (auth.isSetupComplete()) {
      return res.status(409).json({ error: 'Setup já foi concluído.' });
    }
    const { username, password } = req.body || {};
    const uErr = auth.validateUsername(username);
    if (uErr) return res.status(400).json({ error: uErr });
    const pErr = auth.validatePassword(password);
    if (pErr) return res.status(400).json({ error: pErr });

    try {
      const passwordHash = await auth.hashPassword(password);
      const now = new Date().toISOString();
      auth.saveAuth(
        {
          username: username.trim(),
          passwordHash,
          sessionSecret: auth.generateSessionSecret(),
          createdAt: now,
          updatedAt: now,
        },
        { create: true }
      );
      res.json({ ok: true });
    } catch (e) {
      // EEXIST significa que alguém venceu a corrida e já criou o arquivo
      if (e && e.code === 'EEXIST') {
        return res.status(409).json({ error: 'Setup já foi concluído.' });
      }
      console.error('[auth] setup falhou:', e);
      res.status(500).json({ error: 'Falha ao salvar credenciais.' });
    }
  });

  // Login
  router.post('/login', loginLimiter, async (req, res) => {
    if (!auth.isSetupComplete()) {
      return res.status(400).json({ error: 'Setup ainda não foi concluído.' });
    }
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Credenciais inválidas.' });
    }
    const current = auth.loadAuth();
    if (!current) {
      return res.status(500).json({ error: 'Arquivo de credenciais ausente.' });
    }

    const sameUser = username.trim().toLowerCase() === current.username.toLowerCase();
    const ok = sameUser && (await auth.verifyPassword(password, current.passwordHash));
    if (!ok) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }

    req.session.regenerate((err) => {
      if (err) {
        console.error('[auth] regenerate falhou:', err);
        return res.status(500).json({ error: 'Falha ao iniciar sessão.' });
      }
      req.session.user = { username: current.username };
      res.json({ ok: true, username: current.username });
    });
  });

  // Logout
  router.post('/logout', (req, res) => {
    if (!req.session) return res.json({ ok: true });
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ ok: true });
    });
  });

  // Trocar senha (requer estar logado)
  router.post('/change-password', async (req, res) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Não autenticado.' });
    }
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'Dados inválidos.' });
    }
    const pErr = auth.validatePassword(newPassword);
    if (pErr) return res.status(400).json({ error: pErr });

    const current = auth.loadAuth();
    if (!current) return res.status(500).json({ error: 'Credenciais ausentes.' });

    const ok = await auth.verifyPassword(currentPassword, current.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Senha atual incorreta.' });

    try {
      current.passwordHash = await auth.hashPassword(newPassword);
      current.updatedAt = new Date().toISOString();
      auth.saveAuth(current);
      res.json({ ok: true });
    } catch (e) {
      console.error('[auth] change-password falhou:', e);
      res.status(500).json({ error: 'Falha ao atualizar senha.' });
    }
  });

  return router;
}

// Middleware para proteger rotas /api/* (exceto /api/auth/*)
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Não autenticado.' });
}

module.exports = { createAuthRouter, requireAuth };
