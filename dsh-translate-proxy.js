/*
 * DSH 本地翻译代理
 * ---------------------------------------------------------------
 * 复用 DSH 自己的模型线路（默认 provider: deepseek-official →
 * https://api.deepseek.com），给浏览器里的划词脚本提供一个本机 HTTP 端点。
 *
 *   POST /translate   { text, from, to }  →  { translation, cached, ms, model }
 *   GET  /health                          →  运行状态自检
 *   POST /translate   { text, ..., noCache: true }   跳过缓存
 *
 * 为什么用代理而不是把密钥写进用户脚本：
 *   1. 密钥留在 ~/.dsh/.credentials.yaml，不进浏览器扩展存储
 *   2. 可以缓存（重复划同一个词零成本、零延迟）
 *   3. 提示词、术语表、模型选择都能随时改，不用重装脚本
 *   4. 其他工具（编辑器、命令行）也能复用这个端点
 *
 * 启动：node dsh-translate-proxy.js
 * 环境变量：TRANSLATE_PORT(8787) TRANSLATE_MODEL(deepseek-v4-flash)
 *           DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL 可覆盖 DSH 配置
 * ---------------------------------------------------------------
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.TRANSLATE_PORT || 8787);
const HOST = '127.0.0.1';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CACHE_FILE = path.join(__dirname, '.translate-cache.json');
const CACHE_LIMIT = 1000;
const MAX_BODY = 256 * 1024;
const MAX_CONCURRENT = 3;
const UPSTREAM_TIMEOUT = 45000;
const DEFAULT_BASE_URL = 'https://api.deepseek.com';

// ---------------------------------------------------------------
// 安全开关：拒绝来自「网页」的跨源请求
// ---------------------------------------------------------------
// 为什么必须做：CORS 只阻止网页“读取”响应，**不阻止请求本身被执行**。
// 恶意网页只要用 text/plain 发一个“简单请求”，就能绕过浏览器预检，
// 直接调用本代理、消耗你的 API 额度（钱）。
//
// 判定依据：浏览器发起的网页请求一定带 http(s):// 的 Origin 请求头；
// 而油猴的 GM_xmlhttpRequest（扩展发起）和命令行工具都不带网页源。
//
// 万一这个开关导致划词翻译失效（理论上不会），临时关掉即可恢复：
//   $env:TRANSLATE_ALLOW_WEB_ORIGINS=1   然后重启代理
const BLOCK_WEB_ORIGINS = process.env.TRANSLATE_ALLOW_WEB_ORIGINS !== '1';

/* ------------------------- 配置读取 ------------------------- */

// 返回值里有两个"来源"字段，别搞混：
//   source —— 详细来源，可能是完整本地路径。只用在【本机控制台日志】里，用户自己看。
//   via    —— 简短标签，不含任何路径。用在【HTTP 响应】里。
//
// 为什么要分两个？因为 /health 是能被本机任何进程访问的接口，
// 把「用户主目录下 .dsh/.credentials.yaml 的完整路径」吐出去，
// 等于白送对方一个用户名和目录结构，没有必要。
// 密钥本身本来就不会返回（只返回有没有），这里只是顺手把路径也收掉。
function readCredentials() {
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      key: process.env.DEEPSEEK_API_KEY,
      source: '环境变量 DEEPSEEK_API_KEY',
      via: '环境变量'
    };
  }
  const candidates = [path.join(DSH_HOME, '.credentials.yaml')];
  for (const f of candidates) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(/DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)/);
      if (m) return { key: m[1], source: f, via: '配置文件' };
    } catch (e) { /* 继续找 */ }
  }
  return null;
}

