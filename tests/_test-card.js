/*
 * 运行时测试：把「词典卡片渲染」那一段真代码抠出来，用桩 DOM 跑一遍
 * 为什么要这样测：语法检查只能查拼写，查不出"引用了不存在的变量"这类运行时错误。
 *   之前就踩过一次（appendWordSpans 引用了 srcItemOf），幸好是在测试里发现的。
 * 数据用真实的 /lookup 返回，不是编的。
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

/* ---------- 桩 DOM ---------- */
let idSeq = 0;
function makeNode(tag, cls) {
  const node = {
    id: ++idSeq, tag: tag, className: cls || '', children: [],
    dataset: {}, style: {}, _text: '', title: '', disabled: false, offsetWidth: 340, offsetHeight: 180,
    classList: {
      add(c) { if (node.className.indexOf(c) < 0) node.className += ' ' + c; },
      remove(c) { node.className = node.className.split(/\s+/).filter((x) => x !== c).join(' '); },
      contains(c) { return node.className.split(/\s+/).indexOf(c) >= 0; }
    },
    appendChild(c) { node.children.push(c); return c; },
    removeChild() {},
    remove() { node._removed = true; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    style_setProperty() {},
    getBoundingClientRect() { return { left: 100, top: 200, right: 160, bottom: 220, width: 60, height: 20 }; }
  };
  Object.defineProperty(node, 'textContent', {
    get() { return node._text; },
    set(v) { node._text = String(v); node.children.length = 0; }
  });
  return node;
}
const fakeDocument = { createTextNode(t) { const n = makeNode('#text'); n._text = t; return n; } };

/* ---------- 从脚本里抠真代码 ---------- */
const code = [
  extractFn(src, 'hideDictCard'),
  extractFn(src, 'speakWord'),
  extractFn(src, 'dictLine'),
  extractFn(src, 'placeDictCard'),
  extractFn(src, 'dictShell'),
  extractFn(src, 'aiButton'),
  extractFn(src, 'renderDictFound')
].join('\n\n');

const dictCard = makeNode('div', 'dictcard');
const shadow = { querySelectorAll() { return []; }, querySelector() { return null; } };
const CONFIG = { dictOnClick: true, localEndpoint: 'http://127.0.0.1:8787/translate' };
const fakeWindow = { innerWidth: 1440, innerHeight: 900, speechSynthesis: null };
let toastLog = [];

const api = new Function('el', 'document', 'shadow', 'dictCard', 'CONFIG', 'themeOf', 'showToast', 'dictUrl', 'dictWord', 'dictSentence', 'window',
  code + '\nreturn { dictLine, placeDictCard, dictShell, aiButton, renderDictFound };'
)(
  (t, c) => makeNode(t, c), fakeDocument, shadow, dictCard, CONFIG,
  () => 'light', (m) => toastLog.push(m), (k) => 'http://127.0.0.1:8787/' + k, '', '', fakeWindow
);

/* ---------- 把渲染结果打成文本 ---------- */
function toText(node, depth) {
  const pad = '  '.repeat(depth || 0);
  let out = '';
  const cls = (node.className || '').trim();
  const label = node.tag === '#text' ? '' : '[<' + node.tag + (cls ? ' class="' + cls + '"' : '') + '>] ';
  if (node._text) out += pad + label + node._text + '\n';
  else if (node.tag !== '#text') out += pad + label + '\n';
  (node.children || []).forEach((c) => { out += toText(c, (depth || 0) + 1); });
  return out;
}

function get(p) {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:8787' + p, (r) => {
      let c = []; r.on('data', (d) => c.push(d));
      r.on('end', () => res(JSON.parse(Buffer.concat(c).toString('utf8'))));
    }).on('error', rej);
  });
}

