// Azul 核心规则引擎 —— 纯函数式状态机，后端全权管理
// 状态完全由 JSON 描述，前端只发送操作意图。

const COLORS = ['blue', 'yellow', 'red', 'black', 'white'];
const FLOOR_PENALTIES = [-1, -1, -2, -2, -2, -3, -3];
const FLOOR_CAPACITY = 7;

// 标准 Azul 墙壁配色：第 r 行第 c 列的颜色（每行右移一格）
function wallColorAt(row, col) {
  return COLORS[(col - row + 5) % 5];
}

// 该颜色在第 row 行墙壁上的列号
function wallColForColor(row, color) {
  return (COLORS.indexOf(color) + row) % 5;
}

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newBag() {
  const bag = [];
  for (const c of COLORS) for (let i = 0; i < 20; i++) bag.push(c);
  return shuffle(bag);
}

function newPlayerBoard(meta) {
  return {
    nickname: meta.nickname,
    isAi: !!meta.isAi,
    userId: meta.userId ?? null,
    difficulty: meta.isAi ? (meta.difficulty || 'medium') : null,
    score: 0,
    // patternLines[r] = { color: 'red'|null, count: n }，容量 r+1
    patternLines: Array.from({ length: 5 }, () => ({ color: null, count: 0 })),
    // wall[r][c] = true 表示已贴瓷砖（颜色由 wallColorAt 决定）
    wall: Array.from({ length: 5 }, () => Array(5).fill(false)),
    floor: [], // 元素为颜色字符串或 'first'（1 号玩家标记）
  };
}

/**
 * 创建新游戏状态。players: [{nickname, isAi, userId}]
 */
function createGame(players) {
  const n = players.length;
  if (n < 2 || n > 4) throw new Error('玩家数必须为 2-4');
  const state = {
    phase: 'playing', // playing | finished
    seq: 0, // 动作序号，前端据此判断是否播放增量动画
    round: 1,
    players: players.map(newPlayerBoard),
    factories: Array.from({ length: n * 2 + 1 }, () => []),
    center: [],
    centerHasFirst: true, // 1 号玩家标记是否在中央
    bag: newBag(),
    discard: [], // 盒盖（弃牌堆）
    currentPlayer: Math.floor(Math.random() * n),
    nextFirstPlayer: null, // 本轮第一个从中央拿瓷砖的玩家
    lastAction: null, // 供前端做动画/提示
    scoreEvents: [], // 上次结算的得分明细
    winnerRanking: null,
  };
  fillFactories(state);
  return state;
}

// 每轮 Step 1：工厂供货
function fillFactories(state) {
  for (const f of state.factories) {
    while (f.length < 4) {
      if (state.bag.length === 0) {
        if (state.discard.length === 0) break; // 袋与弃堆都空：按官方规则就此开局
        state.bag = shuffle(state.discard);
        state.discard = [];
      }
      f.push(state.bag.pop());
    }
  }
}

/**
 * 校验操作合法性。action: { source: -1(中央) 或工厂序号, color, targetLine: 0-4 或 -1(直接进地板) }
 * 返回 null 表示合法，否则返回错误信息字符串。
 */
function validateAction(state, seatIndex, action) {
  if (state.phase !== 'playing') return '游戏已结束';
  if (seatIndex !== state.currentPlayer) return '还没轮到你';
  if (!action || typeof action !== 'object') return '无效操作';
  const { source, color, targetLine } = action;
  if (!COLORS.includes(color)) return '无效颜色';
  if (!Number.isInteger(source) || source < -1 || source >= state.factories.length) return '无效来源';
  if (!Number.isInteger(targetLine) || targetLine < -1 || targetLine > 4) return '无效目标行';

  const pool = source === -1 ? state.center : state.factories[source];
  if (!pool.some((t) => t === color)) return '该处没有这种颜色的瓷砖';

  if (targetLine >= 0) {
    const p = state.players[seatIndex];
    const line = p.patternLines[targetLine];
    const cap = targetLine + 1;
    if (line.count >= cap) return '该图案行已满';
    if (line.color && line.color !== color) return '该图案行已有其他颜色';
    const wallCol = wallColForColor(targetLine, color);
    if (p.wall[targetLine][wallCol]) return '墙壁该行已有这种颜色';
  }
  return null;
}

/**
 * 执行一次拿瓷砖操作（必须先通过 validateAction）。
 * 返回 { roundEnded, gameOver }
 */
function applyAction(state, seatIndex, action) {
  const { source, color, targetLine } = action;
  const p = state.players[seatIndex];

  let taken;
  if (source === -1) {
    taken = state.center.filter((t) => t === color);
    state.center = state.center.filter((t) => t !== color);
    if (state.centerHasFirst) {
      state.centerHasFirst = false;
      state.nextFirstPlayer = seatIndex;
      pushFloor(state, p, 'first');
    }
  } else {
    const f = state.factories[source];
    taken = f.filter((t) => t === color);
    // 其余瓷砖推入中央
    for (const t of f) if (t !== color) state.center.push(t);
    state.factories[source] = [];
  }

  let count = taken.length;
  if (targetLine >= 0) {
    const line = p.patternLines[targetLine];
    const cap = targetLine + 1;
    line.color = color;
    const fit = Math.min(cap - line.count, count);
    line.count += fit;
    count -= fit;
  }
  // 多余的（或玩家主动选择 -1）落入地板行
  for (let i = 0; i < count; i++) pushFloor(state, p, color);

  state.lastAction = { seatIndex, source, color, targetLine, taken: taken.length };
  state.seq = (state.seq || 0) + 1;

  const roundEnded =
    state.center.length === 0 && state.factories.every((f) => f.length === 0);

  let gameOver = false;
  let preScore = null;
  if (roundEnded) {
    // 结算前快照：供前端先渲染"拿完最后一手"的局面，再逐步播放结算动画
    preScore = structuredClone(state);
    gameOver = endOfRound(state);
  } else {
    state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
  }
  return { roundEnded, gameOver, preScore };
}

