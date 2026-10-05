import fs from 'node:fs';
const s = fs.readFileSync(process.env.TEMP + '/toy-host.js', 'utf8');
function around(needle, n = 3, before = 150, after = 800) {
  let i = 0, c = 0;
  while ((i = s.indexOf(needle, i)) !== -1 && c < n) {
    console.log(`\n==== ${needle} @${i} ====`);
    console.log(s.slice(Math.max(0, i - before), i + after));
    i += needle.length;
    c++;
  }
}
around('var Y=');
around('Y.request');
around('Y=axios');
around('create({');
around('csrf');
around('bili_jct');
around('rank/submit');
around('function Wi(');
around('function Gi(');
around('function Ki(');
