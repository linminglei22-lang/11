// 大模型 AI 玩家 —— 通过 OpenAI 兼容的 Chat Completions API（DeepSeek / OpenAI / 通义 / Kimi 等）
// 由服务端调用，API Key 只保存在服务端内存，绝不下发给前端。
const { legalActions, wallColorAt, wallColForColor, COLORS } = require('./rules');

const CN = { blue: '蓝', yellow: '黄', red: '红', black: '黑', white: '白' };
const SYSTEM_PROMPT =
  '你是桌游《花砖物语(Azul)》的高手玩家。根据给出的局面，从"合法操作列表"中选择一个最优操作。' +
  '规则要点：图案行填满后该行最右1块在回合结算时贴上墙壁并按横竖邻接计分；溢出瓷砖进地板行扣分(-1/-1/-2/-2/-2/-3/-3)；' +
  '终局奖励：完整横排+2、完整纵列+7、集齐同色5块+10；第一个从中央拿瓷砖者获得下轮先手但1号标记计入地板扣分。' +
  '策略要领：上墙位置尽量与已贴瓷砖横竖相邻以叠加连线分；有意识地围绕同一纵列(+7)和同一颜色(+10)规划多轮收集；' +
  '行容量越大越难填满，前期慎开第4、5行；权衡抢先手标记的价值与其地板扣分；留意对手即将完成的行，必要时拿走他需要的颜色。' +
  '只输出一个 JSON 对象，不要输出任何其他内容，格式：' +
  '{"think": "<你的局面分析与选择理由，60-150字，单段不换行>", "action": <操作序号(整数)>, "say": "<一句简短台词，可选>"}';

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
  const deep = !!cfg.deep; // 深度推理：开启思考模式，棋力更强但每步更慢
  const body = {
    model: cfg.model || 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(state, seat, actions) },
    ],
    max_tokens: deep ? 50000 : 2000,
  };
  // Kimi k2.5 等模型强制 temperature=1，自定义值会被 400 拒绝；其余服务商用低温更稳定
  if (!/moonshot|kimi/i.test(baseUrl)) {
    body.temperature = 0.3;
  }
  // 思考开关：DeepSeek v4 与智谱 GLM-4.5+ 都用 thinking: {type} 参数控制
  // （思考过程与答案共享 token 配额，必须显式管理）。
  // 仅对已知支持的服务商下发，避免其他 OpenAI 兼容服务商拒绝未知字段。
  if (/deepseek|bigmodel/i.test(baseUrl)) {
    body.thinking = { type: deep ? 'enabled' : 'disabled' };
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(deep ? 300000 : 60000),
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
  // 模型偶尔会在 JSON 字符串里输出裸换行（非法 JSON），统一替换为空格
  const parsed = JSON.parse(m[0].replace(/[\r\n]+/g, ' '));
  const idx = Number(parsed.action);
  if (!Number.isInteger(idx) || idx < 0 || idx >= actions.length) {
    throw new Error(`操作序号越界: ${parsed.action}`);
  }
  // 思考内容：深度推理模式优先展示完整推理过程，普通模式优先展示精炼的 think 字段
  const reasoning = (msg.reasoning_content || '').trim();
  const thinkField = typeof parsed.think === 'string' ? parsed.think.trim() : '';
  let thinking = deep ? (reasoning || thinkField) : (thinkField || reasoning);
  if (!thinking) thinking = text.replace(m[0], '').replace(/<\/?think>/g, '').trim();
  return {
    action: actions[idx],
    say: typeof parsed.say === 'string' ? parsed.say.slice(0, 60) : null,
    thinking: thinking ? thinking.slice(0, deep ? 8000 : 4000) : null,
  };
}

module.exports = { chooseAction };
