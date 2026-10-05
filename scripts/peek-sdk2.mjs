import fs from 'node:fs';
const s = fs.readFileSync(process.env.TEMP + '/toy-sdk.js', 'utf8');

function around(needle, before = 200, after = 600) {
  let i = 0, n = 0;
  while ((i = s.indexOf(needle, i)) !== -1 && n < 6) {
    console.log(`\n==== ${needle} @${i} ====`);
    console.log(s.slice(Math.max(0, i - before), i + after));
    i += needle.length;
    n++;
  }
}

around('function et(');
around('et=function');
around('function O(');
around('request({kind:`rank`');
around('getParentOrigin');
around('period:');
around('op:`submit`');
