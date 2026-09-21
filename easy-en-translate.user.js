// ==UserScript==
// @name         GitHub 划词即译 · 中英对照
// @namespace    https://github.com/lithia114/easy-en-translate
// @version      2.1.4
// @description  在任意网页上拖动选中文字即自动翻译，气泡内逐句中英对照；可点击原文单词查词典（本地 ECDICT 词典 + AI 语境义）；可直连任何 OpenAI 兼容的 AI（填自己的 key，无需安装任何东西），也可走本机代理；内置代码标识符保护、术语纠偏、结果缓存
// @author       lithia114
// @homepageURL  https://github.com/lithia114/easy-en-translate
// @updateURL    https://raw.githubusercontent.com/lithia114/easy-en-translate/main/easy-en-translate.user.js
// @downloadURL  https://raw.githubusercontent.com/lithia114/easy-en-translate/main/easy-en-translate.user.js
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      api.deepseek.com
// @connect      api.openai.com
// @connect      openrouter.ai
// @connect      api.moonshot.cn
// @connect      open.bigmodel.cn
// @connect      dashscope.aliyuncs.com
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * ========================= 先看这里 =========================
 *
 * 两种用法，二选一：
 *
 * 【推荐】填自己的 AI key，直连 —— 电脑上什么都不用装
 *     点油猴图标 →「⚙ 设置自己的 AI」→ 选服务商 → 粘 key → 测试连接 → 保存
 *     （设置页里有「去哪拿 key」的图文步骤）
 *
 * 【另一种】走本机代理（复用 DSH 的模型线路，另外还提供本地词典）
 *     先双击 启动翻译代理.cmd，然后保持那个黑窗口开着
 *     代理还提供「点单词查词典」用的本地词典数据（86MB）
 *
 * 两种可以共存：翻译走哪个由引擎决定，词典始终由代理提供。
 * ==========================================================
 *
 * 快捷键 / 油猴菜单
 *   Esc      关闭气泡（以及词典卡片、设置面板）
 *   Alt+T    开关划词翻译（Alt+Shift+T 备用）
 *   油猴菜单  设置自己的 AI、开关、切换对照模式、切换引擎、检查代理、清空缓存
 */

