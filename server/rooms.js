// 大厅 / 房间 / 游戏 的 Socket.io 逻辑
const db = require('./db');
const { verifyToken } = require('./auth');
const rules = require('./game/rules');
const ai = require('./game/ai');
const llm = require('./game/llm');

// 内存中的房间表：roomId(=games.id) -> room
// room: { id, name, maxPlayers, status, hostUserId, members: [{userId, nickname, isAi, aiId}], state }
const rooms = new Map();
let aiSeq = 1;

function roomSummary(room) {
  return {
    id: room.id,
    name: room.name,
    maxPlayers: room.maxPlayers,
    status: room.status,
    hostNickname: room.members.find((m) => m.userId === room.hostUserId)?.nickname || '?',
    playerCount: room.members.length,
  };
}

function roomDetail(room) {
  return {
    ...roomSummary(room),
    hostUserId: room.hostUserId,
    members: room.members.map((m) => ({
      userId: m.userId,
      nickname: m.nickname,
      isAi: m.isAi,
      aiId: m.aiId || null,
      difficulty: m.difficulty || null,
      llmModel: m.llm ? m.llm.model : null,
      connected: m.isAi ? true : !!m.connected,
    })),
  };
}

function lobbyList() {
  return [...rooms.values()]
    .filter((r) => r.status !== 'finished')
    .map(roomSummary);
}

function saveState(room) {
  db.prepare(
    `INSERT INTO game_state (game_id, state_json) VALUES (?, ?)
     ON CONFLICT(game_id) DO UPDATE SET state_json = excluded.state_json`
  ).run(room.id, JSON.stringify(room.state));
}

// 服务器重启后从数据库恢复进行中的对局（大模型 AI 的 Key 只在内存，恢复后降级为困难启发式）
function restoreRooms() {
  const playing = db.prepare("SELECT * FROM games WHERE status = 'playing'").all();
  let restored = 0;
  for (const g of playing) {
    try {
      const st = db.prepare('SELECT state_json FROM game_state WHERE game_id = ?').get(g.id);
      const players = db
        .prepare('SELECT * FROM game_players WHERE game_id = ? ORDER BY seat_index')
        .all(g.id);
      const state = st ? JSON.parse(st.state_json) : null;
      if (!state || state.phase !== 'playing' || players.length === 0) throw new Error('状态不完整');

      const members = players.map((p) =>
        p.is_ai
          ? { userId: null, aiId: `ai-r${p.id}`, nickname: p.nickname, isAi: true, difficulty: 'hard' }
          : { userId: p.user_id, nickname: p.nickname, isAi: false, connected: false }
      );
      const host = members.find((m) => !m.isAi);
      if (!host) throw new Error('无真人玩家');
      rooms.set(g.id, {
        id: g.id, name: g.room_name, maxPlayers: g.max_players,
        status: 'playing', hostUserId: host.userId, members, state, aiTimer: null,
      });
      restored++;
    } catch (e) {
      db.prepare('UPDATE games SET status = ? WHERE id = ?').run('finished', g.id);
      console.warn(`对局 #${g.id} 无法恢复（${e.message}），已标记结束`);
    }
  }
  if (restored > 0) console.log(`已从数据库恢复 ${restored} 局进行中的对局，等待玩家重连`);
}

