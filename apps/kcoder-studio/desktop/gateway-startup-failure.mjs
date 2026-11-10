import { join } from 'node:path';

const storageReasons = 'network_storage|reparse_point|owner_mismatch|acl_not_private|unsafe_file|identity_unavailable|validation_failed|powershell_unavailable|execution_failed|output_limit|timeout|invalid_identity|store_busy';
const storageFailure = new RegExp(`(?:Private Windows mobile device storage unavailable \\((${storageReasons})\\)|KCODER_MOBILE_STORAGE_ERROR:(${storageReasons})\\b)`);

/** Recognize only the bounded storage diagnostic, never expose its raw stderr. */
export function gatewayStartupExitError({ code, signal, stderr, dataDirectory }) {
  const match = storageFailure.exec(stderr);
  if (match) {
    const reason = match[1] || match[2];
    return Object.assign(new Error(`Windows sign-in data could not be protected (${reason})`), {
      code: 'MOBILE_DEVICE_STORAGE_UNAVAILABLE', reason, storageDataDirectory: dataDirectory,
    });
  }
  return new Error(`KCoder Studio gateway exited before startup (code=${String(code)}, signal=${String(signal)}): ${stderr}`);
}

/** A native recovery prompt has no Gateway, credentials, renderer or RPC access. */
export async function showGatewayStorageRecovery({ error, dialog, shell, locale, dataDirectory }) {
  if (error?.code !== 'MOBILE_DEVICE_STORAGE_UNAVAILABLE') return false;
  dataDirectory = error.storageDataDirectory || dataDirectory;
  const chinese = String(locale).toLowerCase().startsWith('zh');
  const directory = join(dataDirectory, 'mobile-device-auth');
  const reason = new RegExp(`^(?:${storageReasons})$`).test(error.reason) ? error.reason : 'validation_failed';
  const busy = reason === 'store_busy';
  const result = await dialog.showMessageBox({
    type: 'error',
    title: chinese ? 'KCoder Studio 登录数据需要恢复' : 'KCoder Studio sign-in data needs attention',
    message: busy
      ? (chinese ? '登录数据锁暂不可用' : 'The sign-in data lock is unavailable')
      : (chinese ? '无法安全修复登录数据目录的权限' : 'Sign-in data permissions could not be safely repaired'),
    detail: busy
      ? (chinese ? `未修改登录数据。请等待其他 KCoder 进程完成保存后重新启动；持续失败时检查本机端口占用。\n\n目录：${directory}\n原因：store_busy`
        : `Sign-in data was not changed. Wait for other KCoder processes to finish saving, then restart. If this persists, check local port conflicts.\n\nDirectory: ${directory}\nReason: store_busy`)
      : chinese
      ? `KCoder 已停止启动以保护登录数据。请确认此目录属于当前 Windows 账户，或从可信备份恢复，然后重新启动。\n\n目录：${directory}\n原因：${reason}\n\n不要删除目录中的密钥和设备记录，否则已有登录和配对可能失效。`
      : `KCoder stopped startup to protect sign-in data. Check that this directory belongs to your Windows account, or restore a trusted backup, then restart.\n\nDirectory: ${directory}\nReason: ${reason}\n\nKeep the keys and device records; deleting them may invalidate existing sign-ins and pairings.`,
    buttons: chinese ? ['打开数据目录', '退出'] : ['Open data folder', 'Quit'],
    defaultId: 1, cancelId: 1, noLink: true,
  });
  if (result.response === 0) await shell.openPath(dataDirectory);
  return true;
}
