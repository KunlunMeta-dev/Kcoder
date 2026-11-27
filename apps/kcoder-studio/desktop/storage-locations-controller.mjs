import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isTrustedGatewayUrl } from './security-policy.mjs';

const prefix = 'kcoder:storage-locations:';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const absolute = value => typeof value === 'string' && isAbsolute(value) && value.length <= 32767 && !/[\0\r\n]/.test(value);
const originalOperation = input => {
  if (!input || typeof input.operationId !== 'string' || !/^[\w.-]{1,128}$/.test(input.operationId) ||
    input.operationId.endsWith('.')) fail('STORAGE_OPERATION_INVALID');
  return input.operationId;
};

/** A local main-frame capability. Neither Gateway routes nor model tools register these channels. */
export function registerStorageLocations({ ipcMain, dialog, window, getGatewayOrigin, selected, client,
  confirmStop, stopInstance, channelScope = '' }) {
  const contents = window.webContents;
  const readOnly = selected.context.development || selected.paths.externallyConfigured;
  let disposed = false, pending = false, preview = null, revision = 0, cleanup = null;
  const authorize = event => {
    if (disposed || window.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame ||
      !isTrustedGatewayUrl(event.senderFrame?.url ?? '', getGatewayOrigin())) fail('STORAGE_LOCAL_HOST_REQUIRED');
  };
  const editable = () => { if (readOnly) fail('STORAGE_EXTERNAL_INSTANCE_READ_ONLY'); };
  const handlers = {
    async read(event) {
      authorize(event);
      const [paths, operation] = await Promise.all([client.paths(), client.status()]);
      authorize(event);
      return { paths, readOnly, operation };
    },
    async pick(event, input) {
      authorize(event); editable();
      if (pending) fail('STORAGE_OPERATION_BUSY');
      if (!input || !['data', 'cache'].includes(input.kind) || Object.keys(input).some(key => key !== 'kind')) {
        fail('STORAGE_OPERATION_INVALID');
      }
      pending = true;
      try {
        const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'],
          defaultPath: input.kind === 'data' ? selected.paths.dataRoot : selected.paths.cacheRoot });
        authorize(event);
        if (result.canceled) return null;
        if (result.filePaths?.length !== 1 || !absolute(result.filePaths[0])) fail('STORAGE_PATH_INVALID');
        return result.filePaths[0];
      } finally { pending = false; }
    },
    async preview(event, input) {
      authorize(event); editable();
      if (pending) fail('STORAGE_OPERATION_BUSY');
      if (!input || Object.keys(input).some(key => !['dataRoot', 'cacheRoot'].includes(key)) ||
        !absolute(input.dataRoot) || !absolute(input.cacheRoot)) fail('STORAGE_PATH_INVALID');
      const current = ++revision;
      preview = null;
      const plan = await client.preview({ ...input, operationId: randomUUID(), launchIntent: 'desktop' });
      authorize(event);
      if (current !== revision) fail('STORAGE_PREVIEW_CHANGED');
      preview = plan;
      return plan;
    },
    async migrate(event, input) {
      authorize(event); editable();
      if (pending) fail('STORAGE_OPERATION_BUSY');
      if (!preview || !input || Object.keys(input).some(key => key !== 'operationId') ||
        input.operationId !== preview.operationId) fail('STORAGE_PREVIEW_CHANGED');
      pending = true;
      const plan = preview;
      try {
        // Confirmation explicitly owns ending current work. A renderer-supplied
        // plan, path or process command cannot substitute for the host preview.
        if (!await confirmStop(plan, window)) return { operationId: plan.operationId, state: 'cancelled' };
        authorize(event);
        if (preview !== plan) fail('STORAGE_PREVIEW_CHANGED');
        const ready = await client.handoff(plan);
        if (ready?.state !== 'ready' || ready.operationId !== plan.operationId) fail('STORAGE_HANDOFF_UNCONFIRMED');
        preview = null; ++revision;
        stopInstance(plan);
        return ready;
      } finally { pending = false; }
    },
    async retry(event, input) {
      authorize(event); editable();
      if (pending) fail('STORAGE_OPERATION_BUSY');
      const operationId = originalOperation(input);
      if (Object.keys(input).some(key => key !== 'operationId')) fail('STORAGE_OPERATION_INVALID');
      pending = true;
      try {
        const receipt = await client.status(operationId);
        authorize(event);
        if (receipt?.plan?.operationId !== operationId || receipt.disposition !== 'deferred' ||
          !['planned', 'stopping', 'stopped', 'copying', 'verifying', 'prepared'].includes(receipt.phase)) {
          fail('STORAGE_PREVIEW_CHANGED');
        }
        const plan = receipt.plan;
        if (!await confirmStop(plan, window)) return { operationId, state: 'cancelled' };
        authorize(event);
        const current = await client.status(operationId);
        authorize(event);
        if (!isDeepStrictEqual(current, receipt)) fail('STORAGE_PREVIEW_CHANGED');
        const ready = await client.handoff(plan, { retry: true });
        if (ready?.state !== 'ready' || ready.operationId !== operationId) fail('STORAGE_HANDOFF_UNCONFIRMED');
        preview = null; ++revision;
        stopInstance(plan);
        return ready;
      } finally { pending = false; }
    },
    async cleanupPreview(event, input) {
      authorize(event); editable();
      if (pending) fail('STORAGE_OPERATION_BUSY');
      const operationId = originalOperation(input);
      if (Object.keys(input).some(key => key !== 'operationId')) fail('STORAGE_OPERATION_INVALID');
      pending = true;
      cleanup = null;
      try {
        const next = await client.cleanupPreview({ operationId });
        authorize(event);
        if (next?.operationId !== operationId || !/^[a-f0-9]{64}$/.test(next.confirmation) ||
          typeof next.pending !== 'boolean' || !Array.isArray(next.entries) || next.entries.length > 4096) {
          fail('STORAGE_SOURCE_CLEANUP_UNKNOWN');
        }
        cleanup = next;
        return next;
      } finally { pending = false; }
    },
    async cleanupConfirm(event, input) {
      authorize(event); editable();
      if (pending) fail('STORAGE_OPERATION_BUSY');
      const operationId = originalOperation(input);
      if (Object.keys(input).some(key => !['operationId', 'confirmation'].includes(key)) ||
        !cleanup || cleanup.operationId !== operationId || input.confirmation !== cleanup.confirmation) {
        fail('STORAGE_SOURCE_CLEANUP_PREVIEW_CHANGED');
      }
      pending = true;
      const confirmed = cleanup;
      cleanup = null;
      try {
        const result = await client.cleanupConfirm({ operationId, confirmation: confirmed.confirmation });
        authorize(event);
        if (result?.operationId !== operationId || result.confirmation !== confirmed.confirmation ||
          !Array.isArray(result.entries) || result.entries.length > 4096) {
          fail('STORAGE_SOURCE_CLEANUP_UNKNOWN');
        }
        return result;
      } finally { pending = false; }
    },
    async cleanupStatus(event, input) {
      authorize(event);
      const operationId = originalOperation(input);
      if (Object.keys(input).some(key => key !== 'operationId')) fail('STORAGE_OPERATION_INVALID');
      const receipt = await client.status(operationId);
      authorize(event);
      if (receipt != null && receipt.plan?.operationId !== operationId) fail('STORAGE_SOURCE_CLEANUP_UNKNOWN');
      return receipt;
    },
  };
  const channel = name => prefix + name + (channelScope ? `:${channelScope}` : '');
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(channel(name), handler);
  const dispose = () => {
    if (disposed) return;
    disposed = true; preview = null; cleanup = null; ++revision;
    for (const name of Object.keys(handlers)) ipcMain.removeHandler(channel(name));
  };
  window.once('closed', dispose);
  return dispose;
}