(function () {
  'use strict';

  if (window.__GH_SELECT_TRANSLATE__) return;
  window.__GH_SELECT_TRANSLATE__ = true;

  /* ============================ 1. 配置（只改这一块） ============================ */

  const CONFIG = {
    provider: 'dsh',                // 'dsh'（本机代理）| 'openai'（填自己的 key 直连）
    localEndpoint: 'http://127.0.0.1:8787/translate',   // 本机翻译代理（dsh-translate-proxy.js）
    // 直连模式：用户自己填的 AI 接口（OpenAI 兼容）。填了它就不再需要本机代理。
    direct: { preset: '', baseURL: '', model: '', apiKey: '' },
    minChars: 2,                    // 少于该长度不翻译
    maxChars: 8000,                 // 超长选区截断保护
    display: 'bilingual',           // 'bilingual' 中英对照 | 'translated' 仅译文
    retries: 2,                     // 失败重试次数
    cacheLimit: 500,                // 本地缓存条目上限
    autoEnable: true,               // 首次运行是否开启
    skipEditable: false,            // true = 不翻译输入框/可编辑区域里的选区
    dictOnClick: true,              // true = 点击气泡里原文的单词可查词典
    panelMaxHeightVh: 55
  };

  // 目标语言为中文时的术语纠偏（左 = 机器译法，右 = 首选译法）
  const GLOSSARY_ZH = [
    ['存储库', '仓库'],
    ['代码库', '仓库'],
    ['仓储库', '仓库'],
    ['复刻', '分叉'],
    ['分岔', '分叉'],
    ['提取请求', '拉取请求'],
    ['拉拽请求', '拉取请求'],
    ['拉动请求', '拉取请求'],
    ['拉取要求', '拉取请求'],
    ['合并请求', '拉取请求'],
    ['登记项', '议题'],
    ['问题单', '议题'],
    ['签出', '检出'],
    ['提交记录', '提交']
  ];

  // 目标语言为英文时的大小写/品牌名纠偏
  const CANON_EN = {
    github: 'GitHub', javascript: 'JavaScript', typescript: 'TypeScript', nodejs: 'Node.js',
    npm: 'npm', pnpm: 'pnpm', api: 'API', url: 'URL', uri: 'URI', json: 'JSON', yaml: 'YAML',
    http: 'HTTP', https: 'HTTPS', html: 'HTML', css: 'CSS', sql: 'SQL', cli: 'CLI', ui: 'UI',
    sdk: 'SDK', markdown: 'Markdown', docker: 'Docker', kubernetes: 'Kubernetes',
    postgresql: 'PostgreSQL', mysql: 'MySQL', linux: 'Linux', macos: 'macOS', ios: 'iOS',
    python: 'Python', java: 'Java', bash: 'Bash', powershell: 'PowerShell', windows: 'Windows'
  };

  /* ============================ 3. 存储与工具 ============================ */

  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  const store = {
    get(key, def) {
      try {
        if (hasGM) {
          const v = GM_getValue(key, undefined);
          return v === undefined ? def : v;
        }
        const raw = localStorage.getItem('ghst.' + key);
        return raw === null ? def : JSON.parse(raw);
      } catch (e) { return def; }
    },
    set(key, val) {
      try {
        if (hasGM) GM_setValue(key, val);
        else localStorage.setItem('ghst.' + key, JSON.stringify(val));
      } catch (e) { /* ignore */ }
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function el(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function decodeEntities(s) {
    return String(s).replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (m, dec, hex, name) => {
      if (dec) return String.fromCharCode(parseInt(dec, 10));
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      return map[String(name).toLowerCase()] || m;
    });
  }

  function createPool(limit) {
    let running = 0;
    const queue = [];
    const pump = () => {
      if (running >= limit || queue.length === 0) return;
      const job = queue.shift();
      running += 1;
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).then(() => {
        running -= 1;
        pump();
      });
    };
    return {
      run(fn) {
        return new Promise((resolve, reject) => {
          queue.push({ fn, resolve, reject });
          pump();
        });
      }
    };
  }

  class TranslateError extends Error {
    constructor(message, opts) {
      super(message);
      const o = opts || {};
      this.quota = !!o.quota;         // 额度用尽
      this.rateLimit = !!o.rateLimit; // 触发限流，可退避重试
      this.fatal = !!o.fatal;         // 配置错误，锁定并停止后续请求
      this.aborted = !!o.aborted;     // 被新选区打断，不是真失败
      this.noRetry = !!o.noRetry;     // 立即失败，不做退避重试
    }
  }

  /* ============================ 4. 文本处理 ============================ */

  function detectLang(text) {
    const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
    const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length;
    const cyr = (text.match(/[\u0400-\u04ff]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    const total = cjk + kana + hangul + cyr + latin || 1;
    if (kana / total > 0.05) return 'ja';
    if (hangul / total > 0.05) return 'ko';
    if (cyr / total > 0.2) return 'ru';
    if (cjk / total > 0.15) return 'zh-CN';
    return 'en';
  }

  const LANG_LABEL = { 'zh-CN': '中文', en: 'EN', ja: '日文', ko: '韩文', ru: '俄文' };

  function readSelectionText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
    let t = sel.toString();
    t = t.replace(/\u00a0/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '');
    t = t.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n');
    return t.replace(/\n{3,}/g, '\n\n').trim();
  }

  function isWorthTranslating(text) {
    if (!text || text.length < CONFIG.minChars) return false;
    if (!/[\p{L}]/u.test(text)) return false;
    if (/^https?:\/\/\S+$/i.test(text)) return false;
    return true;
  }

  function cleanMarkdown(text) {
    let s = text.replace(/\r\n?/g, '\n');
    s = s.replace(/```[a-zA-Z0-9+#.-]*\n?([\s\S]*?)```/g, '$1');
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    s = s.replace(/^\s{0,3}>\s?/gm, '');
    s = s.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '');
    s = s.replace(/^\s*\|?[\s:|-]{5,}\|?\s*$/gm, '');
    s = s.replace(/^\s*\|(.+)\|\s*$/gm, (m, inner) => inner.split('|').map((c) => c.trim()).filter(Boolean).join(' · '));
    s = s.replace(/!?\[([^\]\n]*)\]\(([^)\n]*)\)/g, '$1');
    s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
    s = s.replace(/^\s*[-*_]{3,}\s*$/gm, '');
    s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  // 不在此处断句的缩写。注意：'e.g' 与 'i.e' 必须带上尾部那个点，
  // 因为匹配到的尾巴是 "e.g." 去掉标点后的 "e.g"。
  const ABBR = new Set(['e.g', 'i.e', 'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'st', 'no', 'fig', 'al', 'inc', 'ltd', 'jr', 'sr', 'approx', 'v', 'cf', 'resp']);

  function splitSentences(line) {
    const parts = line.match(/[^.!?。！？；;]+[.!?。！？；;]["'”’)\]]*|[^.!?。！？；;]+$/g) || [line];
    const out = [];
    for (const p of parts) {
      // 回接的第 ① 类：点号两边都是字母/数字 → 这个点不是句号，是词内部的点。
      //   "Use Node." + "js, i.e. ..."   → Node.js / v1.2.3 / README.md / 1.5
      // 修之前这里什么都不管，"Use Node.js, i.e. the runtime." 会被切成
      //   ["Use Node.", "js, i.", "e.", "the runtime, to run it."]
      // 四段碎片，每段单独发给 AI → 上下文丢掉、译文质量崩、还多花钱。
      const isDotJoin = (a, b) =>
        !!a && !!b && /[A-Za-z0-9]\.$/.test(a) && /^[A-Za-z0-9]/.test(b);
      // 回接的第 ② 类：上一段以已知缩写结尾 → 那句话还没完。
      //   "See e.g." + " the docs."  → 合成一句
      const endsWithAbbr = (a) => {
        if (!a || !/[.!?]["'”’)\]]*$/.test(a.trim())) return false;
        const tail = a.trim().replace(/["'”’)\]]+$/, '').split(/[\s(]+/).pop() || '';
        return ABBR.has(tail.replace(/\.$/, '').toLowerCase());
      };
      let merged = false;
      // 必须用 for(;;) 循环而不是只判断上一段一次：
      // 缩写会连着出现（"Node.js, i.e. the runtime" 要先接 js，再接 e，再接着往下），
      // 只回接一次会留下 "js, i." 这种半截句子，翻出来是废的。
      for (;;) {
        const prev = out[out.length - 1];
        if (prev === undefined) break;
        if (!isDotJoin(prev, p) && !endsWithAbbr(prev)) break;
        out[out.length - 1] = prev + p;
        merged = true;
        break;
      }
      if (!merged) out.push(p);
    }
    return out.map((s) => s.trim()).filter(Boolean);
  }

  function hardSplit(s, limit) {
    if (s.length <= limit) return [s];
    const out = [];
    let rest = s;
    while (rest.length > limit) {
      const win = rest.slice(0, limit);
      let cut = Math.max(win.lastIndexOf(' '), win.lastIndexOf('，'), win.lastIndexOf('、'), win.lastIndexOf(')'));
      if (cut < limit * 0.5) cut = limit;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out.filter(Boolean);
  }

  function splitUnits(text, limit) {
    const units = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      for (const s of splitSentences(line)) {
        for (const piece of hardSplit(s, limit)) if (piece) units.push(piece);
      }
    }
    return units;
  }

  /* ============================ 5. 代码/标识符占位保护 ============================ */

  const MASK_RULES = [
    /`[^`\n]+`/g,
    /https?:\/\/[^\s)>\]"'，。]+/g,
    /<\/?[a-zA-Z][^<>\n]{0,80}>/g,
    /\b[\w.@-]+\/[\w./@-]*[\w/]\b/g,
    /\b[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|ya?ml|md|mdx|py|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|sh|bash|zsh|ps1|bat|sql|html?|css|scss|toml|ini|cfg|lock|txt|log|env|exe|dll|so|zip|tar|gz)\b/gi,
    // 命令行：只保护「命令 + 少量参数」，绝不能无限吞掉后面的英文
    // 踩过的坑：原来的写法是 (?:\s+[-\w.@:/=~^]+)* —— 它会一路吃到底！
    //   "Use git push --force to overwrite the remote history."
    //   整句后半段都被当成命令参数保护起来 → 译文变成"使用 git push --force to overwrite..."
    //   也就是后半句根本没翻。GitHub README 里这种句子遍地都是。
    // 现在的做法：最多跟 2 个参数，遇到常见虚词（to/the/and/of...）就停。
    // 为什么是 2 而不是 3：实测 "The docker build command creates a new image..."
    //   跟 3 个会把动词 creates 一起吞掉 → "The [[0]] a new image..." 句子结构被破坏；
    //   跟 2 个则是 "The [[0]] creates a new image..."，动词保留、句子完整。
    //   原则：宁可"少保护一点"（顶多某个词被多翻译一次），也不要"多保护"（丢翻译）。
    /\b(?:git|npm|pnpm|yarn|bun|cargo|pip3?|docker|kubectl|helm|npx|cmake|dotnet|curl|wget|ssh|scp|gh)\b(?:\s+(?!(?:to|the|a|an|and|or|but|if|then|when|while|for|of|in|on|at|by|with|from|is|are|was|were|be|been|it|this|that|these|those|you|your|we|our|they|their|will|would|can|could|should|may|might|must|do|does|did|not|no|so|as|than|about|before|after|into|over|under|between|up|down|out|off|also|just|very|too|more|most|such|only|each|every|all|any|some|new|old)\b)[-\w.@:/=~^]+){0,2}/g,
    /(?<=\s|^)--?[A-Za-z][\w-]*/g,
    /\bv?\d+\.\d+(?:\.\d+)*(?:[-+][\w.]+)?\b/g,
    /\b(?=[0-9a-f]{7,40}\b)[0-9a-f]*\d[0-9a-f]*\b/gi,
    /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g,
    /\b\w*_\w+\b/g,
    /@[A-Za-z0-9][\w-]*/g,
    /#\d+\b/g
  ];

  function mask(text) {
    const map = Object.create(null);
    let out = text;
    let n = 0;
    for (const rule of MASK_RULES) {
      out = out.replace(new RegExp(rule.source, rule.flags), (m) => {
        const key = String(n++);
        map[key] = m;
        return '[[' + key + ']]';
      });
    }
    return { text: out, map };
  }

  function applyGlossary(text, tgtLang) {
    let t = text;
    if (tgtLang === 'zh-CN') {
      for (const [from, to] of GLOSSARY_ZH) t = t.split(from).join(to);
    } else if (tgtLang === 'en') {
      t = t.replace(/\b[A-Za-z][A-Za-z.+-]*\b/g, (w) => CANON_EN[w.toLowerCase()] || w);
    }
    return t;
  }

  // 还原占位符时用不可见标记包住代码片段，渲染时单独上等宽样式
  const MK_OPEN = '\u0002';
  const MK_CLOSE = '\u0003';

  function finalize(raw, item, tgtLang) {
    let t = decodeEntities(String(raw == null ? '' : raw).trim());
    t = applyGlossary(t, tgtLang);
    const restored = Object.create(null);
    t = t.replace(/\[\s*\[\s*(\d+)\s*\]\s*\]/g, (m, key) => {
      const v = item.map[key];
      if (v === undefined) return m;
      restored[key] = true;
      return MK_OPEN + v + MK_CLOSE;
    });
    const missing = [];
    for (const k of Object.keys(item.map)) if (!restored[k]) missing.push(item.map[k]);
    // 模型偶尔会自己加 [[ ]] 包裹（提示词里出现过该格式），残留的一律去掉括号
    let invented = 0;
    t = t.replace(/\[\[\s*([^[\]]*?)\s*\]\]/g, (m, inner) => { invented++; return inner; });
    return { text: t.replace(/[ \t]{2,}/g, ' ').trim(), missing, invented };
  }

  function toSegments(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
      const a = text.indexOf(MK_OPEN, i);
      if (a === -1) { if (i < text.length) out.push({ s: text.slice(i), code: false }); break; }
      if (a > i) out.push({ s: text.slice(i, a), code: false });
      const b = text.indexOf(MK_CLOSE, a + 1);
      if (b === -1) { out.push({ s: text.slice(a + 1), code: true }); break; }
      out.push({ s: text.slice(a + 1, b), code: true });
      i = b + 1;
    }
    return out.filter((p) => p.s !== '');
  }

  const plainOf = (text) => text.split(MK_OPEN).join('').split(MK_CLOSE).join('');

  /* ============================ 6. 引擎适配层 ============================ */

  const active = new Set();
  let lastReqAt = 0;
  let blockNotice = '';

  function hostOf(url) {
    try { return new URL(url).host; } catch (e) { return url; }
  }

  // 统一的 HTTP 传输：优先 GM_xmlhttpRequest（绕开跨域），否则退回 fetch
  function httpRequest(opts) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        let settled = false;
        const finish = (fn) => (arg) => {
          if (settled) return;
          settled = true;
          if (handle) active.delete(handle);
          fn(arg);
        };
        const handle = GM_xmlhttpRequest({
          method: opts.method,
          url: opts.url,
          data: opts.data,
          headers: opts.headers,
          timeout: 20000,
          onload: finish((r) => resolve({ status: r.status, text: r.responseText })),
          onerror: finish(() => reject(new TranslateError('网络请求失败（无法连接 ' + hostOf(opts.url) + '，检查网络或油猴 @connect）'))),
          ontimeout: finish(() => reject(new TranslateError('请求超时'))),
          onabort: finish(() => reject(new TranslateError('请求已取消', { aborted: true })))
        });
        if (handle && typeof handle.abort === 'function') active.add(handle);
      } else {
        fetch(opts.url, { method: opts.method, headers: opts.headers, body: opts.data, credentials: 'omit' })
          .then((r) => r.text().then((t) => resolve({ status: r.status, text: t })))
          .catch((e) => reject(new TranslateError('网络请求失败：' + e.message + '（请用 Tampermonkey 安装，脚本需要 GM_xmlhttpRequest 绕过跨域）')));
      }
    });
  }

  const PROVIDERS = {
    // 直连任何「OpenAI 兼容」接口：DeepSeek / OpenAI / Kimi / 智谱 / 通义 / OpenRouter / 本地 Ollama…
    // 这是公开版的主路径 —— 用户填自己的 key，电脑上不需要 Node、不需要黑窗口。
    openai: {
      id: 'openai',
      label: '自定义 AI（直连）',
      batchChars: 3000,            // 直连没有第三方字符上限，可以一次翻更长
      concurrency: 2,
      minGapMs: 0,
      autoSource: true,
      ready() { return directReady(); },
      async request(text, from, to) {
        if (!directReady()) {
          throw new TranslateError('还没配置 AI 接口：油猴菜单 →「设置自己的 AI」填一下', { fatal: true });
        }
        const segCount = text.split('\n').filter((s) => s.trim()).length;
        const targetName = to === 'zh-CN' ? '简体中文' : (to === 'en' ? '英文' : to);
        try {
          return await directCall(CONFIG.direct, text, directPrompt(targetName, segCount));
        } catch (e) {
          throw new TranslateError(e.message);
        }
      }
    },

    // 本机 DSH 模型：由 dsh-translate-proxy.js 复用 deepseek-official 线路，密钥不出本机
    dsh: {
      id: 'dsh',
      label: '本机 DSH 模型',
      batchChars: 4000,            // 走本机代理，一次调用能翻很长一段
      concurrency: 2,
      minGapMs: 0,
      autoSource: true,
      ready() { return true; },
      async request(text, from, to) {
        let res;
        try {
          res = await httpRequest({
            method: 'POST',
            url: CONFIG.localEndpoint,
            data: JSON.stringify({ text, from, to }),
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (e) {
          if (e && e.aborted) throw e;
          throw new TranslateError('翻译代理没在运行：双击「启动翻译代理.cmd」即可恢复（那个黑窗口不能关）', { noRetry: true });
        }
        let data;
        try { data = JSON.parse(res.text); } catch (e) {
          throw new TranslateError('本机代理返回无法解析（HTTP ' + res.status + '）', { noRetry: true });
        }
        if (data.error) {
          throw new TranslateError('本机代理：' + data.error, { rateLimit: !!data.rateLimit });
        }
        if (!data.translation) throw new TranslateError('本机代理返回空译文');
        return data.translation;
      }
    },

  };

  async function throttle(p) {
    const wait = p.minGapMs - (Date.now() - lastReqAt);
    if (wait > 0) await sleep(wait);
    lastReqAt = Date.now();
  }

  async function apiTranslate(text, ctx) {
    const p = ctx.provider;
    if (blockNotice) throw new TranslateError(blockNotice, { quota: true, fatal: true });
    let lastErr = null;
    for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
      await throttle(p);
      try {
        return await p.request(text, ctx.from, ctx.to);
      } catch (e) {
        lastErr = e;
        if (e.aborted) throw e;                    // 被新选区打断：原样抛出，不当成失败
        if (e.rateLimit && attempt < CONFIG.retries) {
          p.minGapMs = Math.min(Math.max(p.minGapMs * 2, 300), 4000);   // 自动降速
          continue;
        }
        if (e.fatal) { blockNotice = e.message; throw e; }
        if (e.noRetry) throw e;
        if (attempt < CONFIG.retries) await sleep(400 * (attempt + 1));
      }
    }
    throw lastErr || new TranslateError('翻译失败');
  }

  function abortAll() {
    for (const h of Array.from(active)) {
      try { h.abort(); } catch (e) { /* ignore */ }
    }
    active.clear();
  }

  /* ============================ 7. 缓存 ============================ */

  // 【为什么要改版本号】v2.1.2 修了 splitSentences 的断句 bug，
  // 同一段原文切出来的「段」跟以前不一样了 —— 老缓存是按旧切法存进去的，
  // 继续用就会命中一条跟当前分段对不上的旧译文（轻则段落错位，重则整段是废的）。
  // 缓存本来就是"可丢弃"的东西，换个 key 版本让它自然过期，比写迁移逻辑简单也更安全。
  // 以后只要改了「怎么切段 / 怎么 mask / 怎么拼提示词」，都要把这里的版本号 +1。
  const CACHE_KEY = 'cache.v2';
  const cache = new Map();
  (function loadCache() {
    const raw = store.get(CACHE_KEY, null);
    if (!raw || typeof raw !== 'object') return;
    for (const k of Object.keys(raw)) cache.set(k, raw[k]);
  })();

  let saveTimer = null;
  function saveCacheSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      while (cache.size > CONFIG.cacheLimit) cache.delete(cache.keys().next().value);
      const obj = {};
      for (const [k, v] of cache) obj[k] = v;
      store.set(CACHE_KEY, obj);
    }, 800);
  }

  const ck = (pair, text) => pair + '\u0001' + text;
  const cacheGet = (pair, text) => { const v = cache.get(ck(pair, text)); return typeof v === 'string' ? v : null; };
  const cacheSet = (pair, text, out) => { cache.set(ck(pair, text), out); saveCacheSoon(); };

  /* ============================ 8. 气泡 UI ============================ */

  const host = el('div', 'ghst-host');
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;';
  const shadow = host.attachShadow({ mode: 'open' });

  const styleTag = el('style');
  styleTag.textContent = `
:host { all: initial; }
.panel {
  --bg:#ffffff; --fg:#1f2328; --mut:#656d76; --bd:#d0d7de; --bd2:#e8ecf0;
  --acc:#0969da; --chip:#f6f8fa; --warn:#9a6700; --err:#cf222e;
  position:fixed; left:0; top:0; width:min(560px,92vw); max-height:var(--maxh,55vh);
  display:none; flex-direction:column; overflow:hidden; box-sizing:border-box;
  background:var(--bg); color:var(--fg); border:1px solid var(--bd); border-radius:10px;
  box-shadow:0 16px 40px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.08);
  font:400 13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif;
  opacity:0; transition:opacity .1s ease-out;
}
.panel[data-theme="dark"] {
  --bg:#161b22; --fg:#e6edf3; --mut:#8b949e; --bd:#30363d; --bd2:#21262d;
  --acc:#4493f8; --chip:#1c2129; --warn:#d29922; --err:#f85149;
  box-shadow:0 16px 40px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.03);
}
.panel.on { display:flex; opacity:1; }
.hdr { display:flex; align-items:center; gap:8px; padding:6px 8px; background:var(--chip);
       border-bottom:1px solid var(--bd2); cursor:move; user-select:none; }
.dir { font-weight:600; font-size:12px; white-space:nowrap; }
.stat { font-size:11px; color:var(--mut); margin-right:auto; }
.btn { all:unset; box-sizing:border-box; cursor:pointer; font:inherit; font-size:11px;
       padding:2px 8px; border:1px solid var(--bd); border-radius:6px; background:var(--bg);
       color:var(--fg); white-space:nowrap; }
.btn:hover { border-color:var(--acc); color:var(--acc); }
.btn[data-on="1"] { background:var(--acc); border-color:var(--acc); color:#fff; }
.body { overflow:auto; padding:8px 10px; overscroll-behavior:contain; }
.row { padding:6px 0; }
.row + .row { border-top:1px dashed var(--bd2); }
.txt { white-space:pre-wrap; word-break:break-word; }
.tgt.loading { color:var(--mut); }
.tgt.err { color:var(--err); }
.src { margin-top:3px; font-size:11.5px; color:var(--mut); }
.panel[data-display="translated"] .src { display:none; }
.code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.94em;
        background:var(--chip); border-radius:3px; padding:0 2px; }
.miss { display:block; margin-top:3px; font-size:11px; color:var(--warn); }
.foot { display:flex; align-items:center; gap:6px; padding:6px 8px; border-top:1px solid var(--bd2); background:var(--chip); }
.hint { margin-left:auto; font-size:11px; color:var(--mut); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hint[data-warn="1"] { color:var(--warn); }
/* 原文里可点击的单词：悬停微高亮是纯 CSS，不花任何请求 */
.src .w { cursor:pointer; border-radius:3px; padding:0 1px; }
.src .w:hover { background:rgba(9,105,218,.16); }
.src .w.on { background:rgba(9,105,218,.26); }
/* 词典卡片（点单词后弹出）——自带配色，因为它在 .panel 外面 */
.dictcard { --bg:#ffffff; --fg:#1f2328; --mut:#656d76; --bd:#d0d7de; --bd2:#e8ecf0; --acc:#0969da; --chip:#f6f8fa;
  position:fixed; left:0; top:0; width:min(340px,92vw); max-height:52vh; overflow:auto;
  display:none; box-sizing:border-box; padding:10px 12px;
  background:var(--bg); color:var(--fg); border:1px solid var(--bd); border-radius:10px;
  box-shadow:0 12px 32px rgba(0,0,0,.22);
  font:400 13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif;
  z-index:2147483002; }
.dictcard[data-theme="dark"] { --bg:#161b22; --fg:#e6edf3; --mut:#8b949e; --bd:#30363d; --bd2:#21262d; --acc:#4493f8; --chip:#1c2129; }
.dictcard.on { display:block; }
.dictcard .dhead { display:flex; align-items:baseline; gap:8px; }
.dictcard .dw { font-weight:600; font-size:15px; }
.dictcard .dp { font-size:12px; color:var(--mut); }
.dictcard .dacts { margin-left:auto; display:flex; gap:4px; }
.dictcard .dbtn { all:unset; cursor:pointer; font-size:11px; padding:2px 7px; border:1px solid var(--bd);
  border-radius:6px; white-space:nowrap; }
.dictcard .dbtn:hover { border-color:var(--acc); color:var(--acc); }
.dictcard .dsec { margin-top:7px; }
.dictcard .dtech { color:var(--acc); }
.dictcard .ddim { color:var(--mut); font-size:12px; }
.dictcard .dline { margin:1px 0; }
.dictcard .dai { margin-top:8px; padding-top:7px; border-top:1px dashed var(--bd2); }
.dictcard .dwarn { color:var(--warn); font-size:12px; }
/* 设置面板（填自己的 AI key） */
.settings { --bg:#ffffff; --fg:#1f2328; --mut:#656d76; --bd:#d0d7de; --bd2:#e8ecf0; --acc:#0969da; --chip:#f6f8fa;
  position:fixed; left:50%; top:60px; transform:translateX(-50%); width:min(460px,94vw); max-height:84vh; overflow:auto;
  display:none; box-sizing:border-box; padding:12px 14px;
  background:var(--bg); color:var(--fg); border:1px solid var(--bd); border-radius:10px;
  box-shadow:0 16px 40px rgba(0,0,0,.24);
  font:400 13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif;
  z-index:2147483003; }
.settings[data-theme="dark"] { --bg:#161b22; --fg:#e6edf3; --mut:#8b949e; --bd:#30363d; --bd2:#21262d; --acc:#4493f8; --chip:#1c2129; }
.settings.on { display:block; }
.settings .shead { display:flex; align-items:center; gap:8px; }
.settings .stitle { font-weight:600; font-size:15px; }
.settings .shead .btn { margin-left:auto; }
.settings .stip { margin-top:6px; padding:6px 8px; border-radius:6px; background:var(--chip); color:var(--mut); font-size:12px; }
.settings .srow { margin-top:10px; }
.settings .slabel { display:block; font-size:12px; color:var(--mut); margin-bottom:3px; }
.settings .sinput, .settings .sselect { all:unset; box-sizing:border-box; display:block; width:100%;
  padding:6px 9px; border:1px solid var(--bd); border-radius:6px; background:var(--bg); color:var(--fg); font:inherit; }
.settings .sinput:focus, .settings .sselect:focus { border-color:var(--acc); }
.settings .shint { margin-top:3px; font-size:11px; color:var(--mut); }
.settings .snote { margin-top:10px; font-size:12px; color:var(--mut); }
.settings .sguide { margin-top:10px; padding:8px 10px; border-radius:6px; background:var(--chip); border-left:3px solid var(--acc); }
.settings .sgtitle { font-size:12px; font-weight:600; margin-bottom:4px; }
.settings .sstep { font-size:12px; color:var(--fg); line-height:1.7; }
.settings .slink { margin-top:5px; font-size:12px; }
.settings .slink a { color:var(--acc); text-decoration:none; word-break:break-all; }
.settings .slink a:hover { text-decoration:underline; }
.settings .sguidehint { margin-top:4px; font-size:11px; color:var(--mut); }
.settings .sbar { display:flex; gap:8px; margin-top:12px; }
.settings .sstatus { margin-top:8px; font-size:12px; min-height:1.4em; }
.settings .sstatus[data-kind="ok"] { color:#1a7f37; }
.settings .sstatus[data-kind="err"] { color:var(--err); }
.toast { position:fixed; left:50%; bottom:36px; transform:translateX(-50%) translateY(10px);
         background:#1f2328; color:#fff; border:1px solid rgba(255,255,255,.18);
         border-radius:8px; padding:9px 16px; font-size:13px; line-height:1.5; white-space:nowrap;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif;
         box-shadow:0 8px 24px rgba(0,0,0,.35); opacity:0; pointer-events:none;
         transition:opacity .18s ease-out, transform .18s ease-out; z-index:2147483001; }
.toast.on { opacity:1; transform:translateX(-50%) translateY(0); }
`;
  shadow.appendChild(styleTag);

  const panel = el('div', 'panel');
  panel.style.setProperty('--maxh', CONFIG.panelMaxHeightVh + 'vh');

  const hdr = el('div', 'hdr');
  const dirEl = el('span', 'dir');
  const statEl = el('span', 'stat');
  const btnMode = el('button', 'btn');
  const btnPin = el('button', 'btn');
  const btnClose = el('button', 'btn');
  btnMode.type = btnPin.type = btnClose.type = 'button';
  btnClose.textContent = '✕';
  btnClose.title = '关闭（Esc）';
  hdr.appendChild(dirEl);
  hdr.appendChild(statEl);
  hdr.appendChild(btnMode);
  hdr.appendChild(btnPin);
  hdr.appendChild(btnClose);

  const body = el('div', 'body');
  const foot = el('div', 'foot');
  const btnCopyT = el('button', 'btn');
  const btnCopyS = el('button', 'btn');
  const btnRetry = el('button', 'btn');
  const hint = el('span', 'hint');
  btnCopyT.type = btnCopyS.type = btnRetry.type = 'button';
  btnCopyT.textContent = '复制译文';
  btnCopyS.textContent = '复制原文';
  btnRetry.textContent = '重试';
  btnRetry.style.display = 'none';
  foot.appendChild(btnCopyT);
  foot.appendChild(btnCopyS);
  foot.appendChild(btnRetry);
  foot.appendChild(hint);

  panel.appendChild(hdr);
  panel.appendChild(body);
  panel.appendChild(foot);
  shadow.appendChild(panel);
  (document.documentElement || document.body).appendChild(host);

  /* --------- 状态 --------- */

  let enabled = store.get('enabled', CONFIG.autoEnable) !== false;
  let pinned = false;
  let manualMoved = false;
  let runToken = 0;
  let currentText = '';
  let lastRunFailed = false;
  let anchorRect = null;
  let rows = [];
  let lastResult = { text: '', src: '' };
  let selTimer = null;
  let mouseDown = false;

  function setHint(text, warn) {
    hint.textContent = text;
    hint.dataset.warn = warn ? '1' : '0';
  }

  function baseHint(p) {
    setHint((p ? p.label : '翻译') + ' · 划词即译 · Esc 关闭', false);
  }

  // 屏幕底部的一次性提示条（1.6 秒后自动消失）
  // 为什么需要它：开关类操作如果不给任何反馈，用户就不知道自己现在是开还是关
  let toastEl = null;
  let toastTimer = null;
  function showToast(text) {
    try {
      if (!toastEl) {
        toastEl = el('div', 'toast');
        shadow.appendChild(toastEl);
      }
      toastEl.textContent = text;
      toastEl.classList.add('on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1600);
    } catch (e) { /* 提示条出问题绝不影响主功能 */ }
  }

  function themeOf() {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const lum = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
        return lum < 128 ? 'dark' : 'light';
      }
    } catch (e) { /* ignore */ }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function refreshChrome() {
    panel.dataset.theme = themeOf();
    panel.dataset.display = CONFIG.display;
    btnMode.textContent = CONFIG.display === 'bilingual' ? '对照' : '仅译文';
    btnMode.dataset.on = CONFIG.display === 'bilingual' ? '1' : '0';
    btnPin.dataset.on = pinned ? '1' : '0';
    btnPin.textContent = pinned ? '已钉住' : '钉住';
  }

  async function copyText(text, btn) {
    if (!text) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      try {
        const ta = el('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch (e2) { ok = false; }
    }
    const old = btn.textContent;
    btn.textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => { btn.textContent = old; }, 900);
  }

  function place(rect) {
    if (!rect) return;
    const pad = 8;
    const pw = panel.offsetWidth || 480;
    const ph = panel.offsetHeight || 220;
    const left = Math.min(Math.max(pad, rect.left), Math.max(pad, window.innerWidth - pw - pad));
    let top = rect.bottom + 8;
    if (top + ph > window.innerHeight - pad) {
      const above = rect.top - ph - 8;
      top = above >= pad ? above : Math.max(pad, window.innerHeight - ph - pad);
    }
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  function show(rect) {
    anchorRect = rect;
    panel.classList.add('on');
    requestAnimationFrame(() => {
      if (!manualMoved) place(anchorRect);
    });
  }

  function hidePanel() {
    panel.classList.remove('on');
    pinned = false;
    manualMoved = false;
    hideDictCard();
    refreshChrome();
  }

  function setStat(done, total) {
    statEl.textContent = total > 1 ? done + '/' + total + ' 段' : '';
  }

  function addRow(item) {
    const row = el('div', 'row');
    const tgt = el('div', 'txt tgt loading');
    tgt.textContent = '翻译中…';
    row.appendChild(tgt);
    let src = null;
    if (CONFIG.display === 'bilingual') {
      src = el('div', 'txt src');
      renderSrcWords(src, item);          // 原文渲染成一个个可点击的单词（代码块除外）
      row.appendChild(src);
    }
    body.appendChild(row);
    return { row, tgt, src, item, srcText: item.src, plain: '' };
  }

  function renderSegments(container, text) {
    for (const seg of toSegments(text)) {
      if (seg.code) {
        const span = el('span', 'code');
        span.textContent = seg.s;
        container.appendChild(span);
      } else {
        container.appendChild(document.createTextNode(seg.s));
      }
    }
  }

  function updateRow(index, result, err) {
    const r = rows[index];
    if (!r) return;
    r.tgt.classList.remove('loading');
    if (err) {
      r.tgt.classList.add('err');
      r.tgt.textContent = '翻译失败：' + err.message;
      return;
    }
    r.tgt.classList.remove('err');
    r.tgt.textContent = '';
    renderSegments(r.tgt, result.text);
    r.plain = plainOf(result.text);
    if (result.missing && result.missing.length) {
      const miss = el('span', 'miss');
      miss.textContent = '⚠ 未还原，原文：' + result.missing.join(' 、 ');
      r.tgt.appendChild(miss);
    }
  }

  /* ============================ 9. 翻译流程 ============================ */

  function makeBatches(items, limit) {
    const batches = [];
    let cur = null;
    items.forEach((it, i) => {
      const len = it.masked.length;
      if (!cur || cur.chars + len + 1 > limit) {
        cur = { items: [], chars: 0, start: i };
        batches.push(cur);
      }
      cur.items.push(it);
      cur.chars += len + 1;
    });
    return batches;
  }

  function splitLines(out, n) {
    const lines = String(out).split('\n').map((s) => s.trim()).filter(Boolean);
    return lines.length === n ? lines : null;
  }

  async function translateBatch(batch, ctx) {
    const pair = ctx.pair;
    const joined = batch.items.map((it) => it.masked).join('\n');
    let raw = cacheGet(pair, joined);
    if (raw === null) {
      raw = await apiTranslate(joined, ctx);
      cacheSet(pair, joined, raw);
    }
    let lines = splitLines(raw, batch.items.length);
    if (!lines) {
      // 换行没被保住：退回逐条请求，保证对照不错位
      lines = [];
      for (const it of batch.items) {
        let one = cacheGet(pair, it.masked);
        if (one === null) {
          one = await apiTranslate(it.masked, ctx);
          cacheSet(pair, it.masked, one);
        }
        lines.push(one);
      }
    }
    return lines.map((t, i) => finalize(t, batch.items[i], ctx.tgtLang));
  }

  function startRun(text, rect) {
    const token = ++runToken;
    abortAll();
    lastRunFailed = false;
    btnRetry.style.display = 'none';
    // 【修 bug】必须先解开上一次的 fatal 锁。
    // blockNotice 是模块级的：上一次因为"密钥无效"锁上之后，用户去设置页把 key 改好、
    // 再划一段新文字，如果他还点了「保存」那没问题（保存会清空），
    // 但要是他用别的方式修好了（改代理的密钥文件、换个能用的引擎），
    // 这个锁会一直挂着，之后每次划词都在开跑前就直接抛错 ——
    // 表现就是"工具彻底没反应了，怎么划都是同一句报错"。
    // 每次新开一次翻译就重新给一次机会，是更符合直觉的行为。
    blockNotice = '';

    let truncated = false;
    let source = text;
    if (source.length > CONFIG.maxChars) {
      source = source.slice(0, CONFIG.maxChars);
      truncated = true;
    }

    const srcLang = detectLang(source);
    const tgtLang = srcLang === 'zh-CN' ? 'en' : 'zh-CN';

    // 只用用户选定的引擎。没配好就让它报清楚的错，【不偷偷退回别的引擎】。
    // 原来的做法是"没填密钥就悄悄改用 MyMemory"，那样有两个问题：
    //   ① 用户不知道自己在用一个质量差得多的引擎
    //   ② MyMemory 是公开语料库，内容会进别人的语料（隐私）
    // 现在改成：直接报错并告诉他去哪儿填 key。
    const provider = PROVIDERS[CONFIG.provider] || PROVIDERS.openai;

    // 现在只有两个引擎，语言代码也不需要再转来转去了：
    //   直连的 openai 用标准代码（zh-CN / en）；本机代理也是原样传。
    const mapLang = (l) => l;
    const from = provider.autoSource ? 'auto' : mapLang(srcLang);
    const to = mapLang(tgtLang);

    const units = splitUnits(cleanMarkdown(source), provider.batchChars - 30);
    if (units.length === 0) { hidePanel(); return; }

    const items = units.map((u) => {
      const m = mask(u);
      return { src: u, masked: m.text, map: m.map };
    });

    const ctx = {
      token,
      provider,
      from,
      to,
      tgtLang,
      pair: provider.id + ':' + from + '>' + to,
      pool: createPool(provider.concurrency)
    };

    currentText = text;
    lastResult = { text: '', src: text };
    manualMoved = false;
    body.textContent = '';
    hideDictCard();                 // 换了新选区，旧的词典卡片作废
    rows = items.map(addRow);
    dirEl.textContent = (LANG_LABEL[srcLang] || srcLang) + ' → ' + (LANG_LABEL[tgtLang] || tgtLang) + (truncated ? '（已截断）' : '');
    setStat(0, items.length);
    baseHint(provider);
    refreshChrome();
    show(rect);

    const batches = makeBatches(items, provider.batchChars);
    let done = 0;

    batches.forEach((batch) => {
      ctx.pool.run(async () => {
        try {
          const results = await translateBatch(batch, ctx);
          if (token !== runToken) return;
          results.forEach((res, i) => updateRow(batch.start + i, res, null));
        } catch (e) {
          if (token !== runToken) return;
          const err = e instanceof Error ? e : new Error(String(e));
          batch.items.forEach((_, i) => updateRow(batch.start + i, null, err));
          lastRunFailed = true;
          btnRetry.style.display = '';
          if (err.quota) setHint('额度/配置受限 · 点击重试或换引擎', true);
          // 【修 bug】这里原来写的是「检查脚本里的密钥」——那是只有本机代理时代才成立的说法。
          // 公开版（v2.0 起）密钥是用户在「⚙ 设置自己的 AI」里填的，脚本里根本没有密钥，
          // 用户照着这句去找只会白费工夫。按当前引擎给出真正该去的地方。
          else if (err.fatal) {
            setHint(provider.id === 'openai'
              ? '配置有误 · 点油猴图标 →「⚙ 设置自己的 AI」检查 key / 接口地址 / 模型名'
              : '配置有误 · 检查本机代理的黑窗口和 ~/.dsh/.credentials.yaml', true);
          }
        } finally {
          if (token === runToken) {
            done += batch.items.length;
            setStat(Math.min(done, items.length), items.length);
            lastResult.text = rows.map((r) => r.plain).filter(Boolean).join('\n');
          }
        }
      });
    });
  }

  /* ============================ 10. 选区事件 ============================ */

  function selectionRect(sel) {
    try {
      const range = sel.getRangeAt(0);
      const rects = range.getClientRects();
      for (let i = rects.length - 1; i >= 0; i--) {
        const r = rects[i];
        if (r.width > 0 || r.height > 0) return r;
      }
      const r = range.getBoundingClientRect();
      if (r && (r.width || r.height)) return r;
    } catch (e) { /* ignore */ }
    return null;
  }

  function insidePanel(node) {
    if (!node) return false;
    try {
      const root = node.getRootNode ? node.getRootNode() : null;
      if (root === shadow) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function inEditable(node) {
    let n = node;
    while (n && n.nodeType === 1) {
      const tag = n.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || n.isContentEditable) return true;
      n = n.parentNode;
    }
    return false;
  }

  function onSelectionSettled() {
    if (!enabled) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    if (insidePanel(sel.anchorNode) || insidePanel(sel.focusNode)) return;
    if (CONFIG.skipEditable && inEditable(sel.anchorNode)) return;
    const text = readSelectionText();
    if (!isWorthTranslating(text)) return;
    const rect = selectionRect(sel);
    if (text === currentText && panel.classList.contains('on') && !lastRunFailed) {
      if (rect) { anchorRect = rect; if (!manualMoved) place(rect); }
      return;
    }
    startRun(text, rect);
  }

  function scheduleSelectionCheck(delay) {
    clearTimeout(selTimer);
    selTimer = setTimeout(onSelectionSettled, delay);
  }

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    mouseDown = true;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(host) === -1 && panel.classList.contains('on') && !pinned) hidePanel();
    // 点面板外面也把设置面板收起来
    if (path.indexOf(host) === -1 && settingsPanel.classList.contains('on')) closeSettings();
  }, true);

  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    mouseDown = false;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(host) !== -1) return;
    scheduleSelectionCheck(10);
  }, true);

  document.addEventListener('selectionchange', () => {
    if (mouseDown) return;          // 拖动中不触发，等 mouseup 一次性处理
    scheduleSelectionCheck(220);    // 键盘 Shift+方向键选词
  });

  // 按键监听挂在 window 上（不是 document）：
  // 事件传播顺序是 window → document → 页面元素，挂得越靠前越可能抢在网站自己的快捷键之前。
  // 有些网站在 document 上抢先处理 Alt+T，挂在 window 上就能赢过它们。
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 从最上面那层开始关：设置面板 → 词典卡片 → 气泡
      if (settingsPanel.classList.contains('on')) { closeSettings(); return; }
      if (dictCard.classList.contains('on')) { hideDictCard(); return; }
      if (panel.classList.contains('on')) { hidePanel(); return; }
      return;
    }
    // Alt+T 开关；Alt+Shift+T 作为备用（有些网站会占用 Alt+T）
    // 用 e.code 判断而不是只看 e.key：中文输入法开启时 e.key 可能不是 't'，但 e.code 始终是 'KeyT'
    if (e.altKey && (e.code === 'KeyT' || e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      setEnabled(!enabled);
    }
  }, true);

  let scrollTick = false;
  window.addEventListener('scroll', () => {
    if (!panel.classList.contains('on') || manualMoved || scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const rect = selectionRect(sel);
      if (rect) { anchorRect = rect; place(rect); }
    });
  }, true);

  window.addEventListener('resize', () => {
    if (panel.classList.contains('on') && !manualMoved && anchorRect) place(anchorRect);
  });

  /* --------- 面板内交互 --------- */

  let drag = null;
  shadow.addEventListener('mousedown', (e) => {
    const t = e.target;
    pressAt = { x: e.clientX, y: e.clientY };     // 记下按下位置：用来区分「点击」和「拖选」
    // 在原文/译文/词典卡片/设置面板里都要允许正常交互（不然输入框点不进去、下拉点不开）
    // 踩过的坑：一开始这里只写了 .txt 和 .dictcard，结果设置面板的输入框
    //           每次 mousedown 都被下面的 preventDefault 挡掉，光标进不去。
    const inText = t && t.closest
      ? (t.closest('.txt') || t.closest('.dictcard') || t.closest('.settings'))
      : null;
    if (inText) return;
    e.preventDefault();              // 关键：防止点击面板清空页面上的选区
    e.stopPropagation();
    const btn = t && t.closest ? t.closest('.btn') : null;
    if (btn || !t.closest || !t.closest('.hdr')) return;
    const r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    manualMoved = true;
  }, true);

  // 点词查词典：用「按下 → 抬起」的位移区分点击和拖选
  shadow.addEventListener('click', (e) => {
    const t = e.target;
    const w = t && t.closest ? t.closest('.w') : null;
    if (w) {
      if (pressAt) {
        const dx = e.clientX - pressAt.x;
        const dy = e.clientY - pressAt.y;
        if (dx * dx + dy * dy > 25) return;   // 移位超过 5 像素 → 是拖选（复制），不查词
      }
      e.preventDefault();
      e.stopPropagation();
      lookupWord(w.dataset.w || w.textContent, w);
      return;
    }
    if (t && t.closest && t.closest('.dictcard')) return;   // 点卡片内部不关卡片
    hideDictCard();
  }, true);

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    e.preventDefault();
    panel.style.left = Math.max(4, Math.min(e.clientX - drag.dx, window.innerWidth - panel.offsetWidth - 4)) + 'px';
    panel.style.top = Math.max(4, Math.min(e.clientY - drag.dy, window.innerHeight - 40)) + 'px';
  }, true);

  window.addEventListener('mouseup', () => { drag = null; }, true);

  btnClose.addEventListener('click', hidePanel);

  btnPin.addEventListener('click', () => {
    pinned = !pinned;
    refreshChrome();
  });

  btnMode.addEventListener('click', () => {
    CONFIG.display = CONFIG.display === 'bilingual' ? 'translated' : 'bilingual';
    store.set('display', CONFIG.display);
    rows.forEach((r) => {
      if (CONFIG.display === 'bilingual' && !r.src) {
        const src = el('div', 'txt src');
        renderSrcWords(src, r.item || { src: r.srcText, masked: r.srcText, map: {} });
        r.row.appendChild(src);
        r.src = src;
      } else if (CONFIG.display === 'translated' && r.src) {
        r.src.remove();
        r.src = null;
      }
    });
    refreshChrome();
  });

  btnCopyT.addEventListener('click', () => copyText(lastResult.text, btnCopyT));
  btnCopyS.addEventListener('click', () => copyText(lastResult.src, btnCopyS));

  btnRetry.addEventListener('click', () => {
    if (!lastResult.src) return;
    blockNotice = '';
    startRun(lastResult.src, anchorRect);
  });

  /* ============================ 12. 点词查词典 ============================ */

  /*
   * 设计要点：
   *   · 只有「原文行」里的词可点（译文是中文，反查英文需要词对齐技术，不做）
   *   · 代码/标识符（原本被 mask 成 [[0]] 的那些）整块跳过：不可点、不查
   *   · 点击 vs 拖选：按下与抬起的距离小于 5 像素才算点击，否则当拖选（防误触发）
   *   · 第 1 级：本地词典（免费、2 毫秒、不联网）—— 音标、释义、变形、考试标签、编程义
   *   · 第 2 级：点「看这句话里的意思」才调 AI（花钱，但只有它能判语境）
   */

  const dictCard = el('div', 'dictcard');
  shadow.appendChild(dictCard);

  const srcItemOf = new WeakMap();   // 单词 span → 它所属的 item（用来取整句给 AI）
  let pressAt = null;                // 鼠标按下位置，用于区分点击和拖选
  let dictWord = '';                 // 卡片当前显示的词
  let dictSentence = '';             // 它所在的那句话

  function dictUrl(kind) {
    return CONFIG.localEndpoint.replace(/\/translate$/, '/' + kind);
  }

  function isLookupable(t) {
    if (!t || t.length < 2 || t.length > 40) return false;
    if (!/[A-Za-z]/.test(t)) return false;          // 必须含字母（纯数字/符号不查）
    if (!/[aeiouyAEIOUY]/.test(t)) return false;    // 至少一个元音，过滤 xxx、nth 之类缩写
    return true;
  }

  // 分词：优先用浏览器自带的 Intl.Segmenter（能正确处理 don't、Node.js 这类）
  function splitWords(text) {
    try {
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        const seg = new Intl.Segmenter('en', { granularity: 'word' });
        const out = [];
        for (const s of seg.segment(text)) out.push({ text: s.segment, isWord: !!s.isWordLike });
        return out;
      }
    } catch (e) { /* 落到下面的正则兜底 */ }
    const out = [];
    const re = /[A-Za-z0-9_'\u2019-]+|[^A-Za-z0-9_'\u2019-]+/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push({ text: m[0], isWord: /[A-Za-z0-9]/.test(m[0]) });
    return out;
  }

  function appendWordSpans(container, text, item) {
    for (const seg of splitWords(text)) {
      if (seg.isWord && isLookupable(seg.text)) {
        const s = el('span', 'w');
        s.textContent = seg.text;
        s.dataset.w = seg.text;
        s.title = '点一下查这个词';
        srcItemOf.set(s, item);
        container.appendChild(s);
      } else {
        container.appendChild(document.createTextNode(seg.text));
      }
    }
  }

  // 原文渲染：借助 mask 过的文本定位「代码块」（整块渲染成等宽、不可点），
  // 其余文字再切分成可点击的单词。这样 npm ci / index.js 不会被拆碎乱查。
  function renderSrcWords(container, item) {
    const masked = item.masked || item.src;
    const map = item.map || {};
    let i = 0;
    while (i < masked.length) {
      const open = masked.indexOf('[[', i);
      if (open === -1) { appendWordSpans(container, masked.slice(i), item); break; }
      const close = masked.indexOf(']]', open);
      if (close === -1) { appendWordSpans(container, masked.slice(i), item); break; }
      if (open > i) appendWordSpans(container, masked.slice(i, open), item);
      const orig = map[masked.slice(open + 2, close)];
      if (orig === undefined) {
        appendWordSpans(container, masked.slice(open, close + 2), item);
      } else {
        const code = el('span', 'code');
        code.textContent = orig;
        code.title = '代码 / 标识符，不查词典';
        container.appendChild(code);
      }
      i = close + 2;
    }
  }

  function hideDictCard() {
    const on = shadow.querySelector('.w.on');
    if (on) on.classList.remove('on');
    dictCard.classList.remove('on');
  }

  function placeDictCard(anchorEl) {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const pad = 8;
    const cw = dictCard.offsetWidth || 340;
    const ch = dictCard.offsetHeight || 180;
    const left = Math.min(Math.max(pad, r.left), Math.max(pad, window.innerWidth - cw - pad));
    let top = r.bottom + 6;
    if (top + ch > window.innerHeight - pad) {
      const above = r.top - ch - 6;
      top = above >= pad ? above : Math.max(pad, window.innerHeight - ch - pad);
    }
    dictCard.style.left = left + 'px';
    dictCard.style.top = top + 'px';
  }

  function dictLine(text, cls) {
    const d = el('div', cls || 'dline');
    d.textContent = text;
    return d;
  }

  // 建卡片骨架（标题 + 发音 + 关闭），返回可供填充的 body
  function dictShell(word, phonetic) {
    dictCard.dataset.theme = themeOf();
    dictCard.textContent = '';
    const head = el('div', 'dhead');
    const w = el('span', 'dw');
    w.textContent = word;
    head.appendChild(w);
    if (phonetic) {
      const p = el('span', 'dp');
      p.textContent = '/' + phonetic.replace(/^\/|\/$/g, '') + '/';
      head.appendChild(p);
    }
    const acts = el('div', 'dacts');
    const say = el('button', 'dbtn');
    say.textContent = '🔊';
    say.title = '读一遍（浏览器自带发音，不联网）';
    say.addEventListener('click', () => speakWord(word));
    const close = el('button', 'dbtn');
    close.textContent = '✕';
    close.title = '关闭（Esc）';
    close.addEventListener('click', hideDictCard);
    acts.appendChild(say);
    acts.appendChild(close);
    head.appendChild(acts);
    dictCard.appendChild(head);
    const body = el('div', 'dbody');
    dictCard.appendChild(body);
    return body;
  }

  function speakWord(word) {
    try {
      if (!window.speechSynthesis) { showToast('这个浏览器不支持朗读'); return; }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(word);
      u.lang = 'en-US';
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    } catch (e) { showToast('朗读失败：' + e.message); }
  }

  // 直连 AI 时用的「查词释义」提示词（代理不在时的降级方案）
  function directDictPrompt(word, sentence) {
    return [
      '你是英语学习助手，服务对象是正在读英文技术文档的中文读者。',
      '用户给你一个单词和它所在的句子。只输出 JSON，不要解释、不要 markdown 代码块。格式：',
      '{"pos":"词性如 n./v./adj.","cn":"在这句话里的中文意思，不超过20字","field":"领域如 编程/通用","why":"为什么是这个意思，不超过30字","top":["该词另外 2 个常用中文释义，每条不超过12字"],"forms":"常见变形，用 / 分隔"}',
      '规则：以这句话的语境为准，不要罗列所有意思；cn 要短，像词典释义。'
    ].join('\n');
  }

  function stripFence(s) {
    return String(s || '').trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  // 语境义：优先走代理（它带着本地词典和专门的提示词）；代理不在时退回直连 AI
  function askAIInContext(word, sentence) {
    const viaProxy = function () {
      return httpRequest({
        method: 'POST',
        url: dictUrl('explain'),
        data: JSON.stringify({ word: word, sentence: sentence }),
        headers: { 'Content-Type': 'application/json' }
      }).then(function (res) {
        const j = JSON.parse(res.text);
        if (!j.ok) throw new Error(j.error || 'AI 请求失败');
        return j;
      });
    };
    const viaDirect = function () {
      return directCall(CONFIG.direct, '单词：' + word + '\n句子：' + sentence, directDictPrompt(word, sentence))
        .then(function (txt) {
          let j = null;
          try { j = JSON.parse(stripFence(txt)); } catch (e) { j = null; }
          if (!j || typeof j !== 'object') {
            return { ok: true, pos: '', cn: String(txt).slice(0, 60), field: '', why: '' };
          }
          return {
            ok: true,
            pos: String(j.pos || ''),
            cn: String(j.cn || ''),
            field: String(j.field || ''),
            why: String(j.why || ''),
            isFunctionWord: !!j.isFunctionWord
          };
        });
    };
    return viaProxy().catch(function (e) {
      if (directReady()) return viaDirect();
      throw new Error('需要本机代理（它提供本地词典）；或在「⚙ 设置自己的 AI」里配好直连');
    });
  }

  function askAI(wrap, btn, anchorEl) {
    if (!dictSentence) { showToast('拿不到整句，没法判断语境'); return; }
    btn.disabled = true;
    btn.textContent = 'AI 正在判断…';
    askAIInContext(dictWord, dictSentence)
      .then((j) => {
        btn.remove();
        const box = el('div', 'dsec');
        const line = el('div', 'dline');
        const strong = el('strong');
        strong.textContent = '在这句话里：' + (j.pos ? j.pos + ' ' : '') + j.cn;
        line.appendChild(strong);
        if (j.field && j.field !== '通用') {
          const tag = el('span', 'ddim');
          tag.textContent = '（' + j.field + '）';
          line.appendChild(tag);
        }
        box.appendChild(line);
        if (j.why) box.appendChild(dictLine(j.why, 'ddim'));
        if (j.isFunctionWord) box.appendChild(dictLine('功能词，只需知道它起什么语法作用', 'ddim'));
        wrap.appendChild(box);
        placeDictCard(anchorEl);
      })
      .catch((e) => {
        btn.disabled = false;
        btn.textContent = '💡 重试';
        wrap.appendChild(dictLine('AI 判断失败：' + e.message, 'dwarn'));
        placeDictCard(anchorEl);
      });
  }

  function aiButton(anchorEl) {
    const wrap = el('div', 'dai');
    const btn = el('button', 'dbtn');
    btn.textContent = '💡 看这句话里的意思（AI）';
    btn.title = '词典只能给"这个词有哪些意思"，要判断"在这句话里是哪个意思"必须问 AI';
    btn.addEventListener('click', () => askAI(wrap, btn, anchorEl));
    wrap.appendChild(btn);
    return wrap;
  }

  function renderDictFound(word, data, anchorEl) {
    const body = dictShell(data.word || word, data.phonetic || '');

    if (data.fromForm) body.appendChild(dictLine('变形词：' + word + ' → 原形 ' + data.fromForm, 'ddim'));
    else if (data.baseForm) body.appendChild(dictLine('原形：' + data.baseForm + '（这个词是它的变形）', 'ddim'));

    if (!data.found) {
      body.appendChild(dictLine('词典里没有「' + word + '」', 'dline'));
      body.appendChild(dictLine('可能是专有名词、缩写或新造词。', 'ddim'));
      body.appendChild(aiButton(anchorEl));
      placeDictCard(anchorEl);
      return;
    }

    // 编程义：来自词典自带的 [计]/[网] 标注，免费
    if (data.techDefs && data.techDefs.length) {
      const sec = el('div', 'dsec dtech');
      data.techDefs.forEach((d) => sec.appendChild(dictLine(d)));
      body.appendChild(sec);
    }

    // 默认显示：常用释义（最多 2 条）
    (data.top || []).forEach((d) => body.appendChild(dictLine(d)));

    // 折叠区：其余释义 + 英文释义
    const rest = (data.definitions || []).filter((d) => (data.top || []).indexOf(d) < 0 && (data.techDefs || []).indexOf(d) < 0);
    const more = el('div', 'dsec');
    more.style.display = 'none';
    rest.forEach((d) => more.appendChild(dictLine(d)));
    if ((data.definitionEn || []).length) {
      const en = el('div', 'dsec ddim');
      en.appendChild(dictLine('英文释义：'));
      data.definitionEn.forEach((d) => en.appendChild(dictLine('· ' + d)));
      more.appendChild(en);
    }
    body.appendChild(more);

    const enCount = (data.definitionEn || []).length;
    if (rest.length || enCount) {
      const btnMore = el('button', 'dbtn');
      const parts = [];
      if (rest.length) parts.push(rest.length + ' 条中文释义');
      if (enCount) parts.push('英文释义');
      const label = rest.length ? '展开全部（还有 ' + parts.join(' + ') + '）' : '展开英文释义';
      btnMore.textContent = label;
      btnMore.addEventListener('click', () => {
        const shown = more.style.display !== 'none';
        more.style.display = shown ? 'none' : 'block';
        btnMore.textContent = shown ? label : '收起';
        placeDictCard(anchorEl);
      });
      const bar = el('div', 'dsec');
      bar.appendChild(btnMore);
      body.appendChild(bar);
    }

    const forms = [...new Set(data.forms || [])];
    if (forms.length) body.appendChild(dictLine('变形：' + forms.join(' / '), 'ddim'));

    const meta = [];
    if ((data.tagsCn || []).length) meta.push('考试：' + data.tagsCn.join(' · '));
    if (data.collins) meta.push('柯林斯 ' + data.collins + ' 星');
    if (data.bnc) meta.push('高频度 ' + data.bnc);
    if (meta.length) body.appendChild(dictLine(meta.join('　'), 'ddim'));

    // 第 2 级：只有用户主动点才调 AI（省钱）
    body.appendChild(aiButton(anchorEl));
    placeDictCard(anchorEl);
  }

  function lookupWord(word, anchorEl) {
    if (!CONFIG.dictOnClick) return;
    const item = srcItemOf.get(anchorEl);
    dictWord = word;
    dictSentence = item ? item.src : '';

    shadow.querySelectorAll('.w.on').forEach((n) => n.classList.remove('on'));
    anchorEl.classList.add('on');

    const body = dictShell(word, '');
    body.appendChild(dictLine('查询中…', 'ddim'));
    dictCard.classList.add('on');
    placeDictCard(anchorEl);

    const cached = cacheGet('dict', word.toLowerCase());
    if (cached) {
      try { renderDictFound(word, JSON.parse(cached), anchorEl); return; } catch (e) { /* 缓存坏了就重查 */ }
    }

    httpRequest({ method: 'GET', url: dictUrl('lookup') + '?word=' + encodeURIComponent(word) })
      .then((res) => {
        const data = JSON.parse(res.text);
        if (!data.ok) throw new Error(data.error || '词典查询失败');
        if (data.found) {
          try { cacheSet('dict', word.toLowerCase(), JSON.stringify(data)); } catch (e) { /* 缓存失败不影响显示 */ }
        }
        renderDictFound(word, data, anchorEl);
      })
      .catch((e) => {
        const b = dictShell(word, '');
        b.appendChild(dictLine('本地词典查不到：' + e.message, 'dwarn'));
        // 本地词典是代理提供的（86MB 数据）。没代理时给用户一条出路。
        b.appendChild(dictLine(directReady()
          ? '本地词典需要代理；不过可以问 AI 看看这个词在这句话里的意思。'
          : '本地词典需要代理：双击 启动翻译代理.cmd；或在「⚙ 设置自己的 AI」里配好直连。', 'ddim'));
        if (directReady()) b.appendChild(aiButton(anchorEl));
        else {
          const btnGo = el('button', 'dbtn');
          btnGo.textContent = '⚙ 去设置自己的 AI';
          btnGo.addEventListener('click', () => { hideDictCard(); openSettings(); });
          const bar = el('div', 'dai');
          bar.appendChild(btnGo);
          b.appendChild(bar);
        }
        placeDictCard(anchorEl);
      });
  }

  /* ============================ 13. 设置自己的 AI（公开版用） ============================ */

  /*
   * 为什么要有这一节：
   *   默认走本机代理（借用 DSH 配好的线路），但那样别人要用就必须装 Node + 跑代理。
   *   这一节让用户【填自己的 key 直连 AI】，于是：
   *     · 电脑上不需要装 Node、不需要黑窗口
   *     · 支持任何「OpenAI 兼容」的服务：DeepSeek / OpenAI / Kimi / 智谱 / 通义 / OpenRouter / 本地 Ollama…
   *   代理仍然可用（它多了本地词典、共享缓存、提示词可远程更新），但不再必需。
   */

  // 每家都带上「去哪拿 key」的链接和步骤 —— 摩擦最大的就是这一步，必须写清楚
  // 链接都实测过可达（OpenAI 那台机器连不上是网络原因，正常网络下可用）
  const PRESETS = [
    {
      id: 'deepseek', name: 'DeepSeek（便宜，推荐）',
      baseURL: 'https://api.deepseek.com', model: 'deepseek-chat',
      signup: 'https://platform.deepseek.com/api_keys',
      steps: ['打开下面的链接，注册（手机号就行）', '进左侧「API keys」页面，点「创建 API key」', '复制那串 sk- 开头的字符', '粘到上面「API 密钥」框里，点「测试连接」'],
      note: '充值最低 10 元，够翻几十万字'
    },
    {
      id: 'openai', name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
      signup: 'https://platform.openai.com/api-keys',
      steps: ['打开下面的链接并登录', '点「Create new secret key」', '复制弹出的 sk-...（关掉窗口就看不到了，马上存好）', '粘到上面「API 密钥」框里，点「测试连接」'],
      note: '需要绑海外支付方式；国内网络可能连不上'
    },
    {
      id: 'openrouter', name: 'OpenRouter（一个 key 调很多家）',
      baseURL: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat',
      signup: 'https://openrouter.ai/keys',
      steps: ['打开下面的链接注册（可以用 GitHub 账号登录）', '点「Create Key」', '复制那串 sk-or- 开头的字符', '粘到上面「API 密钥」框里，点「测试连接」'],
      note: '同一个 key 能调 Claude、Gemini 等很多模型'
    },
    {
      id: 'moonshot', name: '月之暗面 Kimi',
      baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k',
      signup: 'https://platform.moonshot.cn/console/api-keys',
      steps: ['打开下面的链接注册', '进「API Key 管理」，新建一个', '复制那串 sk- 开头的字符', '粘到上面「API 密钥」框里，点「测试连接」'],
      note: '国内直连，速度快'
    },
    {
      id: 'zhipu', name: '智谱 GLM',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash',
      signup: 'https://open.bigmodel.cn/usercenter/apikeys',
      steps: ['打开下面的链接注册', '进「API 密钥」页面，复制密钥', '粘到上面「API 密钥」框里', '点「测试连接」'],
      note: 'glm-4-flash 这个模型有免费额度'
    },
    {
      id: 'dashscope', name: '通义千问（阿里云百炼）',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',
      signup: 'https://bailian.console.aliyun.com/',
      steps: ['打开下面的链接，用阿里云账号登录', '开通「百炼」服务', '进「API-KEY 管理」创建并复制', '粘到上面「API 密钥」框里，点「测试连接」'],
      note: '新用户有免费额度'
    },
    {
      id: 'custom', name: '自定义（自己填地址）',
      baseURL: '', model: '',
      steps: ['填任何「OpenAI 兼容」格式的接口', '接口地址填到 /v1 为止，例如 https://your-host/v1', '模型名字照服务商文档里写的填', '点「测试连接」验证'],
      note: '大多数 AI 服务都提供这种兼容接口'
    }
  ];

  const settingsPanel = el('div', 'settings');
  shadow.appendChild(settingsPanel);

  // 直连模式用的翻译提示词（原来是放在代理里的，公开版必须搬进脚本）
  function directPrompt(targetName, segCount) {
    const rules = [
      '你是资深技术文档译者，服务对象是正在阅读英文技术文档的中文读者。',
      '规则：',
      '1. 把输入准确翻译成' + targetName + '，语气简洁、书面、专业。',
      '2. 输入中形如 [[0]]、[[12]] 的编号占位符代表代码、命令、路径、版本号等，必须原样保留在译文对应位置，不得改写、增删、重排序。',
      '3. 绝对不要自己创造这种占位符。输入里没有 [[数字]] 时，把原文的反引号、引号等格式原样保留即可。',
      '4. 保留英文专有名词与品牌原始写法：GitHub、Node.js、npm、Docker、JSON 等。',
      '5. 术语统一：repository=仓库、pull request=拉取请求、commit=提交、issue=议题、fork=分叉、branch=分支、merge=合并。',
      '6. 只输出译文。不要解释、不要加引号、不要用 markdown 代码块包裹。'
    ];
    if (segCount > 1) {
      rules.push('7. 输入有 ' + segCount + ' 行，逐行翻译；输出的行数必须与输入完全一致，一行对一行，不要合并也不要拆分。');
    }
    return rules.join('\n');
  }

  function directReady() {
    const d = CONFIG.direct;
    return !!(d && d.baseURL && d.model && d.apiKey);
  }

  function settingsRow(labelText, inputEl, hintText) {
    const row = el('div', 'srow');
    const lab = el('label', 'slabel');
    lab.textContent = labelText;
    row.appendChild(lab);
    row.appendChild(inputEl);
    if (hintText) {
      const h = el('div', 'shint');
      h.textContent = hintText;
      row.appendChild(h);
    }
    return row;
  }

  function buildSettings() {
    settingsPanel.dataset.theme = themeOf();
    settingsPanel.textContent = '';
    const d = CONFIG.direct || {};

    // 标题
    const head = el('div', 'shead');
    const title = el('span', 'stitle');
    title.textContent = '设置自己的 AI';
    head.appendChild(title);
    const closeBtn = el('button', 'btn');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closeSettings);
    head.appendChild(closeBtn);
    settingsPanel.appendChild(head);

    const tip = el('div', 'stip');
    tip.textContent = '填自己的 AI 接口后，【不再需要本机代理】——电脑上不用装 Node、不用开黑窗口。';
    settingsPanel.appendChild(tip);

    // 预设下拉
    const sel = el('select', 'sselect');
    PRESETS.forEach((p) => {
      const o = el('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    });
    sel.value = d.preset || 'deepseek';
    settingsPanel.appendChild(settingsRow('AI 服务商', sel, '选了会自动填下面两格，你只需要粘 API 密钥'));

    // 「怎么拿 key」的图文指引：跟着上面选的服务商变
    const guide = el('div', 'sguide');
    settingsPanel.appendChild(guide);
    function renderGuide(presetId) {
      guide.textContent = '';
      const p = PRESETS.filter((x) => x.id === presetId)[0];
      if (!p) return;
      const title = el('div', 'sgtitle');
      title.textContent = p.id === 'custom'
        ? '自定义接口怎么填：'
        : '怎么拿到 ' + p.name.replace(/（.*?）/, '') + ' 的 API 密钥：';
      guide.appendChild(title);
      (p.steps || []).forEach((s, i) => {
        const line = el('div', 'sstep');
        line.textContent = (i + 1) + '. ' + s;
        guide.appendChild(line);
      });
      if (p.signup) {
        const wrap = el('div', 'slink');
        const a = el('a');
        a.href = p.signup;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = '👉 ' + p.signup;
        wrap.appendChild(a);
        guide.appendChild(wrap);
      }
      if (p.note) {
        const n = el('div', 'sguidehint');
        n.textContent = '💡 ' + p.note;
        guide.appendChild(n);
      }
    }

    // 三个输入框
    const inBase = el('input', 'sinput');
    inBase.type = 'text';
    inBase.placeholder = 'https://api.deepseek.com';
    inBase.value = d.baseURL || '';
    const inModel = el('input', 'sinput');
    inModel.type = 'text';
    inModel.placeholder = 'deepseek-chat';
    inModel.value = d.model || '';
    const inKey = el('input', 'sinput');
    inKey.type = 'password';
    inKey.placeholder = 'sk-...';
    inKey.value = d.apiKey || '';
    inKey.autocomplete = 'off';

    sel.addEventListener('change', () => {
      const p = PRESETS.filter((x) => x.id === sel.value)[0];
      if (p && p.id !== 'custom') {
        inBase.value = p.baseURL;
        inModel.value = p.model;
      }
      renderGuide(sel.value);
    });
    // 首次打开且没配过时，自动填上默认预设
    if (!inBase.value) {
      const p = PRESETS.filter((x) => x.id === (d.preset || 'deepseek'))[0];
      if (p) { inBase.value = p.baseURL; inModel.value = p.model; }
    }
    renderGuide(sel.value || d.preset || 'deepseek');

    settingsPanel.appendChild(settingsRow('接口地址', inBase, '以 /chat/completions 结尾的那个地址之前的部分'));
    settingsPanel.appendChild(settingsRow('模型名字', inModel));
    settingsPanel.appendChild(settingsRow('API 密钥', inKey, '只存在你自己浏览器的油猴存储里，不会上传到任何地方'));

    const note = el('div', 'snote');
    note.textContent = '💡 「测试连接」通了再点「保存」，保存后会自动切换到直连，并记住这个选择。';
    settingsPanel.appendChild(note);

    // 按钮
    const bar = el('div', 'sbar');
    const btnTest = el('button', 'btn');
    btnTest.textContent = '测试连接';
    const btnSave = el('button', 'btn');
    btnSave.textContent = '保存';
    btnSave.dataset.on = '1';
    bar.appendChild(btnTest);
    bar.appendChild(btnSave);
    settingsPanel.appendChild(bar);

    const status = el('div', 'sstatus');
    settingsPanel.appendChild(status);

    btnTest.addEventListener('click', () => {
      status.textContent = '正在测试…';
      status.dataset.kind = '';
      const cfg = { baseURL: inBase.value.trim(), model: inModel.value.trim(), apiKey: inKey.value.trim() };
      if (!cfg.baseURL || !cfg.model || !cfg.apiKey) {
        status.textContent = '❌ 三个空都要填';
        status.dataset.kind = 'err';
        return;
      }
      directCall(cfg, 'Reply with the single word: ok', '只输出 ok 这个词')
        .then((txt) => {
          status.textContent = '✅ 连接成功，模型回了：' + String(txt).slice(0, 40);
          status.dataset.kind = 'ok';
        })
        .catch((e) => {
          status.textContent = '❌ ' + e.message;
          status.dataset.kind = 'err';
        });
    });

    btnSave.addEventListener('click', () => {
      CONFIG.direct = {
        preset: sel.value,
        baseURL: inBase.value.trim(),
        model: inModel.value.trim(),
        apiKey: inKey.value.trim()
      };
      store.set('direct', CONFIG.direct);
      store.set('provider', 'openai');   // 记住这个选择：设置页是用户主动操作，值得持久化
      status.textContent = '✅ 已保存。正在切换到「自定义 AI（直连）」…';
      status.dataset.kind = 'ok';
      CONFIG.provider = 'openai';
      blockNotice = '';
      setTimeout(() => { closeSettings(); showToast('已切换到直连 AI：' + CONFIG.direct.model); }, 700);
    });
  }

  // 一次直连调用（给"测试连接"和真正的翻译共用）
  function directCall(cfg, text, sysPrompt) {
    const url = String(cfg.baseURL).replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: cfg.model,
      messages: [
        { role: 'system', content: sysPrompt || '你是翻译助手。' },
        { role: 'user', content: text }
      ],
      temperature: 0
    };
    // DeepSeek 支持关掉「思考」，实测输出 token 从 465 降到 37（快十几倍、也便宜十几倍）。
    // 但 OpenAI 等接口不认这个字段（会报 Unrecognized request argument），所以只对 DeepSeek 加。
    if (/deepseek/i.test(cfg.baseURL)) body.thinking = { type: 'disabled' };
    return httpRequest({
      method: 'POST',
      url: url,
      data: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey }
    }).then((res) => {
      let j = null;
      try { j = JSON.parse(res.text); } catch (e) { throw new Error('返回不是 JSON（HTTP ' + res.status + '）'); }
      if (j.error) throw new Error((j.error && j.error.message) || '接口返回错误');
      const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!c) throw new Error('接口没有返回内容（检查模型名字是否正确）');
      return String(c).trim();
    });
  }

  function openSettings() {
    buildSettings();
    settingsPanel.classList.add('on');
    hideDictCard();
    const first = settingsPanel.querySelector('.sinput');
    if (first) setTimeout(() => { try { first.focus(); } catch (e) { /* 忽略 */ } }, 50);
  }

  function closeSettings() {
    settingsPanel.classList.remove('on');
  }

  /* ============================ 11. 开关与菜单 ============================ */

  function setEnabled(on) {
    enabled = !!on;
    store.set('enabled', enabled);
    if (!enabled) hidePanel();
    showToast(enabled ? '划词翻译：已开启（Alt+T 切换）' : '划词翻译：已关闭（Alt+T 切换）');
  }

  const savedDisplay = store.get('display', null);
  if (savedDisplay === 'bilingual' || savedDisplay === 'translated') CONFIG.display = savedDisplay;

  // 点词查词典的开关也读回来（用户可能关过）
  const savedDictOnClick = store.get('dictOnClick', null);
  if (typeof savedDictOnClick === 'boolean') CONFIG.dictOnClick = savedDictOnClick;

  // 直连 AI 的配置（公开版路径）：用户在设置页里填过就生效
  try {
    const savedDirect = store.get('direct', null);
    if (savedDirect && typeof savedDirect === 'object') Object.assign(CONFIG.direct, savedDirect);
  } catch (e) { /* 读不到就用空配置 */ }

  // 读回用户在设置页里选的引擎。
  // 必须放在读 direct 之后 —— openai 引擎的 ready() 依赖 CONFIG.direct。
  // 只有设置页点过「保存」才会存这个值；油猴菜单里那个「切换引擎」是临时的，不写它。
  const savedProvider = store.get('provider', null);
  if (savedProvider && PROVIDERS[savedProvider] && PROVIDERS[savedProvider].ready()) {
    CONFIG.provider = savedProvider;
  }
  refreshChrome();
  baseHint(PROVIDERS[CONFIG.provider] || PROVIDERS.openai);

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('划词翻译：开启 / 关闭', () => setEnabled(!enabled));
    GM_registerMenuCommand('切换 中英对照 / 仅译文', () => {
      CONFIG.display = CONFIG.display === 'bilingual' ? 'translated' : 'bilingual';
      store.set('display', CONFIG.display);
      refreshChrome();
      showToast(CONFIG.display === 'bilingual' ? '显示：中英对照' : '显示：仅译文');
    });
    GM_registerMenuCommand('⚙ 设置自己的 AI（填 key，免装代理）', openSettings);
    GM_registerMenuCommand('切换：点击原文单词查词典（开 / 关）', () => {
      CONFIG.dictOnClick = !CONFIG.dictOnClick;
      store.set('dictOnClick', CONFIG.dictOnClick);
      if (!CONFIG.dictOnClick) hideDictCard();
      showToast('点词查词典：' + (CONFIG.dictOnClick ? '已开启' : '已关闭'));
    });
    GM_registerMenuCommand('切换引擎（本机代理 / 填的 key）', () => {
      const order = ['dsh', 'openai'];
      // 只在本次会话内切换，不持久化：真正要长期切换请去设置页保存（那个会记住）
      CONFIG.provider = order[(order.indexOf(CONFIG.provider) + 1) % order.length];
      blockNotice = '';
      const p = PROVIDERS[CONFIG.provider];
      setHint(p.label + (p.ready() ? ' 已启用' : ' 未配置密钥'), !p.ready());
      showToast('引擎：' + p.label + (p.ready() ? '（仅本次会话）' : '（没配置好，划词会直接报错告诉你去哪填）'));
      setTimeout(() => baseHint(p), 2000);
    });
    GM_registerMenuCommand('检查本机翻译代理', () => {
      const health = CONFIG.localEndpoint.replace(/\/translate$/, '/health');
      httpRequest({ method: 'GET', url: health })
        .then((r) => {
          let j;
          try { j = JSON.parse(r.text); } catch (e) { alert('返回无法解析：' + r.text.slice(0, 200)); return; }
          alert('代理运行正常\n\n模型：' + j.model + '\n线路：' + j.baseURL +
            '\n密钥：' + (j.hasKey ? '已读取（' + j.keySource + '）' : '❌ 缺失') +
            '\n缓存：' + j.cacheSize + ' 条\n运行时长：' + j.uptimeSec + ' 秒');
        })
        .catch((e) => alert('代理没响应：' + e.message +
          '\n\n恢复方法：双击代理文件夹里的「启动翻译代理.cmd」\n（那个黑窗口不能关，关了就翻译不了）'));
    });
    GM_registerMenuCommand('清空翻译缓存', () => {
      cache.clear();
      store.set(CACHE_KEY, {});
      setHint('缓存已清空', false);
      setTimeout(() => baseHint(PROVIDERS[CONFIG.provider]), 1500);
    });
    GM_registerMenuCommand('查看引擎状态', () => {
      const lines = Object.keys(PROVIDERS).map((id) => {
        const p = PROVIDERS[id];
        return p.label + '：' + (p.ready() ? '已配置' : '未配置') + '（每批 ' + p.batchChars + ' 字符 / 并发 ' + p.concurrency + '）';
      });
      alert('当前引擎：' + (PROVIDERS[CONFIG.provider] ? PROVIDERS[CONFIG.provider].label : CONFIG.provider) +
        '\n本机代理：' + CONFIG.localEndpoint +
        '\n缓存条目：' + cache.size + '\n\n' + lines.join('\n') +
        '\n\n要改 key：油猴菜单 →「⚙ 设置自己的 AI」。');
    });
  }

  if (!enabled) hidePanel();

  // 首次使用的引导：只提示一次
  // 公开版用户电脑上没有代理，不提示的话他划词只会看到"翻译代理没在运行"，不知道该干嘛。
  if (!store.get('shownFirstRunTip', false)) {
    store.set('shownFirstRunTip', true);
    setTimeout(() => {
      if (directReady()) return;   // 已经配好直连，不需要提示
      showToast('首次使用：点油猴图标 →「⚙ 设置自己的 AI」填一下 key 即可开始');
    }, 1200);
  }
})();
