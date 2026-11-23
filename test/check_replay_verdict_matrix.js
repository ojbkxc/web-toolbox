// check_replay_verdict_matrix.js —— verdict 判定矩阵走查(v1.1.54)
//
// verdict 是链路重放的"裁判"—— 每条 OK/DIFF/FAIL/ERR 的分类直接决定 AI/用户下一步做什么。
// 现有 check_replay_smoke 覆盖了引擎级语义; 本行走查钉**判定矩阵的边界组合**:
//   ①断言优先级(有 asserts 时状态码差异也不触发 FAIL 判定, 以断言结果为准);
//   ②四类断言逐类: status/contains/not_contains/json_eq 各自的正反例;
//   ③json_eq 的降级路径(非 JSON 文本 / 路径不存在);
//   ④无断言时: 状态码差异>响应 diff 优先(业务可读性); 归一化后相等则 OK。
// 这组矩阵此前没有独立对照 —— 修 verdict 时容易破坏"断言优先于状态码"这条隐含契约。
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const RV = require(path.join(ROOT, "replay.js"));

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

const rec = (status, response) => ({ status, response });

// ---- 1. 网络错误 / 无响应 ----
ok("live=null → ERR", RV.verdict(rec(200, "x"), null).verdict === "ERR");
ok("live.status=0 → ERR(页面 fetch 失败)", RV.verdict(rec(200, "x"), { status: 0, ok: false, text: "" }).verdict === "ERR");

// ---- 2. 断言优先于状态码(隐含契约) ----
{
  // 录制 500, 现场 200, 但断言只看 contains —— 断言通过了就是 OK
  const r = RV.verdict(rec(500, "err"), { status: 200, ok: true, text: "ok:true" },
    { asserts: [{ type: "contains", target: "ok:true", expect: "" }] });
  ok("断言通过 → OK(即使状态码 500→200)", r.verdict === "OK", r);
  // 断言失败: 优先级也高于状态码判断(msg 要标\"业务断言\"让人知道是断言层的失败)
  const r2 = RV.verdict(rec(500, "err"), { status: 200, ok: true, text: "ok:false" },
    { asserts: [{ type: "contains", target: "ok:true", expect: "" }] });
  ok("断言失败 → FAIL 且 msg 标明业务断言", r2.verdict === "FAIL" && /业务断言失败/.test(r2.msg), r2);
}

// ---- 3. 四类断言正反例 ----
{
  const live = { status: 200, ok: true, text: '{"data":{"rc":0,"msg":"成功"}}' };
  ok("status 断言命中", RV.verdict(rec(200, ""), live, { asserts: [{ type: "status", target: "200" }] }).verdict === "OK");
  ok("status 断言不符", RV.verdict(rec(200, ""), live, { asserts: [{ type: "status", target: "500" }] }).verdict === "FAIL");
  ok("contains 命中", RV.verdict(rec(200, ""), live, { asserts: [{ type: "contains", target: "成功" }] }).verdict === "OK");
  ok("not_contains 命中(不存在该串)", RV.verdict(rec(200, ""), live, { asserts: [{ type: "not_contains", target: "不存在词" }] }).verdict === "OK");
  ok("not_contains 不符(存在该串)", RV.verdict(rec(200, ""), live, { asserts: [{ type: "not_contains", target: "成功" }] }).verdict === "FAIL");
  ok("json_eq 命中(rc=0)", RV.verdict(rec(200, ""), live, { asserts: [{ type: "json_eq", target: "data.rc", expect: "0" }] }).verdict === "OK");
  ok("json_eq 不符(rc=1)", RV.verdict(rec(200, ""), live, { asserts: [{ type: "json_eq", target: "data.rc", expect: "1" }] }).verdict === "FAIL");
}

// ---- 4. json_eq 降级路径 ----
{
  ok("非 JSON 文本 → 断言失败(不炸不跳过)", RV.verdict(rec(200, ""), { status: 200, ok: true, text: "plain" },
    { asserts: [{ type: "json_eq", target: "a", expect: "1" }] }).verdict === "FAIL");
  ok("路径不存在 → 失败", RV.verdict(rec(200, ""), { status: 200, ok: true, text: '{"a":1}' },
    { asserts: [{ type: "json_eq", target: "b.c", expect: "1" }] }).verdict === "FAIL");
  // 数组路径走第一个元素(与文档一致的宽松语义)
  ok("数组路径取首元素", RV.verdict(rec(200, ""), { status: 200, ok: true, text: '{"list":[{"id":7}]}' },
    { asserts: [{ type: "json_eq", target: "list.id", expect: "7" }] }).verdict === "OK");
}

// ---- 5. 无断言回退路径 ----
{
  const r1 = RV.verdict(rec(200, '{"a":1}'), { status: 200, ok: true, text: '{"a":1}' });
  ok("全文一致 → OK", r1.verdict === "OK", r1);
  const r2 = RV.verdict(rec(200, '{"a":1}'), { status: 500, ok: false, text: "err" });
  ok("状态码差异优先于 body(直接 FAIL)", r2.verdict === "FAIL" && /状态码/.test(r2.msg), r2);
  const r3 = RV.verdict(rec(200, '{"a":1}'), { status: 200, ok: true, text: '{"a":2}' });
  ok("体差异 → DIFF(不是 FAIL)", r3.verdict === "DIFF", r3);
}

// ---- 6. 断言数组首条失败即停(快失败) ----
{
  const r = RV.verdict(rec(200, ""), { status: 200, ok: true, text: "x" },
    { asserts: [{ type: "contains", target: "y" }, { type: "contains", target: "z" }] });
  ok("首条断言失败即停(msg 报第一条)", /contains:y/.test(r.msg), r);
}

console.log(fails ? `=== verdict matrix FAIL: ${fails} ===` : "=== verdict matrix PASS ===");
process.exit(fails ? 1 : 0);