/*
 * 验证「退出时缓存落盘」这条修复。
 * 放在 data/（不进仓库）。用法：node data/_test-cache-flush.js
 *
 * 【为什么这样测，而不是直接杀进程】
 * 第一版测法是把代理跑起来、发一条翻译、然后 job_kill —— 结果证明不了修复：
 * job_kill 是强杀，任何 process.on('exit') 都不会执行，新旧代码都是"丢"。
 * （顺带这一测反而证明了问题本身真实存在：延迟 60 秒落盘时，强杀之前
 *   磁盘上确实没有那条记录，内存里却有。）
 *
 * 能把这段逻辑测确定的办法是"直接测函数本身"：
 * 把 flushCacheSync 抠出来，喂一个假缓存和一个假文件名，
 * 检查它是不是真的把 100% 的内容同步写下去了。
 * 这是纯文件 I/O，没有并发，测出来的结论是确定的。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROXY = path.join(ROOT, 'dsh-translate-proxy.js');
const proxySrc = fs.readFileSync(PROXY, 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---------- 1. 结构检查：三条退出路径都挂上了同步落盘 ---------- */
console.log('════════ 1. 退出路径有没有挂上同步落盘 ════════');
{
  ok('定义了 flushCacheSync（同步写）', /function flushCacheSync\(\)/.test(proxySrc));
  ok('flushCacheSync 用的是 writeFileSync（同步）',
    /function flushCacheSync\(\)[\s\S]*?fs\.writeFileSync\(CACHE_FILE/.test(proxySrc));
  ok('SIGINT 走 flushCacheSync', /process\.on\('SIGINT'[\s\S]{0,400}?flushCacheSync\(\)/.test(proxySrc));
  ok('beforeExit 走 flushCacheSync', /process\.on\('beforeExit'[\s\S]{0,300}?flushCacheSync\(\)/.test(proxySrc));
  ok('exit 走 flushCacheSync', /process\.on\('exit'[\s\S]{0,200}?flushCacheSync\(\)/.test(proxySrc));
  ok('beforeExit / exit 里没有留 setTimeout（退出阶段跑不了异步）',
    !/process\.on\('(?:beforeExit|exit)'[\s\S]{0,300}?setTimeout/.test(proxySrc));
  ok('两个退出钩子都先用 saveTimer 判断"有没有没落盘的东西"',
    (proxySrc.match(/if \(saveTimer\)/g) || []).length >= 2);
}

/* ---------- 2. 行为检查：把真函数抠出来真跑 ---------- */
console.log('');
console.log('════════ 2. 把 flushCacheSync 抠出来真跑一遍 ════════');

// 抠函数：从 "function flushCacheSync()" 到配平的 }
function extractFn(text, name) {
  const ix = text.indexOf('function ' + name + '(');
  if (ix < 0) throw new Error('找不到函数：' + name);
  const open = text.indexOf('{', ix);
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') { depth--; if (depth === 0) return text.slice(ix, j + 1); }
  }
  throw new Error('括号不匹配：' + name);
}

const tmpFile = path.join(os.tmpdir(), 'flush-test-' + Date.now() + '.json');
const CACHE_LIMIT = 5;
const cache = new Map();
let saveTimer = { fake: true };   // 假装有一个"还没跑的定时器"
const logs = [];

const fnSrc = extractFn(proxySrc, 'flushCacheSync');
const runner = new Function('cache', 'CACHE_LIMIT', 'CACHE_FILE', 'log', 'fs', 'clearTimeout', 'saveTimerRef',
  'let saveTimer = saveTimerRef.current;\n' +
  fnSrc + '\n' +
  'const r = flushCacheSync();\n' +
  'saveTimerRef.current = saveTimer;\n' +
  'return r;'
);

// 塞 8 条进去（超过 CACHE_LIMIT=5，顺便验上限裁剪）
for (let i = 1; i <= 8; i++) cache.set('zh-CN\u0001text-' + i, { translation: '译文-' + i, model: 'm' });
const ref = { current: saveTimer };

const rc = runner(cache, CACHE_LIMIT, tmpFile, (m) => logs.push(m), fs,
  (t) => { logs.push('clearTimeout 被调用了'); }, ref);

ok('flushCacheSync 返回了写出条数（不是 undefined）', typeof rc === 'number', String(rc));
ok('返回值 = CACHE_LIMIT（超上限的旧条目被裁掉）', rc === CACHE_LIMIT, '返回值 ' + rc);
ok('超上限的旧条目确实被删了（内存里只剩 5 条）', cache.size === CACHE_LIMIT, 'size=' + cache.size);
ok('最早的条目（text-3 之前）已经被淘汰', !cache.has('zh-CN\u0001text-1') && !cache.has('zh-CN\u0001text-3'));
ok('clearTimeout 被调用了（没落盘的定时器被取消，不会重复写）', logs.some((l) => l.indexOf('clearTimeout') >= 0));
ok('saveTimer 被清成 null', ref.current === null, String(ref.current));

// 磁盘上真的写了吗
const onDisk = fs.existsSync(tmpFile);
ok('文件在磁盘上生成了', onDisk);
if (onDisk) {
  const obj = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  const n = Object.keys(obj).length;
  ok('磁盘上的条数 = 内存里的条数（一条不漏）', n === cache.size, '磁盘 ' + n + ' / 内存 ' + cache.size);
  ok('内容正确（不是空对象）', obj['zh-CN\u0001text-8'] && obj['zh-CN\u0001text-8'].translation === '译文-8',
    JSON.stringify(obj['zh-CN\u0001text-8']));
  fs.unlinkSync(tmpFile);
}

/* ---------- 3. 对比：异步那版为什么不行 ---------- */
console.log('');
console.log('════════ 3. 留档：为什么异步落盘在退出时会丢 ════════');
{
  ok('saveCacheSoon 用的是异步 fs.writeFile（所以退出时会丢）',
    /function saveCacheSoon\(\)[\s\S]{0,600}?fs\.writeFile\(CACHE_FILE/.test(proxySrc));
  ok('saveCacheSoon 仍然保留（正常运行时批量写，省 I/O）',
    /function saveCacheSoon\(\)/.test(proxySrc));
}

console.log('');
console.log('════════════════════════════════════════');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('════════════════════════════════════════');
process.exit(fail ? 1 : 0);
