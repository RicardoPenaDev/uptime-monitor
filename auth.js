// auth.js — Gerenciamento de credenciais do admin (single-user)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const AUTH_FILE = path.join(__dirname, 'data', 'auth.json');
const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;

function loadAuth() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[auth] Erro ao carregar auth.json:', e.message);
  }
  return null;
}

function saveAuth(data, { create = false } = {}) {
  // flag 'wx' → falha se já existir (evita corrida no setup).
  // 'w' usado normalmente para update.
  const flag = create ? 'wx' : 'w';
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), { flag });
}

function isSetupComplete() {
  const auth = loadAuth();
  return !!(auth && auth.username && auth.passwordHash);
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  try {
    return await bcrypt.compare(plain, hash);
  } catch (e) {
    return false;
  }
}

function generateSessionSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function validatePassword(pw) {
  if (typeof pw !== 'string') return 'Senha inválida.';
  if (pw.length < MIN_PASSWORD_LENGTH) {
    return `Senha deve ter no mínimo ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  return null;
}

function validateUsername(u) {
  if (typeof u !== 'string') return 'Usuário inválido.';
  const trimmed = u.trim();
  if (trimmed.length < 3) return 'Usuário deve ter no mínimo 3 caracteres.';
  if (trimmed.length > 64) return 'Usuário muito longo.';
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    return 'Usuário pode conter apenas letras, números, ponto, hífen e underline.';
  }
  return null;
}

module.exports = {
  AUTH_FILE,
  MIN_PASSWORD_LENGTH,
  loadAuth,
  saveAuth,
  isSetupComplete,
  hashPassword,
  verifyPassword,
  generateSessionSecret,
  validatePassword,
  validateUsername,
};
