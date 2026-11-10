import { loadEnv } from './config.mjs';

async function verifyAccount() {
  loadEnv();
  const { KCODER_RELAY_PUBLIC_URL, KCODER_RELAY_TEST_USERNAME: username, KCODER_RELAY_TEST_PASSWORD: password } = process.env;
  if (!username || !password) throw Error('在私有 .env 中填写 KCODER_RELAY_TEST_USERNAME 和 KCODER_RELAY_TEST_PASSWORD');
  let relay;
  try { relay = new URL(KCODER_RELAY_PUBLIC_URL); } catch {}
  if (relay?.protocol !== 'https:' || relay.href !== relay.origin + '/') {
    throw Error('KCODER_RELAY_PUBLIC_URL 必须是 Relay 根 HTTPS 地址');
  }
  const account = '/_relay/account/';
  const post = (path, fields, cookie) => fetch(new URL(path, relay), {
    method: 'POST',
    headers: { origin: relay.origin, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  const login = await post(account + 'login', { username, password });
  await login.body?.cancel();
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  if (login.status !== 303 || login.headers.get('location') !== account || !cookie?.startsWith('__Host-kcoder_account=')) {
    throw Error(`测试账号登录失败，HTTP ${login.status}`);
  }
  try {
    const page = await fetch(new URL(account, relay), {
      headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
    const html = await page.text();
    if (!page.ok || !html.includes('我的 Gateway')) throw Error(`无法访问账号的 Gateway 列表，HTTP ${page.status}`);
  } finally {
    const logout = await post(account + 'logout', {}, cookie);
    await logout.body?.cancel();
    if (logout.status !== 303) throw Error(`测试会话退出失败，HTTP ${logout.status}`);
  }
  console.log('公网 KCoder 测试账号验证通过（登录、Gateway 列表、退出）');
}

verifyAccount().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
