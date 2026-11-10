/* Bundled after the shared builder and sync core by capture/package.mjs. */
figma.showUI(__html__, { width: 480, height: 600, themeColors: true });
let syncPackage = bundledSyncPackage, busy = false;
const checkpointKey = data => `kcoder-ref-sync:${data.checkpoint.fileKey}:${data.checkpoint.rootNodeId}`;
const send = (type, data) => figma.ui.postMessage({ type, ...data });

async function effectiveBundle() {
  const saved = await figma.clientStorage.getAsync(checkpointKey(syncPackage));
  if (!saved) return syncPackage;
  if (saved.schema !== 1 || saved.fileKey !== syncPackage.checkpoint.fileKey || saved.rootNodeId !== syncPackage.checkpoint.rootNodeId) throw new Error('Stored checkpoint identity mismatch');
  if ((syncPackage.checkpoint.updatedAt || '') > (saved.updatedAt || '')) return syncPackage;
  return { ...syncPackage, checkpoint: saved };
}

figma.ui.onmessage = async message => {
  if (busy) return;
  busy = true;
  try {
    if (message.type === 'load') {
      const candidate = JSON.parse(message.text);
      if (candidate.schema !== 1 || candidate.interfaceVersion !== 'V3' || !Array.isArray(candidate.states)
          || candidate.checkpoint?.fileKey !== bundledSyncPackage.checkpoint.fileKey
          || candidate.checkpoint?.rootNodeId !== bundledSyncPackage.checkpoint.rootNodeId) throw new Error('不是此 REF 区的 V3 同步包');
      syncPackage = candidate;
    }
    const bundle = await effectiveBundle();
    if (message.type === 'apply') {
      // Inspect again immediately before writing; an old preview is never authorization to overwrite edits.
      const result = await applySync(figma, bundle, buildEditableScreens);
      if (result.status === 'updated') {
        try { await figma.clientStorage.setAsync(checkpointKey(bundle), result.checkpoint); }
        catch { send('warning', { text: '页面已更新，但本机检查点保存失败。请下载检查点并通过 KCODER_FIGMA_CHECKPOINT 指定，避免下一次误报冲突。' }); }
      }
      send('result', { result });
    } else {
      const { plan } = await inspectSync(figma, bundle.checkpoint, bundle.states);
      send('preview', { plan, generatedAt: bundle.generatedAt, stateCount: bundle.states.length });
    }
  } catch (error) { send('error', { text: String(error.message || error) }); }
  finally { busy = false; send('ready', {}); }
};