// 代理没开时用内置样本（这份是从真实 /lookup 抄下来的，不是编的）
// 这样这个测试只验证"渲染代码"，不再依赖代理在不在
const FIXTURES = {
  token: {
    ok: true, found: true, query: 'token', word: 'token', fromForm: null, baseForm: null,
    phonetic: "'tәukәn", collins: 2, oxford: 0, bnc: 6352, frq: 8924,
    tags: ['cet6', 'ky', 'ielts'], tagsCn: ['六级', '考研', '雅思'],
    definitions: ['n. 表征, 记号, 代币', 'a. 象征的, 表意的', '[计] 记号'],
    top: ['n. 表征, 记号, 代币', 'a. 象征的, 表意的'],
    techDefs: ['[计] 记号'], techNames: ['计算机'],
    definitionEn: ['n. an individual instance of a type of symbol', 'n. something serving as a sign of something else'],
    forms: ['tokens']
  },
  commit: {
    ok: true, found: true, query: 'commit', word: 'commit', fromForm: null, baseForm: null,
    phonetic: "kә'mit", collins: 4, oxford: 1, bnc: 1393, frq: 1394,
    tags: ['gk', 'cet4', 'cet6'], tagsCn: ['高考', '四级', '六级'],
    definitions: ['vt. 委托(托付), 犯罪, 指派...作战', '[法] 犯, 做, 把...交托给'],
    top: ['vt. 委托(托付), 犯罪, 指派...作战', '[法] 犯, 做, 把...交托给'],
    techDefs: [], techNames: [],
    definitionEn: ['v. cause to be admitted; of persons to an institution'],
    forms: ['committed', 'committing', 'commits']
  },
  committed: {
    ok: true, found: true, query: 'committed', word: 'committed', fromForm: null, baseForm: 'commit',
    phonetic: '', collins: 0, oxford: 0, bnc: 6359, frq: 6417,
    tags: ['toefl'], tagsCn: ['托福'],
    definitions: ['a. 献身于某种事业的', '[计] 委托的'],
    top: ['a. 献身于某种事业的'], techDefs: ['[计] 委托的'], techNames: ['计算机'],
    definitionEn: [], forms: ['committed', 'committeds']
  },
  xyzzyplugh: { ok: true, found: false, query: 'xyzzyplugh' }
};

async function getData(word) {
  try { return await get('/lookup?word=' + encodeURIComponent(word)); }
  catch (e) {
    const f = FIXTURES[word];
    if (f) return f;
    throw e;
  }
}

(async () => {
  const words = ['token', 'commit', 'committed', 'xyzzyplugh'];
  let fails = 0;

  for (const w of words) {
    const data = await getData(w);
    dictCard.children.length = 0;
    dictCard._text = '';
    const anchor = makeNode('span', 'w');
    console.log('════════════════ 渲染「' + w + '」' + (data.found ? '' : '（词典没有这个词）') + ' ════════════════');
    try {
      api.renderDictFound(w, data, anchor);
      console.log(toText(dictCard, 1));
    } catch (e) {
      fails++;
      console.log('  ❌ 渲染时抛错：' + e.message);
      console.log(e.stack.split('\n').slice(1, 4).map((l) => '     ' + l.trim()).join('\n'));
    }
  }

  /* 错误路径：代理不在时的兜底渲染 */
  console.log('════════════════ 错误路径（模拟词典查不到）════════════════');
  dictCard.children.length = 0;
  try {
    const b = api.dictShell('token', '');
    b.appendChild(api.dictLine('本地词典查不到：连不上代理', 'dwarn'));
    b.appendChild(api.dictLine('本地词典需要代理：双击 启动翻译代理.cmd', 'ddim'));
    console.log(toText(dictCard, 1));
  } catch (e) {
    fails++;
    console.log('  ❌ ' + e.message);
  }

  console.log('提示条调用记录: ' + JSON.stringify(toastLog));
  console.log('');
  console.log(fails === 0 ? '✅ 卡片渲染代码全部跑通，没有运行时错误' : '❌ 有 ' + fails + ' 处运行时错误');
})();
