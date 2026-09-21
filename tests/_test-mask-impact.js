/*
 * 临时测试：验证 mask 规则对【翻译质量】的实际影响
 * 对比：
 *   (A) 直接把原句发给代理翻译
 *   (B) 走真实链路：mask → 翻译 → 还原
 * 如果 (B) 明显比 (A) 差，说明 mask 规则有问题。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const SCRIPT = path.join(__dirname, '..', 'easy-en-translate.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

function extractFn(text, name) {
  const start = text.indexOf('  function ' + name + '(');
  if (start < 0) throw new Error('找不到函数：' + name);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const c = text[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, j + 1); }
  }
  throw new Error('括号不匹配：' + name);
}
function extractConst(text, name) {
  const start = text.indexOf('  const ' + name + ' = [');
  const end = text.indexOf('\n  ];', start);
  return text.slice(start, end + 4);
}
const api = new Function(
  extractConst(src, 'MASK_RULES') + '\n' + extractFn(src, 'mask') + '\nreturn { mask };'
)();

function post(p, obj) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: 8787, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, (r) => {
      let s = '';
      r.on('data', (c) => { s += c; });
      r.on('end', () => resolve(JSON.parse(s)));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

// 还原：把 [[n]] 换回原文（和脚本里的 finalize 逻辑一致）
function unmask(text, map) {
  return String(text).replace(/\[\s*\[\s*(\d+)\s*\]\s*\]/g, (m, k) => (map[k] === undefined ? m : map[k]));
}

const cases = [
  'Use git push --force to overwrite the remote history.',
  'Run npm install and then npm run build to start the server.',
  'The docker build command creates a new image from the Dockerfile.',
  'You should commit your changes before switching branches.'
];

(async () => {
  for (const s of cases) {
    console.log('════════════════════════════════════════════════════════');
    console.log('原文: ' + s);
    const m = api.mask(s);
    console.log('保护后: ' + m.text);
    console.log('对照表: ' + JSON.stringify(m.map));

    // (A) 不走 mask，直接翻
    const a = await post('/translate', { text: s, to: 'zh-CN' });

    // (B) 真实链路
    const b = await post('/translate', { text: m.text, to: 'zh-CN' });
    const restored = unmask(b.translation, m.map);

    console.log('');
    console.log('  (A) 直接翻译      : ' + a.translation);
    console.log('  (B) 真实链路(mask): ' + restored);
    const same = a.translation === restored;
    console.log('  两者是否相同      : ' + (same ? '相同' : '⚠️ 不同'));
    console.log('');
  }
})();
