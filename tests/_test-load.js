/*
 * 真机加载测试：在 Node 里造一个最小的浏览器环境，把 userscript 整个加载进去，
 * 让它的初始化代码（第 1879 行以后那一段：读存储、注册油猴菜单、buildSettings、
 * refreshChrome、首次提示……）真的跑一遍。
 *
 * 【为什么值得单独做这一步】
 * node --check 只验语法。这个脚本里大量"引用了不存在的名字 / 调了不存在的函数"
 * 的错误，语法完全合法，只有在初始化那一刻才会炸，而且炸的时候用户看到的现象是
 * "整脚本一点反应都没有"——没有任何提示，最难查。
 * 加载一遍能把这些一次性全抓出来。
 *
 * 放在 data/（不进仓库）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'easy-en-translate.user.js');
const code = fs.readFileSync(SRC, 'utf8');

/* ---------------- 最小 DOM 桩 ---------------- */
const calls = { menu: [], toast: [], storage: [] };
const store = new Map();

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    style: { cssText: '', setProperty() {}, display: '' },
    dataset: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); }
    },
    textContent: '',
    value: '',
    title: '',
    type: '',
    href: '',
    target: '',
    rel: '',
    disabled: false,
    parentNode: null,
    className: '',
    style_: {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(t, fn) { (this._ev = this._ev || {})[t] = fn; },
    removeEventListener() {},
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; },
    attachShadow() { return shadowRoot; },
    getRootNode() { return null; },
    focus() {},
    select() {},
    contains() { return false; },
    offsetWidth: 480,
    offsetHeight: 220,
    isContentEditable: false
  };
  Object.defineProperty(el, 'firstChild', { get() { return this.children[0] || null; } });
  return el;
}

const shadowRoot = (() => {
  const r = makeEl('shadow-root');
  r.host = null;
  return r;
})();
shadowRoot.querySelector = () => null;
shadowRoot.querySelectorAll = () => [];

const documentStub = {
  documentElement: makeEl('html'),
  body: makeEl('body'),
  createElement: (t) => makeEl(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  createDocumentFragment: () => makeEl('fragment'),
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  execCommand: () => true,
  getElementById: () => null
};

const windowStub = {
  innerWidth: 1280,
  innerHeight: 800,
  matchMedia: () => ({ matches: false }),
  getSelection: () => ({ isCollapsed: true, rangeCount: 0, toString: () => '' }),
  addEventListener() {},
  removeEventListener() {},
  speechSynthesis: null,
  __GH_SELECT_TRANSLATE__: undefined
};

const sandbox = {
  window: windowStub,
  document: documentStub,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  navigator: { clipboard: { writeText: async () => {} } },
  location: { href: 'https://example.com/' },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v); calls.storage.push(k); },
    removeItem: (k) => store.delete(k)
  },
  Math, JSON, Date, Promise, Error, TypeError, String, Number, Boolean, Object, Array, Map, Set, WeakMap,
  RegExp, Intl, URL, AbortController, Symbol, Proxy, Reflect, BigInt, isNaN, parseInt, parseFloat,
  encodeURIComponent, decodeURIComponent, fetch: async () => { throw new Error('不该发真请求'); },
  alert: (msg) => { calls.toast.push('alert: ' + String(msg).slice(0, 60)); },
  getComputedStyle: () => ({ backgroundColor: 'rgb(255, 255, 255)' }),
  // 让 hasGM = true，走油猴那条分支（更接近真实环境）
  GM_getValue: (k, d) => (store.has('gm.' + k) ? JSON.parse(store.get('gm.' + k)) : d),
  GM_setValue: (k, v) => { store.set('gm.' + k, JSON.stringify(v)); calls.storage.push('gm.' + k); },
  GM_registerMenuCommand: (label, fn) => { calls.menu.push({ label, fn }); },
  GM_xmlhttpRequest: () => ({ abort() {} })
};

/* ---------------- 加载 ---------------- */
console.log('════════ 1. 在假浏览器里整脚本加载一遍 ════════');
let loadError = null;
try {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'easy-en-translate.user.js' });
} catch (e) {
  loadError = e;
}
if (loadError) {
  console.log('  ❌ 加载就炸了（说明初始化路径里有 bug）：');
  console.log('     ' + loadError.constructor.name + ': ' + loadError.message);
  console.log('     ' + String(loadError.stack).split('\n').slice(0, 4).join('\n     '));
} else {
  console.log('  ✅ 加载成功，没有抛错');
}

console.log('');
console.log('════════ 2. 初始化真的做了事吗 ════════');
console.log('  注册的油猴菜单 = ' + calls.menu.length + ' 个');
calls.menu.forEach((m, i) => console.log('     ' + (i + 1) + '. ' + m.label));
console.log('  写过的存储键 = ' + JSON.stringify([...new Set(calls.storage)]));
console.log('  防重复标记 window.__GH_SELECT_TRANSLATE__ = ' + windowStub.__GH_SELECT_TRANSLATE__);

console.log('');
console.log('════════ 3. 逐个调用每个菜单命令（最容易炸的地方）════════');
let menuFail = 0;
for (const m of calls.menu) {
  try {
    m.fn();
    console.log('  ✅ ' + m.label);
  } catch (e) {
    menuFail++;
    console.log('  ❌ ' + m.label + '  → ' + e.constructor.name + ': ' + e.message);
  }
}

console.log('');
console.log('════════ 4. 再加载一次（验防重复）════════');
{
  const before = calls.menu.length;
  try {
    vm.runInContext(code, sandbox, { filename: 'again.js' });
    console.log('  ✅ 第二次加载没抛错，菜单数量没变（' + before + ' → ' + calls.menu.length + '）：防重复生效');
  } catch (e) {
    console.log('  ❌ 第二次加载抛错了：' + e.message);
  }
}

console.log('');
console.log('════════════════════════════════════════');
if (loadError || menuFail) {
  console.log('  有 ' + ((loadError ? 1 : 0) + menuFail) + ' 处运行时问题，见上');
  process.exit(1);
}
console.log('  ✅ 初始化与全部菜单命令都跑通了，没有运行时错误');
console.log('════════════════════════════════════════');
