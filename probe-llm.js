/*
 * 探测 DSH 模型线路（deepseek-official）能否用于翻译
 * 读 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY，调用 OpenAI 兼容 /chat/completions
 * 不打印密钥本身。
 *
 * 用法： node probe-llm.js [model]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

function readKey() {
  if (process.env.DEEPSEEK_API_KEY) return { key: process.env.DEEPSEEK_API_KEY, from: '环境变量 DEEPSEEK_API_KEY' };
  const f = path.join(dshHome, '.credentials.yaml');
  if (fs.existsSync(f)) {
    const m = fs.readFileSync(f, 'utf8').match(/DEEPSEEK_API_KEY:\s*(\S+)/);
    if (m) return { key: m[1], from: f };
  }
  return null;
}

function readRoute() {
  const f = path.join(dshHome, 'settings.yaml');
  let model = 'deepseek-v4-flash';
  if (fs.existsSync(f)) {
    const s = fs.readFileSync(f, 'utf8');
    const m = s.match(/agent-default-model:[\s\S]*?model:\s*(\S+)/);
    if (m) model = m[1];
  }
  return { baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', model };
}

const cred = readKey();
if (!cred) { console.error('找不到 DEEPSEEK_API_KEY'); process.exit(1); }
const route = readRoute();
const model = process.argv[2] || route.model;

console.log('密钥来源：' + cred.from + '（长度 ' + cred.key.length + '，前缀 ' + cred.key.slice(0, 5) + '…）');
console.log('接入地址：' + route.baseURL);
console.log('模型：' + model);
console.log('');

const SRC = 'Fork this repository and create a pull request. Commit messages follow the Conventional Commits spec, and the `build.sh` script runs on Node.js 18 or later.';

async function call(label, extra) {
  const body = Object.assign({
    model,
    messages: [
      { role: 'system', content: '你是技术文档翻译引擎。把用户给的英文翻译成简体中文，保留代码、命令、路径、版本号原样不译。只输出译文，不要解释。' },
      { role: 'user', content: SRC }
    ],
    max_tokens: 800,
    stream: false
  }, extra || {});

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(route.baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cred.key },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.log('[' + label + '] ❌ 网络失败：' + e.message);
    return;
  }
  const ms = Date.now() - t0;
  const raw = await res.text();

  if (!res.ok) {
    console.log('[' + label + '] ❌ HTTP ' + res.status + '（' + ms + 'ms）');
    console.log('    ' + raw.slice(0, 300));
    return;
  }

  let data;
  try { data = JSON.parse(raw); } catch (e) { console.log('[' + label + '] ❌ 非 JSON：' + raw.slice(0, 200)); return; }

  const choice = (data.choices || [])[0] || {};
  const msg = choice.message || {};
  console.log('[' + label + '] ✅ HTTP 200，' + ms + 'ms，finish=' + choice.finish_reason);
  console.log('    译文：' + String(msg.content || '').trim().replace(/\n/g, ' / '));
  if (msg.reasoning_content) console.log('    （含思考内容 ' + msg.reasoning_content.length + ' 字符）');
  if (data.usage) console.log('    usage: prompt=' + data.usage.prompt_tokens + ' completion=' + data.usage.completion_tokens);
  console.log('');
}

(async () => {
  await call('默认参数', {});
  await call('关闭思考 thinking.disabled', { thinking: { type: 'disabled' } });
  await call('reasoning_effort=minimal', { reasoning_effort: 'minimal' });
})();