function readDshDefaults() {
  const out = { baseURL: DEFAULT_BASE_URL, model: 'deepseek-v4-flash' };
  try {
    const s = fs.readFileSync(path.join(DSH_HOME, 'settings.yaml'), 'utf8');
    const m = s.match(/agent-default-model:[\s\S]*?model:\s*(\S+)/);
    if (m) out.model = m[1].replace(/["']/g, '');
  } catch (e) { /* 用默认 */ }
  try {
    // llm-deepseek 分节里若显式配了 baseURL 就用它
    const s = fs.readFileSync(path.join(DSH_HOME, 'settings.yaml'), 'utf8');
    const m = s.match(/llm-deepseek:[\s\S]*?baseURL:\s*(\S+)/);
    if (m) out.baseURL = m[1].replace(/["']/g, '');
  } catch (e) { /* 用默认 */ }
  if (process.env.DEEPSEEK_BASE_URL) out.baseURL = process.env.DEEPSEEK_BASE_URL;
  return out;
}

const dshDefaults = readDshDefaults();
const BASE_URL = dshDefaults.baseURL.replace(/\/+$/, '');
const MODEL = process.env.TRANSLATE_MODEL || dshDefaults.model;

/* ------------------------- 提示词 ------------------------- */

const LANG_NAME = {
  'zh-CN': '简体中文', zh: '简体中文', en: '英文', ja: '日文', ko: '韩文', ru: '俄文', auto: '目标语言'
};

const GLOSSARY = [
  ['repository', '仓库'], ['repo', '仓库'], ['pull request', '拉取请求'], ['PR', 'PR'],
  ['commit', '提交'], ['issue', '议题'], ['fork', '分叉'], ['merge', '合并'],
  ['branch', '分支'], ['release', '发布'], ['dependency', '依赖'], ['build', '构建'],
  ['deploy', '部署'], ['workflow', '工作流'], ['registry', '镜像仓库'], ['patch', '补丁']
];

function systemPrompt(targetName, segmentCount) {
  const rules = [
    '你是资深技术文档译者，服务对象是正在阅读 GitHub 的开发者。',
    '规则：',
    '1. 把输入准确翻译成' + targetName + '，语气简洁、书面、专业，符合技术文档习惯。',
    '2. 输入中形如 [[0]]、[[12]] 的编号占位符代表代码、命令、路径、版本号、提交 SHA 等，必须原样保留在译文对应位置，不得改写、增删或调整顺序。',
    '3. 绝对不要自己创造这种占位符。输入里没有 [[数字]] 时，把原文的反引号、引号、括号等格式原样保留即可。',
    '4. 保留英文专有名词与品牌原始写法：GitHub、Node.js、npm、Docker、JSON 等。',
    '5. 术语统一：' + GLOSSARY.map(([a, b]) => a + '=' + b).join('、') + '。',
    '6. 只输出译文。不要解释、不要加引号、不要加"翻译："之类前缀、不要输出 markdown 代码块包裹。'
  ];
  if (segmentCount > 1) {
    rules.push('7. 输入是 ' + segmentCount + ' 个独立段落，每行一段。逐段翻译，输出 JSON：{"segments":["第一段译文","第二段译文", ...]}，数组长度必须严格等于 ' + segmentCount + '，顺序与输入完全一致。');
  }
  return rules.join('\n');
}

/* ------------------------- 缓存 ------------------------- */

const cache = new Map();

function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    for (const k of Object.keys(raw)) cache.set(k, raw[k]);
    log('已载入缓存 ' + cache.size + ' 条');
  } catch (e) { /* 首次运行没有缓存文件 */ }
}

let saveTimer = null;

// 同步落盘：任何"马上就要退出"的路径都必须用它。
// 为什么必须是同步的：saveCacheSoon 用的是 fs.writeFile（异步）+ 1000ms 延迟，
// 进程一旦退出，那个定时器根本没机会跑 —— 刚翻好的那几条就永远丢了。
// 同步写最多几十毫秒，只在退出时发生一次，代价可以接受。
function flushCacheSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  const obj = {};
  for (const [k, v] of cache) obj[k] = v;
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
    return cache.size;
  } catch (e) {
    log('缓存写入失败：' + e.message);
    return -1;
  }
}

function saveCacheSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    const obj = {};
    for (const [k, v] of cache) obj[k] = v;
    fs.writeFile(CACHE_FILE, JSON.stringify(obj), (e) => {
      if (e) log('缓存写入失败：' + e.message);
    });
  }, 1000);
}

/* ------------------------- 日志 ------------------------- */

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log('[' + t + '] ' + msg);
}

/* ------------------------- 调用模型 ------------------------- */

let inflight = 0;
const waiters = [];

function acquire() {
  if (inflight < MAX_CONCURRENT) { inflight++; return Promise.resolve(); }
  return new Promise((resolve) => waiters.push(resolve));
}
function release() {
  inflight--;
  const next = waiters.shift();
  if (next) { inflight++; next(); }
}

async function callModel(messages, opts) {
  const o = opts || {};
  const cred = readCredentials();
  if (!cred) throw new Error('读不到 DEEPSEEK_API_KEY（检查 ' + DSH_HOME + '\\.credentials.yaml）');

  const body = {
    model: MODEL,
    messages,
    stream: false,
    temperature: 0,
    max_tokens: o.maxTokens || 2048,
    thinking: { type: 'disabled' }     // 实测：输出 token 大幅下降，翻译质量不变
  };
  if (o.json) body.response_format = { type: 'json_object' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT);
  let res;
  try {
    res = await fetch(BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cred.key },
      body: JSON.stringify(body),
      signal: ac.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('模型请求超时（' + UPSTREAM_TIMEOUT + 'ms）');
    throw new Error('连不上模型线路 ' + BASE_URL + '：' + e.message);
  }
  clearTimeout(timer);

  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 300);
    try { const j = JSON.parse(raw); detail = (j.error && (j.error.message || j.error.code)) || detail; } catch (e) { /* 原样 */ }
    if (res.status === 401) detail = '密钥无效或已过期（' + detail + '）';
    if (res.status === 402) detail = '账户余额不足（' + detail + '）';
    if (res.status === 429) throw Object.assign(new Error('触发限流：' + detail), { rateLimit: true });
    throw new Error('模型接口 HTTP ' + res.status + '：' + detail);
  }

  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error('模型返回非 JSON：' + raw.slice(0, 200)); }
  const choice = (data.choices || [])[0];
  if (!choice) throw new Error('模型返回没有 choices：' + raw.slice(0, 200));
  return {
    content: String((choice.message && choice.message.content) || '').trim(),
    finish: choice.finish_reason,
    usage: data.usage || null
  };
}

/* ------------------------- 翻译逻辑 ------------------------- */

function stripFence(s) {
  const m = String(s).trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1].trim() : String(s).trim();
}

async function translateText(text, from, to) {
  const lines = String(text).split('\n').map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('待翻译文本为空');

  const targetName = LANG_NAME[to] || to;
  const maxTokens = Math.min(8000, Math.max(512, Math.ceil(text.length * 1.6) + 96));

  if (lines.length === 1) {
    const r = await callModel([
      { role: 'system', content: systemPrompt(targetName, 1) },
      { role: 'user', content: lines[0] }
    ], { maxTokens });
    if (!r.content) throw new Error('模型返回空译文');
    return { translation: stripFence(r.content), usage: r.usage, finish: r.finish };
  }

  const joined = lines.join('\n');
  let lastUsage = null;
  let lastFinish = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await callModel([
      { role: 'system', content: systemPrompt(targetName, lines.length) },
      { role: 'user', content: joined }
    ], { json: true, maxTokens });
    lastUsage = r.usage;
    lastFinish = r.finish;

    let arr = null;
    try {
      const parsed = JSON.parse(stripFence(r.content));
      if (Array.isArray(parsed)) arr = parsed;
      else if (parsed && Array.isArray(parsed.segments)) arr = parsed.segments;
      else if (parsed && Array.isArray(parsed.translation)) arr = parsed.translation;
      else if (parsed && typeof parsed.translations === 'object') {
        const keys = Object.keys(parsed.translations).sort((a, b) => Number(a) - Number(b));
        arr = keys.map((k) => parsed.translations[k]);
      }
    } catch (e) { /* 落到下一轮 */ }

    if (arr && arr.length === lines.length) {
      return {
        translation: arr.map((s) => String(s == null ? '' : s).trim()).join('\n'),
        usage: lastUsage,
        finish: lastFinish
      };
    }
    log('段落数对不上（期望 ' + lines.length + '，拿到 ' + (arr ? arr.length : 'null') + '），重试一次');
  }

  // 兜底：逐段单独翻，保证对照不错位
  log('JSON 对齐失败，回退逐段翻译');
  const out = [];
  for (const line of lines) {
    const r = await callModel([
      { role: 'system', content: systemPrompt(targetName, 1) },
      { role: 'user', content: line }
    ], { maxTokens: Math.min(4000, Math.max(400, Math.ceil(line.length * 1.6) + 96)) });
    out.push(stripFence(r.content));
  }
  return { translation: out.join('\n'), usage: lastUsage, finish: lastFinish };
}

