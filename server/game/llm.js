// 大模型 AI 玩家 —— 通过 OpenAI 兼容的 Chat Completions API（DeepSeek / OpenAI / 通义 / Kimi 等）
// 由服务端调用，API Key 只保存在服务端内存，绝不下发给前端。
const { legalActions, wallColorAt, wallColForColor, COLORS } = require('./rules');

const CN = { blue: '蓝', yellow: '黄', red: '红', black: '黑', white: '白' };
const SYSTEM_PROMPT =
  '你是桌游《花砖物语(Azul)》的高手玩家。根据给出的局面，从"合法操作列表"中选择一个最优操作。' +
  '规则要点：图案行填满后该行最右1块在回合结算时贴上墙壁并按横竖邻接计分；溢出瓷砖进地板行扣分(-1/-1/-2/-2/-2/-3/-3)；' +
  '终局奖励：完整横排+2、完整纵列+7、集齐同色5块+10；第一个从中央拿瓷砖者获得下轮先手但1号标记计入地板扣分。' +
  '只输出一个 JSON 对象，格式：{"action": <操作序号(整数)>, "say": "<一句简短中文台词，可选>"}，不要输出其他内容。';

function describeBoard(p, label) {
  const lines = p.patternLines
    .map((l, r) => `行${r + 1}(容量${r + 1}): ${l.count > 0 ? `${CN[l.color]}×${l.count}` : '空'}`)
    .join('，');
  const wall = p.wall
    .map((row, r) => {
      const filled = row.map((v, c) => (v ? CN[wallColorAt(r, c)] : null)).filter(Boolean);
      return `第${r + 1}行[${filled.join('') || '无'}]`;
    })
    .join(' ');
  return `${label}：得分${p.score}，图案行：${lines}；墙壁已贴：${wall}；地板${p.floor.length}块`;
}

function describeAction(state, seat, a, i) {
  const pool = a.source === -1 ? state.center : state.factories[a.source];
  const taken = pool.filter((t) => t === a.color).length;
  const src = a.source === -1 ? '中央' : `工厂${a.source + 1}`;
  if (a.targetLine < 0) return `${i}: 从${src}拿${CN[a.color]}×${taken} → 全部进地板(扣分)`;
  const line = state.players[seat].patternLines[a.targetLine];
  const cap = a.targetLine + 1;
  const fit = Math.min(cap - line.count, taken);
  const over = taken - fit;
  const full = line.count + fit === cap ? '✔将填满该行' : '';
  return `${i}: 从${src}拿${CN[a.color]}×${taken} → 第${a.targetLine + 1}行(放${fit}${over ? `,溢出${over}进地板` : ''}) ${full}`;
}

function buildPrompt(state, seat, actions) {
  const facs = state.factories
    .map((f, i) => `工厂${i + 1}:[${f.map((t) => CN[t]).join('') || '空'}]`)
    .join(' ');
  const center = `中央:[${state.center.map((t) => CN[t]).join('') || '空'}]${state.centerHasFirst ? '(含1号先手标记)' : ''}`;
  const me = describeBoard(state.players[seat], '我');
  const opps = state.players
    .map((p, i) => (i === seat ? null : describeBoard(p, `对手「${p.nickname}」`)))
    .filter(Boolean)
    .join('\n');
  const acts = actions.map((a, i) => describeAction(state, seat, a, i)).join('\n');
  return `第${state.round}轮。\n${facs}\n${center}\n\n${me}\n${opps}\n\n合法操作列表：\n${acts}\n\n请选择最优操作，输出 JSON。`;
}

/**
 * 调用大模型选择操作。cfg: { baseUrl, model, apiKey }
 * 返回 { action, say }；任何失败抛异常（由调用方回退到启发式 AI）。
 */
async function chooseAction(state, seat, cfg) {
  const actions = legalActions(state, seat);
  if (actions.length === 0) return { action: null, say: null };

  const baseUrl = String(cfg.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model || 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPrompt(state, seat, actions) },
      ],
      temperature: 0.3,
      // 推理模型（如 deepseek-v4 思考模式）思考过程与答案共享配额，
      // 上限太小会在 JSON 输出前被截断，留足余量（8000 在各家上限内安全）
      max_tokens: 8000,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  // 推理模型的最终答案在 content；若为空则从思考内容里兜底提取
  const text = msg.content || msg.reasoning_content || '';
  if (!text) {
    throw new Error(
      `回复内容为空（finish_reason=${data.choices?.[0]?.finish_reason}，` +
      `可能是思考模型 token 耗尽或返回结构异常）`
    );
  }
  // 优先匹配含 "action" 的 JSON 对象，避免误抓思考过程里的其他花括号
  const m = text.match(/\{[^{}]*"action"[^{}]*\}/) || text.match(/\{[\s\S]*?\}/);
  if (!m) throw new Error(`无法从回复中解析 JSON: ${text.slice(0, 150)}`);
  const parsed = JSON.parse(m[0]);
  const idx = Number(parsed.action);
  if (!Number.isInteger(idx) || idx < 0 || idx >= actions.length) {
    throw new Error(`操作序号越界: ${parsed.action}`);
  }
  // 提取思考过程：推理模型专用字段优先，否则取 content 里 JSON 之外的文本
  let thinking = (msg.reasoning_content || '').trim();
  if (!thinking) {
    thinking = text.replace(m[0], '').replace(/<\/?think>/g, '').trim();
  }
  return {
    action: actions[idx],
    say: typeof parsed.say === 'string' ? parsed.say.slice(0, 60) : null,
    thinking: thinking ? thinking.slice(0, 4000) : null,
  };
}

module.exports = { chooseAction };
