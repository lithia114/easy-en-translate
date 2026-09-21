/*
 * 实测「直连 AI」路径：把用户脚本里的 directCall / directPrompt 抠出来真跑
 * 用 Node 的 fetch 冒充 httpRequest（浏览器里那个是 GM_xmlhttpRequest）
 * 目的：确认请求格式、URL 拼法、预设模型名都是对的
 */
const fs = require('fs');
const os = require('os');
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

// 从 DSH 配置里读钥匙（只用于测试；脚本本身不含钥匙）
const credFile = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml');
const KEY = (fs.readFileSync(credFile, 'utf8').match(/DEEPSEEK_API_KEY:\s*(\S+)/) || [])[1];
if (!KEY) { console.error('读不到钥匙'); process.exit(1); }

// 用 Node fetch 冒充用户脚本里的 httpRequest
function httpRequest(opts) {
  return fetch(opts.url, {
    method: opts.method,
    headers: opts.headers,
    body: opts.data
  }).then((r) => r.text().then((t) => ({ status: r.status, text: t })));
}

const CONFIG = { direct: { baseURL: '', model: '', apiKey: '' } };

const api = new Function('httpRequest', 'CONFIG',
  extractFn(src, 'directReady') + '\n' +
  extractFn(src, 'directPrompt') + '\n' +
  extractFn(src, 'directCall') + '\n' +
  'return { directReady, directPrompt, directCall };'
)(httpRequest, CONFIG);

/* ---------- 1. 预设里的 URL 拼法 ---------- */
console.log('==================== 1. URL 拼接检查（各预设）====================');
const PRESETS = [
  ['DeepSeek', 'https://api.deepseek.com', 'deepseek-chat'],
  ['OpenAI', 'https://api.openai.com/v1', 'gpt-4o-mini'],
  ['OpenRouter', 'https://openrouter.ai/api/v1', 'x'],
  ['Ollama 本地', 'http://127.0.0.1:11434/v1', 'llama3.1'],
  ['带尾部斜杠', 'https://api.deepseek.com/', 'x']
];
PRESETS.forEach(function (p) {
  const url = String(p[1]).replace(/\/+$/, '') + '/chat/completions';
  console.log('  ' + p[0].padEnd(14) + p[1].padEnd(38) + ' → ' + url);
});

/* ---------- 2. 提示词 ---------- */
console.log('');
console.log('==================== 2. 直连用的翻译提示词（多行时）====================');
console.log(api.directPrompt('简体中文', 3).split('\n').map(function (l) { return '  ' + l; }).join('\n'));

/* ---------- 3. 真连一次 ---------- */
(async () => {
  console.log('');
  console.log('==================== 3. 真连测试 ====================');
  for (const model of ['deepseek-chat', 'deepseek-v4-flash']) {
    CONFIG.direct = { baseURL: 'https://api.deepseek.com', model: model, apiKey: KEY };
    console.log('');
    console.log('  模型 "' + model + '"：ready=' + api.directReady());
    const t0 = Date.now();
    try {
      const txt = await api.directCall(CONFIG.direct, 'Reply with the single word: ok', '只输出 ok 这个词');
      console.log('     ✅ 成功（' + (Date.now() - t0) + ' ms）：' + JSON.stringify(txt));
    } catch (e) {
      console.log('     ❌ 失败（' + (Date.now() - t0) + ' ms）：' + e.message);
    }
  }

  /* ---------- 4. 模拟真实翻译（含占位符） ---------- */
  console.log('');
  console.log('==================== 4. 模拟一次真实翻译（多行 + 占位符）====================');
  CONFIG.direct = { baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: KEY };
  const masked = 'Run [[0]] before [[1]].\nCommit your changes before switching branches.';
  const t0 = Date.now();
  try {
    const out = await api.directCall(CONFIG.direct, masked, api.directPrompt('简体中文', 2));
    console.log('  输入 2 行：');
    console.log('    ' + masked.split('\n').join('\n    '));
    console.log('  输出（' + (Date.now() - t0) + ' ms）：');
    console.log('    ' + out.split('\n').join('\n    '));
    console.log('  行数对不对: ' + (out.split('\n').filter(Boolean).length === 2 ? '✅ 2 行' : '❌ ' + out.split('\n').length + ' 行'));
    console.log('  占位符保住了吗: ' + (/\[\[0\]\]/.test(out) && /\[\[1\]\]/.test(out) ? '✅' : '❌ 丢了'));
  } catch (e) {
    console.log('  ❌ ' + e.message);
  }
})();
