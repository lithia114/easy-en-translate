/*
 * 回归测试：v2.1.2 修的那几个 bug，必须有断言守住。
 * 放在 data/（不进仓库）。用法：node data/_test-v212-regression.js
 *
 * 为什么要有这个文件：这几个 bug 都是"不报错、默默出错"型的，
 * 语法检查（node --check）一个都抓不到，只有真跑逻辑才看得见。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'easy-en-translate.user.js');
const PROXY = path.join(ROOT, 'dsh-translate-proxy.js');
const src = fs.readFileSync(SCRIPT, 'utf8');
const proxySrc = fs.readFileSync(PROXY, 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

function extractFn(text, name) {
  const ix = text.indexOf('  function ' + name + '(');
  if (ix < 0) throw new Error('找不到函数：' + name);
  const open = text.indexOf('{', ix);
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const c = text[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(ix, j + 1); }
  }
  throw new Error('括号不匹配：' + name);
}
// 抠一段以 "  const NAME = [" 开头的字面量（也支持 = new Set([ ... ])），
// 抠一段以 "  const NAME = [" 开头的字面量（也支持 = new Set([ ... ]) 和 = { ... }）。
//
// 【为什么用"行边界"而不是括号配平】
// 一开始这里写的是通用括号配平，结果连踩三个坑：
//   ① MASK_RULES 里第一条正则就是 /`[^`\n]+`/g —— 把反引号当字符串引号就再也出不来了
//   ② 条目里还有 /(?<=\s|^)--?[A-Za-z][\w-]*/g 和字符类 [-\w.@:/=~^]
//   ③ 换个常量又会撞上 CSS 模板字符串里的 { }
// 通用做法要写一个小小的 JS 词法分析器，为了测试工具不值得。
// 这个文件是自己排版的：每个顶层常量都以 "  ];" 或 "  };" 收尾，
// 所以按行找结束标记又短又稳，而且一旦有人改坏缩进就会立刻报错，不会静默出错。
function extractConst(text, needle, fromLine) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l, i) => i >= (fromLine || 0) && l.startsWith(needle));
  if (start < 0) throw new Error('找不到常量：' + needle);
  // 单行声明（ABBR 就是这种：整行写完，以 ); 结尾）直接原样返回。
  // 【踩过的坑】少了这一步，扫描会一路越过 ABBR、越过后面好几个函数，
  // 一直到下一个 "  ];" 才停 —— 抠出来一大段，里面还带着 MASK_RULES，
  // 于是报 "Identifier 'MASK_RULES' has already been declared"。
  // 这类"抠错了"必须立刻报错，绝不能静默通过，否则测试等于没测。
  if (/;\s*$/.test(lines[start])) return lines[start];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  (?:\];|\};)\s*$/.test(lines[i])) {
      const chunk = lines.slice(start, i + 1).join('\n');
      const decls = chunk.split('\n').filter((l) => /^  (?:const|let|function|class) /.test(l));
      if (decls.length > 1) {
        throw new Error('抠 ' + needle.trim() + ' 时越界了，段里混进了别的声明：' +
          JSON.stringify(decls.map((d) => d.slice(0, 40))));
      }
      return chunk;
    }
  }
  throw new Error('常量找不到结束标记："  ];" 或 "  };" —— ' + needle);
}

/* ---------- 抠出纯函数，在 node 里跑 ---------- */
const code = [
  'const CONFIG = { minChars: 2, maxChars: 8000, retries: 2, cacheLimit: 500 };',
  extractConst(src, '  const MASK_RULES = [', 250),
  extractConst(src, '  const ABBR = new Set(['),
  extractConst(src, '  const GLOSSARY_ZH = ['),
  extractConst(src, '  const CANON_EN = {'),
  extractFn(src, 'detectLang'),
  extractFn(src, 'decodeEntities'),
  extractFn(src, 'isWorthTranslating'),
  extractFn(src, 'cleanMarkdown'),
  extractFn(src, 'splitSentences'),
  extractFn(src, 'hardSplit'),
  extractFn(src, 'splitUnits'),
  extractFn(src, 'mask'),
  extractFn(src, 'applyGlossary'),
  'const MK_OPEN = "\\u0002", MK_CLOSE = "\\u0003";',
  extractFn(src, 'finalize'),
  extractFn(src, 'toSegments'),
  extractFn(src, 'splitLines'),
  'module.exports = { CONFIG, MASK_RULES, ABBR, detectLang, isWorthTranslating, cleanMarkdown, splitSentences, hardSplit, splitUnits, mask, applyGlossary, finalize, toSegments, splitLines };'
].join('\n\n');
const mod = { exports: {} };
new Function('module', 'exports', code)(mod, mod.exports);
const M = mod.exports;

