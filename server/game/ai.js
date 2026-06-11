// AI 玩家决策 —— 支持三档难度
//   easy   简单：只看眼前能放多少块，带较大随机性，常犯小错
//   medium 中等：启发式评分（填满行 > 上墙得分 > 避免扣分 > 抢先手）
//   hard   困难：中等评分 + 一层前瞻（压制下家的最佳回应）
const {
  legalActions, validateAction, applyAction,
  wallColForColor, scorePlacement, FLOOR_PENALTIES,
} = require('./rules');

function chooseAction(state, seatIndex, difficulty = 'medium') {
  const actions = legalActions(state, seatIndex);
  if (actions.length === 0) return null;

  if (difficulty === 'easy') return chooseEasy(state, seatIndex, actions);
  if (difficulty === 'hard') return chooseHard(state, seatIndex, actions);
  return pickBest(actions, (a) => evaluate(state, seatIndex, a));
}

/* ---------- 简单 ---------- */
function chooseEasy(state, seatIndex, actions) {
  // 25% 概率完全随机（但不主动全扔地板）
  if (Math.random() < 0.25) {
    const nonFloor = actions.filter((a) => a.targetLine >= 0);
    const pool = nonFloor.length ? nonFloor : actions;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  // 其余时间：只数"放进图案行几块、溢出几块"，不考虑上墙得分与先手
  return pickBest(actions, (a) => {
    const pool = a.source === -1 ? state.center : state.factories[a.source];
    const taken = pool.filter((t) => t === a.color).length;
    if (a.targetLine < 0) return -taken;
    const p = state.players[seatIndex];
    const line = p.patternLines[a.targetLine];
    const fit = Math.min(a.targetLine + 1 - line.count, taken);
    return fit - (taken - fit) + Math.random() * 1.5; // 噪声让它不稳定
  });
}

/* ---------- 困难 ---------- */
function chooseHard(state, seatIndex, actions) {
  // 先用中等评分取前 8 个候选，再做一层前瞻：扣减下家最佳回应的价值
  const scored = actions
    .map((a) => ({ a, v: evaluate(state, seatIndex, a) }))
    .sort((x, y) => y.v - x.v)
    .slice(0, 8);

  let best = scored[0].a;
  let bestTotal = -Infinity;
  for (const { a, v } of scored) {
    let total = v;
    try {
      const sim = structuredClone(state);
      const r = applyAction(sim, seatIndex, a);
      if (!r.gameOver && sim.phase === 'playing' && !r.roundEnded) {
        const opp = sim.currentPlayer;
        if (opp !== seatIndex) {
          const oppActions = legalActions(sim, opp);
          let oppBest = 0;
          for (const oa of oppActions) {
            const ov = evaluate(sim, opp, oa);
            if (ov > oppBest) oppBest = ov;
          }
          total -= oppBest * 0.45; // 压制对手：留给下家的好牌越少越好
        }
      } else if (r.gameOver) {
        // 终局：直接看排名
        const me = sim.players[seatIndex];
        const maxOther = Math.max(...sim.players.filter((_, i) => i !== seatIndex).map((p) => p.score));
        total += me.score > maxOther ? 50 : -20;
      }
    } catch { /* 模拟失败则退回中等评分 */ }
    if (total > bestTotal) { bestTotal = total; best = a; }
  }
  return best;
}

/* ---------- 共用工具 ---------- */
function pickBest(actions, evalFn) {
  let best = [];
  let bestScore = -Infinity;
  for (const a of actions) {
    const v = evalFn(a);
    if (v > bestScore + 1e-9) { bestScore = v; best = [a]; }
    else if (Math.abs(v - bestScore) < 1e-9) best.push(a);
  }
  return best[Math.floor(Math.random() * best.length)];
}

/* ---------- 中等评分（hard 也复用） ---------- */
function evaluate(state, seatIndex, action) {
  const p = state.players[seatIndex];
  const pool = action.source === -1 ? state.center : state.factories[action.source];
  const taken = pool.filter((t) => t === action.color).length;

  let score = 0;
  let overflow = taken;

  if (action.targetLine >= 0) {
    const r = action.targetLine;
    const line = p.patternLines[r];
    const cap = r + 1;
    const fit = Math.min(cap - line.count, taken);
    overflow = taken - fit;
    const newCount = line.count + fit;

    if (newCount === cap) {
      // 优先级 1：能填满 → 估算上墙得分（高权重）
      const col = wallColForColor(r, action.color);
      const wallCopy = p.wall.map((row) => row.slice());
      wallCopy[r][col] = true;
      const placePts = scorePlacement(wallCopy, r, col);
      score += 20 + placePts * 3;
      score += progressBonus(wallCopy, r, col);
    } else {
      // 优先级 2：推进进度，行越短越容易完成
      score += fit * (3 - r * 0.4) + newCount / cap;
      if (cap - newCount > 3) score -= 1;
    }
  }

  // 优先级 3：地板扣分（按实际边际罚分估算）
  if (overflow > 0) {
    const start = p.floor.length;
    for (let i = 0; i < overflow; i++) {
      score += (FLOOR_PENALTIES[start + i] || 0) * 1.2;
    }
  }

  // 优先级 4：从中央拿且 1 号标记还在 → 抢先手
  if (action.source === -1 && state.centerHasFirst) {
    score += 1.5 + (FLOOR_PENALTIES[p.floor.length] || 0);
  }

  // 轻微偏好清空同色多的堆（剥夺对手机会）
  score += Math.min(taken, 4) * 0.1;

  return score;
}

function progressBonus(wall, row, col) {
  let bonus = 0;
  const rowFilled = wall[row].filter(Boolean).length;
  if (rowFilled >= 4) bonus += 2;
  let colFilled = 0;
  for (let r = 0; r < 5; r++) if (wall[r][col]) colFilled++;
  if (colFilled >= 4) bonus += 3;
  return bonus;
}

// AI 思考延迟 0.5 - 1.5 秒
function thinkDelay() {
  return 500 + Math.random() * 1000;
}

module.exports = { chooseAction, thinkDelay };
