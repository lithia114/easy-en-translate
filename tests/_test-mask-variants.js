/* 对比几种「命令行保护」规则的松紧度（只看 mask 结果，不调 API，快） */

const CMD = 'git|npm|pnpm|yarn|bun|cargo|pip3?|docker|kubectl|helm|npx|cmake|dotnet|curl|wget|ssh|scp|gh';
const STOP = 'to|the|a|an|and|or|but|if|then|when|while|for|of|in|on|at|by|with|from|is|are|was|were|be|been|it|this|that|these|those|you|your|we|our|they|their|will|would|can|could|should|may|might|must|do|does|did|not|no|so|as|than|about|before|after|into|over|under|between|up|down|out|off|also|just|very|too|more|most|such|only|each|every|all|any|some|new|old';

const variants = {
  'V1 原版(无限吞)': new RegExp('\\b(?:' + CMD + ')\\b(?:\\s+[-\\w.@:/=~^]+)*', 'g'),
  'V2 最多2个参数': new RegExp('\\b(?:' + CMD + ')\\b(?:\\s+(?!(?:' + STOP + ')\\b)[-\\w.@:/=~^]+){0,2}', 'g'),
  'V3 最多3个参数(当前)': new RegExp('\\b(?:' + CMD + ')\\b(?:\\s+(?!(?:' + STOP + ')\\b)[-\\w.@:/=~^]+){0,3}', 'g'),
  'V4 只保护 参数和路径': new RegExp('\\b(?:' + CMD + ')\\b(?:\\s+(?:--?[A-Za-z][\\w-]*|[-\\w.@]*[/.][-\\w./@]+))*', 'g')
};

const cases = [
  'Use git push --force to overwrite the remote history.',
  'Run npm install and then npm run build to start the server.',
  'The docker build command creates a new image from the Dockerfile.',
  'Install the CLI globally with npm install -g my-tool.',
  'You can use git rebase to rewrite history.',
  'This command runs docker compose up in the background.',
  'Check the docs folder and run npm test before you commit.',
  'See the guide for how to use git properly in a team.'
];

function maskWith(re, text) {
  let n = 0;
  return text.replace(re, function (m) { return '[[' + (n++) + ']]'; });
}

for (const v of Object.keys(variants)) {
  console.log('════════ ' + v + ' ════════');
  cases.forEach(function (t) {
    console.log('  ' + maskWith(variants[v], t));
  });
  console.log('');
}

console.log('════════ 判断标准 ════════');
console.log('  mask 掉的部分 = 会原样保留英文、不翻译');
console.log('  理想：只 mask 命令本身和参数（如 git push --force），句子其余部分要留给 AI 翻译');