function setup(io) {
  restoreRooms();
  // 恢复的对局若轮到 AI，立即调度，避免卡住
  for (const room of rooms.values()) scheduleAi(io, room);
  // 握手鉴权
  io.use((socket, next) => {
    const user = verifyToken(socket.handshake.auth?.token);
    if (!user) return next(new Error('未登录或登录已过期'));
    socket.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.user;
    socket.join('lobby');
    socket.emit('room_list', lobbyList());

    // 断线重连：如果用户在某个进行中的房间里，自动拉回
    for (const room of rooms.values()) {
      const m = room.members.find((x) => !x.isAi && x.userId === user.id);
      if (m) {
        m.connected = true;
        m.socketId = socket.id;
        socket.join(`room:${room.id}`);
        socket.emit('room_update', roomDetail(room));
        if (room.status === 'playing') {
          socket.emit('game_start', { roomId: room.id });
          socket.emit('game_state', publicState(room));
        }
        io.to(`room:${room.id}`).emit('room_update', roomDetail(room));
      }
    }

    socket.on('create_room', ({ name, maxPlayers }, cb) => {
      maxPlayers = [2, 3, 4].includes(maxPlayers) ? maxPlayers : 2;
      name = String(name || '').trim().slice(0, 30) || `${user.nickname} 的房间`;
      if (findUserRoom(user.id)) return cb?.({ error: '你已在一个房间中' });

      const info = db
        .prepare('INSERT INTO games (room_name, max_players, status) VALUES (?, ?, ?)')
        .run(name, maxPlayers, 'waiting');
      const room = {
        id: Number(info.lastInsertRowid),
        name,
        maxPlayers,
        status: 'waiting',
        hostUserId: user.id,
        members: [
          { userId: user.id, nickname: user.nickname, isAi: false, connected: true, socketId: socket.id },
        ],
        state: null,
        aiTimer: null,
      };
      rooms.set(room.id, room);
      socket.join(`room:${room.id}`);
      cb?.({ room: roomDetail(room) });
      socket.emit('room_update', roomDetail(room));
      io.to('lobby').emit('room_list', lobbyList());
    });

    socket.on('join_room', ({ roomId }, cb) => {
      const room = rooms.get(roomId);
      if (!room) return cb?.({ error: '房间不存在' });
      if (room.status !== 'waiting') return cb?.({ error: '游戏已开始' });
      if (room.members.length >= room.maxPlayers) return cb?.({ error: '房间已满' });
      if (findUserRoom(user.id)) return cb?.({ error: '你已在一个房间中' });

      room.members.push({
        userId: user.id, nickname: user.nickname, isAi: false, connected: true, socketId: socket.id,
      });
      socket.join(`room:${room.id}`);
      cb?.({ room: roomDetail(room) });
      io.to(`room:${room.id}`).emit('room_update', roomDetail(room));
      io.to('lobby').emit('room_list', lobbyList());
    });

    socket.on('leave_room', (_payload, cb) => {
      const room = findUserRoom(user.id);
      if (!room) return cb?.({ ok: true });
      if (room.status === 'playing') return cb?.({ error: '游戏进行中无法离开（可直接关闭页面，AI 不会接管）' });
      removeMember(io, room, user.id);
      socket.leave(`room:${room.id}`);
      cb?.({ ok: true });
    });

    socket.on('add_ai', ({ name, difficulty, llm: llmCfg }, cb) => {
      const room = findUserRoom(user.id);
      if (!room) return cb?.({ error: '不在房间中' });
      if (room.hostUserId !== user.id) return cb?.({ error: '只有房主可以添加 AI' });
      if (room.status !== 'waiting') return cb?.({ error: '游戏已开始' });
      if (room.members.length >= room.maxPlayers) return cb?.({ error: '房间已满' });

      const aiId = `ai-${aiSeq++}`;
      const nickname = String(name || '').trim().slice(0, 16) || `AI·${['阿茹', '波特', '塞维亚', '里斯本', '陶瓷师'][Math.floor(Math.random() * 5)]}${aiSeq}`;
      const level = ['easy', 'medium', 'hard', 'llm'].includes(difficulty) ? difficulty : 'medium';
      const member = { userId: null, aiId, nickname, isAi: true, difficulty: level };
      if (level === 'llm') {
        if (!llmCfg || !String(llmCfg.apiKey || '').trim()) {
          return cb?.({ error: '大模型 AI 需要填写 API Key' });
        }
        // API Key 只留在服务端内存，不入库、不下发
        member.llm = {
          baseUrl: String(llmCfg.baseUrl || 'https://api.deepseek.com/v1').trim(),
          model: String(llmCfg.model || 'deepseek-chat').trim(),
          apiKey: String(llmCfg.apiKey).trim(),
        };
      }
      room.members.push(member);
      cb?.({ ok: true });
      io.to(`room:${room.id}`).emit('room_update', roomDetail(room));
      io.to('lobby').emit('room_list', lobbyList());
    });

    socket.on('remove_ai', ({ aiId }, cb) => {
      const room = findUserRoom(user.id);
      if (!room) return cb?.({ error: '不在房间中' });
      if (room.hostUserId !== user.id) return cb?.({ error: '只有房主可以移除 AI' });
      if (room.status !== 'waiting') return cb?.({ error: '游戏已开始' });
      const idx = room.members.findIndex((m) => m.isAi && m.aiId === aiId);
      if (idx >= 0) room.members.splice(idx, 1);
      cb?.({ ok: true });
      io.to(`room:${room.id}`).emit('room_update', roomDetail(room));
      io.to('lobby').emit('room_list', lobbyList());
    });

    socket.on('start_game', (_payload, cb) => {
      const room = findUserRoom(user.id);
      if (!room) return cb?.({ error: '不在房间中' });
      if (room.hostUserId !== user.id) return cb?.({ error: '只有房主可以开始游戏' });
      if (room.status !== 'waiting') return cb?.({ error: '游戏已开始' });
      if (room.members.length < 2) return cb?.({ error: '至少需要 2 名玩家（可添加 AI）' });

      room.status = 'playing';
      room.state = rules.createGame(
        room.members.map((m) => ({
          nickname: m.nickname, isAi: m.isAi, userId: m.userId, difficulty: m.difficulty,
        }))
      );
      db.prepare('UPDATE games SET status = ? WHERE id = ?').run('playing', room.id);
      const insertPlayer = db.prepare(
        'INSERT INTO game_players (game_id, user_id, nickname, is_ai, seat_index, score) VALUES (?, ?, ?, ?, ?, 0)'
      );
      room.members.forEach((m, i) =>
        insertPlayer.run(room.id, m.userId, m.nickname, m.isAi ? 1 : 0, i)
      );
      saveState(room);

      cb?.({ ok: true });
      io.to(`room:${room.id}`).emit('game_start', { roomId: room.id });
      io.to(`room:${room.id}`).emit('game_state', publicState(room));
      io.to('lobby').emit('room_list', lobbyList());
      scheduleAi(io, room);
    });

    socket.on('player_action', (action, cb) => {
      const room = findUserRoom(user.id);
      if (!room || room.status !== 'playing') return cb?.({ error: '没有进行中的游戏' });
      const seat = room.members.findIndex((m) => !m.isAi && m.userId === user.id);
      const err = rules.validateAction(room.state, seat, action);
      if (err) return cb?.({ error: err });

      const result = rules.applyAction(room.state, seat, action);
      afterAction(io, room, result);
      cb?.({ ok: true });
    });

    socket.on('back_to_lobby', (_payload, cb) => {
      // 游戏结束后离开房间（含已结束的房间）
      for (const room of rooms.values()) {
        if (room.status === 'finished' && room.members.some((m) => !m.isAi && m.userId === user.id)) {
          removeMember(io, room, user.id);
          socket.leave(`room:${room.id}`);
        }
      }
      socket.emit('room_list', lobbyList());
      cb?.({ ok: true });
    });

    socket.on('disconnect', () => {
      for (const room of rooms.values()) {
        const m = room.members.find((x) => !x.isAi && x.userId === user.id);
        if (!m) continue;
        // 同一用户可能已用新连接（如页面刷新）接管，旧连接的断开不应影响房间
        if (m.socketId && m.socketId !== socket.id) continue;
        if (room.status === 'waiting') {
          removeMember(io, room, user.id);
        } else {
          m.connected = false;
          io.to(`room:${room.id}`).emit('room_update', roomDetail(room));
        }
      }
    });
  });
}

