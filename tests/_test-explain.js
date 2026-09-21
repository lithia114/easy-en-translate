/* 临时测试：验证 /explain 语境义接口（data/ 里，不进仓库） */
const http = require('http');

function post(p, obj) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: 8787, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, (r) => {
      let s = '';
      r.on('data', (c) => { s += c; });
      r.on('end', () => resolve({ code: r.statusCode, body: s }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const cases = [
  ['token', 'Run the command with a token that has repo scope.'],
  ['commit', 'Commit your changes before switching branches.'],
  ['commit', 'She committed herself to finishing the project on time.'],
  ['fork', 'Fork this repository and open a pull request.'],
  ['fork', 'He ate the salad with a fork.'],
  ['the', 'The quick brown fox jumps over the lazy dog.'],
  ['branch', 'Create a new branch named feature/login.']
];

(async () => {
  for (const [word, sentence] of cases) {
    const t0 = Date.now();
    let r;
    try { r = await post('/explain', { word, sentence }); }
    catch (e) { console.log('❌ ' + word + ' 请求失败: ' + e.message); continue; }
    const ms = Date.now() - t0;
    let j = null;
    try { j = JSON.parse(r.body); } catch (e) {}
    console.log('── ' + word + '   (' + ms + ' ms, HTTP ' + r.code + ')');
    console.log('   句子: ' + sentence);
    if (!j || !j.ok) { console.log('   ❌ ' + (j ? j.error : r.body.slice(0, 100))); console.log(''); continue; }
    console.log('   词性: ' + j.pos + '   领域: ' + j.field + '   功能词: ' + j.isFunctionWord + (j.cached ? '   (缓存)' : ''));
    console.log('   本句义: ' + j.cn);
    console.log('   理由: ' + j.why);
    console.log('');
  }

  console.log('=== 缓存是否生效（同一个请求再发一次，应显示 cached）===');
  const r2 = await post('/explain', { word: 'token', sentence: 'Run the command with a token that has repo scope.' });
  const j2 = JSON.parse(r2.body);
  console.log('   cached=' + j2.cached + '   ms=' + j2.ms);
})();