/* ------------------------- 本地词典（ECDICT） ------------------------- */

// 数据来源：ECDICT（MIT 许可，77 万词条），由 build-dict.js 转成 SQLite。
// 只读打开，多个查询互不影响；词典不存在时功能优雅降级（返回明确提示，不影响翻译）。
const DICT_FILE = path.join(__dirname, 'data', 'ecdict.db');
let dictDb = null;
let dictErr = null;

const TAG_CN = {
  zk: '中考', gk: '高考', cet4: '四级', cet6: '六级',
  ky: '考研', toefl: '托福', ielts: '雅思', gre: 'GRE'
};

// 领域标注：ECDICT 的释义里带 [计] [网] 这类前缀，正好当作"编程义"白送
const TECH_MARKS = ['[计]', '[网]', '[电]'];
const TECH_MARK_NAMES = { '[计]': '计算机', '[网]': '网络', '[电]': '电子' };

function openDict() {
  if (dictDb || dictErr) return dictDb;
  if (!fs.existsSync(DICT_FILE)) {
    dictErr = '词典数据库不存在（先运行 node build-dict.js 生成 data/ecdict.db）';
    return null;
  }
  try {
    const { DatabaseSync } = require('node:sqlite');
    let d;
    try { d = new DatabaseSync(DICT_FILE, { readOnly: true }); }
    catch (e) { d = new DatabaseSync(DICT_FILE); }
    dictDb = d;
    const n = dictDb.prepare('SELECT COUNT(*) AS c FROM dict').get().c;
    log('本地词典已加载：' + n + ' 词条');
  } catch (e) {
    dictErr = '打开词典失败：' + e.message;
  }
  return dictDb;
}

// ECDICT 的释义用「字面量 \n」（反斜杠 + n）分隔多条释义，这里统一转成数组
function splitDefs(s) {
  return String(s || '')
    .replace(/\\n/g, '\n')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
}

// 从 exchange 字段里取变形列表和原形，格式如：
//   p:perceived/i:perceiving/3:perceives/d:perceived/s:perceives/0:perceive/1:p
//   0 = 原形，1 = 原形变化类型，其余是各种变形
function parseExchange(exchange) {
  const forms = [];
  let base = '';
  if (!exchange) return { forms, base };
  for (const part of String(exchange).split('/')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const k = part.slice(0, i);
    const v = part.slice(i + 1);
    if (!v) continue;
    if (k === '0') base = v;
    else if (k !== '1') forms.push(v);
  }
  return { forms, base };
}

