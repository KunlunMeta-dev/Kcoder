import { win32 } from 'node:path';
import { readWindowsCurrentIdentity } from '../src/windows-current-identity.mjs';

/** Resolve only the child environment. Never inspect ACLs or restore a cached
 * profile redirect: access failures must stay attached to the requested path.
 */
export async function prepareWindowsProfileStartup({ env = process.env, platform = process.platform,
  readIdentity = readWindowsCurrentIdentity } = {}) {
  if (platform !== 'win32') return { env: { ...env } };
  const requested = env.KCODER_CONFIG_DIR || env.KCODER_HOME
    || win32.join((await readIdentity({ env, platform })).userProfile, '.config', 'kcoder');
  if (!win32.isAbsolute(requested) || /[\0\r\n]/.test(requested)) throw Object.assign(
    new Error('The configured Windows profile path is not absolute'), { code: 'WINDOWS_PROFILE_PATH_INVALID' });
  return { env: { ...env, KCODER_CONFIG_DIR: requested, KCODER_HOME: requested } };
}

/** A busy store may be retried in place, never recovered into a new Home. */
export async function retryWindowsGatewayStorageStartup({ error, platform = process.platform,
  dialog, locale = 'en', signal, restart } = {}) {
  if (platform !== 'win32' || error?.code !== 'MOBILE_DEVICE_STORAGE_UNAVAILABLE'
    || error.reason !== 'store_busy' || error.cleanupError) return false;
  const chinese = String(locale).toLowerCase().startsWith('zh');
  const result = await dialog.showMessageBox({ type: 'warning', noLink: true,
    title: chinese ? '连接数据暂时忙碌' : 'Connection data is busy',
    message: chinese ? '另一个 KCoder 进程可能正在保存连接数据' : 'Another KCoder process may be saving connection data',
    detail: chinese ? '现有配置、登录和配对未被修改。可以重试启动。' : 'Configuration, sign-ins and pairings were not changed. You can retry startup.',
    buttons: chinese ? ['重试启动', '退出'] : ['Retry startup', 'Quit'], defaultId: 0, cancelId: 1 });
  if (result.response === 0 && !signal?.aborted) await restart();
  return true;
}
