/*
 * 端到端测试：在假浏览器里模拟"用户划了一段文字"，
 * 让真实脚本把整条链路跑完（划词 → 断句 → mask → 请求 → 还原 → 渲染），
 * 翻译请求真的发给本机代理。
 *
 * 【为什么这一步非做不可】
 * data/_test-words.js 和 _test-card.js 只测了单个函数；_test-load.js 只测了初始化。
 * "划词到出气泡"这条链路上真正容易炸的是各段之间的接缝：
 * 事件回调里的 DOM 操作、定时器、token 竞态、最终渲染。
 * 这些只有真的走一遍才会暴露。
 *
 * 放在 data/（不进仓库）。用法：node data/_test-e2e.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'easy-en-translate.user.js');
const code = fs.readFileSync(SRC, 'utf8');

const errors = [];
let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  X   ' + name + (extra ? '  -> ' + extra : '')); }
}

/* ---------------- DOM 桩 ---------------- */
const listeners = { document: {}, window: {}, shadow: {} };
const created = [];
let inHarnessInit = true;   // harness 自己造辅助对象时置 true，避免污染 created
let shadowRoot = null;

function makeEl(tag) {
  const el = {
    nodeType: 1,
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    childNodes: [],
    _text: '',
    style: { cssText: '', setProperty() {}, display: '' },
    dataset: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); }
    },
    value: '', title: '', type: '', href: '', target: '', rel: '', disabled: false,
    parentNode: null, id: '', autocomplete: '',
    offsetWidth: 480, offsetHeight: 220, isContentEditable: false,
    appendChild(c) { this.children.push(c); this.childNodes.push(c); c.parentNode = this; return c; },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      this.childNodes = this.childNodes.filter((x) => x !== c);
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(t, fn) { (listeners.shadow[t] = listeners.shadow[t] || []).push({ el: this, fn }); },
    removeEventListener() {},
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k]; },
    querySelector(sel) { return findIn(this, sel, true); },
    querySelectorAll(sel) { return findIn(this, sel, false); },
    closest(sel) { return closestOf(this, sel); },
    getBoundingClientRect() { return { left: 10, top: 10, right: 200, bottom: 30, width: 190, height: 20 }; },
    // 【必须给每个元素都配上这两个】
    // 脚本里是 host.attachShadow(...)，而 host 是 createElement 造出来的。
    // 少了它，脚本会在那一行抛 TypeError 静悄悄中止，测试里只看到"气泡数量 0"，很难查。
    attachShadow() { return shadowRoot; },
    getRootNode() { return shadowRoot; },
    focus() {}, select() {}, contains() { return false; }
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      if (this._text) return this._text;
      return this.children.map((c) => c.textContent || '').join('');
    },
    set(v) { this._text = String(v); this.children = []; this.childNodes = []; }
  });
  Object.defineProperty(el, 'firstChild', { get() { return this.children[0] || null; } });
  // 【className 和 classList 必须联动】
  // 脚本是 el('div','panel') 这样传类名的，内部走 className = 'panel'。
  // 假 DOM 里如果 className 和 classList 各记各的，那 findIn('.panel') 永远找不到 ——
  // 表现为"明明造出来了，测试却说 0 个"。这一处坑了很久。
  Object.defineProperty(el, 'className', {
    get() { return [...el.classList._s].join(' '); },
    set(v) {
      el.classList._s = new Set(String(v || '').split(/\s+/).filter(Boolean));
    }
  });
  if (!inHarnessInit) created.push(el);
  return el;
}

/* 极简选择器：只支持 ".a"、"div"、".a.b" 这几种，够用了 */
function matchesSimple(el, sel) {
  if (!el || el.nodeType !== 1 || !sel) return false;
  const classes = (sel.match(/\.[A-Za-z][\w-]*/g) || []).map((s) => s.slice(1));
  const tagPart = sel.replace(/\.[\w-]+/g, '').trim();
  if (tagPart && /^[A-Za-z]/.test(tagPart) && el.tagName !== tagPart.toUpperCase()) return false;
  return classes.every((c) => el.classList.contains(c));
}
function findIn(root, sel, one) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      if (matchesSimple(c, sel)) { out.push(c); if (one) return true; }
      if (walk(c) && one) return true;
    }
    return false;
  };
  walk(root);
  return one ? (out[0] || null) : out;
}
function closestOf(el, sel) {
  let n = el;
  while (n) { if (matchesSimple(n, sel)) return n; n = n.parentNode; }
  return null;
}

