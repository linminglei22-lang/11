// 集成测试：对局中退出 → AI 托管 → 全员退出 → 房间解散
// 独立端口 + 临时数据目录，不影响正在运行的正式服务器
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3219;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'azul-test-'));

const ioc = require(path.join(__dirname, '..', 'node_modules', 'socket.io-client'));

let passed = 0;
function ok(cond, msg) {
  if (!cond) { console.error(`✘ ${msg}`); cleanup(1); }
  passed++;
  console.log(`✔ ${msg}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
function cleanup(code) {
  try { server && server.kill(); } catch {}
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

async function register(email, nickname) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, nickname, password: 'test123456' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data.token;
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = ioc(BASE, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('连接超时')), 5000);
  });
}

const emit = (s, ev, payload) =>
  new Promise((resolve) => s.emit(ev, payload, resolve));

(async () => {
  // 启动独立测试服务器
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

  const t1 = await register('u1@test.com', '玩家一');
  const t2 = await register('u2@test.com', '玩家二');
  const s1 = await connect(t1);
  const s2 = await connect(t2);
  ok(true, '两名玩家注册并连接');

  // 建房 → 加入 → 开局
  const created = await emit(s1, 'create_room', { name: '退出测试', maxPlayers: 2 });
  ok(created.room && created.room.id, '玩家一创建房间');
  const roomId = created.room.id;
  const joined = await emit(s2, 'join_room', { roomId });
  ok(!joined.error, '玩家二加入房间');

  let lastState = null;
  let lastRoom = null;
  let leftNotice = null;
  for (const s of [s1, s2]) {
    s.on('game_state', (g) => { lastState = g; });
    s.on('room_update', (r) => { lastRoom = r; });
  }
  s2.on('player_left', (p) => { leftNotice = p; });

  const started = await emit(s1, 'start_game', {});
  ok(!started.error, '开始游戏');
  await wait(500);
  ok(lastState && lastState.phase === 'playing', '收到对局状态');

  // 玩家一中途退出 → AI 托管
  const leave1 = await emit(s1, 'leave_room', {});
  ok(leave1.ok === true, '玩家一对局中退出成功');
  await wait(800);
  ok(leftNotice && leftNotice.nickname === '玩家一', '玩家二收到退出通知');
  ok(lastRoom && lastRoom.members[0].isAi === true, '退出者座位已转为 AI 托管');
  ok(lastRoom.hostUserId !== null && lastRoom.members.some((m) => !m.isAi), '房主移交给剩余真人');

  // 对局未卡死：若轮到托管 AI（座位 0）它应自动行动；若轮到玩家二则属正常等待
  const seqBefore = lastState.seq;
  await wait(4000);
  const aiActed = lastState.seq > seqBefore;
  const humanTurn = lastState.currentPlayer === 1;
  ok(aiActed || humanTurn,
    `托管后对局未卡死（${aiActed ? `AI 已行动 seq ${seqBefore}→${lastState.seq}` : '正常等待玩家二行动'}）`);

  // 玩家二也退出 → 没有真人 → 房间解散
  let roomList = null;
  s2.on('room_list', (l) => { roomList = l; });
  const leave2 = await emit(s2, 'leave_room', {});
  ok(leave2.ok === true, '玩家二退出成功');
  await wait(800);
  const stillThere = (roomList || []).some((r) => r.id === roomId);
  ok(!stillThere, '全员退出后房间已从大厅消失（自动解散）');

  console.log(`\n全部 ${passed} 项退出/托管用例通过 ✅`);
  s1.disconnect(); s2.disconnect();
  cleanup(0);
})().catch((e) => { console.error('✘ 测试异常:', e.message); cleanup(1); });
