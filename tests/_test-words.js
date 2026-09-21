/*
 * 临时测试：从用户脚本里【抠出真实的函数】来跑，验证分词和"可点单词"渲染
 * 为什么要这样测：浏览器那一侧我没法自动打开，但分词和渲染是最容易出错的地方
 *                （don't / Node.js / 代码块会不会被拆碎），必须验证。
 * 注意：抠的是真代码，不是复制品。
 */
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'easy-en-translate.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

function extractFn(text, name) {
  const key = '  function ' + name + '(';
  const start = text.indexOf(key);
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
  const key = '  const ' + name + ' = [';
  const start = text.indexOf(key);
  if (start < 0) throw new Error('找不到常量：' + name);
  const end = text.indexOf('\n  ];', start);
  return text.slice(start, end + 4);
}

// 迷你 DOM 桩：够 appendWordSpans / renderSrcWords 用
let nodeId = 0;
function makeEl(tag, cls) {
  return {
    id: ++nodeId, tag, className: cls || '', textContent: '', title: '', dataset: {}, children: [],
    appendChild(c) { this.children.push(c); return c; }
  };
}
const fakeDocument = {
  createTextNode(t) { return { id: ++nodeId, nodeType: 3, text: t }; }
};

const code = [
  'const srcItemOf = new WeakMap();   // 与脚本里同名同类型的桩（appendWordSpans 依赖它）',
  extractConst(src, 'MASK_RULES'),
  extractFn(src, 'mask'),
  extractFn(src, 'isLookupable'),
  extractFn(src, 'splitWords'),
  extractFn(src, 'appendWordSpans'),
  extractFn(src, 'renderSrcWords')
].join('\n\n');

const api = new Function('el', 'document',
  code + '\nreturn { mask, isLookupable, splitWords, appendWordSpans, renderSrcWords };'
)(makeEl, fakeDocument);

/* ---------- 1. 分词测试 ---------- */
console.log('==================== 1. 分词效果 ====================');
const words = [
  "don't", 'Node.js', 'getUserName', 'well-known', 'v1.2.3',
  'https://github.com/foo/bar', 'repositories', 'run'
];
words.forEach(function (w) {
  const segs = api.splitWords(w);
  const desc = segs.map(function (s) { return (s.isWord ? '[词]' : '[符]') + JSON.stringify(s.text); }).join(' + ');
  console.log('  ' + JSON.stringify(w).padEnd(32) + ' → ' + desc);
});

console.log('');
console.log('  中英混排:');
const mixed = '这个 fork 操作会 clone 仓库';
api.splitWords(mixed).forEach(function (s) {
  console.log('     ' + (s.isWord ? '词' : '符') + '  ' + JSON.stringify(s.text));
});

/* ---------- 2. 哪些词会被做成可点 ---------- */
console.log('');
console.log('==================== 2. 可点判定 isLookupable ====================');
['token', 'a', 'I', 'the', 'xyz', 'nth', '42', 'x1', 'JavaScript', 'don\'t', '3.14', '--force'].forEach(function (w) {
  console.log('  ' + JSON.stringify(w).padEnd(14) + ' → ' + (api.isLookupable(w) ? '可点（会查词典）' : '不可点'));
});

/* ---------- 3. 端到端：mask → renderSrcWords ---------- */
console.log('');
console.log('==================== 3. 端到端渲染（代码块会不会被拆碎）====================');

function render(text) {
  const m = api.mask(text);
  const item = { src: text, masked: m.text, map: m.map };
  const box = makeEl('div', 'txt src');
  api.renderSrcWords(box, item);
  console.log('');
  console.log('  原文: ' + text);
  console.log('  保护后: ' + m.text);
  console.log('  渲染结果:');
  box.children.forEach(function (c) {
    if (c.nodeType === 3) {
      const t = c.text.trim();
      if (t) console.log('     文本  ' + JSON.stringify(c.text));
    } else if (c.className === 'code') {
      console.log('     代码  ' + JSON.stringify(c.textContent) + '   ← 不可点');
    } else {
      const n = c.children ? c.children.length : 0;
      console.log('     词    ' + JSON.stringify(c.textContent) + '   ← 可点');
    }
  });
  const clickable = box.children.filter(function (c) { return c.className === 'w'; }).map(function (c) { return c.textContent; });
  const codes = box.children.filter(function (c) { return c.className === 'code'; }).map(function (c) { return c.textContent; });
  return { clickable, codes };
}

const cases = [
  'Run `npm ci` before `npm run build`.',
  'Fork this repository and create a pull request.',
  'Use git push --force to overwrite history.',
  'The getUserName() method reads nodeIndex_2 from index.html.',
  "Don't panic: the cache is patched in v1.2.3.",
  'Contact @octocat about issue #123 on https://github.com/foo/bar'
];

let issues = 0;
cases.forEach(function (t) {
  const r = render(t);
  // 自检：代码块必须完整、没被拆成多个词
  const brokenCode = r.clickable.filter(function (w) {
    return t.indexOf('`' + w + '`') >= 0;
  });
  if (brokenCode.length) { issues++; console.log('     ⚠️ 代码块被拆成了可点词: ' + JSON.stringify(brokenCode)); }
  console.log('    → 可点 ' + r.clickable.length + ' 个词: ' + JSON.stringify(r.clickable.slice(0, 10)));
  console.log('    → 代码 ' + r.codes.length + ' 块: ' + JSON.stringify(r.codes));
});

console.log('');
console.log(issues === 0 ? '✅ 没有发现代码块被拆碎的问题' : '⚠️ 发现 ' + issues + ' 处问题');
