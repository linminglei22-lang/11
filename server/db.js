// SQLite 数据库（使用 Node.js 内置 node:sqlite，无需原生编译）
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// 可用 DATA_DIR 环境变量指定数据目录（如 Render 挂载的持久磁盘 /var/data）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'azul.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    nickname TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_name TEXT NOT NULL,
    max_players INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS game_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    user_id INTEGER,
    nickname TEXT NOT NULL,
    is_ai INTEGER NOT NULL DEFAULT 0,
    seat_index INTEGER NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (game_id) REFERENCES games(id)
  );

  CREATE TABLE IF NOT EXISTS game_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER UNIQUE NOT NULL,
    state_json TEXT NOT NULL,
    FOREIGN KEY (game_id) REFERENCES games(id)
  );
`);

module.exports = db;
