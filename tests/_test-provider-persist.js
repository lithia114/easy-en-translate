/*
 * 验证「设置页保存后选择是否持久化」这条逻辑
 * 方法：把启动时读回 provider 的那几行、以及保存时写入的那几行抠出来，
 *       用一个假的 store 跑一遍，确认 ✓写进去 ✓读回来 ✓ready 判定正确
 */
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'easy-en-translate.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

console.log('=== 1. 检查关键代码是否都在 ===');
const checks = [
  ['保存时写入 provider', "store.set('provider', 'openai')"],
  ['启动时读回 provider', "store.get('provider', null)"],
  ['读回时校验 ready', 'PROVIDERS[savedProvider] && PROVIDERS[savedProvider].ready()'],
  ['菜单提示改为"仅本次会话"', '（仅本次会话）']
];
let fail = 0;
checks.forEach(function (c) {
  const ok = src.indexOf(c[1]) >= 0;
  if (!ok) fail++;
  console.log('  ' + (ok ? '✅' : '❌') + ' ' + c[0]);
});

console.log('');
console.log('=== 2. 模拟一段完整流程（假 store）===');

// 假 store
const store = {
  data: {},
  get(k, d) { return this.data[k] === undefined ? d : this.data[k]; },
  set(k, v) { this.data[k] = v; }
};

// 假的引擎表：只关心 ready
const PROVIDERS = {
  dsh: { label: '本机 DSH 模型', ready: () => true },
  openai: { label: '自定义 AI（直连）', ready: () => !!(CONFIG.direct.baseURL && CONFIG.direct.model && CONFIG.direct.apiKey) },
  mymemory: { label: 'MyMemory', ready: () => true }
};
const CONFIG = { provider: 'dsh', direct: { preset: '', baseURL: '', model: '', apiKey: '' } };

function startup() {
  // 模拟启动时那几行
  Object.assign(CONFIG.direct, store.get('direct', {}) || {});
  const savedProvider = store.get('provider', null);
  if (savedProvider && PROVIDERS[savedProvider] && PROVIDERS[savedProvider].ready()) {
    CONFIG.provider = savedProvider;
  }
  return CONFIG.provider;
}

console.log('  第1步 全新安装（什么都没配）');
console.log('     启动后引擎 = ' + startup() + '   ← 默认走代理 ✓');

console.log('');
console.log('  第2步 用户在设置页填了 key 并点保存');
store.set('direct', { preset: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-test123' });
store.set('provider', 'openai');
CONFIG.provider = 'openai';
console.log('     当前引擎 = ' + CONFIG.provider + '   ← 已切到直连 ✓');

console.log('');
console.log('  第3步 【关键】刷新页面后再看 —— 这是修复前会出错的地方');
CONFIG.provider = 'dsh';   // 模拟刷新：内存重置回脚本默认值
const after = startup();
console.log('     启动后引擎 = ' + after + '   ' + (after === 'openai' ? '✅ 修复生效，仍是直连' : '❌ 退回代理了'));

console.log('');
console.log('  第4步 用户把 key 清空了（或配置坏了）');
store.set('direct', { preset: 'deepseek', baseURL: '', model: '', apiKey: '' });
CONFIG.direct = { preset: '', baseURL: '', model: '', apiKey: '' };
CONFIG.provider = 'dsh';
const after2 = startup();
console.log('     启动后引擎 = ' + after2 + '   ' + (after2 === 'dsh' ? '✅ 正确退回代理（因为直连没配好）' : '❌ 不该用直连'));

console.log('');
console.log(fail === 0 && after === 'openai' && after2 === 'dsh' ? '✅ 全部通过' : '❌ 有问题');