function lookupWord(word) {
  const db = openDict();
  if (!db) return { ok: false, error: dictErr };

  const q = db.prepare(
    'SELECT word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange ' +
    'FROM dict WHERE word = ?'
  );
  let row = q.get(word);
  let viaForm = null;

  // 精确匹配失败时，尝试"变形 -> 原形"（committed -> commit）
  if (!row) {
    const f = db.prepare('SELECT base FROM forms WHERE form = ?').get(String(word).toLowerCase());
    if (f && f.base) {
      row = q.get(f.base);
      if (row) viaForm = f.base;
    }
  }

  if (!row) return { ok: true, found: false, query: word };

  const defs = splitDefs(row.translation);
  const tech = defs.filter((d) => TECH_MARKS.some((m) => d.indexOf(m) >= 0));
  const { forms, base } = parseExchange(row.exchange);

  return {
    ok: true,
    found: true,
    query: word,
    word: row.word,
    fromForm: viaForm,                                  // 非空表示"是由变形词还原来的"
    baseForm: base && base.toLowerCase() !== String(row.word).toLowerCase() ? base : null,
    phonetic: row.phonetic || '',
    collins: row.collins || 0,
    oxford: row.oxford || 0,
    bnc: row.bnc || 0,
    frq: row.frq || 0,
    tags: String(row.tag || '').split(/\s+/).filter(Boolean),
    tagsCn: String(row.tag || '').split(/\s+/).filter(Boolean).map((t) => TAG_CN[t] || t),
    definitions: defs,                                  // 全部中文释义
    top: defs.filter((d) => TECH_MARKS.indexOf(d.slice(0, 3)) < 0).slice(0, 2),  // 默认只显示 2 条
    techDefs: tech,                                     // 带 [计]/[网] 的（编程义，免费）
    techNames: TECH_MARKS.filter((m) => tech.some((d) => d.indexOf(m) >= 0)).map((m) => TECH_MARK_NAMES[m]),
    definitionEn: splitDefs(row.definition).slice(0, 6),
    forms
  };
}

/* ------------------------- 单词语境义（问 AI） ------------------------- */

// 本地词典能给"这个词有哪些意思"，但给不了"在这句话里是哪个意思" —— 那必须看语境。
// 所以这一层才需要调 AI，而且只在用户主动点"看这句话里的意思"时才调用（省钱）。
async function explainWord(word, sentence) {
  const sys = [
    '你是英语学习助手，服务对象是正在读英文技术文档的中文读者。',
    '用户给你一个单词和它所在的句子，请判断这个单词【在这句话里】是什么意思。',
    '只输出 JSON，不要解释、不要 markdown 代码块。格式：',
    '{"pos":"词性缩写如 n./v./adj.","cn":"在这句话里的中文意思，不超过20字","field":"领域如 编程/网络/通用","why":"为什么是这个意思，不超过30字","isFunctionWord":false}',
    '规则：',
    '1. 以【这句话】的语境为准，不要罗列该词的所有意思。',
    '2. 若是功能词（the/a/is/of 等）或在这句话里没有实义，把 isFunctionWord 设为 true，cn 写它的语法作用（如"定冠词"）。',
    '3. cn 要短，像词典释义那样，不要写成句子。',
    '4. field 只在确实属于某个专业领域时给出，否则写"通用"。'
  ].join('\n');

  const r = await callModel([
    { role: 'system', content: sys },
    { role: 'user', content: '单词：' + word + '\n句子：' + sentence }
  ], { json: true, maxTokens: 400 });

  let parsed = null;
  try { parsed = JSON.parse(stripFence(r.content)); } catch (e) { parsed = null; }
  if (!parsed || typeof parsed !== 'object') {
    // 模型没给合法 JSON 时的兜底：把内容截短当释义用，不让前端崩
    return { pos: '', cn: String(r.content || '').slice(0, 60), field: '', why: '', isFunctionWord: false, raw: true };
  }
  return {
    pos: String(parsed.pos || ''),
    cn: String(parsed.cn || ''),
    field: String(parsed.field || ''),
    why: String(parsed.why || ''),
    isFunctionWord: !!parsed.isFunctionWord
  };
}