inHarnessInit = true;
shadowRoot = makeEl('shadow-root');
shadowRoot.querySelector = (s) => findIn(shadowRoot, s, true);
shadowRoot.querySelectorAll = (s) => findIn(shadowRoot, s, false);

const documentStub = {
  documentElement: makeEl('html'),
  body: makeEl('body'),
  createElement: (t) => makeEl(t),
  createTextNode: (t) => {
    const n = { nodeType: 3, textContent: String(t), children: [], parentNode: null };
    if (!inHarnessInit) created.push(n);
    return n;
  },
  createDocumentFragment: () => makeEl('fragment'),
  addEventListener(t, fn) { (listeners.document[t] = listeners.document[t] || []).push(fn); },
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  execCommand: () => true,
  getElementById: () => null
};

/* 假选区：内容是变量，测试中间改它 */
let selectedText = '';
const fakeSel = {
  isCollapsed: false,
  rangeCount: 1,
  anchorNode: null,
  focusNode: null,
  toString: () => selectedText,
  getRangeAt: () => ({
    getClientRects: () => [{ left: 10, top: 10, right: 200, bottom: 30, width: 190, height: 20 }],
    getBoundingClientRect: () => ({ left: 10, top: 10, right: 200, bottom: 30, width: 190, height: 20 })
  })
};

const store = new Map();
// 【诊断用】数一下脚本到底读了几次选区。
// 读 0 次 = 根本没走到 onSelectionSettled（卡在事件或 enabled 判断）；
// 读了 1 次但没渲染 = 卡在 onSelectionSettled 内部的某个卫语句。
let selectionReads = 0;
const windowStub = {
  innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false }),
  getSelection: () => { selectionReads++; return fakeSel; },
  addEventListener(t, fn) { (listeners.window[t] = listeners.window[t] || []).push(fn); },
  removeEventListener() {},
  speechSynthesis: null
};

const sandbox = {
  window: windowStub, document: documentStub,
  console: {
    log: () => {},
    warn: () => {},
    error: (...a) => errors.push('console.error: ' + a.join(' '))
  },
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  navigator: { clipboard: { writeText: async () => {} } },
  location: { href: 'https://example.com/' },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k)
  },
  Math, JSON, Date, Promise, Error, TypeError, String, Number, Boolean, Object, Array, Map, Set, WeakMap,
  RegExp, Intl, URL, AbortController, Symbol, Proxy, Reflect, BigInt, isNaN, parseInt, parseFloat,
  encodeURIComponent, decodeURIComponent,
  fetch: async () => { throw new Error('不该走 fetch，应该走 GM_xmlhttpRequest'); },
  alert: () => {},
  getComputedStyle: () => ({ backgroundColor: 'rgb(255, 255, 255)' }),
  GM_getValue: (k, d) => (store.has('gm.' + k) ? JSON.parse(store.get('gm.' + k)) : d),
  GM_setValue: (k, v) => store.set('gm.' + k, JSON.stringify(v)),
  GM_registerMenuCommand: () => {},
  // 真发给本机代理（用 Node 的 http，因为这里没有浏览器 fetch 的 CORS 限制）
  GM_xmlhttpRequest: (opts) => {
    const http = require('http');
    const u = new URL(opts.url);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opts.method || 'GET', headers: opts.headers || {}
    }, (r) => {
      let s = '';
      r.on('data', (c) => { s += c; });
      r.on('end', () => {
        try { opts.onload && opts.onload({ status: r.statusCode, responseText: s }); }
        catch (e) { errors.push('onload 里抛错: ' + e.message); }
      });
    });
    req.on('error', (e) => {
      try { opts.onerror && opts.onerror({ error: e.message }); }
      catch (e2) { errors.push('onerror 里抛错: ' + e2.message); }
    });
    if (opts.data) req.write(opts.data);
    req.end();
    return { abort() { try { req.destroy(); } catch (e) { /* ignore */ } } };
  }
};

