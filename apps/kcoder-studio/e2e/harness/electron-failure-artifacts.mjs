/** Best-effort diagnostics must not replace the failure being investigated. */
export async function captureElectronFailureArtifacts(client, context) {
  try { await client.capture('electron-failure.png'); } catch {}
  try {
    const snapshot = JSON.parse(await client.command('snapshot'));
    await context.writeArtifactJson('electron-failure-state.json', snapshot);
  } catch {}
}
