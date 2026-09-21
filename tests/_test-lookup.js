/* 临时测试：验证代理的 /lookup 接口（data/ 里，不进仓库） */
const http = require('http');

function get(p) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:8787' + p, (r) => {
      let s = '';
      r.on('data', (c) => { s += c; });
      r.on('end', () => resolve({ code: r.statusCode, body: s }));
    }).on('error', reject);
  });
}

const APOS = String.fromCharCode(39);

(async () => {
  const words = ['token', 'commit', 'committed', 'repositories', 'branches',
    'don' + APOS + 't', 'xyzzyplugh', 'JavaScript', 'repository', 'xyz'];

  let total = 0;
  for (const w of words) {
    const t0 = Date.now();
    const r = await get('/lookup?word=' + encodeURIComponent(w));
    const ms = Date.now() - t0;
    total += ms;
    const j = JSON.parse(r.body);
    console.log('── 查 ' + w + '   (' + ms + ' ms, HTTP ' + r.code + ')');
    if (!j.ok) { console.log('   ❌ ' + j.error); console.log(''); continue; }
    if (!j.found) { console.log('   （词典没有这个词）'); console.log(''); continue; }
    console.log('   词条   : ' + j.word +
      (j.fromForm ? '   ← 由变形「' + j.query + '」还原' : '') +
      (j.baseForm ? '   ← 它的原形是「' + j.baseForm + '」' : ''));
    console.log('   音标   : ' + (j.phonetic || '(无)'));
    console.log('   星级   : collins=' + j.collins + ' oxford=' + j.oxford + ' bnc=' + j.bnc);
    console.log('   考试   : [' + j.tagsCn.join(' ') + ']');
    console.log('   默认显示: ' + JSON.stringify(j.top));
    console.log('   编程义 : ' + JSON.stringify(j.techDefs) + (j.techNames.length ? '  领域=' + j.techNames.join('/') : ''));
    console.log('   全部 ' + j.definitions.length + ' 条释义, 变形=' + JSON.stringify(j.forms));
    console.log('');
  }

  console.log('==================== 边界情况 ====================');
  for (const p of ['/lookup', '/lookup?word=', '/lookup?word=' + 'x'.repeat(100)]) {
    const r = await get(p);
    console.log('  ' + p.slice(0, 40).padEnd(42) + ' -> HTTP ' + r.code + '  ' + r.body.slice(0, 80));
  }

  console.log('');
  console.log('合计 ' + total + ' ms / ' + words.length + ' 次查询');
})();
