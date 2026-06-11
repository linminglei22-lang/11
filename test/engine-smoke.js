// 规则引擎冒烟测试：让 4 个 AI 互相对战 N 局，校验不变量
const rules = require('../server/game/rules');
const ai = require('../server/game/ai');

const GAMES = 50;
let totalRounds = 0;

for (let g = 0; g < GAMES; g++) {
  const n = 2 + (g % 3); // 2/3/4 人轮换
  const state = rules.createGame(
    Array.from({ length: n }, (_, i) => ({ nickname: `AI${i}`, isAi: true }))
  );
  let turns = 0;
  while (state.phase === 'playing') {
    if (++turns > 2000) throw new Error('疑似死循环');
    const seat = state.currentPlayer;
    const action = ai.chooseAction(state, seat);
    if (!action) throw new Error('当前玩家无合法操作但游戏未结束');
    const err = rules.validateAction(state, seat, action);
    if (err) throw new Error(`AI 给出非法操作: ${err} ${JSON.stringify(action)}`);
    rules.applyAction(state, seat, action);

    // 不变量：瓷砖总数恒为 100（袋 + 弃堆 + 工厂 + 中央 + 玩家板上）
    let count = state.bag.length + state.discard.length + state.center.length;
    for (const f of state.factories) count += f.length;
    for (const p of state.players) {
      count += p.patternLines.reduce((s, l) => s + l.count, 0);
      count += p.floor.filter((t) => t !== 'first').length;
      for (const row of p.wall) for (const c of row) if (c) count++;
    }
    if (count !== 100) throw new Error(`瓷砖数量异常: ${count}（第 ${g} 局第 ${turns} 步）`);
  }
  // 终局校验
  if (!state.winnerRanking || state.winnerRanking.length !== n) throw new Error('排名缺失');
  const someRowFull = state.players.some((p) => p.wall.some((r) => r.every(Boolean)));
  if (!someRowFull) throw new Error('游戏结束但无人完成横排');
  for (const p of state.players) if (p.score < 0) throw new Error('出现负分');
  totalRounds += state.round;
}

console.log(`✔ ${GAMES} 局 AI 对战全部正常结束，平均 ${(totalRounds / GAMES).toFixed(1)} 轮/局`);

// 单点计分校验
const w = Array.from({ length: 5 }, () => Array(5).fill(false));
w[2][2] = true;
console.assert(rules.scorePlacement(w, 2, 2) === 1, '孤立瓷砖应得 1 分');
w[2][1] = true; w[2][3] = true;
console.assert(rules.scorePlacement(w, 2, 2) === 3, '横向 3 连应得 3 分');
w[1][2] = true;
console.assert(rules.scorePlacement(w, 2, 2) === 5, '横 3 + 竖 2 应得 5 分');
console.log('✔ 计分单元校验通过');
