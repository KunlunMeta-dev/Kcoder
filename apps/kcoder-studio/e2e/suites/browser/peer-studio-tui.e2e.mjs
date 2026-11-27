import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { runOwnedTuiLab } from '../../harness/owned-tui-lab.mjs';

process.umask(0o077);
await runE2E(import.meta.url, { testId: 'actual-react-studio-and-tui-two-way-peer-messages', tier: 'full-integration',
  modelPolicy: 'Actual HTTP-authenticated Gateway, fixed Native image, Chromium React renderer and PTY/xterm WebGL. Deterministic loopback Provider isolates two-way message/receipt/navigation UI; no autonomous model, Windows or Electron claim.' },
async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'frozen peer candidate');
  const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  await assertRendererBuildFresh();
  const { evidence, runRoot: tuiRun } = await runOwnedTuiLab(context, { binary, binarySha256,
    scenario: 'peer-studio-browser', description: 'actual-react-studio-tui-peer-history-navigation-receipt',
    label: 'actual-peer-studio-tui' });
  assert.equal(evidence.ok, true); assert.equal(evidence.actualReactChromium, true);
  assert.equal(evidence.syntheticClientSubject, false); assert.equal(evidence.sourceNavigationCreatesTurn, false);
  await context.writeArtifactJson('actual-studio-tui-assertions.json', evidence);
  return { actualReactChromium: true, actualPtyXtermWebgl: true, actualHttpAuthentication: true,
    originalFullAddressNavigation: true, originalReceipt: true, binarySha256, nestedTuiRun: tuiRun };
});
