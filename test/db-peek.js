// 快速查看数据库中进行中的对局
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'azul.db'));
const playing = db.prepare("SELECT id, room_name, status FROM games WHERE status = 'playing'").all();
console.log('playing games:', JSON.stringify(playing));
for (const g of playing) {
  const st = db.prepare('SELECT length(state_json) AS len FROM game_state WHERE game_id = ?').get(g.id);
  const ps = db.prepare('SELECT nickname, is_ai, seat_index FROM game_players WHERE game_id = ? ORDER BY seat_index').all(g.id);
  console.log(`#${g.id} state=${st ? st.len + 'B' : 'NONE'} players=${JSON.stringify(ps)}`);
}