function findUserRoom(userId) {
  for (const room of rooms.values()) {
    if (room.status === 'finished') continue;
    if (room.members.some((m) => !m.isAi && m.userId === userId)) return room;
  }
  return null;
}

function removeMember(io, room, userId) {
  const idx = room.members.findIndex((m) => !m.isAi && m.userId === userId);
  if (idx >= 0) room.members.splice(idx, 1);
  const humans = room.members.filter((m) => !m.isAi);
  if (humans.length === 0) {
    // 没有真人了，解散房间
    if (room.aiTimer) clearTimeout(room.aiTimer);
    rooms.delete(room.id);
    db.prepare('UPDATE games SET status = ? WHERE id = ?').run('finished', room.id);
  } else if (room.hostUserId === userId) {
    room.hostUserId = humans[0].userId; // 移交房主
  }
  if (rooms.has(room.id)) io.to(`room:${room.id}`).emit('room_update', roomDetail(room));
  io.to('lobby').emit('room_list', lobbyList());
}

// 发送给前端的状态（隐藏袋中顺序，防止前端预测抽牌）
function publicState(room) {
  const s = room.state;
  return {
    ...s,
    bag: undefined,
    discard: undefined,
    bagCount: s.bag.length,
    discardCount: s.discard.length,
  };
}

