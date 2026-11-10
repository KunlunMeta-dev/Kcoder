import { runE2E } from '../../harness/run-context.mjs';
import { runWindowsPackageProbe } from '../../harness/windows-package-probe.mjs';

await runE2E(import.meta.url, { testId: 'windows-installed-workflow-draft-protocol', tier: 'manual-live',
  retainSuccessEvidence: true,
  modelPolicy: 'Deterministic loopback provider; actual installed Windows Native; owned profile/workspace/Job only. No personal task, model-quality or GUI acceptance.' },
context => runWindowsPackageProbe(context, {
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, node: process.env.KCODER_E2E_WINDOWS_NODE,
  parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT, installedDirectory: process.env.KCODER_E2E_WINDOWS_INSTALLED_DIRECTORY,
  commit: process.env.KCODER_E2E_WINDOWS_EXPECTED_COMMIT, cliSha256: process.env.KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256,
  workflowViewSourceRef: process.env.KCODER_E2E_WORKFLOW_VIEW_SOURCE_REF,
  focus: 'workflow-draft',
}));