/* ------------------------- HTTP 服务 ------------------------- */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  // 注意：这里【故意不发送】任何 Access-Control-Allow-* 头。
  // 本代理只服务于本机的用户脚本（走 GM_xmlhttpRequest，不受 CORS 约束），
  // 不需要给网页开跨源权限；开了反而等于允许任何网站调用它。
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST + ':' + PORT);

  // ---- 安全闸门（见文件上方 BLOCK_WEB_ORIGINS 的说明）----
  if (BLOCK_WEB_ORIGINS) {
    const origin = req.headers.origin;
    if (origin && /^https?:\/\//i.test(origin)) {
      log('⛔ 已拦截网页跨源请求  Origin=' + origin + '  ' + req.method + ' ' + url.pathname);
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: '拒绝：本机翻译代理不接受网页发起的跨源请求',
        hint: '本代理只服务于本机的用户脚本（GM_xmlhttpRequest）'
      }));
      return;
    }
  }

  if (req.method === 'OPTIONS') {
    // 不再返回任何 CORS 许可头，让浏览器的预检请求失败（这正是我们想要的结果）
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/health' || url.pathname === '/') {
    const cred = readCredentials();
    json(res, 200, {
      ok: true,
      service: 'dsh-translate-proxy',
      model: MODEL,
      baseURL: BASE_URL,
      hasKey: !!cred,
      // 只给不含路径的短标签（"环境变量" / "配置文件"）。
      // 完整路径只在控制台日志里出现，不进 HTTP 响应 —— 见 readCredentials 上方的说明。
      keySource: cred ? cred.via : null,
      cacheSize: cache.size,
      inflight,
      uptimeSec: Math.round(process.uptime())
    });
    return;
  }

  // ---- 冻结版本分发 ----
  // 用途：一次做好几个版本时，每个版本都有固定网址可单独安装测试，
  //       不会互相覆盖（主入口 /install.user.js 永远指向最新工作副本）。
  //
  //   GET /versions                    版本列表页（浏览器打开就能点）
  //   GET /v/<文件名>.user.js           安装指定版本
  if (url.pathname === '/versions' || url.pathname.startsWith('/v/')) {
    const dir = path.join(__dirname, 'versions');

    if (url.pathname === '/versions') {
      fs.readdir(dir, (err, files) => {
        const list = (err ? [] : files.filter((f) => /\.user\.js$/.test(f))).sort();
        const rows = list.length
          ? list.map((f) => '<li><a href="/v/' + encodeURIComponent(f) + '">' + f + '</a></li>').join('')
          : '<li>（versions 文件夹里还没有版本文件）</li>';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><title>可用版本</title>' +
          '<style>body{font:14px/1.8 -apple-system,"Segoe UI","Noto Sans SC",sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#24292f}' +
          'a{color:#0969da}li{margin:6px 0}code{background:#f6f8fa;padding:2px 5px;border-radius:4px}</style>' +
          '<h1>可用版本</h1><p>点下面的链接安装对应版本（油猴会提示更新）。</p><ul>' + rows + '</ul>' +
          '<p style="color:#57606a">主入口 <code>/install.user.js</code> 永远指向最新工作副本。</p>');
      });
      return;
    }

    // 只允许 字母数字点横线中文 组成的 .user.js 文件名，并取 basename，杜绝路径穿越
    const name = path.basename(decodeURIComponent(url.pathname.slice(3)));
    if (!/^[\w.\-\u4e00-\u9fa5]+\.user\.js$/.test(name)) {
      json(res, 400, { error: '文件名不合法（只允许字母数字点横线中文，且以 .user.js 结尾）' });
      return;
    }
    fs.readFile(path.join(dir, name), 'utf8', (err, data) => {
      if (err) { json(res, 404, { error: '找不到这个版本：versions/' + name + '（打开 /versions 看有哪些）' }); return; }
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
    return;
  }

  // 一键安装入口：装好 Tampermonkey 后，浏览器打开这个地址就会弹出安装页
  if (url.pathname === '/install.user.js' || url.pathname === '/userscript') {
    const scriptPath = path.join(__dirname, 'easy-en-translate.user.js');
    fs.readFile(scriptPath, 'utf8', (err, data) => {
      if (err) {
        json(res, 404, { error: '找不到用户脚本文件：' + scriptPath });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
    return;
  }

  // ---- 本地词典查询（免费、不联网、毫秒级）----
  //   GET /lookup?word=token
  if (url.pathname === '/lookup') {
    const word = (url.searchParams.get('word') || '').trim();
    if (!word) { json(res, 400, { ok: false, error: '缺少 word 参数' }); return; }
    if (word.length > 64) { json(res, 400, { ok: false, error: 'word 太长' }); return; }
    try {
      const r = lookupWord(word);
      json(res, r.ok ? 200 : 503, r);
    } catch (e) {
      log('词典查询出错：' + e.message);
      json(res, 500, { ok: false, error: '词典查询出错：' + e.message });
    }
    return;
  }

  // ---- 单词的语境义（要调 AI，花钱；前端只在用户主动点时才请求）----
  //   POST /explain  { word, sentence }
  if (url.pathname === '/explain') {
    if (req.method !== 'POST') { json(res, 405, { error: '请用 POST' }); return; }
    let payload;
    try { payload = JSON.parse((await readBody(req)) || '{}'); }
    catch (e) { json(res, 400, { error: '请求体不是合法 JSON：' + e.message }); return; }

    const word = String(payload.word || '').trim();
    const sentence = String(payload.sentence || '').trim().slice(0, 2000);
    if (!word) { json(res, 400, { error: '缺少 word' }); return; }

    const key = 'explain\u0001' + word.toLowerCase() + '\u0001' + sentence;
    if (cache.has(key)) {
      json(res, 200, Object.assign({}, cache.get(key), { cached: true, ms: 0 }));
      return;
    }

    const t0 = Date.now();
    await acquire();
    try {
      const out = await explainWord(word, sentence);
      const result = Object.assign({ ok: true, word, sentence, model: MODEL, ms: Date.now() - t0 }, out);
      cache.set(key, result);
      saveCacheSoon();
      log('查语境义 "' + word + '" → ' + out.cn + '  (' + result.ms + 'ms)');
      json(res, 200, result);
    } catch (e) {
      log('❌ 查语境义失败：' + e.message);
      json(res, e.rateLimit ? 429 : 502, { ok: false, error: e.message });
    } finally {
      release();
    }
    return;
  }

  if (url.pathname === '/translate') {
    if (req.method !== 'POST') { json(res, 405, { error: '请用 POST' }); return; }
    let payload;
    try {
      const raw = await readBody(req);
      payload = JSON.parse(raw || '{}');
    } catch (e) {
      json(res, 400, { error: '请求体不是合法 JSON：' + e.message });
      return;
    }

    const text = typeof payload.text === 'string' ? payload.text : '';
    const to = payload.to || 'zh-CN';
    const from = payload.from || 'auto';
    if (!text.trim()) { json(res, 400, { error: '缺少 text' }); return; }

    const key = to + '\u0001' + text;
    if (!payload.noCache && cache.has(key)) {
      const hit = cache.get(key);
      json(res, 200, Object.assign({}, hit, { cached: true, ms: 0, model: MODEL }));
      return;
    }

    const t0 = Date.now();
    await acquire();
    try {
      const out = await translateText(text, from, to);
      const result = {
        translation: out.translation,
        cached: false,
        ms: Date.now() - t0,
        model: MODEL,
        usage: out.usage,
        truncated: out.finish === 'length'
      };
      cache.set(key, { translation: out.translation, model: MODEL });
      saveCacheSoon();
      const segCount = text.split('\n').filter((s) => s.trim()).length;
      log(segCount + ' 段 ' + text.length + ' 字 → ' + (result.ms + 'ms') +
        (out.usage ? ' tokens=' + out.usage.prompt_tokens + '/' + out.usage.completion_tokens : '') +
        (result.truncated ? ' ⚠被截断' : ''));
      json(res, 200, result);
    } catch (e) {
      log('❌ ' + e.message);
      json(res, e.rateLimit ? 429 : 502, { error: e.message, rateLimit: !!e.rateLimit });
    } finally {
      release();
    }
    return;
  }

  json(res, 404, { error: '未知路径 ' + url.pathname + '（可用：GET /health、POST /translate）' });
});

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') {
    console.error('  ❌ 服务启动失败：' + e.message);
    process.exit(1);
    return;
  }
  // 端口被占用：先确认是不是我们自己的代理已经在跑
  const otherOwner = () => {
    console.error('');
    console.error('  ❌ 端口 ' + PORT + ' 被别的程序占用了。换个端口再启动：');
    console.error('     $env:TRANSLATE_PORT=8788; node dsh-translate-proxy.js');
    console.error('     （用户脚本里的 CONFIG.localEndpoint 要同步改成 8788）');
    console.error('');
    process.exit(1);
  };
  const probe = http.get({ host: HOST, port: PORT, path: '/health', timeout: 1500 }, (r) => {
    let body = '';
    r.on('data', (c) => { body += c; });
    r.on('end', () => {
      if (String(body).indexOf('dsh-translate-proxy') !== -1) {
        console.log('');
        console.log('  ✅ 代理已经在运行了（端口 ' + PORT + '），无需重复启动。');
        console.log('     直接在 GitHub 上划词即可。要停止请运行「停止翻译代理.cmd」。');
        console.log('');
        process.exit(0);
      }
      otherOwner();
    });
  });
  probe.on('error', otherOwner);
  probe.on('timeout', () => { probe.destroy(); otherOwner(); });
});