function afterAction(io, room, result) {
  saveState(room);
  io.to(`room:${room.id}`).emit('game_state', publicState(room));

  if (result.gameOver) {
    room.status = 'finished';
    db.prepare('UPDATE games SET status = ? WHERE id = ?').run('finished', room.id);
    const upd = db.prepare(
      'UPDATE game_players SET score = ? WHERE game_id = ? AND seat_index = ?'
    );
    room.state.players.forEach((p, i) => upd.run(p.score, room.id, i));
    saveState(room);
    io.to(`room:${room.id}`).emit('game_over', { ranking: room.state.winnerRanking });
    io.to('lobby').emit('room_list', lobbyList());
    return;
  }
  scheduleAi(io, room);
}

// 若当前玩家是 AI，延迟后自动行动（大模型 AI 走异步 API 调用，失败回退困难启发式）
function scheduleAi(io, room) {
  if (room.status !== 'playing') return;
  const seat = room.state.currentPlayer;
  const member = room.members[seat];
  if (!member || !member.isAi) return;
  if (room.aiTimer) clearTimeout(room.aiTimer);

  const isLlm = member.difficulty === 'llm' && member.llm;
  room.aiTimer = setTimeout(async () => {
    room.aiTimer = null;
    if (room.status !== 'playing' || room.state.currentPlayer !== seat) return;

    let action = null;
    let say = null;
    if (isLlm) {
      io.to(`room:${room.id}`).emit('ai_thinking', {
        seatIndex: seat, nickname: member.nickname, model: member.llm.model,
      });
      try {
        ({ action, say } = await llm.chooseAction(room.state, seat, member.llm));
      } catch (e) {
        console.error(`[LLM AI] ${member.nickname}(${member.llm.model}) 调用失败，回退启发式:`, e.message);
      }
      // API 等待期间局面可能已变（如房间解散）
      if (room.status !== 'playing' || room.state.currentPlayer !== seat) return;
      if (!action || rules.validateAction(room.state, seat, action)) {
        action = ai.chooseAction(room.state, seat, 'hard');
        say = null;
      }
    } else {
      action = ai.chooseAction(room.state, seat, member.difficulty || 'medium');
    }

    if (!action) return;
    const err = rules.validateAction(room.state, seat, action);
    if (err) return; // 不应发生；防御性
    const result = rules.applyAction(room.state, seat, action);
    io.to(`room:${room.id}`).emit('ai_action', {
      seatIndex: seat, nickname: member.nickname, action, say,
    });
    afterAction(io, room, result);
  }, isLlm ? 200 : ai.thinkDelay());
}

module.exports = { setup };
