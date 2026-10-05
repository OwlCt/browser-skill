import fs from 'node:fs';
const s = fs.readFileSync(process.env.TEMP + '/toy-sdk.js', 'utf8');
const p = s.indexOf('submit(e){return L().request({kind:');
console.log('submit idx', p);
console.log(s.slice(p, p + 2000));
console.log('\n==== around rank op list ====');
let i = 0, n = 0;
while ((i = s.indexOf("kind:`rank`", i)) !== -1 && n < 8) {
  console.log('---', i, s.slice(i - 80, i + 180));
  i += 10; n++;
}
console.log('\n==== Ii ====');
const p2 = s.search(/Ii=class|class Ii|var Ii=/);
console.log('p2', p2, s.slice(p2, p2 + 1200));
