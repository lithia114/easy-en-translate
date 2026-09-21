/*
 * build-dict.js —— 把 ECDICT 的 CSV 转成本地 SQLite 词典
 * ---------------------------------------------------------------------------
 * 输入：data/package/assets/ecdict.csv   （62.88 MB，77 万词条，MIT 许可）
 * 输出：data/ecdict.db                   （SQLite，供翻译代理毫秒级查询）
 *
 * 特点：零依赖 —— 用 Node 24 内置的 node:sqlite，不需要 npm install 任何东西。
 *
 * 数据怎么来（本机直连 GitHub 只有 11 KB/s，所以走 npm 国内镜像）：
 *     curl.exe -sL -o data\ecdict.tgz https://registry.npmmirror.com/ecdict/-/ecdict-0.0.4.tgz
 *     tar.exe -xzf data\ecdict.tgz -C data
 *   → data/package/assets/ecdict.csv  （62.88 MB，77 万词条，4 秒下完）
 *
 * 用法：node build-dict.js
 * 产出：data/ecdict.db（约 86 MB，实测转换耗时 7 秒）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SRC = path.join(__dirname, 'data', 'package', 'assets', 'ecdict.csv');
const OUT = path.join(__dirname, 'data', 'ecdict.db');

/* ---------------------------------------------------------------------------
 * 1. 真正的 CSV 解析器
 *
 * 为什么不能用 split(',')：ECDICT 里有 20 万行把逗号包在双引号里，例如
 *     -agogue,ə'ɡɒɡ,," [医]〔后缀〕意为催, 利",,,,,0,0,,,
 *                                    ↑ 这个逗号是释义的一部分，不是分隔符
 * 双引号内的 "" 表示一个字面量双引号。
 * ------------------------------------------------------------------------- */
function* csvRows(text) {
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // 转义的双引号
        else inQuotes = false;                             // 引号结束
      } else {
        field += c;                                        // 引号内的逗号/换行都算内容
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); field = ''; yield row; row = []; continue; }
    if (c === '\r') continue;
    field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); yield row; }
}

/* ---------------------------------------------------------------------------
 * 2. 解析 exchange 字段（变形数据）
 *
 * 形如：p:perceived/i:perceiving/3:perceives/d:perceived/s:perceives/0:perceive/1:p
 * 含义（ECDICT 约定）：
 *     0 = 原形    1 = 原形变化类型   p = 过去式   d = 过去分词
 *     i = 现在分词  3 = 第三人称单数  s = 复数     r = 比较级   t = 最高级
 * 我们要的是「变形 -> 原形」的反向映射，用来支持"点了 committed 也能查到 commit"。
 * ------------------------------------------------------------------------- */
const EXCHANGE_META = new Set(['0', '1']);

