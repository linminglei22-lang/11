// 计分系统定向测试：相邻加分（含下方相邻）、回合结算、积分累加、地板扣分
const {
  createGame, applyAction, validateAction, scorePlacement, wallColForColor,
} = require('../server/game/rules');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`✘ ${msg}`); process.exit(1); }
  passed++;
  console.log(`✔ ${msg}`);
}

/* ---------- scorePlacement 单元用例 ---------- */
const W = () => Array.from({ length: 5 }, () => Array(5).fill(false));

let w = W(); w[2][2] = true;
assert(scorePlacement(w, 2, 2) === 1, '孤立一块 = 1 分');

w = W(); w[2][1] = true; w[2][2] = true;
assert(scorePlacement(w, 2, 2) === 2, '左侧相邻一块 = 2 分');

w = W(); w[2][3] = true; w[2][2] = true;
assert(scorePlacement(w, 2, 2) === 2, '右侧相邻一块 = 2 分');

w = W(); w[1][2] = true; w[2][2] = true;
assert(scorePlacement(w, 2, 2) === 2, '上方相邻一块 = 2 分');

w = W(); w[3][2] = true; w[2][2] = true;
assert(scorePlacement(w, 2, 2) === 2, '下方相邻一块 = 2 分（用户质疑场景）');

w = W(); w[2][1] = true; w[2][3] = true; w[3][2] = true; w[2][2] = true;
assert(scorePlacement(w, 2, 2) === 5, '横 3 连 + 竖 2 连 = 5 分');

w = W(); w[0][2] = true; w[1][2] = true; w[3][2] = true; w[4][2] = true; w[2][2] = true;
assert(scorePlacement(w, 2, 2) === 5, '补满整列中间一块 = 竖 5 分');

/* ---------- 通过 applyAction 走真实回合结算 ---------- */
function emptyBoard(state) {
  state.factories = state.factories.map(() => []);
  state.center = [];
  state.centerHasFirst = false;
}

const s = createGame([{ nickname: 'A' }, { nickname: 'B' }]);
const seat = s.currentPlayer;
const me = s.players[seat];

// 第 1 轮：拿 1 块蓝放入第 1 行（容量 1）→ 回合结束 → 上墙得 1 分
emptyBoard(s);
s.factories[0] = ['blue'];
let err = validateAction(s, seat, { source: 0, color: 'blue', targetLine: 0 });
assert(err === null, '动作合法性校验通过');
let r1 = applyAction(s, seat, { source: 0, color: 'blue', targetLine: 0 });
assert(r1.roundEnded === true, '工厂与中央清空触发回合结算');
assert(me.wall[0][wallColForColor(0, 'blue')] === true, '蓝砖贴上墙壁第 1 行');
assert(me.score === 1, `第 1 轮孤立上墙得 1 分（实际 ${me.score}）`);

// 第 2 轮：拿 1 块黄放第 1 行 → 黄在蓝右侧相邻 → +2 分，总分累加为 3
assert(s.round === 2 && s.currentPlayer === seat, '进入第 2 轮且先手未变');
emptyBoard(s);
s.factories[0] = ['yellow'];
applyAction(s, seat, { source: 0, color: 'yellow', targetLine: 0 });
assert(me.score === 3, `第 2 轮相邻上墙 +2，总分累加 1+2=3（实际 ${me.score}）`);

// 第 3 轮：同回合完成第 2、3 行（同列垂直相邻）→ 官方顺序：上行先算（+1），下行后算（+2），共 +3
emptyBoard(s);
me.patternLines[1] = { color: 'black', count: 2 };   // 第 2 行已满（黑 → 列 (3+1)%5=4）
me.patternLines[2] = { color: 'red', count: 2 };      // 第 3 行差 1 块（红 → 列 (2+2)%5=4，同列！）
s.factories[0] = ['red'];
applyAction(s, seat, { source: 0, color: 'red', targetLine: 2 });
assert(me.wall[1][4] && me.wall[2][4], '第 2、3 行同回合上墙且同列');
assert(me.score === 6, `同回合垂直相邻：上行+1、下行+2，总分 3+3=6（实际 ${me.score}）`);

// 第 4 轮：地板扣分 + 上墙同时发生
emptyBoard(s);
me.patternLines[0] = { color: null, count: 0 };
s.factories[0] = ['white', 'white', 'white'];
applyAction(s, seat, { source: 0, color: 'white', targetLine: 0 }); // 1 块入行，2 块溢出地板(-1-1)
// 白落 (0,4)；第 3 轮已贴 (1,4)(2,4) → 垂直 3 连 +3；地板 2 块 -2
assert(me.score === 7, `上墙竖3连+3 与地板-2 同回合结算：6+3-2=7（实际 ${me.score}）`);

// 分数不会扣成负数
const s2 = createGame([{ nickname: 'A' }, { nickname: 'B' }]);
const seat2 = s2.currentPlayer;
const me2 = s2.players[seat2];
emptyBoard(s2);
s2.factories[0] = ['red', 'red', 'red', 'red'];
applyAction(s2, seat2, { source: 0, color: 'red', targetLine: -1 }); // 4 块全扔地板 -1-1-2-2=-6
assert(me2.score === 0, `0 分时扣分不会变负（实际 ${me2.score}）`);

// scoreEvents 的 points 与实际得分严格一致（前端演出依赖它）
const s3 = createGame([{ nickname: 'A' }, { nickname: 'B' }]);
const seat3 = s3.currentPlayer;
const me3 = s3.players[seat3];
emptyBoard(s3);
me3.patternLines[1] = { color: 'blue', count: 1 };
s3.factories[0] = ['blue'];
applyAction(s3, seat3, { source: 0, color: 'blue', targetLine: 1 });
const evs = s3.scoreEvents.find((e) => e.seatIndex === seat3).events;
const sum = evs.reduce((t, e) => t + e.points, 0);
assert(me3.score === sum, `scoreEvents 总和 = 实际得分（${sum} = ${me3.score}）`);

console.log(`\n全部 ${passed} 项计分用例通过 ✅`);
