/*
 * 一把梭测试入口：把 data/ 下所有测试脚本按顺序跑一遍，最后给一个总账。
 * 放在 data/（不进仓库）。
 *
 * 用法：
 *   node data/_test-all.js              跑全部
 *   node data/_test-all.js -q           只打印失败的（安静模式）
 *
 * 【需要代理在跑】标了 "需要代理" 的会真发请求（/translate、/lookup）。
 * 代理没起时它们会被跳过，不算失败 —— 但也就少了一层验证，
 * 所以改完代码最好把代理起起来再跑一次完整版。
 */
const { spawnSync } = require('child_process');
const path = require('path');
const http = require('http');

const QUIET = process.argv.indexOf('-q') >= 0;

// 顺序有意义：先静态、再单元、再假 DOM、最后端到端（最慢的在最后）
const SUITES = [
  ['_test-cache-flush.js', '缓存退出落盘（纯文件 I/O）', false],
  ['_test-v212-regression.js', 'v2.1.2 修复项回归（36 项断言）', false],
  ['_test-words.js', '分词与"可点单词"渲染', false],
  ['_test-card.js', '词典卡片渲染', false],
  ['_test-settings.js', '设置面板构建', false],
  ['_test-provider-persist.js', '引擎选择持久化', false],
  ['_test-load.js', '整脚本在假浏览器里加载 + 8 个菜单命令', false],
  ['_test-mask-variants.js', '命令行保护规则对比', false],
  ['_test-versions.js', '版本分发 /versions 与 /v/', true],
  ['_test-lookup.js', '本地词典 /lookup', true],
  ['_test-e2e.js', '端到端：模拟划词 → 真翻译 → 渲染', true]
];

function proxyUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 8787, path: '/health', timeout: 1500 }, (r) => {
      let s = '';
      r.on('data', (c) => { s += c; });
      r.on('end', () => resolve(s.indexOf('dsh-translate-proxy') >= 0));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

(async () => {
  const up = await proxyUp();
  console.log('代理状态：' + (up ? '✅ 在跑（需要代理的用例会真跑）' : '❌ 没在跑（需要代理的用例会跳过）'));
  console.log('');

  const lines = [];
  let pass = 0, fail = 0, skip = 0;
  const failures = [];

  for (const [file, desc, needProxy] of SUITES) {
    if (needProxy && !up) {
      skip++;
      lines.push(['跳过', file, desc + '（代理没跑）']);
      continue;
    }
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(__dirname, file)], {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 180000
    });
    const ms = Date.now() - t0;
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.status === 0) {
      pass++;
      // 抓测试自己的总结行
      const summary = (out.match(/(?:通过|全部通过|没有发现|✅ 全部|卡片渲染代码全部跑通)[^\n]*/g) || []).slice(-1)[0] || '';
      lines.push(['通过', file, desc + '  (' + ms + 'ms) ' + summary]);
    } else {
      fail++;
      failures.push({ file, out });
      lines.push(['失败', file, desc + '  (exit=' + r.status + ')']);
    }
  }

  for (const [state, file, desc] of lines) {
    if (QUIET && state === '通过') continue;
    const mark = state === '通过' ? '✅' : (state === '跳过' ? '⏭' : '❌');
    console.log(mark + ' ' + file.padEnd(30) + ' ' + desc);
  }

  if (failures.length) {
    console.log('');
    console.log('════════ 失败详情 ════════');
    for (const f of failures) {
      console.log('');
      console.log('---- ' + f.file + ' ----');
      console.log(f.out.trim().split('\n').slice(-40).join('\n'));
    }
  }

  console.log('');
  console.log('════════════════════════════════════════');
  console.log('  通过 ' + pass + ' 个 / 失败 ' + fail + ' 个 / 跳过 ' + skip + ' 个');
  console.log('════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})();
