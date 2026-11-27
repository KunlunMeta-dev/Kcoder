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
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(?:token|access_token|refresh_token|accessToken|refreshToken|code)$/i.test(key)) parsed.searchParams.delete(key);
    }
    return `${parsed.pathname}${parsed.search}`;
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
  const message = error ? `<p class="error" role="alert" aria-live="assertive">${escapeHtml(error)}</p>` : "";
  const returnInput = returnTo
    ? `<input name="returnTo" type="hidden" value="${escapeHtml(returnTo)}">`
    : "";
  const prefix = loginActionPath.replace(/\/login$/, '');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KCoder Studio 登录</title><link rel="icon" href="${escapeHtml(prefix)}/favicon.png"><script defer src="${escapeHtml(loginActionPath)}/bridge.js"></script><style>body{margin:0;background:#111;color:#eee;font:14px system-ui;display:grid;place-items:center;min-height:100vh}.card{box-sizing:border-box;width:min(360px,calc(100vw - 40px));padding:28px;border:1px solid #333;border-radius:14px;background:#1b1b1b}h1{font-size:20px;margin:0 0 8px}p{color:#aaa}input,button{box-sizing:border-box;width:100%;padding:11px 12px;border-radius:8px;border:1px solid #444;background:#111;color:#fff}button{margin-top:12px;background:#e8e8e8;color:#111;border:0;font-weight:600;cursor:pointer}.error{color:#ff7777}</style><body><form id="gateway-login" class="card" method="post" action="${escapeHtml(loginActionPath)}"><h1>KCoder Studio</h1><p>请输入服务器访问令牌后进入远程工作台。</p><p><a href="${escapeHtml(prefix)}/mobile/">打开手机 Web</a></p>${message}${returnInput}<label for="gateway-token">服务器访问令牌</label><input id="gateway-token" name="token" type="password" autocomplete="current-password" autofocus required><button type="submit">登录</button></form></body></html>`;
}

// Credentials leave the address bar before any same-origin form submission.
export const loginTicketBridge = `(()=>{const hash=new URLSearchParams(location.hash.slice(1)),code=hash.get('code');if(!code)return;history.replaceState(null,'',location.pathname+location.search);if(!/^(?:kclog1_[A-Za-z0-9_-]{43}|kcweb1_[a-f0-9]{64})$/.test(code))return;const form=document.getElementById('gateway-login'),password=document.getElementById('gateway-token');if(!form||!password||new URL(form.action).origin!==location.origin)return;password.required=false;password.value='';for(const [name,value] of [['ticket',code],['renewSession','1']]){const input=document.createElement('input');input.type='hidden';input.name=name;input.value=value;form.appendChild(input)}form.requestSubmit();})();`;
