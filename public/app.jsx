/* 花砖物语 Azul - 前端 SPA（React 18，免构建，Babel 浏览器内编译） */
const { useState, useEffect, useRef, useCallback } = React;

const COLORS = ['blue', 'yellow', 'red', 'black', 'white'];
const COLOR_NAMES = { blue: '蓝', yellow: '黄', red: '红', black: '黑', white: '白' };
const FLOOR_PENALTY_LABELS = ['-1', '-1', '-2', '-2', '-2', '-3', '-3'];
const DIFF_NAMES = { easy: '简单', medium: '中等', hard: '困难', llm: '大模型' };

/* ============ 音效引擎（WebAudio 合成，无需音频文件） ============ */
const Sound = (() => {
  let ctx = null;
  let muted = localStorage.getItem('azul_muted') === '1';
  const ensure = () => {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  // 浏览器要求首次用户手势后才能出声
  document.addEventListener('pointerdown', ensure);

  function tone(freq, dur, type = 'sine', vol = 0.15, when = 0) {
    if (muted) return;
    const c = ensure(); if (!c) return;
    const t0 = c.currentTime + when;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function clack(dur = 0.05, vol = 0.22, when = 0, freq = 2400) {
    if (muted) return;
    const c = ensure(); if (!c) return;
    const t0 = c.currentTime + when;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource(); src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.4;
    const g = c.createGain(); g.gain.value = vol;
    src.connect(bp).connect(g).connect(c.destination);
    src.start(t0);
  }
  return {
    pick() { tone(1250, 0.06, 'triangle', 0.1); },                              // 选中瓷砖
    take() { clack(0.04, 0.12, 0, 3000); tone(740, 0.07, 'triangle', 0.08); },  // 拿起
    place() { clack(0.05, 0.26, 0, 2100); tone(185, 0.1, 'sine', 0.2, 0.004); },// 落子（陶瓷脆响+闷击）
    score() { tone(880, 0.12, 'sine', 0.12); tone(1318.5, 0.2, 'sine', 0.12, 0.1); },
    over() { [523.3, 659.3, 784, 1046.5].forEach((f, i) => tone(f, 0.28, 'sine', 0.13, i * 0.14)); },
    toggle() { muted = !muted; localStorage.setItem('azul_muted', muted ? '1' : '0'); return muted; },
    isMuted: () => muted,
  };
})();

/* ============ 瓷砖飞行动画（拿取 → 放置 轨迹） ============ */
function flyTiles(fromEl, toEl, color, count, onDone) {
  const f = fromEl.getBoundingClientRect();
  const t = toEl.getBoundingClientRect();
  const n = Math.min(count, 6);
  const sx = f.left + f.width / 2 - 17;
  const sy = f.top + f.height / 2 - 17;
  const tx = t.left + Math.min(t.width / 2, 40) - 17;
  const ty = t.top + t.height / 2 - 17;
  const dx = tx - sx, dy = ty - sy;
  let finished = 0;
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = `tile fly-tile ${color}`;
    el.style.left = sx + 'px';
    el.style.top = sy + 'px';
    document.body.appendChild(el);
    // 弧线轨迹：中点向上抬起，带一点旋转
    const midX = dx * 0.5 - dy * 0.12;
    const midY = dy * 0.5 - Math.max(70, Math.abs(dx) * 0.22);
    const anim = el.animate([
      { transform: 'translate(0,0) scale(1) rotate(0deg)' },
      { transform: `translate(${midX}px, ${midY}px) scale(1.25) rotate(12deg)`, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(1) rotate(0deg)` },
    ], { duration: 520, delay: i * 70, easing: 'cubic-bezier(.32,.72,.38,1)', fill: 'both' });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.remove();
      if (++finished === n && onDone) onDone();
    };
    anim.onfinish = finish;
    // 兜底：后台标签页等场景下动画事件可能不触发
    setTimeout(finish, 520 + i * 70 + 300);
  }
  if (n === 0 && onDone) onDone();
}

// 回合结算特效：墙壁新贴瓷砖弹跳 + 得分飘字（+N / -N）
function wallTilingFx(scoreEvents) {
  let delay = 0;
  for (const { seatIndex, events } of scoreEvents) {
    const board = document.querySelector(`.board[data-seat="${seatIndex}"]`);
    if (!board) continue;
    for (const ev of events) {
      let anchor = null;
      if (ev.type === 'wall') {
        const row = board.querySelectorAll('.wall-row')[ev.row];
        anchor = row && row.children[ev.col];
        if (anchor) {
          setTimeout(() => {
            anchor.classList.add('just-placed');
            Sound.place();
            setTimeout(() => anchor.classList.remove('just-placed'), 700);
          }, delay);
        }
      } else if (ev.type === 'floor') {
        anchor = board.querySelector('.floor-row');
      }
      if (anchor && ev.points !== 0) {
        const r = anchor.getBoundingClientRect();
        const pts = ev.points;
        setTimeout(() => {
          const label = document.createElement('div');
          label.className = `score-float ${pts > 0 ? 'gain' : 'loss'}`;
          label.textContent = pts > 0 ? `+${pts}` : `${pts}`;
          label.style.left = r.left + r.width / 2 + 'px';
          label.style.top = r.top - 6 + 'px';
          document.body.appendChild(label);
          setTimeout(() => label.remove(), 1400);
        }, delay);
        delay += 260;
      }
    }
  }
}

// 根据 lastAction 播放"来源 → 目标玩家板"的飞砖动画，结束后提交新状态
function runActionFx(action, commit) {
  const srcEl = action.source === -1
    ? document.querySelector('.center-area')
    : document.querySelectorAll('.factories-area .factory')[action.source];
  const board = document.querySelector(`.board[data-seat="${action.seatIndex}"]`);
  let dstEl = null;
  if (board) {
    dstEl = action.targetLine >= 0
      ? board.querySelectorAll('.pline')[action.targetLine]
      : board.querySelector('.floor-row');
  }
  if (!dstEl) dstEl = document.querySelector(`.mini-tab[data-seat="${action.seatIndex}"]`);
  if (!srcEl || !dstEl) { commit(); return; }

  // 隐藏来源处即将被拿走的同色瓷砖，避免"分身"；提交时必须恢复
  // （React 会复用这些 DOM 节点，内联样式不恢复会导致后续瓷砖隐形）
  const hidden = [...srcEl.querySelectorAll(`.tile.${action.color}`)];
  hidden.forEach((t2) => { t2.style.visibility = 'hidden'; });
  Sound.take();
  let committed = false;
  const doCommit = () => {
    if (committed) return;
    committed = true;
    hidden.forEach((t2) => { t2.style.visibility = ''; });
    commit();
  };
  flyTiles(srcEl, dstEl, action.color, action.taken, () => { Sound.place(); doCommit(); });
  setTimeout(doCommit, 1500); // 兜底：动画异常也要提交状态
}

function wallColorAt(row, col) {
  return COLORS[(col - row + 5) % 5];
}
function wallColForColor(row, color) {
  return (COLORS.indexOf(color) + row) % 5;
}

/* ============ 通用小组件 ============ */
function Tile({ color, sm, onClick, selected, dimmed, className = '' }) {
  const cls = [
    'tile', color, sm ? 'sm' : '',
    onClick ? 'clickable' : '', selected ? 'selected' : '', dimmed ? 'dimmed' : '',
    className,
  ].join(' ');
  return (
    <span className={cls} onClick={onClick} title={color === 'first' ? '1 号玩家标记' : COLOR_NAMES[color]}>
      {color === 'first' ? '1' : ''}
    </span>
  );
}

function Toast({ msg }) {
  if (!msg) return null;
  return <div className="toast">{msg}</div>;
}

/* ============ 登录 / 注册 ============ */
function AuthPage({ onAuthed }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', nickname: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      onAuthed(data.token, data.user);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="logo-tiles">
          {COLORS.map((c) => <Tile key={c} color={c} sm />)}
        </div>
        <div className="logo">AZUL</div>
        <div className="logo-sub">花砖物语 · 在线对战</div>
        <form onSubmit={submit}>
          <input
            type="email" placeholder="邮箱" required value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          {mode === 'register' && (
            <input
              placeholder="昵称（最长 16 字）" required maxLength={16} value={form.nickname}
              onChange={(e) => setForm({ ...form, nickname: e.target.value })}
            />
          )}
          <input
            type="password" placeholder="密码（至少 6 位）" required value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          {err && <div style={{ color: '#b8432f', fontSize: 14 }}>{err}</div>}
          <button disabled={busy}>{mode === 'login' ? '登 录' : '注 册'}</button>
        </form>
        <div className="auth-switch">
          {mode === 'login' ? (
            <>还没有账号？<a onClick={() => { setMode('register'); setErr(''); }}>去注册</a></>
          ) : (
            <>已有账号？<a onClick={() => { setMode('login'); setErr(''); }}>去登录</a></>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============ 大厅 ============ */
function LobbyPage({ socket, roomList, toast }) {
  const [name, setName] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(2);

  const createRoom = () => {
    socket.emit('create_room', { name, maxPlayers: Number(maxPlayers) }, (res) => {
      if (res?.error) toast(res.error);
    });
  };
  const joinRoom = (id) => {
    socket.emit('join_room', { roomId: id }, (res) => {
      if (res?.error) toast(res.error);
    });
  };

  return (
    <div className="lobby-grid">
      <div className="card">
        <h3>房间列表</h3>
        {roomList.length === 0 ? (
          <div className="empty-hint">暂无房间，创建一个开始游戏吧 →</div>
        ) : (
          <table className="rooms">
            <thead>
              <tr><th>房间名</th><th>房主</th><th>人数</th><th>状态</th><th></th></tr>
            </thead>
            <tbody>
              {roomList.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.hostNickname}</td>
                  <td>{r.playerCount}/{r.maxPlayers}</td>
                  <td>
                    <span className={`status-pill ${r.status}`}>
                      {r.status === 'waiting' ? '等待中' : '游戏中'}
                    </span>
                  </td>
                  <td>
                    <button
                      className="small"
                      disabled={r.status !== 'waiting' || r.playerCount >= r.maxPlayers}
                      onClick={() => joinRoom(r.id)}
                    >加入</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h3>创建房间</h3>
        <div className="create-form">
          <input placeholder="房间名（可留空）" value={name} maxLength={30}
            onChange={(e) => setName(e.target.value)} />
          <select value={maxPlayers} onChange={(e) => setMaxPlayers(e.target.value)}>
            <option value={2}>2 人局（5 个工厂盘）</option>
            <option value={3}>3 人局（7 个工厂盘）</option>
            <option value={4}>4 人局（9 个工厂盘）</option>
          </select>
          <button onClick={createRoom}>创建房间</button>
        </div>
      </div>
    </div>
  );
}

/* ============ 房间等待页 ============ */
function RoomPage({ socket, room, user, toast }) {
  const [aiName, setAiName] = useState('');
  const [aiDiff, setAiDiff] = useState('medium');
  const [llmCfg, setLlmCfg] = useState({
    baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '',
  });
  const isHost = room.hostUserId === user.id;

  const addAi = () => {
    if (aiDiff === 'llm' && !llmCfg.apiKey.trim()) return toast('请填写 API Key');
    socket.emit('add_ai', {
      name: aiName, difficulty: aiDiff,
      llm: aiDiff === 'llm' ? llmCfg : undefined,
    }, (res) => {
      if (res?.error) toast(res.error);
      else setAiName('');
    });
  };

  return (
    <div className="card room-card">
      <h3>{room.name} <span style={{ fontWeight: 400, fontSize: 14, color: 'var(--ink-soft)' }}>
        （{room.members.length}/{room.maxPlayers} 人）</span></h3>
      {room.members.map((m, i) => (
        <div className="member-row" key={m.isAi ? m.aiId : m.userId}>
          <span className="seat">{i + 1}</span>
          <span style={{ flex: 1 }}>{m.nickname}</span>
          {m.isAi && (
            <span className="tag ai">
              AI · {m.difficulty === 'llm' ? `大模型(${m.llmModel || '?'})` : (DIFF_NAMES[m.difficulty] || '中等')}
            </span>
          )}
          {!m.isAi && m.userId === room.hostUserId && <span className="tag host">房主</span>}
          {!m.isAi && !m.connected && <span className="tag offline">离线</span>}
          {isHost && m.isAi && (
            <button className="small ghost" onClick={() =>
              socket.emit('remove_ai', { aiId: m.aiId }, (res) => res?.error && toast(res.error))
            }>移除</button>
          )}
        </div>
      ))}

      {isHost && room.members.length < room.maxPlayers && (
        <>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <input placeholder="AI 昵称（可留空随机）" value={aiName} maxLength={16}
              onChange={(e) => setAiName(e.target.value)} />
            <select style={{ width: 130, flex: 'none' }} value={aiDiff}
              onChange={(e) => setAiDiff(e.target.value)}>
              <option value="easy">简单</option>
              <option value="medium">中等</option>
              <option value="hard">困难</option>
              <option value="llm">大模型 API</option>
            </select>
            <button className="ghost" style={{ flex: 'none' }} onClick={addAi}>+ 添加 AI</button>
          </div>
          {aiDiff === 'llm' && (
            <div className="llm-config">
              <div className="llm-hint">
                接入 OpenAI 兼容接口（DeepSeek / Kimi / 通义等）。API Key 仅保存在服务端内存，不入库、不下发给其他玩家。模型响应失败时自动回退为"困难"启发式 AI。
              </div>
              <input placeholder="API 地址" value={llmCfg.baseUrl}
                onChange={(e) => setLlmCfg({ ...llmCfg, baseUrl: e.target.value })} />
              <input placeholder="模型名（如 deepseek-chat）" value={llmCfg.model}
                onChange={(e) => setLlmCfg({ ...llmCfg, model: e.target.value })} />
              <input type="password" placeholder="API Key（必填）" value={llmCfg.apiKey}
                onChange={(e) => setLlmCfg({ ...llmCfg, apiKey: e.target.value })} />
            </div>
          )}
        </>
      )}

      <div className="room-actions">
        {isHost && (
          <button disabled={room.members.length < 2} onClick={() =>
            socket.emit('start_game', {}, (res) => res?.error && toast(res.error))
          }>开始游戏</button>
        )}
        {!isHost && <span style={{ color: 'var(--ink-soft)', alignSelf: 'center' }}>等待房主开始游戏…</span>}
        <button className="ghost" onClick={() =>
          socket.emit('leave_room', {}, (res) => res?.error && toast(res.error))
        }>离开房间</button>
      </div>
    </div>
  );
}

/* ============ 游戏页 ============ */
function GamePage({ socket, game, room, user, toast }) {
  // 我的座位号（纯观战时为 -1）
  const mySeat = game.players.findIndex((p) => !p.isAi && p.userId === user.id);
  const isMyTurn = game.phase === 'playing' && game.currentPlayer === mySeat;

  const [sel, setSel] = useState(null); // { source, color }
  const [viewSeat, setViewSeat] = useState(mySeat >= 0 ? mySeat : 0);
  const [roundBanner, setRoundBanner] = useState(null);
  const prevRound = useRef(game.round);
  const [popSeats, setPopSeats] = useState({}); // 得分动画
  const prevScores = useRef(game.players.map((p) => p.score));

  // 轮次切换 → 横幅 + 得分动画
  useEffect(() => {
    if (game.round !== prevRound.current || game.phase === 'finished') {
      if (game.round !== prevRound.current) setRoundBanner(`第 ${game.round} 轮 · 拼贴计分完成`);
      if (game.scoreEvents && game.scoreEvents.length > 0) {
        // 等本帧渲染出新墙壁后再播放拼贴特效
        requestAnimationFrame(() => wallTilingFx(game.scoreEvents));
      }
      const pops = {};
      game.players.forEach((p, i) => {
        if (p.score !== prevScores.current[i]) pops[i] = Date.now();
      });
      setPopSeats(pops);
      if (Object.keys(pops).length > 0) Sound.score();
      const t = setTimeout(() => setRoundBanner(null), 2300);
      prevRound.current = game.round;
      prevScores.current = game.players.map((p) => p.score);
      return () => clearTimeout(t);
    }
    prevScores.current = game.players.map((p) => p.score);
  }, [game]);

  useEffect(() => { setSel(null); }, [game.currentPlayer, game.round]);

  const pickTile = (source, color) => {
    if (!isMyTurn) return;
    Sound.pick();
    if (sel && sel.source === source && sel.color === color) setSel(null);
    else setSel({ source, color });
  };

  const canDrop = (line) => {
    if (!sel || mySeat < 0) return false;
    if (line === -1) return true;
    const me = game.players[mySeat];
    const pl = me.patternLines[line];
    if (pl.count >= line + 1) return false;
    if (pl.color && pl.color !== sel.color) return false;
    if (me.wall[line][wallColForColor(line, sel.color)]) return false;
    return true;
  };

  const drop = (line) => {
    if (!sel || !canDrop(line)) return;
    socket.emit('player_action', { source: sel.source, color: sel.color, targetLine: line }, (res) => {
      if (res?.error) toast(res.error);
    });
    setSel(null);
  };

  const cur = game.players[game.currentPlayer];
  const selCount = sel
    ? (sel.source === -1 ? game.center : game.factories[sel.source]).filter((t) => t === sel.color).length
    : 0;

  return (
    <div>
      {roundBanner && <div className="round-banner">{roundBanner}</div>}

      <div className="game-head">
        <div className="turn-banner">
          {game.phase === 'finished' ? '游戏结束' : isMyTurn
            ? <span className="you">轮到你了！选择瓷砖 →</span>
            : <span>等待 {cur.nickname}{cur.isAi ? '（AI）' : ''} 行动…</span>}
        </div>
        <div className="meta">
          <span>第 {game.round} 轮</span>
          <span>袋中 {game.bagCount} 块</span>
          <span>弃堆 {game.discardCount} 块</span>
          {mySeat >= 0 && <span>我的得分 {game.players[mySeat].score}</span>}
        </div>
      </div>

      <div className="game-grid">
        {/* 左：工厂盘 + 中央区 */}
        <div>
          <div className="factories-area">
            {game.factories.map((f, i) => (
              <div key={i} className={`factory ${f.length === 0 ? 'empty' : ''}`}>
                <span className="fnum">{i + 1}</span>
                {f.map((t, j) => (
                  <Tile key={j} color={t}
                    onClick={isMyTurn ? () => pickTile(i, t) : undefined}
                    selected={sel && sel.source === i && sel.color === t}
                    dimmed={sel && sel.source === i && sel.color !== t}
                  />
                ))}
              </div>
            ))}
          </div>

          <div className="center-area">
            <span className="center-label">桌面中央</span>
            {game.centerHasFirst && <Tile color="first" />}
            {game.center.length === 0 && !game.centerHasFirst && (
              <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>（空）</span>
            )}
            {[...game.center].sort((a, b) => COLORS.indexOf(a) - COLORS.indexOf(b)).map((t, j) => (
              <Tile key={j} color={t}
                onClick={isMyTurn ? () => pickTile(-1, t) : undefined}
                selected={sel && sel.source === -1 && sel.color === t}
                dimmed={sel && sel.source === -1 && sel.color !== t}
              />
            ))}
          </div>

          {sel && (
            <div className="hint-bar" style={{ marginTop: 12 }}>
              已选择 <b>{COLOR_NAMES[sel.color]}</b> 色 × {selCount}
              {sel.source === -1 && game.centerHasFirst && '（含 1 号玩家标记，将进入地板行）'}
              ，请点击右侧你的<b>图案行</b>放置（或点击地板行全部弃置）
            </div>
          )}
        </div>

        {/* 右：玩家板 */}
        <div>
          <div className="mini-boards">
            {game.players.map((p, i) => (
              <div key={i} data-seat={i}
                className={`mini-tab ${viewSeat === i ? 'on' : ''}`}
                onClick={() => setViewSeat(i)}>
                {game.currentPlayer === i && game.phase === 'playing' ? '▶ ' : ''}
                {p.nickname}{p.isAi ? ' 🤖' : ''}{i === mySeat ? '（我）' : ''}
                <span className="sc">{p.score}</span>
              </div>
            ))}
          </div>

          <PlayerBoard
            player={game.players[viewSeat]}
            seat={viewSeat}
            mySeat={mySeat}
            isCurrent={game.currentPlayer === viewSeat && game.phase === 'playing'}
            canDrop={viewSeat === mySeat ? canDrop : () => false}
            onDrop={drop}
            pop={popSeats[viewSeat]}
          />
          {viewSeat !== mySeat && mySeat >= 0 && (
            <PlayerBoard
              player={game.players[mySeat]}
              seat={mySeat}
              mySeat={mySeat}
              isCurrent={game.currentPlayer === mySeat && game.phase === 'playing'}
              canDrop={canDrop}
              onDrop={drop}
              pop={popSeats[mySeat]}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PlayerBoard({ player, seat, mySeat, isCurrent, canDrop, onDrop, pop }) {
  return (
    <div data-seat={seat}
      className={`board ${isCurrent ? 'active' : ''} ${seat === mySeat ? 'mine' : ''}`}>
      <div className="board-head">
        <span className="name">
          {player.nickname}
          {player.isAi ? ` 🤖${DIFF_NAMES[player.difficulty] ? '·' + DIFF_NAMES[player.difficulty] : ''}` : ''}
          {seat === mySeat ? '（我）' : ''}
        </span>
        <span className="score">
          <span className={pop ? 'score-pop' : ''} key={pop || 0}>{player.score}</span> 分
        </span>
      </div>
      <div className="board-body">
        {/* 图案行 */}
        <div className="plines">
          {player.patternLines.map((line, r) => {
            const cap = r + 1;
            const droppable = canDrop(r);
            return (
              <div key={r}
                className={`pline ${droppable ? 'droppable' : ''}`}
                onClick={droppable ? () => onDrop(r) : undefined}>
                {Array.from({ length: cap }, (_, k) => {
                  const filled = k >= cap - line.count;
                  return filled
                    ? <Tile key={k} color={line.color} />
                    : <span key={k} className="pslot" />;
                })}
              </div>
            );
          })}
        </div>
        {/* 墙壁 */}
        <div className="wall">
          {Array.from({ length: 5 }, (_, r) => (
            <div className="wall-row" key={r}>
              {Array.from({ length: 5 }, (_, c) => {
                const color = wallColorAt(r, c);
                const filled = player.wall[r][c];
                return (
                  <span key={c} className={`wcell ${filled ? 'filled' : ''}`}>
                    <span className={`ghost tile ${color}`} style={{ width: 'auto', height: 'auto', display: 'block' }} />
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {/* 地板行 */}
      <div
        className={`floor-row ${canDrop(-1) ? 'droppable' : ''}`}
        onClick={canDrop(-1) ? () => onDrop(-1) : undefined}
        title="地板行（扣分区）"
      >
        {Array.from({ length: 7 }, (_, i) => (
          <span className="fslot" key={i}>
            {FLOOR_PENALTY_LABELS[i]}
            {player.floor[i] && <Tile color={player.floor[i]} sm />}
          </span>
        ))}
      </div>
    </div>
  );
}

function GameOverModal({ ranking, onBack }) {
  const medals = ['🥇', '🥈', '🥉', '4'];
  return (
    <div className="modal-mask">
      <div className="modal">
        <h2>🏆 游戏结束 · 最终排名</h2>
        {ranking.map((r) => (
          <div key={r.seatIndex} className={`rank-row ${r.rank === 1 ? 'first' : ''}`}>
            <span className="medal">{medals[r.rank - 1]}</span>
            <span className="rname">{r.nickname}{r.isAi ? ' 🤖' : ''}</span>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>完成横排 ×{r.rows}</span>
            <span className="rscore">{r.score} 分</span>
          </div>
        ))}
        <div className="actions">
          <button onClick={onBack}>返回大厅</button>
        </div>
      </div>
    </div>
  );
}

/* ============ 根组件 ============ */
function App() {
  const [token, setToken] = useState(localStorage.getItem('azul_token'));
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('azul_user')); } catch { return null; }
  });
  const [socket, setSocket] = useState(null);
  const [roomList, setRoomList] = useState([]);
  const [room, setRoom] = useState(null);
  const [game, setGame] = useState(null);
  const [ranking, setRanking] = useState(null);
  const [toastMsg, setToastMsg] = useState('');
  const [muted, setMuted] = useState(Sound.isMuted());
  const toastTimer = useRef(null);

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 2600);
  }, []);

  const onAuthed = (tk, u) => {
    localStorage.setItem('azul_token', tk);
    localStorage.setItem('azul_user', JSON.stringify(u));
    setToken(tk);
    setUser(u);
  };

  const logout = () => {
    localStorage.removeItem('azul_token');
    localStorage.removeItem('azul_user');
    socket?.disconnect();
    setSocket(null); setToken(null); setUser(null);
    setRoom(null); setGame(null); setRanking(null);
  };

  useEffect(() => {
    if (!token) return;
    const s = io({ auth: { token } });
    // 调试钩子：window.__azul 当前连接，window.__evlog 事件流水
    window.__azul = s;
    s.onAny((ev) => {
      const log = (window.__evlog = window.__evlog || []);
      log.push([Date.now() % 1000000, ev, s.id]);
      if (log.length > 200) log.splice(0, 100);
    });
    s.on('connect_error', (e) => {
      if (/登录/.test(e.message)) logout();
      else toast('连接失败：' + e.message);
    });
    s.on('room_list', setRoomList);
    const gameRef = { current: null };
    s.on('game_state', (g) => {
      const prev = gameRef.current;
      gameRef.current = g;
      // 增量动作（seq 连续）→ 先播放飞砖动画再更新状态；否则（开局/重连）直接渲染
      if (prev && g.lastAction && g.seq === (prev.seq || 0) + 1) {
        runActionFx(g.lastAction, () => setGame(g));
      } else {
        setGame(g);
      }
    });
    s.on('ai_thinking', ({ nickname, model }) => toast(`🤖 ${nickname}（${model}）思考中…`));
    s.on('room_update', (r) => {
      setRoom((prev) => {
        // 自己被移出（不在成员里）→ 回大厅
        if (!r.members.some((m) => !m.isAi && m.userId === JSON.parse(localStorage.getItem('azul_user')).id)) {
          return prev && prev.id === r.id ? null : prev;
        }
        return r;
      });
    });
    s.on('game_start', () => { setGame(null); setRanking(null); gameRef.current = null; });
    s.on('ai_action', ({ nickname, say }) => {
      if (say) toast(`💬 ${nickname}：${say}`);
    });
    s.on('game_over', ({ ranking: rk }) => {
      // 等飞砖动画结束再弹排名
      setTimeout(() => { setRanking(rk); Sound.over(); }, 1200);
    });
    setSocket(s);
    return () => s.disconnect();
  }, [token]);

  // leave_room 成功后服务端不再推 room_update 给自己，这里手动清
  useEffect(() => {
    if (!socket) return;
    const origEmit = socket.emit.bind(socket);
    socket.emit = (ev, payload, cb) => origEmit(ev, payload, (res) => {
      if ((ev === 'leave_room' || ev === 'back_to_lobby') && res?.ok) {
        setRoom(null); setGame(null); setRanking(null);
      }
      cb && cb(res);
    });
    return () => { socket.emit = origEmit; };
  }, [socket]);

  if (!token || !user) return (
    <>
      <Toast msg={toastMsg} />
      <AuthPage onAuthed={onAuthed} />
    </>
  );

  const inGame = room && game;

  return (
    <div className="page">
      <Toast msg={toastMsg} />
      <div className="topbar">
        <span className="brand">AZUL · 花砖物语</span>
        <span className="me">
          {user.nickname}（{user.email}）
          <button className="small ghost" title="音效开关" onClick={() => setMuted(Sound.toggle())}>
            {muted ? '🔇' : '🔊'}
          </button>
          <button className="small ghost" onClick={logout}>退出登录</button>
        </span>
      </div>

      {!socket ? (
        <div className="empty-hint">连接服务器中…</div>
      ) : inGame ? (
        <GamePage socket={socket} game={game} room={room} user={user} toast={toast} />
      ) : room ? (
        <RoomPage socket={socket} room={room} user={user} toast={toast} />
      ) : (
        <LobbyPage socket={socket} roomList={roomList} toast={toast} />
      )}

      {ranking && (
        <GameOverModal ranking={ranking} onBack={() =>
          socket.emit('back_to_lobby', {}, () => {})
        } />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
