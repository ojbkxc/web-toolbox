// 对比参考脚本已有接口 vs 抓到的接口
import { readFileSync } from 'fs';

// 参考脚本已有的 spm 接口路径
const refText = readFileSync('D:/jmx/jmeter业务流脚本/jmeter业务流脚本/公有巡系统完成生产环境巡检-i-Service3.0-香港-备件管理-TTC/script/公有巡系统完成生产环境巡检-i-Service3.0-香港-备件管理-TTC.jmx', 'utf8');
const refPaths = new Set();
for (const m of refText.matchAll(/iservice-spm\/([\w/]+)/g)) {
  refPaths.add(m[1]);
}
console.log(`参考脚本已有 spm 接口: ${refPaths.size} 个`);
for (const p of [...refPaths].sort()) console.log(`  ${p}`);

// 抓到的接口
const spm = JSON.parse(readFileSync('spm-final.json', 'utf8'));
const caught = new Set(spm.map(s => s.interface.replace('POST /web/iservice-spm/', '').replace('GET /web/iservice-spm/', '')));

console.log(`\n抓到的 spm 接口: ${caught.size} 个`);
const newOnes = [...caught].filter(p => !refPaths.has(p));
const dupes = [...caught].filter(p => refPaths.has(p));
console.log(`\n参考脚本已有(重复): ${dupes.length} 个`);
for (const p of dupes.sort()) console.log(`  ✓ ${p}`);
console.log(`\n新增(参考脚本没有): ${newOnes.length} 个`);
for (const p of newOnes.sort()) console.log(`  + ${p}`);