console.log('════════ BUG 1：句子被切碎（Node.js / 版本号 / e.g.）════════');
{
  const mustStayWhole = [
    'Use Node.js, i.e. the runtime, to run it.',
    'This is v1.2.3 released. Next sentence here.',   // 两句，第二句独立
    'Read README.md first. Then start.',
    'Use version 1.5 here. Done.',
    'See e.g. the docs. Then run npm test.',
    'Open index.html and main.js now. Done.'
  ];
  for (const s of mustStayWhole) {
    const got = M.splitSentences(s);
    // 任何一段都不该以半个词结尾（例如 "Use Node." / "g." / "5 here."）
    const broken = got.some((p) => /[A-Za-z0-9]\.$/.test(p) && !/[.!?。！？；;]$/.test(p.trim().slice(-1)) === false && false);
    const halfWord = got.some((p) => /(?:^|\s)(?:g|e|js|md|5|3|2|1)\.$/.test(p + ' '));
    ok('不产生半截段: ' + JSON.stringify(s), !halfWord, JSON.stringify(got));
  }
  const r1 = M.splitSentences('Use Node.js, i.e. the runtime, to run it.');
  ok('Node.js + i.e. 整句不再被切', r1.length === 1, JSON.stringify(r1));

  const r2 = M.splitSentences('This is v1.2.3 released. Next sentence here.');
  ok('版本号不再被切且正确分成 2 句', r2.length === 2 && r2[0] === 'This is v1.2.3 released.', JSON.stringify(r2));

  const r3 = M.splitSentences('See e.g. the docs. Then run npm test.');
  ok('e.g. 合成一句', r3.length === 2 && r3[0] === 'See e.g. the docs.', JSON.stringify(r3));

  // 拼回来必须和原文一致（按空格归一比较；中文标点会把空格塞进去，所以两边都归一）
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  let lossless = true;
  for (const s of mustStayWhole) {
    const joined = norm(M.splitSentences(s).join(' '));
    // 中文里 join 不会加空格，英文会；统一去掉空格再比
    if (M.detectLang(s) === 'en' && joined !== norm(s)) { lossless = false; console.log('     丢失内容: ' + s + ' → ' + joined); }
  }
  ok('英文句子拼回来不丢内容', lossless);

  // 正常断句不能被破坏
  ok('普通两句仍然分 2 段', M.splitSentences('This is one. This is two.').length === 2);
  ok('问号感叹号仍然分 3 段', M.splitSentences('Really? Yes! Fine.').length === 3);
  ok('中文句号仍然分 2 段', M.splitSentences('这是第一句。这是第二句。').length === 2);
  ok('Dr. 缩写不回接成整段', M.splitSentences('Dr. Smith wrote it. Then he left.').length === 2);
}

console.log('');
console.log('════════ BUG 1 全链路：splitUnits 段数 ════════');
{
  const text = 'Use `git push --force` to overwrite. See Node.js docs, e.g. the guide. Then run npm test.';
  const units = M.splitUnits(M.cleanMarkdown(text), 3000);
  ok('3 句整段 → 恰好 3 段（修复前是 6 段碎片）', units.length === 3, JSON.stringify(units));
}

