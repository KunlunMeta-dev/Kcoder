import { join } from 'node:path';

const storageReasons = 'network_storage|reparse_point|owner_mismatch|unsafe_file|identity_unavailable|validation_failed|powershell_unavailable|execution_failed|output_limit|timeout|invalid_identity|store_busy';
const validStorageReason = new RegExp(`^(?:${storageReasons})$`);
const loginIoReasons = new Set(['space_exhausted', 'access_denied', 'read_only', 'resource_limit', 'io_unavailable']);

export function storageStartupFailureMessage(error, locale) {
  if (error?.code !== 'STORAGE_MIGRATION_BUSY') return null;
  return String(locale).toLowerCase().startsWith('zh')
    ? '配置与数据操作正在进行。请等待当前操作完成后再打开 KCoder Studio，不要重复发起迁移。'
    : 'A configuration and data operation is in progress. Wait for it to finish before reopening KCoder Studio. Do not start another migration.';
}

export function gatewayLoginStorageError(reason, dataDirectory) {
  if (typeof reason !== 'string' || (!validStorageReason.test(reason) && !loginIoReasons.has(reason))) return null;
  return Object.assign(new Error(`KCoder Studio sign-in data is unavailable (${reason})`), {
    code: loginIoReasons.has(reason) ? 'DESKTOP_LOGIN_STORAGE_IO' : 'MOBILE_DEVICE_STORAGE_UNAVAILABLE',
    reason, storageDataDirectory: dataDirectory,
  });
}
const storageFailure = new RegExp(`(?:Private Windows mobile device storage unavailable \\((${storageReasons})\\)|KCODER_MOBILE_STORAGE_ERROR:(${storageReasons})\\b)`);

/** Recognize only the bounded storage diagnostic, never expose its raw stderr. */
export function gatewayStartupExitError({ code, signal, stderr, dataDirectory }) {
  const match = storageFailure.exec(stderr);
  if (match) {
    const reason = match[1] || match[2];
    return gatewayLoginStorageError(reason, dataDirectory);
  }
  return new Error(`KCoder Studio gateway exited before startup (code=${String(code)}, signal=${String(signal)}): ${stderr}`);
}

/** A native recovery prompt has no Gateway, credentials, renderer or RPC access. */
export async function showGatewayStorageRecovery({ error, dialog, shell, locale, dataDirectory }) {
  if (error?.code === 'DESKTOP_LOGIN_STORAGE_IO' && loginIoReasons.has(error.reason)) {
    const chinese = String(locale).toLowerCase().startsWith('zh');
    const space = error.reason === 'space_exhausted';
    await dialog.showMessageBox({ type: 'error', noLink: true,
      title: chinese ? 'KCoder Studio 无法保存登录状态' : 'KCoder Studio cannot save sign-in data',
      message: space ? (chinese ? '存储空间不足' : 'Storage space is exhausted')
        : (chinese ? '登录数据暂时无法读写' : 'Sign-in data is unavailable'),
      detail: chinese ? 'KCoder 没有主动删除现有数据。请恢复存储后重新启动。'
        : 'KCoder did not intentionally delete existing data. Restore storage access and restart.',
      buttons: [chinese ? '退出' : 'Quit'], defaultId: 0, cancelId: 0 });
    return true;
  }
  if (error?.code !== 'MOBILE_DEVICE_STORAGE_UNAVAILABLE') return false;
  dataDirectory = error.storageDataDirectory || dataDirectory;
  const chinese = String(locale).toLowerCase().startsWith('zh');
  const directory = join(dataDirectory, 'mobile-device-auth');
  const reason = validStorageReason.test(error.reason) ? error.reason : 'validation_failed';
  const busy = reason === 'store_busy';
  const recovery = reason === 'owner_mismatch'
      ? (chinese ? '登录数据的所有者与运行账户不符。请使用原 Gateway 账户启动，或请管理员核对该目录和文件的所有者。'
        : 'The sign-in data owner does not match the Gateway account. Use the original account or ask the administrator to review ownership of this directory and its files.')
      : (chinese ? '请检查原登录数据是否可用，并根据下方原因排查；需要恢复时使用可信备份。'
        : 'Check that the original sign-in data is available and investigate the reason below; use a trusted backup if recovery is needed.');
  const result = await dialog.showMessageBox({
    type: 'error',
    title: chinese ? 'KCoder Studio 登录数据需要恢复' : 'KCoder Studio sign-in data needs attention',
    message: busy
      ? (chinese ? '登录数据锁暂不可用' : 'The sign-in data lock is unavailable')
      : (chinese ? '登录数据未通过安全检查' : 'Sign-in data did not pass its safety checks'),
    detail: busy
      ? (chinese ? `未修改登录数据。请等待其他 KCoder 进程完成保存后重新启动；持续失败时检查本机端口占用。\n\n目录：${directory}\n原因：store_busy`
        : `Sign-in data was not changed. Wait for other KCoder processes to finish saving, then restart. If this persists, check local port conflicts.\n\nDirectory: ${directory}\nReason: store_busy`)
      : chinese
      ? `KCoder 已停止启动，现有登录数据未被修改。${recovery}处理后重新启动。\n\n目录：${directory}\n原因：${reason}\n\n不要删除目录中的密钥和设备记录，否则已有登录和配对可能失效。`
      : `KCoder stopped startup without changing existing sign-in data. ${recovery} Restart after addressing the issue.\n\nDirectory: ${directory}\nReason: ${reason}\n\nKeep the keys and device records; deleting them may invalidate existing sign-ins and pairings.`,
    buttons: chinese ? ['打开数据目录', '退出'] : ['Open data folder', 'Quit'],
    defaultId: 1, cancelId: 1, noLink: true,
  });
  if (result.response === 0) await shell.openPath(dataDirectory);
  return true;
}
