// 战绩 API 测试：独立端口 + 临时数据库，验证 /api/stats/me 与 /leaderboard
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3221;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'azul-stats-'));

let passed = 0;
let server;
function ok(cond, msg) {
  if (!cond) { console.error(`✘ ${msg}`); cleanup(1); }
  passed++;
  console.log(`✔ ${msg}`);
}
function cleanup(code) {
  try { server && server.kill(); } catch {}
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: tmpData },
    stdio: 'ignore',
  });
  // 轮询等待服务就绪（至多 15s）
  for (let i = 0; ; i++) {
    try { await fetch(BASE); break; }
    catch { if (i > 30) { console.error('✘ 测试服务器未能启动'); cleanup(1); } await wait(500); }
  }

  // 注册
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 's@t.com', nickname: '统计员', password: 'test123456' }),
  }).then((r) => r.json());
  ok(reg.token, '注册成功');
  const headers = { Authorization: `Bearer ${reg.token}` };

  // 未登录被拒
  const noAuth = await fetch(`${BASE}/api/stats/me`);
  ok(noAuth.status === 401, '无 token 访问被拒绝(401)');

  // 空战绩
  let me = await fetch(`${BASE}/api/stats/me`, { headers }).then((r) => r.json());
  ok(me.games === 0 && me.winRate === 0, '初始战绩为 0');

  // 直接向数据库写入两局完整对局记录（user 1 一胜一负）
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(tmpData, 'azul.db'));
  for (const [gid, rank, score] of [[101, 1, 55], [102, 2, 38]]) {
    db.prepare("INSERT INTO games (id, room_name, max_players, status) VALUES (?, 't', 2, 'finished')").run(gid);
    db.prepare('INSERT INTO game_players (game_id, user_id, nickname, is_ai, seat_index, score, rank) VALUES (?, 1, ?, 0, 0, ?, ?)')
      .run(gid, '统计员', score, rank);
    // 对手是 AI（user_id 为空），不应出现在榜单
    db.prepare('INSERT INTO game_players (game_id, user_id, nickname, is_ai, seat_index, score, rank) VALUES (?, NULL, ?, 1, 1, ?, ?)')
      .run(gid, 'AI对手', 60, rank === 1 ? 2 : 1);
  }
  // 一局未完整结束的对局（rank 为空），不应计入
  db.prepare("INSERT INTO games (id, room_name, max_players, status) VALUES (103, 't', 2, 'finished')").run();
  db.prepare('INSERT INTO game_players (game_id, user_id, nickname, is_ai, seat_index, score) VALUES (103, 1, ?, 0, 0, 10)').run('统计员');
  db.close();

  me = await fetch(`${BASE}/api/stats/me`, { headers }).then((r) => r.json());
  ok(me.games === 2, `只统计完整对局：场次=2（实际 ${me.games}）`);
  ok(me.wins === 1 && me.winRate === 50, `胜场 1、胜率 50%（实际 ${me.wins}/${me.winRate}%）`);
  ok(me.totalScore === 93 && me.bestScore === 55, `累计 93、最高 55（实际 ${me.totalScore}/${me.bestScore}）`);

  const lb = await fetch(`${BASE}/api/stats/leaderboard`, { headers }).then((r) => r.json());
  ok(lb.length === 1 && lb[0].nickname === '统计员', '排行榜只含真人玩家（AI 不上榜）');
  ok(lb[0].wins === 1 && lb[0].totalScore === 93, '榜单数据正确');

  console.log(`\n全部 ${passed} 项战绩用例通过 ✅`);
  cleanup(0);
})().catch((e) => { console.error('✘ 测试异常:', e.message); cleanup(1); });
