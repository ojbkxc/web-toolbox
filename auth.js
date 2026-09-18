// auth.js —— 登录前置识别引擎
//
// 目标: 从录制条目里自动找出「登录前置链」(登录+切换岗位+token 等环境准备),
// 供 JMX 导出时包进 OnceOnlyController(每线程只执行一次) 或 IfController(会话失效自动重登)。
// 参照 iserver/scripts/gen_ktki_perf_jmx.py 的权威生成器: ThreadGroup → 前置块 → 业务链路。
//
// 识别策略(自动+手动两层):
//   1. 自动: 规则表(AUTH_RULES)匹配 URL path / 响应特征, 命中 → _prelude=true
//   2. 手动: 侧栏请求列表每条 checkbox 可强制/取消标记前置(自动识别可能漏/误判, 人工兜底)
// groupPrelude() 分离前置链与业务链, JMX 导出时分别放置。

// 规则表: 常见登录形态的特征(与 gen_ktki_perf_jmx.py 的登录链/切换岗位链对应)。
// 每条: { name, paths: [正则], responseMarkers: [子串] }
const AUTH_RULES = [
  // 1. CAS / SSO ticket 链(登录页 + 校验 + ticket)
  { name: "CAS/SSO", paths: [/\/login\b/i, /\/sso\b/i, /\/cas\b/i, /\/signin/i, /\/signon/i, /\/serviceValidate/i, /\/ticket/i] },
  // 2. OAuth / token 链
  { name: "OAuth/token", paths: [/\/(auth|oauth|openid-connect)\/(token|authorize|introspect|checkToken|refreshToken)/i, /\/token$/i, /refreshToken/i] },
  // 3. 表单登录
  { name: "form login", paths: [/\/login/i, /\/auth\/login/i, /authenticate/i, /doLogin/i, /loginCheck/i, /checkLogin/i] },
  // 4. 业务系统登录上下文(iserver/ics 链: 登录后取 Profile/角色, 切岗位刷新上下文)
  { name: "user context", paths: [/\/auth-server\//i, /getSetProfile/i, /changePosition/i, /updateProfile/i, /getUserRole/i, /getLoginUser/i] },
  // 5. 登录页响应特征(URL 无特征时的兜底: 返回登录页 HTML 的请求, 通常是前置链起点)
  { name: "login page resp", paths: [], responseMarkers: ["统一认证", "用户登录", "欢迎登录", "password", "记住密码", "CAS"] },
  // 6. body 双要素(现代 SPA: 登录接口 URL 无 /login 特征如 /api/authenticate, 凭据在 body)。
  //    只认 username+password **同时**出现 —— 单 username 的业务接口(改资料)不误报;
  //    中段误命中的风险由 autoDetectPrelude 前缀连续策略兜底(链断后不自动勾)。
  { name: "login body", paths: [], body: true },
];

// body 双要素判定: 表单 k=v 与 JSON "k":v 两种形态(空格无关, 值内容不参与)
function hasLoginBodyPair(e) {
  const b = String(e.body || "").replace(/\s/g, "");
  return /(^|["&?])username["=]/.test(b) && /(^|["&?])password["=]/.test(b);
}

// 是否命中登录前置特征
function isAuthLike(e) {
  const url = String(e.url || "");
  const resp = String(e.response || "");
  for (const r of AUTH_RULES) {
    const pathHit = (r.paths || []).some((re) => re.test(url));
    const respHit = (r.responseMarkers || []).some((m) => resp.includes(m));
    const bodyHit = r.body && hasLoginBodyPair(e);
    if (pathHit || respHit || bodyHit) return r.name;
  }
  return null;
}

// 自动识别: 返回 { ids: Set<number>, reasons: Map<id, ruleName> }
// 只把「前缀连续命中」的请求自动标前置 —— 登录一定发生在业务操作之前, 中段误命中的业务请求不自动勾。
// 【重开窗口】(v1.0.57): 冷启动先访问业务页面再跳 SSO 登录(302 跳转链)时, 登录链在
// 中段——前缀策略一刀切会把整条登录链漏掉。强特征规则(CAS/SSO、OAuth/token、user context,
// URL 路径正则命中)可重开识别窗口; 弱特征(login page resp 的响应子串/login body 双要素)
// 不重开——它们的误报面(改密码接口响应含 'password')正是靠窗口关闭挡的。
function autoDetectPrelude(entries) {
  // 强特征集不含 form login —— 它的 /login/i 是宽正则(中段业务接口如 /api/loginHistory
  // 会命中), 重开语义下会把这类业务请求误勾; CAS/SSO、OAuth/token、user context 是严格
  // 路径形态(/cas /serviceValidate /refreshToken /auth-server/ 等), 误报面可忽略。
  // form login 命中的链前面通常已有 CAS 登录页(CAS/SSO 规则重开覆盖), 漏检面小。
  const STRONG_RULES = new Set(["CAS/SSO", "OAuth/token", "user context"]);
  const ids = new Set();
  const reasons = new Map();
  let preludeActive = true; // 一旦出现连续非前置, 后续不再自动标(登录链结束)
  for (const e of entries) {
    const rule = isAuthLike(e);
    if (preludeActive && rule) {
      ids.add(e.id);
      reasons.set(e.id, rule);
    } else {
      preludeActive = false; // 链中断
      // 中断后遇强特征 → 重新激活(SSO 302 跳转链: 业务首页 → 跳登录 → 登录链 → 回业务)
      if (rule && STRONG_RULES.has(rule)) {
        preludeActive = true;
        ids.add(e.id);
        reasons.set(e.id, rule);
      }
    }
  }
  return { ids, reasons };
}

// 手动 + 自动标记合并后分离前置/业务
// entries: 每项可有 _prelude(bool), 或调用方显式传 forceIds
function groupPrelude(entries, forceIds) {
  const forced = forceIds ? new Set(forceIds) : null;
  const prelude = [];
  const business = [];
  for (const e of entries) {
    const isPre = (e && e._prelude) || (forced && forced.has(e && e.id));
    (isPre ? prelude : business).push(e);
  }
  return { prelude, business };
}

// node 环境导出(供单测; 浏览器 script 标签加载时此分支不执行)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { AUTH_RULES, isAuthLike, autoDetectPrelude, groupPrelude, hasLoginBodyPair };
}