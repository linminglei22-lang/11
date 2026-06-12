// 战绩统计 API：个人累计数据 + 排行榜
// 只统计完整打完的对局（game_players.rank 非空）；AI 玩家（user_id 为空）不计入
const express = require('express');
const db = require('./db');
const { verifyToken } = require('./auth');

const router = express.Router();

// 鉴权：Authorization: Bearer <token>
router.use((req, res, next) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: '未登录或登录已过期' });
  req.user = user;
  next();
});

function shape(row) {
  const games = row.games || 0;
  const wins = row.wins || 0;
  return {
    games,
    wins,
    winRate: games > 0 ? Math.round((wins / games) * 100) : 0,
    totalScore: row.total_score || 0,
    bestScore: row.best_score || 0,
    avgScore: games > 0 ? Math.round((row.total_score || 0) / games) : 0,
  };
}

// 我的累计战绩
router.get('/me', (req, res) => {
  const row = db.prepare(`
    SELECT COUNT(*) AS games,
           SUM(rank = 1) AS wins,
           SUM(score) AS total_score,
           MAX(score) AS best_score
    FROM game_players
    WHERE user_id = ? AND rank IS NOT NULL
  `).get(req.user.id);
  res.json(shape(row));
});

// 排行榜：按胜场降序，再按累计得分降序，取前 20
router.get('/leaderboard', (_req, res) => {
  const rows = db.prepare(`
    SELECT u.id AS user_id, u.nickname,
           COUNT(*) AS games,
           SUM(gp.rank = 1) AS wins,
           SUM(gp.score) AS total_score,
           MAX(gp.score) AS best_score
    FROM game_players gp
    JOIN users u ON u.id = gp.user_id
    WHERE gp.user_id IS NOT NULL AND gp.rank IS NOT NULL
    GROUP BY u.id
    ORDER BY wins DESC, total_score DESC
    LIMIT 20
  `).all();
  res.json(rows.map((r) => ({ userId: r.user_id, nickname: r.nickname, ...shape(r) })));
});

module.exports = { router };
