// 注册 / 登录 路由 + JWT 工具
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'azul-dev-secret-change-me';
const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, nickname: user.nickname },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

router.post('/register', (req, res) => {
  const { email, nickname, password } = req.body || {};
  if (!email || !nickname || !password) {
    return res.status(400).json({ error: '邮箱、昵称、密码均为必填' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }
  if (nickname.length > 16) {
    return res.status(400).json({ error: '昵称最长 16 个字符' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: '该邮箱已注册' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (email, nickname, password_hash) VALUES (?, ?, ?)')
    .run(email, nickname, hash);
  const user = { id: Number(info.lastInsertRowid), email, nickname };
  res.json({ token: signToken(user), user });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '请输入邮箱和密码' });

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }
  const user = { id: row.id, email: row.email, nickname: row.nickname };
  res.json({ token: signToken(user), user });
});

module.exports = { router, verifyToken };