server.listen(PORT, HOST, () => {
  const cred = readCredentials();
  console.log('');
  console.log('  DSH 本地翻译代理已启动');
  console.log('  ────────────────────────────────────────────');
  console.log('  端点    http://' + HOST + ':' + PORT + '/translate');
  console.log('  自检    http://' + HOST + ':' + PORT + '/health');
  console.log('  装脚本  http://' + HOST + ':' + PORT + '/install.user.js');
  console.log('  多版本  http://' + HOST + ':' + PORT + '/versions   （测试各版本用）');
  console.log('  词典    http://' + HOST + ':' + PORT + '/lookup?word=token');
  console.log('  模型    ' + MODEL + '  @ ' + BASE_URL);
  console.log('  密钥    ' + (cred ? '已读取（' + cred.source + '）' : '❌ 未找到，翻译会失败'));
  console.log('  安全    ' + (BLOCK_WEB_ORIGINS ? '已开启：拒绝网页跨源请求（防他人白嫖额度）' : '⚠️ 已关闭（TRANSLATE_ALLOW_WEB_ORIGINS=1）'));
  console.log('  ────────────────────────────────────────────');
  console.log('  在 GitHub 上划词即可翻译；Ctrl+C 停止');
  console.log('');
  loadCache();
});

process.on('SIGINT', () => {
  log('收到 Ctrl+C，正在退出…');
  const n = flushCacheSync();
  if (n >= 0) log('缓存已保存（' + n + ' 条）');
  process.exit(0);
});

// 退出兜底：用户直接关黑窗口 / 任务管理器结束进程 / 父进程退出，
// 都不一定会走到 SIGINT。beforeExit 在事件循环空了以后触发，
// 这时把还没落盘的那几条同步补上，避免"刚翻好的没了"。
// exit 事件里禁止再起异步任务，所以这里也必须是同步写。
process.on('beforeExit', () => {
  if (saveTimer) {
    const n = flushCacheSync();
    if (n >= 0) log('退出前缓存已保存（' + n + ' 条）');
  }
});
process.on('exit', () => {
  if (saveTimer) flushCacheSync();
});
