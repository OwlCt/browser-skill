import fs from 'node:fs';
const s = fs.readFileSync(process.env.TEMP + '/toy-host.js', 'utf8');
function around(needle, n = 3, before = 250, after = 700) {
  let i = 0, c = 0;
  while ((i = s.indexOf(needle, i)) !== -1 && c < n) {
    console.log(`\n==== ${needle} @${i} ====`);
    console.log(s.slice(Math.max(0, i - before), i + after));
    i += needle.length;
    c++;
  }
}
around('2,24');
around('kind:`rank`');
around('op:`submit`');
around('/x/sunflower');
around('rank');
around('submitScore');
