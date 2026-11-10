const loginForm = `<form id="login" method="post" action="/_relay/admin/login">
<h2>管理员登录</h2>
<label>账号<input name="username" autocomplete="username" required>
</label>
<label>密码<input name="password" type="password" autocomplete="current-password" required maxlength="256">
</label>
<button>登录</button>
</form>`;

export function renderDashboard({ authenticated = false, loginError = '' } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KCoder Relay</title>
<link rel="stylesheet" href="/_relay/admin/assets/style.css">
<body>
<main>
<header>
<h1>KCoder Relay</h1>
<p>账户与中继连接管理</p>
</header>
<p id="error" role="alert"${loginError ? '' : ' hidden'}>${loginError}</p>
${authenticated ? '' : loginForm}
<section id="dashboard" hidden>
<button id="logout" class="quiet">退出登录</button>
<section><h2>KCoder 账号</h2><div id="accounts"></div></section>
<form id="create">
<h2>签发账号注册或密码重置邀请</h2>
<label>KCoder 账号<select name="accountId" id="code-account"></select></label>
<label>设备备注<input name="label" maxlength="100" placeholder="例如：我的笔记本">
</label>
<label>有效期（天）
<input name="ttlDays" type="number" min="1" step="1" placeholder="不限期">
</label>
<p>留空表示不限期。邀请只能使用一次。</p>
<button>生成邀请链接</button>
</form>
<section id="issued" hidden>
<h3>邀请链接仅在此显示一次</h3>
<p>打开链接注册账号。选择已有账号时，此链接用于设置或重置密码。</p>
<input id="activation-link" readonly aria-label="一次性账号邀请链接">
<button id="copy">复制链接</button>
</section>
<section>
<h2>设备</h2>
<p>撤销立即关闭该设备的中继连接，不删除本机任务或历史。</p>
<div id="gateways">
</div>
</section>
<section>
<h2>一次性登录链接和历史激活码</h2>
<div id="codes">
</div>
</section>
</section>
</main>
<script type="module" src="/_relay/admin/assets/app.js">
</script>
</body>
</html>`;
}

export const activationHtml = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KCoder Relay</title>
<link rel="stylesheet" href="/_relay/account/style.css">
<body>
<main>
<h1 id="activation-title">KCoder 账号登录</h1>
<p id="activation-guide">在 Studio 左下角的账号菜单选择“登录 KCoder”，粘贴一次性登录链接。</p>
<form id="activation">
<label>一次性登录码<input id="code" autocomplete="off" spellcheck="false" required>
</label>
<button>生成登录链接</button>
</form>
<section id="issued" hidden>
<input id="activation-link" readonly aria-label="一次性登录链接">
<button id="copy">复制链接</button>
</section>
<p id="error" role="alert" hidden>
</p>
</main>
<script type="module" src="/_relay/activation.js">
</script>
</body>
</html>`;

export const adminCss = `:root{color-scheme:light dark;--bg:#f6f7f8;--surface:#fff;--text:#202428;--muted:#636b74;--border:#d9dde2;--primary:#202428;--on-primary:#fff;--error:#b3261e;font:14px/1.6 system-ui,sans-serif}
@media(prefers-color-scheme:dark){:root{--bg:#17191c;--surface:#212429;--text:#edf0f3;--muted:#a7aeb8;--border:#40454c;--primary:#edf0f3;--on-primary:#17191c;--error:#ffb4ab}
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text)}
main{max-width:900px;margin:40px auto;padding:0 20px}
h1{font-size:24px}
h2{font-size:18px}
h3{font-size:16px}
header p,section>p{color:var(--muted)}
form,section>section,#issued{padding:20px;margin:20px 0;background:var(--surface);border:1px solid var(--border);border-radius:12px}
label{display:block;margin:12px 0}
input,select{display:block;width:100%;margin-top:4px;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font:inherit}
button{min-height:40px;padding:8px 16px;border:0;border-radius:6px;background:var(--primary);color:var(--on-primary);font:inherit;cursor:pointer}
button.quiet{background:transparent;color:var(--text);border:1px solid var(--border)}
button:disabled{opacity:.5;cursor:wait}
button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #417dcc;outline-offset:2px}
.row{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border)}
.row span{min-width:0;overflow-wrap:anywhere}
.row small{display:block;color:var(--muted)}
[hidden]{display:none!important}
#error{color:var(--error)}
#activation-link{margin-bottom:12px}
`;

const sharedJs = `const $ = id => document.getElementById(id);
const showError = error => { $('error').textContent = error.message; $('error').hidden = false; };
function issued(link) { $('activation-link').value = link; $('issued').hidden = false; }
$('copy').onclick = async () => { try {
    await navigator.clipboard.writeText($('activation-link').value);
    $('copy').textContent = '已复制';
}
catch {
    showError(Error('复制失败，请手动复制链接。'));
} };
`;
export const activationJs = `${sharedJs}
const activation = $('activation');
if (activation) {
    if (location.pathname === '/_relay/activate') {
        $('activation-title').textContent = 'Gateway 激活';
        $('activation-guide').textContent = '此链接用于旧版 Gateway 的中继设置。';
    }
    const params = new URLSearchParams(location.hash.slice(1));
    $('code').value = params.get('code') || '';
    history.replaceState(null, '', location.pathname);
    activation.onsubmit = e => { e.preventDefault(); const code = $('code').value.trim(); if (!/^[A-Za-z0-9_-]{43}$/.test(code))
        return showError(Error('请输入完整的登录码。')); issued(location.origin + location.pathname + '#code=' + encodeURIComponent(code)); };
    if ($('code').value)
        activation.requestSubmit();
}
`;
export const adminJs = `${sharedJs}
async function api(path, body) { const r = await fetch('/_relay/admin/api/' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await r.json(); if (!r.ok)
    throw Error(data.error || '操作未完成，请刷新核对状态。'); return data; }
{
    function row(target, title, detail, action, actionLabel = '撤销', confirmation = '确认撤销？') { const item = document.createElement('div'); item.className = 'row'; const text = document.createElement('span'); text.textContent = title; const small = document.createElement('small'); small.textContent = detail; text.append(small); item.append(text); if (action) {
        const b = document.createElement('button');
        b.className = 'quiet';
        b.textContent = actionLabel;
        b.onclick = async () => { if (!confirm(confirmation))
            return; b.disabled = true; try {
            await action();
            await refresh();
        }
        catch (e) {
            showError(e);
            b.disabled = false;
        } };
        item.append(b);
    } target.append(item); }
    async function refresh() {
        const state = await api('state');
        $('login')?.remove();
        $('dashboard').hidden = false;
        const accounts = new Map(state.accounts.map(account => [account.id, account]));
        const enabled = state.accounts.filter(account => !account.revokedAt);
        const selector = $('code-account');
        const current = selector.value;
        selector.replaceChildren(new Option('激活时创建新账号', ''), ...enabled.map(account => new Option(account.username, account.id)));
        if (enabled.some(account => account.id === current)) selector.value = current;
        for (const id of ['accounts', 'gateways', 'codes']) $(id).replaceChildren();
        for (const account of state.accounts) {
            const count = state.gateways.filter(g => g.accountId === account.id && !g.revokedAt).length;
            row($('accounts'), account.username, account.revokedAt ? '已停用' :
                (account.passwordLogin ? '可用密码登录' : '待设置密码') + ' · Gateway ' + count,
                account.revokedAt ? null : () => api('accounts/' + account.id + '/revoke', {}),
                '停用账户', '确认停用该账户？此账户的所有 Gateway 将立即断开中继。');
        }
        for (const gateway of state.gateways) {
            const account = accounts.get(gateway.accountId);
            const target = $('gateways');
            row(target, gateway.label || gateway.id,
                (gateway.readOnly ? '静态配置' : account?.username || '历史登记，未分配账户') + ' · ' +
                (gateway.revokedAt ? '已撤销' : account?.revokedAt ? '账户已停用' : gateway.online ? '在线' : '离线'),
                !gateway.revokedAt && !gateway.readOnly ? () => api('gateways/' + gateway.id + '/revoke', {}) : null);
            if (!gateway.readOnly && !gateway.revokedAt && !account && enabled.length) {
                const picker = document.createElement('select');
                picker.setAttribute('aria-label', '为 Gateway ' + gateway.id + ' 分配账户');
                picker.append(new Option('分配到中继账户', '', true, true));
                picker.options[0].disabled = true;
                picker.append(...enabled.map(value => new Option(value.username, value.id)));
                picker.onchange = async () => {
                    if (!confirm('确认将此 Gateway 分配给 ' + accounts.get(picker.value).username + '？')) {
                        picker.value = ''; return;
                    }
                    picker.disabled = true;
                    try { await api('gateways/' + gateway.id + '/account', { accountId: picker.value }); await refresh(); }
                    catch (error) { showError(error); picker.disabled = false; picker.value = ''; }
                };
                target.lastElementChild.append(picker);
            }
        }
        for (const code of state.activationCodes) {
            const expiresAt = code.activated ? code.sessionExpiresAt : code.expiresAt;
            const expired = expiresAt !== null && expiresAt <= Date.now();
            const expiry = expiresAt === null ? '不限期' : new Date(expiresAt).toLocaleString();
            const status = code.revokedAt ? '已撤销' : code.legacySession ? '旧会话已失效' : code.gatewayId ? '已使用' : expired ? '已过期' :
                (code.activated ? '已使用 · 会话有效期 ' : '待使用 · ') + expiry;
            row($('codes'), code.label || code.id, (accounts.get(code.accountId)?.username || (code.purpose === 'register' || code.signupCapacity ? '新 KCoder 账号' : '历史激活码')) + ' · ' + status,
                !code.revokedAt && !code.gatewayId ? () => api('codes/' + code.id + '/revoke', {}) : null);
        }
    }
    $('create').onsubmit = async (e) => { e.preventDefault(); const b = e.target.querySelector('button'); b.disabled = true; try {
        const data = new FormData(e.target);
        const days = data.get('ttlDays');
        const details = { label: data.get('label'), ...(days === '' ? {} : { ttlMs: Number(days) * 86400000 }) };
        const result = await (data.get('accountId')
            ? api('accounts/' + data.get('accountId') + '/login-codes', details)
            : api('invitations', details));
        issued(result.loginLink);
        await refresh();
    }
    catch (e) {
        showError(e);
    }
    finally {
        b.disabled = false;
    } };
    $('logout').onclick = async () => { try {
        await api('logout', {});
        location.reload();
    }
    catch (e) {
        showError(e);
    } };
    refresh().catch(error => { if (!$('login')) showError(error); });
}
`;
