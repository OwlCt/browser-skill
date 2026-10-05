import fs from 'node:fs';
const s = fs.readFileSync(process.env.TEMP + '/toy-host.js', 'utf8');
function around(needle, n = 4, before = 120, after = 900) {
  let i = 0, c = 0;
  while ((i = s.indexOf(needle, i)) !== -1 && c < n) {
    console.log(`\n==== ${needle} @${i} ====`);
    console.log(s.slice(Math.max(0, i - before), i + after));
    i += needle.length;
    c++;
  }
}
around('rank/submit');
around('mi,');
around('op===`submit`');
around("op==`submit`");
around('case`submit`');
around('e.op');
around('payload.score');
around('score:e.score');
around('Math.pow(2,24)');
around('16777216');
around('board');
