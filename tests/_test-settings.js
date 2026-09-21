/*
 * 运行时测试：把「设置面板」的构建代码抠出来真跑
 * 重点验证：① 面板能建出来不报错 ② 各服务商的「怎么拿 key」指引是否都正确生成
 *          ③ 切换服务商时指引会不会跟着变
 */
const fs = require('fs');
const path = require('path');

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
  if (start < 0) throw new Error('找不到常量：' + name);
  const end = text.indexOf('\n  ];', start);
  return text.slice(start, end + 4);
}

/* ---------- 桩 DOM（支持事件处理器与查找） ---------- */
let idSeq = 0;
function makeNode(tag, cls) {
  const node = {
    id: ++idSeq, tag, className: cls || '', children: [], handlers: {},
    dataset: {}, style: {}, _text: '', title: '', disabled: false,
    offsetWidth: 340, offsetHeight: 180,
    classList: {
      add(c) { if (node.className.indexOf(c) < 0) node.className += ' ' + c; },
      remove(c) { node.className = node.className.split(/\s+/).filter((x) => x !== c).join(' '); },
      contains(c) { return node.className.split(/\s+/).indexOf(c) >= 0; }
    },
    appendChild(c) { node.children.push(c); return c; },
    remove() {}, removeChild() {},
    addEventListener(t, fn) { node.handlers[t] = fn; },
    getBoundingClientRect() { return { left: 100, top: 200, right: 160, bottom: 220 }; }
  };
  Object.defineProperty(node, 'textContent', {
    get() { return node._text; },
    set(v) { node._text = String(v); node.children.length = 0; }
  });
  return node;
}
function walk(node, fn) {
  fn(node);
  (node.children || []).forEach((c) => walk(c, fn));
}
function find(node, pred) {
  let hit = null;
  walk(node, (n) => { if (!hit && pred(n)) hit = n; });
  return hit;
}
function textOf(node, depth) {
  const pad = '  '.repeat(depth || 0);
  let out = '';
  const cls = (node.className || '').trim();
  if (node._text) out += pad + (node.tag === 'a' ? '[链接] ' : '') + node._text + '\n';
  else if (node.tag && node.tag !== 'input' && node.tag !== 'option') {
    out += pad + '<' + node.tag + (cls ? ' class="' + cls + '"' : '') + '>\n';
  }
  (node.children || []).forEach((c) => { out += textOf(c, (depth || 0) + 1); });
  return out;
}

/* ---------- 抠真代码 ---------- */
const code = [
  extractConst(src, 'PRESETS'),
  extractFn(src, 'settingsRow'),
  extractFn(src, 'buildSettings')
].join('\n\n');

const settingsPanel = makeNode('div', 'settings');
const storeLog = [];
const store = {
  data: {},
  get(k, d) { return store.data[k] === undefined ? d : store.data[k]; },
  set(k, v) { store.data[k] = v; storeLog.push(k + '=' + JSON.stringify(v).slice(0, 40)); }
};
const CONFIG = { direct: { preset: '', baseURL: '', model: '', apiKey: '' }, provider: 'dsh' };
let blockNotice = '';
let toastLog = [];
let testCallCount = 0;

const api = new Function(
  'el', 'settingsPanel', 'CONFIG', 'store', 'themeOf', 'showToast', 'closeSettings', 'blockNotice',
  'directCall',
  code + '\nreturn { buildSettings };'
)(
  (t, c) => makeNode(t, c), settingsPanel, CONFIG, store, () => 'light',
  (m) => toastLog.push(m), () => { }, blockNotice,
  () => { testCallCount++; return Promise.resolve('ok'); }
);

console.log('==================== 1. 构建设置面板 ====================');
let ok = true;
try {
  api.buildSettings();
  console.log('  ✅ 构建成功，没有运行时错误');
} catch (e) {
  ok = false;
  console.log('  ❌ 构建时抛错：' + e.message);
  console.log(e.stack.split('\n').slice(1, 4).map((l) => '     ' + l.trim()).join('\n'));
}

console.log('');
console.log('==================== 2. 默认（DeepSeek）渲染出来的内容 ====================');
if (ok) console.log(textOf(settingsPanel, 1));

console.log('==================== 3. 逐个服务商检查指引 ====================');
if (ok) {
  const sel = find(settingsPanel, (n) => n.tag === 'select');
  if (!sel) {
    console.log('  ❌ 找不到服务商下拉框');
  } else {
    const ids = ['deepseek', 'openai', 'openrouter', 'moonshot', 'zhipu', 'dashscope', 'custom'];
    ids.forEach((id) => {
      sel.value = id;
      try {
        sel.handlers.change();
        const guide = find(settingsPanel, (n) => n.className === 'sguide');
        const steps = [];
        walk(guide, (n) => { if (n.className === 'sstep') steps.push(n._text); });
        const link = find(guide, (n) => n.tag === 'a');
        const filled = find(settingsPanel, (n) => n.tag === 'input' && n.placeholder === 'https://api.deepseek.com');
        console.log('  ' + id.padEnd(11) +
          ' 步骤=' + steps.length + ' 条' +
          '  链接=' + (link ? link.href.replace(/^https?:\/\//, '').slice(0, 32) : '无') +
          '  地址自动填=' + (filled && filled.value ? '是' : '否'));
      } catch (e) {
        ok = false;
        console.log('  ❌ ' + id + ' 切换时报错：' + e.message);
      }
    });
  }
}

console.log('');
console.log('==================== 4. 确认 Ollama 和免费试用已移除 ====================');
const srcAll = src;
console.log('  PRESETS 里还有 ollama 吗: ' + (srcAll.indexOf("id: 'ollama'") >= 0 ? '❌ 还有' : '✅ 已移除'));
console.log('  设置页还提 Ollama 吗:     ' + (srcAll.indexOf('选「本地 Ollama」') >= 0 ? '❌ 还提' : '✅ 已移除'));
console.log('  引擎循环只剩两个选项:      ' + (srcAll.indexOf("const order = ['dsh', 'openai']") >= 0 ? '✅' : '❌'));

console.log('');
console.log(ok ? '✅ 设置面板构建与指引渲染全部通过' : '❌ 有错误，见上');