function pushFloor(state, player, tile) {
  if (player.floor.length < FLOOR_CAPACITY) {
    player.floor.push(tile);
  } else if (tile !== 'first') {
    state.discard.push(tile); // 地板满，多余瓷砖进盒盖
  }
  // 1 号标记即使地板满也已生效（nextFirstPlayer 已记录）
}

// 每轮 Step 3：墙壁拼贴 + 计分；返回是否游戏结束
function endOfRound(state) {
  state.scoreEvents = [];
  for (let s = 0; s < state.players.length; s++) {
    const p = state.players[s];
    const events = [];
    // 图案行结算（从第 1 行到第 5 行）
    for (let r = 0; r < 5; r++) {
      const line = p.patternLines[r];
      if (line.count === r + 1 && line.color) {
        const c = wallColForColor(r, line.color);
        p.wall[r][c] = true;
        const pts = scorePlacement(p.wall, r, c);
        p.score += pts;
        events.push({ type: 'wall', row: r, col: c, color: line.color, points: pts });
        // 1 块上墙，其余 r 块进盒盖
        for (let i = 0; i < r; i++) state.discard.push(line.color);
        line.color = null;
        line.count = 0;
      }
    }
    // 地板行扣分
    if (p.floor.length > 0) {
      let penalty = 0;
      for (let i = 0; i < p.floor.length; i++) penalty += FLOOR_PENALTIES[i] || 0;
      const applied = Math.max(penalty, -p.score); // 分数不低于 0
      p.score += applied;
      events.push({ type: 'floor', tiles: p.floor.length, points: applied });
      for (const t of p.floor) if (t !== 'first') state.discard.push(t);
      p.floor = [];
    }
    state.scoreEvents.push({ seatIndex: s, events });
  }

  // 结束条件：任一玩家完成完整横排
  const someoneFinishedRow = state.players.some((p) =>
    p.wall.some((row) => row.every(Boolean))
  );

  if (someoneFinishedRow) {
    finalScoring(state);
    return true;
  }

  // Step 4：新一轮
  state.round += 1;
  state.currentPlayer =
    state.nextFirstPlayer != null ? state.nextFirstPlayer : state.currentPlayer;
  state.nextFirstPlayer = null;
  state.centerHasFirst = true;
  fillFactories(state);
  return false;
}

// 在 (row, col) 放置瓷砖的即时得分：水平连线 + 垂直连线
function scorePlacement(wall, row, col) {
  let h = 1;
  for (let c = col - 1; c >= 0 && wall[row][c]; c--) h++;
  for (let c = col + 1; c < 5 && wall[row][c]; c++) h++;
  let v = 1;
  for (let r = row - 1; r >= 0 && wall[r][col]; r--) v++;
  for (let r = row + 1; r < 5 && wall[r][col]; r++) v++;
  if (h === 1 && v === 1) return 1;
  return (h > 1 ? h : 0) + (v > 1 ? v : 0);
}

// 终局计分：横排 +2、纵列 +7、同色 5 块 +10
function finalScoring(state) {
  for (let s = 0; s < state.players.length; s++) {
    const p = state.players[s];
    const bonus = { rows: 0, cols: 0, colors: 0 };
    for (let r = 0; r < 5; r++) if (p.wall[r].every(Boolean)) bonus.rows++;
    for (let c = 0; c < 5; c++) {
      let full = true;
      for (let r = 0; r < 5; r++) if (!p.wall[r][c]) full = false;
      if (full) bonus.cols++;
    }
    for (const color of COLORS) {
      let cnt = 0;
      for (let r = 0; r < 5; r++) if (p.wall[r][wallColForColor(r, color)]) cnt++;
      if (cnt === 5) bonus.colors++;
    }
    const pts = bonus.rows * 2 + bonus.cols * 7 + bonus.colors * 10;
    p.score += pts;
    p.finalBonus = { ...bonus, points: pts };
  }
  state.phase = 'finished';
  // 排名：分数降序，平分时完成横排多者胜（官方规则）
  state.winnerRanking = state.players
    .map((p, i) => ({
      seatIndex: i,
      nickname: p.nickname,
      isAi: p.isAi,
      score: p.score,
      rows: p.wall.filter((row) => row.every(Boolean)).length,
    }))
    .sort((a, b) => b.score - a.score || b.rows - a.rows)
    .map((e, idx) => ({ ...e, rank: idx + 1 }));
}

/**
 * 枚举某玩家当前所有合法操作（供 AI 使用）
 */
function legalActions(state, seatIndex) {
  const actions = [];
  const sources = [];
  state.factories.forEach((f, i) => {
    if (f.length > 0) sources.push({ idx: i, tiles: f });
  });
  if (state.center.length > 0) sources.push({ idx: -1, tiles: state.center });

  for (const src of sources) {
    const colors = [...new Set(src.tiles)];
    for (const color of colors) {
      for (let line = -1; line < 5; line++) {
        const a = { source: src.idx, color, targetLine: line };
        if (!validateAction(state, seatIndex, a)) actions.push(a);
      }
    }
  }
  return actions;
}

module.exports = {
  COLORS,
  FLOOR_PENALTIES,
  wallColorAt,
  wallColForColor,
  createGame,
  validateAction,
  applyAction,
  legalActions,
  scorePlacement,
};