function parseExchange(word, exchange) {
  const out = [];
  if (!exchange) return out;
  for (const part of exchange.split('/')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const key = part.slice(0, i);
    const val = part.slice(i + 1);
    if (!val || EXCHANGE_META.has(key)) continue;
    if (val.toLowerCase() === word.toLowerCase()) continue;   // 与原形相同，不必记
    out.push([val.toLowerCase(), word]);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 3. 主流程
 * ------------------------------------------------------------------------- */
function main() {
  if (!fs.existsSync(SRC)) {
    console.error('❌ 找不到源文件：' + SRC);
    console.error('   请先确认 data/package/assets/ecdict.csv 存在');
    process.exit(1);
  }
  if (fs.existsSync(OUT)) {
    fs.unlinkSync(OUT);
    console.log('（已删除旧的 ' + path.relative(__dirname, OUT) + '，重新生成）');
  }

  console.log('读取 CSV ...');
  const t0 = Date.now();
  const text = fs.readFileSync(SRC, 'utf8');
  console.log('  ' + (text.length / 1048576).toFixed(1) + ' M 字符，用时 ' + (Date.now() - t0) + ' ms');

  console.log('打开数据库 ' + path.relative(__dirname, OUT) + ' ...');
  const db = new DatabaseSync(OUT);
  db.exec('PRAGMA journal_mode = OFF');
  db.exec('PRAGMA synchronous = OFF');
  db.exec(`
    CREATE TABLE dict (
      word        TEXT PRIMARY KEY COLLATE NOCASE,
      phonetic    TEXT,
      definition  TEXT,
      translation TEXT,
      pos         TEXT,
      collins     INTEGER DEFAULT 0,
      oxford      INTEGER DEFAULT 0,
      tag         TEXT,
      bnc         INTEGER DEFAULT 0,
      frq         INTEGER DEFAULT 0,
      exchange    TEXT
    )
  `);
  db.exec('CREATE TABLE forms (form TEXT PRIMARY KEY COLLATE NOCASE, base TEXT)');

  const insDict = db.prepare(
    'INSERT OR REPLACE INTO dict (word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  const insForm = db.prepare('INSERT OR IGNORE INTO forms (form,base) VALUES (?,?)');

  let n = 0, formCount = 0, header = true;
  let hasPhon = 0, hasColl = 0, hasTag = 0, hasExch = 0, hasTrans = 0, hasDef = 0;
  let formsParsed = 0;
  const samples = [];
  const t1 = Date.now();

  db.exec('BEGIN');
  for (const f of csvRows(text)) {
    if (header) { header = false; continue; }
    if (!f[0]) continue;
    const word = f[0];
    const phonetic = f[1] || '';
    const definition = f[2] || '';
    const translation = f[3] || '';
    const pos = f[4] || '';
    const collins = parseInt(f[5], 10) || 0;
    const oxford = parseInt(f[6], 10) || 0;
    const tag = f[7] || '';
    const bnc = parseInt(f[8], 10) || 0;
    const frq = parseInt(f[9], 10) || 0;
    const exchange = f[10] || '';

    insDict.run(word, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange);
    n++;
    if (phonetic) hasPhon++;
    if (collins) hasColl++;
    if (tag) hasTag++;
    if (exchange) hasExch++;
    if (translation) hasTrans++;
    if (definition) hasDef++;

    if (exchange) {
      formsParsed++;
      const pairs = parseExchange(word, exchange);
      for (const [form, base] of pairs) { insForm.run(form, base); formCount++; }
      if (samples.length < 6 && pairs.length) {
        samples.push(word + '  ->  ' + JSON.stringify(pairs));
      }
    }

    if (n % 100000 === 0) {
      console.log('  已处理 ' + n + ' 条 ...  ' + ((Date.now() - t1) / 1000).toFixed(1) + ' 秒');
    }
  }
  db.exec('COMMIT');

  console.log('');
  console.log('完成统计：');
  console.log('  词条数          ' + n);
  console.log('  变形映射数      ' + formCount + '（来自 ' + formsParsed + ' 个词的 exchange 字段）');
  console.log('  有中文释义      ' + hasTrans + '  (' + Math.round(hasTrans / n * 100) + '%)');
  console.log('  有英文释义      ' + hasDef + '  (' + Math.round(hasDef / n * 100) + '%)');
  console.log('  有音标          ' + hasPhon + '  (' + Math.round(hasPhon / n * 100) + '%)');
  console.log('  有柯林斯星级    ' + hasColl + '  (' + Math.round(hasColl / n * 100) + '%)');
  console.log('  有考试标签      ' + hasTag + '  (' + Math.round(hasTag / n * 100) + '%)');
  console.log('  有变形数据      ' + hasExch + '  (' + Math.round(hasExch / n * 100) + '%)');
  console.log('');
  console.log('变形映射样例：');
  samples.forEach((s) => console.log('  ' + s));
  console.log('');
  console.log('总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
  console.log('数据库文件：' + OUT + '  ' + (fs.statSync(OUT).size / 1048576).toFixed(1) + ' MB');

  db.close();
}

main();