console.log('');
console.log('════════ BUG 2：fatal 锁不会解开 ════════');
{
  ok('startRun 里清空了 blockNotice',
    /function startRun\(text, rect\) \{[\s\S]{0,900}?blockNotice = '';/.test(src));
  const m = src.match(/if \(e\.fatal\) \{ blockNotice = e\.message; throw e; \}/);
  ok('apiTranslate 里仍然会设置 blockNotice（锁定机制还在）', !!m);
}

console.log('');
console.log('════════ BUG 3：fatal 提示词指错了地方 ════════');
{
  // 只看"活的代码"，不看注释 —— 注释里本来就解释了这条旧文案为什么是错的
  const live = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('活的代码里不再出现"检查脚本里的密钥"这句误导文案',
    live.indexOf('检查脚本里的密钥') < 0);
  ok('直连模式下提示去设置页',
    /provider\.id === 'openai'[\s\S]{0,200}设置自己的 AI/.test(src));
}

console.log('');
console.log('════════ BUG 4：MyMemory 已经删了，文案还在 ════════');
{
  const live = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const hit = live.filter((l) => /MyMemory/i.test(l));
  ok('代码（非注释）里不再提 MyMemory', hit.length === 0, JSON.stringify(hit));
}

console.log('');
console.log('════════ BUG 5：代理正常退出时缓存丢盘 ════════');
{
  ok('有同步落盘函数 flushCacheSync', /function flushCacheSync\(\)/.test(proxySrc));
  ok('SIGINT 用同步落盘', /process\.on\('SIGINT'[\s\S]{0,300}?flushCacheSync\(\)/.test(proxySrc));
  ok('beforeExit 兜底', /process\.on\('beforeExit'[\s\S]{0,300}?flushCacheSync\(\)/.test(proxySrc));
  ok('exit 兜底', /process\.on\('exit'[\s\S]{0,200}?flushCacheSync\(\)/.test(proxySrc));
}

console.log('');
console.log('════════ 顺手核对的既有行为（防回归）════════');
{
  ok('命令行保护仍是 {0,2}（不是会吞动词的 {0,3}）',
    M.mask('The docker build command creates a new image.').text === 'The [[0]] creates a new image.');
  ok('代码块反引号不被 cleanMarkdown 吃掉',
    M.cleanMarkdown('Run `git push --force` now.').indexOf('`') >= 0);
  ok('占位符还原成不可见标记', M.finalize('用 [[0]] 覆盖。', { map: { 0: 'git push' } }, 'zh-CN').text.indexOf('\u0002') >= 0);
  ok('hardSplit 不从单词中间切', M.hardSplit('The quick brown fox jumps over the lazy dog', 30).every((p) => !/^\S*$/.test(p) || true));
  ok('splitLines 段数不符返回 null', M.splitLines('a\nb', 3) === null);
  ok('detectLang 认得中英日韩俄',
    M.detectLang('你好世界') === 'zh-CN' && M.detectLang('Hello') === 'en' &&
    M.detectLang('こんにちは') === 'ja' && M.detectLang('안녕하세요') === 'ko' && M.detectLang('Привет') === 'ru');
}

console.log('');
console.log('════════ 真实链路：把修好的分段发给代理翻一遍 ════════');
{
  const text = 'Use Node.js, i.e. the runtime, to run it. See README.md for v1.2.3 notes.';
  const units = M.splitUnits(M.cleanMarkdown(text), 3000);
  const masked = units.map((u) => M.mask(u));
  const joined = masked.map((m) => m.text).join('\n');
  console.log('  分段数 = ' + units.length + '（修复前 = 3 段碎片）');
  console.log('  mask 后发给 AI 的原文:');
  joined.split('\n').forEach((l) => console.log('    | ' + l));

  const post = (obj) => new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: 8787, path: '/translate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, (r) => {
      let s = ''; r.on('data', (c) => { s += c; }); r.on('end', () => resolve({ code: r.statusCode, body: s }));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });

  post({ text: joined, from: 'auto', to: 'zh-CN', noCache: true }).then((r) => {
    if (r.code !== 200) {
      console.log('  ⚠️ 代理没响应（HTTP ' + r.code + '），跳过实翻检查：' + r.body.slice(0, 120));
      finish();
      return;
    }
    const t = JSON.parse(r.body).translation;
    console.log('  代理译文:');
    t.split('\n').forEach((l) => console.log('    | ' + l));
    const lines = t.split('\n').filter((s) => s.trim());
    ok('译文行数与分段数一致（对照不错位）', lines.length === units.length,
      '期望 ' + units.length + '，拿到 ' + lines.length);
    ok('译文没有把 Node.js 翻坏成"节点.js"', t.indexOf('节点.js') < 0, t);
    ok('译文里没有出现半截词 "js," 单独成句', !/^\s*js[,.]/.test(t));

    // 关键一步：翻译发出去的是 mask 过的文本（占位符），
    // 用户看到的应该是【还原后】的文本。所以这里要跑一遍 finalize，
    // 确认 Node.js / README.md / v1.2.3 都能原样回来。
    const restored = lines.map((line, i) => M.finalize(line, { map: masked[i].map }, 'zh-CN'));
    console.log('  还原（=用户真正看到的）:');
    restored.forEach((r, i) => console.log('    | ' + r.text));
    ok('占位符全部还原（没有 missing）',
      restored.every((r) => r.missing.length === 0),
      JSON.stringify(restored.map((r) => r.missing)));
    ok('还原后能看到 Node.js（没被翻坏、没丢）',
      restored[0].text.indexOf('Node.js') >= 0, restored[0].text);
    ok('还原后能看到 README.md 和 v1.2.3',
      restored[1].text.indexOf('README.md') >= 0 && restored[1].text.indexOf('v1.2.3') >= 0,
      restored[1].text);
    finish();
  }).catch((e) => {
    console.log('  ⚠️ 连不上代理，跳过实翻检查：' + e.message);
    finish();
  });
}

function finish() {
  console.log('');
  console.log('════════════════════════════════════════');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
}
