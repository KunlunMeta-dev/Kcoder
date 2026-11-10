export function safeReturnTo(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\r\n]/.test(value)
  )
    return null;
  try {
    const parsed = new URL(value, "http://kcoder.local");
    if (
      parsed.origin !== "http://kcoder.local" ||
      parsed.pathname === "/login" ||
      parsed.pathname.startsWith("/login/")
    )
      return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function loginPage(error = "", returnTo = null, loginActionPath = "/login") {
  const message = error ? `<p class="error">${error}</p>` : "";
  const returnInput = returnTo
    ? `<input name="returnTo" type="hidden" value="${escapeHtml(returnTo)}">`
    : "";
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KCoder Studio 登录</title><link rel="icon" href="favicon.ico"><style>body{margin:0;background:#111;color:#eee;font:14px system-ui;display:grid;place-items:center;min-height:100vh}.card{box-sizing:border-box;width:min(360px,calc(100vw - 40px));padding:28px;border:1px solid #333;border-radius:14px;background:#1b1b1b}h1{font-size:20px;margin:0 0 8px}p{color:#aaa}input,button{box-sizing:border-box;width:100%;padding:11px 12px;border-radius:8px;border:1px solid #444;background:#111;color:#fff}button{margin-top:12px;background:#e8e8e8;color:#111;border:0;font-weight:600;cursor:pointer}.error{color:#ff7777}</style><body><form class="card" method="post" action="${escapeHtml(loginActionPath)}"><h1>KCoder Studio</h1><p>请输入服务器访问令牌后进入远程工作台。</p><p><a href="mobile/">打开手机 Web</a></p>${message}${returnInput}<input name="token" type="password" autocomplete="current-password" autofocus required><button type="submit">登录</button></form></body></html>`;
}
