/* 验证版本分发：/versions 页面 + /v/ 链接能否正确提供各版本脚本 */
const http = require('http');

function get(p) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:8787' + p, (r) => {
      let chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ code: r.statusCode, ct: r.headers['content-type'], buf: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

(async () => {
  console.log('=== 1. /versions 列表页 ===');
  const list = await get('/versions');
  console.log('  HTTP ' + list.code + '   ' + list.ct);
  const html = list.buf.toString('utf8');
  // 抽出页面里的链接
  const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  console.log('  页面里的链接: ' + JSON.stringify(links));

  console.log('');
  console.log('=== 2. 逐个下载版本文件并检查内容 ===');
  for (const l of links) {
    const r = await get(l.replace(/^http:\/\/[^/]+/, ''));
    const body = r.buf.toString('utf8');
    const ver = (body.match(/@version\s+(\S+)/) || [])[1] || '(读不到版本号)';
    const lastLine = body.trimEnd().split('\n').pop();
    console.log('  ' + l);
    console.log('     HTTP ' + r.code + '  ' + (r.buf.length / 1024).toFixed(1) + ' KB  版本=' + ver);
    console.log('     首行=' + JSON.stringify(body.split('\n')[0]));
    console.log('     末行=' + JSON.stringify(lastLine.slice(0, 40)));
    console.log('     含词典功能=' + body.includes('function renderSrcWords') +
                '  含 mask 修复=' + body.includes('{0,2}/g,'));
  }

  console.log('');
  console.log('=== 3. 主入口 /install.user.js（应等于最新工作副本）===');
  const main = await get('/install.user.js');
  const mb = main.buf.toString('utf8');
  console.log('  HTTP ' + main.code + '  ' + (main.buf.length / 1024).toFixed(1) + ' KB  版本=' +
    ((mb.match(/@version\s+(\S+)/) || [])[1] || '?'));

  console.log('');
  console.log('=== 4. 安全性：中文文件名之外还拦不拦 ===');
  for (const bad of ['/v/..%2Fx.user.js', '/v/evil.exe', '/v/a%2Fb.user.js']) {
    const r = await get(bad);
    console.log('  ' + bad.padEnd(26) + ' -> HTTP ' + r.code);
  }
})();
