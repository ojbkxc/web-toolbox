// 把"真实消费方解析"做成闸门: 有 java 就真解析(强证据), 没有就 SKIP(不伪装通过)。
// 同时保留手写 checkXml 作为快速路径 —— 两者必须**一致**(不一致就说明手写判定有盲区)。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

// ---- 探测 java ----
function hasJava() {
  try { const r = spawnSync("java", ["-version"], { encoding: "utf8", timeout: 20000 }); return r.status === 0; }
  catch { return false; }
}

// ---- 写一个最小的 Java XML 校验器(单文件源码执行, JDK 11+) ----
const JAVA_SRC = [
  "import javax.xml.parsers.*;",
  "import org.xml.sax.*;",
  "import java.io.*;",
  "public class JmxParseCheck {",
  "  public static void main(String[] a) throws Exception {",
  "    DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();",
  "    f.setFeature(\"http://apache.org/xml/features/disallow-doctype-decl\", true);",
  "    f.setNamespaceAware(false);",
  "    DocumentBuilder b = f.newDocumentBuilder();",
  "    b.setErrorHandler(new ErrorHandler() {",
  "      public void warning(SAXParseException e) {}",
  "      public void error(SAXParseException e) throws SAXException { throw e; }",
  "      public void fatalError(SAXParseException e) throws SAXException { throw e; }",
  "    });",
  "    b.parse(new File(a[0]));",
  "    System.out.println(\"PARSE_OK\");",
  "  }",
  "}",
].join("\n");

const jmx = require(path.join(ROOT, "jmx.js"));
const TC = require(path.join(ROOT, "test/lib/toolchain.js"));
const mk = (v) => ([{
  method: "GET", url: "https://a.test/p", path: "/s", query: "q=1",
  headers: { "x-evil": v }, body: v, status: 200, response: v, ts: "", durationMs: 1,
}]);

const javaOk = hasJava();
if (!javaOk) {
  console.log("  SKIP(env) java 不可用 —— 跳过真实解析验证(不伪装通过)");
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jmxparse-"));
  const javaFile = path.join(dir, "JmxParseCheck.java");
  fs.writeFileSync(javaFile, JAVA_SRC, "utf8");

  const parseWithJava = (xml, tag) => {
    const p = path.join(dir, tag + ".jmx");
    fs.writeFileSync(p, xml, "utf8");
    const r = spawnSync("java", [javaFile, p], { encoding: "utf8", timeout: 90000 });
    return { ok: (r.stdout || "").includes("PARSE_OK"), err: (r.stderr || "").split("\n")[0].slice(0, 140) };
  };

  // ① 正常产物真实可解析
  const good = jmx.buildJmx(mk("plain"));
  const r1 = parseWithJava(good, "good");
  ok("真实 Java XML 解析器接受正常导出物", r1.ok, r1.err);

  // ② 控制字符已被剥离 → 仍可解析
  const ctrl = jmx.buildJmx(mk("a" + String.fromCharCode(1) + "b"));
  const r2 = parseWithJava(ctrl, "ctrl");
  ok("含控制字符的原始数据导出后仍可被真实解析器打开", r2.ok, r2.err);

  // ②b XML 特殊字符全覆盖: & < > 引号 换行 —— 缺任何一个转义, 真实解析器都会拒绝。
  //     (第一版用例只有 plain 与控制字符, 去掉 & 转义时闸门没红 —— 用例不覆盖等于闸门不设防)
  const specials = "a&b <tag> \"q\" 's'" + String.fromCharCode(10) + "next";
  const r2b = parseWithJava(jmx.buildJmx(mk(specials)), "specials");
  ok("XML 特殊字符(& < > 引号 换行)全部正确转义(真实解析器接受)", r2b.ok, r2b.err);

  // ③ 一致性强校验: 我方 checkXml 与真实解析器判断必须一致
  const cases = [
    ["正常", good],
    ["控制字符数据", ctrl],
    ["坏 XML(未转义 &)", '<?xml version="1.0"?><r>a & b</r>'],
    ["坏 XML(控制字符)", '<?xml version="1.0"?><r>' + String.fromCharCode(1) + "</r>"],
  ];
  const mismatch = [];
  for (const [label, xml] of cases) {
    const mine = TC.checkXml(xml).ok;
    const real = parseWithJava(xml, "cmp" + Math.abs(label.length)).ok;
    if (mine !== real) mismatch.push(`${label}: 我方=${mine} 真实=${real}`);
  }
  ok("手写 checkXml 与真实 Java 解析器判断一致(不一致=手写判定有盲区)", mismatch.length === 0, mismatch);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fails ? `=== jmx real parse FAIL: ${fails} ===` : "=== jmx real parse PASS ===");
process.exit(fails ? 1 : 0);