process.on('unhandledRejection', (e) => errors.push('未处理的 Promise 拒绝: ' + (e && e.message)));
process.on('uncaughtException', (e) => errors.push('未捕获异常: ' + (e && e.message)));

const waitFor = (ms) => new Promise((r) => setTimeout(r, ms));

function dump() {
  console.log('');
  console.log('======== 全程错误汇总 ========');
  if (errors.length === 0) console.log('  一个错误都没有');
  else errors.forEach((e) => console.log('  X ' + e));
}

(async () => {
  console.log('======== 1. 加载脚本 ========');
  inHarnessInit = false;
  vm.createContext(sandbox);
  let loadErr = null;
  try {
    vm.runInContext(code, sandbox, { filename: 'easy-en-translate.user.js' });
  } catch (e) { loadErr = e; }
  ok('加载成功', !loadErr, loadErr ? loadErr.message : '');
  if (loadErr) { console.log(String(loadErr.stack).split('\n').slice(0, 5).join('\n')); process.exit(1); }

  const hostEl = documentStub.documentElement.children[0];
  console.log('  挂到 documentElement 的元素: ' + (hostEl ? hostEl.tagName + '.' + hostEl.className : '(无)'));
  console.log('  shadow 里的元素: ' + JSON.stringify(shadowRoot.children.map((c) => c.tagName + '.' + c.className)));

  console.log('');
  console.log('======== 2. 模拟用户划词 ========');
  const TEXT = 'Use Node.js, i.e. the runtime, to run it. See README.md for v1.2.3 notes.';
  selectedText = TEXT;
  console.log('  选中的文字: ' + JSON.stringify(TEXT));
  const mouseups = listeners.document['mouseup'] || [];
  ok('脚本挂上了 document mouseup 监听', mouseups.length > 0, '数量 ' + mouseups.length);
  mouseups.forEach((fn) => {
    try { fn({ button: 0, composedPath: () => [], clientX: 1, clientY: 1 }); }
    catch (e) { errors.push('mouseup 回调抛错: ' + e.message); }
  });

  await waitFor(9000);

  console.log('');
  console.log('======== 3. 气泡里渲染出了什么 ========');
  const panelEl = shadowRoot.children.find((c) => c.classList && c.classList.contains('panel'));
  if (!panelEl) {
    // 没走到渲染，就得知道卡在哪一步 —— 盲目猜会浪费大量时间
    const hdr = shadowRoot.children.length ? findIn(shadowRoot, '.hdr', true) : null;
    const bodyEl = findIn(shadowRoot, '.body', true);
    const hintEl = findIn(shadowRoot, '.hint', true);
    console.log('  诊断：shadow children = ' + JSON.stringify(shadowRoot.children.map((c) => c.tagName + '.' + c.className)));
    console.log('  诊断：找到 .hdr 吗 = ' + !!hdr + '  它的文字 = ' + JSON.stringify(hdr ? hdr.textContent : ''));
    console.log('  诊断：.body 的子节点数 = ' + (bodyEl ? bodyEl.children.length : 'n/a'));
    console.log('  诊断：.hint 的文字 = ' + JSON.stringify(hintEl ? hintEl.textContent : ''));
    const toastEl = shadowRoot.children.find((c) => c.classList && c.classList.contains('toast'));
    console.log('  诊断：toast 文字 = ' + JSON.stringify(toastEl ? toastEl.textContent : '(无 toast)'));
    console.log('  诊断：脚本读选区的次数 = ' + selectionReads + '（0 = 没走到 onSelectionSettled）');
    console.log('  诊断：mouseup 监听数量 = ' + (listeners.document['mouseup'] || []).length);
    console.log('  诊断：selectionchange 监听数量 = ' + (listeners.document['selectionchange'] || []).length);
  }
  ok('气泡被创建了', !!panelEl);
  ok('气泡被显示（有 on 类）', !!panelEl && panelEl.classList.contains('on'));
  if (!panelEl) { dump(); process.exit(1); }

  const rows = findIn(panelEl, '.row', false);
  console.log('  行数（= 分段数）= ' + rows.length);
  rows.forEach((r, i) => {
    const tgt = findIn(r, '.tgt', true);
    const src = findIn(r, '.src', true);
    console.log('  -- 第 ' + (i + 1) + ' 段');
    console.log('     译文: ' + JSON.stringify(String((tgt && tgt.textContent) || '').slice(0, 110)));
    console.log('     原文: ' + JSON.stringify(String((src && src.textContent) || '').slice(0, 110)));
  });

  const allTgt = rows.map((r) => { const x = findIn(r, '.tgt', true); return x ? x.textContent : ''; }).join('\n');
  const allSrc = rows.map((r) => { const x = findIn(r, '.src', true); return x ? x.textContent : ''; }).join('\n');

  console.log('');
  console.log('======== 4. 断言 ========');
  ok('没有 console.error', errors.filter((e) => e.indexOf('console.error') === 0).length === 0,
    errors.filter((e) => e.indexOf('console.error') === 0).join(' | '));
  ok('没有未捕获异常 / 未处理拒绝',
    errors.filter((e) => e.indexOf('未捕获') === 0 || e.indexOf('未处理') === 0).length === 0,
    errors.filter((e) => e.indexOf('未捕获') === 0 || e.indexOf('未处理') === 0).join(' | '));
  ok('分段数 = 2（修复前这条文本会碎成 3 段以上）', rows.length === 2, '实际 ' + rows.length);
  ok('译文里没有"翻译中"（说明都回来了）', allTgt.indexOf('翻译中') < 0);
  ok('译文里没有"翻译失败"', allTgt.indexOf('翻译失败') < 0, allTgt.slice(0, 200));
  ok('没有未还原占位符的告警', allTgt.indexOf('未还原') < 0, allTgt.slice(0, 200));
  ok('原文行里还原出了 Node.js', allSrc.indexOf('Node.js') >= 0, allSrc.slice(0, 200));
  ok('原文行里还原出了 README.md', allSrc.indexOf('README.md') >= 0, allSrc.slice(0, 200));
  ok('原文行里还原出了 v1.2.3', allSrc.indexOf('v1.2.3') >= 0, allSrc.slice(0, 200));
  ok('译文里能看到 Node.js（没被翻坏）', allTgt.indexOf('Node.js') >= 0, allTgt.slice(0, 200));

  console.log('');
  console.log('======== 5. 词典：点原文里的一个单词 ========');
  const words = findIn(panelEl, '.w', false);
  console.log('  可点击单词 ' + words.length + ' 个: ' + JSON.stringify(words.slice(0, 8).map((w) => w.dataset.w)));
  ok('原文渲染出了可点击单词', words.length > 0);

  const runtimeW = words.find((w) => w.dataset.w === 'runtime') || words[0];
  if (runtimeW) {
    const clicks = (listeners.shadow['click'] || []).filter((l) => l.el === shadowRoot);
    clicks.forEach((l) => {
      try { l.fn({ target: runtimeW, clientX: 12, clientY: 12, preventDefault() {}, stopPropagation() {} }); }
      catch (e) { errors.push('click 回调抛错: ' + e.message); }
    });
    await waitFor(3500);
    const card = shadowRoot.children.find((c) => c.classList && c.classList.contains('dictcard'));
    const cardText = card ? card.textContent : '';
    console.log('  卡片内容: ' + JSON.stringify(String(cardText).slice(0, 220)));
    ok('词典卡片弹出来了', !!card && card.classList.contains('on'));
    ok('卡片里不是卡在"查询中"', cardText.indexOf('查询中') < 0, String(cardText).slice(0, 120));
  }

  dump();

  console.log('');
  console.log('========================================');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})();
