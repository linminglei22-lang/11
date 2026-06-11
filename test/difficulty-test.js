// AI 难度对抗测试：每组打 N 局 1v1，统计胜率
const rules = require('../server/game/rules');
const ai = require('../server/game/ai');

function playMatch(diffA, diffB) {
  const state = rules.createGame([
    { nickname: 'A', isAi: true, difficulty: diffA },
    { nickname: 'B', isAi: true, difficulty: diffB },
  ]);
  const diffs = [diffA, diffB];
  let turns = 0;
  while (state.phase === 'playing') {
    if (++turns > 2000) throw new Error('死循环');
    const seat = state.currentPlayer;
    const action = ai.chooseAction(state, seat, diffs[seat]);
    const err = rules.validateAction(state, seat, action);
    if (err) throw new Error(`非法操作(${diffs[seat]}): ${err}`);
    rules.applyAction(state, seat, action);
  }
  return state.winnerRanking[0].seatIndex; // 0 = A 胜
}

const N = 30;
for (const [a, b] of [['hard', 'easy'], ['hard', 'medium'], ['medium', 'easy']]) {
  let winsA = 0;
  for (let i = 0; i < N; i++) if (playMatch(a, b) === 0) winsA++;
  console.log(`${a} vs ${b}: ${winsA}/${N} 胜（${Math.round((winsA / N) * 100)}%）`);
}
