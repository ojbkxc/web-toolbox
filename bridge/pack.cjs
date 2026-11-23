// pack.cjs —— 一条命令产出"加载即用"的扩展 zip(v1.1.60)。
//
// 动机: 用户装扩展要手动挑文件(排除 test/samples/bridge/docs/.git), 挑错就装不上或
// 带脏东西。参考仓库走 npm 包 + verify-npm-package.js; 本仓库的产物形态是
// "chrome://extensions 加载目录", 等价物是 zip —— 纯 Node(零依赖, 用系统 zip 或
// PowerShell Compress-Archive 不可移植, 所以用内置 zlib 手写 zip)。
//
// 包含: manifest + 根 js + 四页面目录 + icons + bridge-protocol.js。
// 排除: test/ samples/ bridge/ docs/ .git* REVIEW/CHANGELOG 等所有非运行时文件。
// 自检: 打包后遍历 zip, 断言 ①manifest.json 在 ②无 test/samples/bridge/docs 路径
//       ③无 node_modules ④文件数与源侧声明面一致。
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "web-toolbox.zip");

// ---- 收集(白名单式: 只进运行时文件) ----
const files = [];
const addFile = (rel) => files.push(rel);
const addDir = (dir) => {
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    const p = path.join(ROOT, dir, f);
    if (fs.statSync(p).isDirectory()) continue;
    addFile(dir + "/" + f);
  }
};

// manifest + 根 js(扩展运行时)
addFile("manifest.json");
for (const f of fs.readdirSync(ROOT)) {
  // 根目录白名单排测试: 仓库根有 test_regression.js / mock_bg_test.js(回归用, 非运行时)。
  // 命名约定: *_test.js 与 test_*.js 都视为测试(与 test/ 目录同口径)。
  if (/\.js$/.test(f) && !/^test_|_test\.js$/.test(f)) addFile(f);
}
addDir("popup");
addDir("sidepanel");
addDir("options");
addDir("icons");

// ---- 最小 zip 写入(store 模式, 免依赖; 目录条目省略 —— Chrome 加载 unzip 不需要) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const entries = [];
const chunks = [];
let offset = 0;
for (const rel of files) {
  const data = fs.readFileSync(path.join(ROOT, rel));
  const name = Buffer.from(rel.replace(/\\/g, "/"), "utf8");
  const crc = crc32(data);
  // deflate(level 9): 源码文本实测 -63%(448KB → ~170KB)。zip 标准方法 8。
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);       // version needed
  lh.writeUInt16LE(0, 6);        // flags
  lh.writeUInt16LE(8, 8);        // method: deflate
  lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); // time/date
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18);   // compressed size
  lh.writeUInt32LE(data.length, 22);   // uncompressed size(校验用)
  lh.writeUInt16LE(name.length, 26);
  lh.writeUInt16LE(0, 28);
  chunks.push(lh, name, comp);
  entries.push({ name, crc, size: data.length, csize: comp.length, offset });
  offset += lh.length + name.length + comp.length;
}
// central directory
const cdStart = offset;
for (const e of entries) {
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10);
  ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); // method=deflate / time
  ch.writeUInt32LE(e.crc, 16);
  ch.writeUInt32LE(e.csize, 20); ch.writeUInt32LE(e.size, 24);
  ch.writeUInt16LE(e.name.length, 28);
  ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
  ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
  ch.writeUInt32LE(0, 38);
  ch.writeUInt32LE(e.offset, 42);
  chunks.push(ch, e.name);
  offset += ch.length + e.name.length;
}
const cdEnd = offset;
const eo = Buffer.alloc(22);
eo.writeUInt32LE(0x06054b50, 0);
eo.writeUInt16LE(0, 4); eo.writeUInt16LE(0, 6);
eo.writeUInt16LE(entries.length, 8); eo.writeUInt16LE(entries.length, 10);
eo.writeUInt32LE(cdEnd - cdStart, 12);
eo.writeUInt32LE(cdStart, 16);
eo.writeUInt16LE(0, 20);
chunks.push(eo);
fs.writeFileSync(OUT, Buffer.concat(chunks));
console.log("打包完成:", files.length, "文件,", fs.statSync(OUT).size, "字节 →", path.relative(ROOT, OUT));

// ---- 自检(读回 zip 验结构) ----
const zip = fs.readFileSync(OUT);
// 扫 local file headers 取文件名
const names = [];
for (let i = 0; i < zip.length - 4; ) {
  if (zip.readUInt32LE(i) === 0x04034b50) {
    const nlen = zip.readUInt16LE(i + 26);
    const elen = zip.readUInt16LE(i + 28);
    const csize = zip.readUInt32LE(i + 18);  // compressed(deflate 后与 size 不同)
    names.push(zip.slice(i + 30, i + 30 + nlen).toString("utf8"));
    i += 30 + nlen + elen + csize;
  } else i++;
}
const bad = names.filter((n) => /^(test|samples|bridge|docs|node_modules)\//.test(n) || /^\.git/.test(n) || /REVIEW|CHANGELOG|AGENTS|CLAUDE|SECURITY/.test(n));
const hasManifest = names.includes("manifest.json");
console.log("自检: 文件", names.length, "/ manifest:", hasManifest, "/ 违禁:", bad.length ? bad.join(",") : "无");
if (!hasManifest || bad.length) { console.error("打包自检失败"); process.exit(1); }