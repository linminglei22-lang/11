// 大模型接入自检：验证指定服务商能否正常出招并返回思考内容
// 用法: node test/llm-probe.js <API地址> <模型名> <API Key> [deep]
// 例如: node test/llm-probe.js https://api.moonshot.cn/v1 kimi-k2.5 sk-xxxx
const { createGame } = require('../server/game/rules');
const llm = require('../server/game/llm');

const [baseUrl, model, apiKey, deepFlag] = process.argv.slice(2);
if (!baseUrl || !model || !apiKey) {
  console.log('用法: node test/llm-probe.js <API地址> <模型名> <API Key> [deep]');
  console.log('示例: node test/llm-probe.js https://api.deepseek.com/v1 deepseek-v4-flash sk-xxx');
  process.exit(1);
}

(async () => {
  const state = createGame([{ nickname: '自检' }, { nickname: '对手' }]);
  const seat = state.currentPlayer;
  console.log(`正在调用 ${model} @ ${baseUrl}${deepFlag === 'deep' ? '（深度推理）' : ''} ...`);
  const t0 = Date.now();
  try {
    const r = await llm.chooseAction(state, seat, {
      baseUrl, model, apiKey, deep: deepFlag === 'deep',
    });
    console.log(`\n✔ 调用成功（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    console.log('  动作:', JSON.stringify(r.action));
    console.log('  台词:', r.say || '（无）');
    console.log('  思考:', r.thinking ? `${r.thinking.slice(0, 200)}${r.thinking.length > 200 ? '…' : ''}` : '⚠ 无思考内容（请看上方诊断日志）');
  } catch (e) {
    console.error(`\n✘ 调用失败: ${e.message}`);
    process.exit(1);
  }
})();
