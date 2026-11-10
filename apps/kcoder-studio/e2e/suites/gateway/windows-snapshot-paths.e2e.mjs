import { runE2E } from '../../harness/run-context.mjs';
import { runWindowsNativeLibtest, validateNativeLibtestOptions } from '../../harness/windows-native-libtest.mjs';

const wikiSelection = process.env.KCODER_E2E_WINDOWS_WIKI_WRITER_CASE;
const wikiTests = {
  names: 'private_files::native_sqlite_path::tests::native_name_pin_keeps_original_directory_and_database_names',
  writer: 'directory_writer::tests::windows_personal_writer_keeps_native_wal_and_pins_its_actual_namespace',
};
if (wikiSelection !== undefined && !Object.hasOwn(wikiTests, wikiSelection))
  throw Error('Unknown owned Windows Wiki writer selection');
const exactTest = wikiSelection === undefined
  ? 'app_server::tests::isolated_turn_snapshot_supports_windows_paths_beyond_max_path'
  : wikiTests[wikiSelection];
const options = { consent: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST,
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  node: process.env.KCODER_E2E_WINDOWS_NODE, testBinary: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_BIN,
  testSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256, sourceTreeSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256,
  supervisor: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN, supervisorSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256,
  expectedCommit: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT, expectedDirty: false,
  exactTest, expectedTests: [exactTest], gitLineEndings: 'preserve' };
if (wikiSelection === undefined && (!/^[a-f0-9]{40}$/.test(options.expectedCommit ?? '') || process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY !== 'false'))
  throw Error('Exact clean CLI source identity required');
validateNativeLibtestOptions(options);
await runE2E(import.meta.url, { testId: wikiSelection === undefined ? 'windows-private-snapshot-long-paths' : `windows-held-wiki-${wikiSelection}`, tier: 'manual-live',
  modelPolicy: wikiSelection === undefined ? 'one exact native Rust regression: private paths beyond 320 characters, snapshot, diff and reverse patch; owned data only; no model, personal state, GUI or installation'
    : 'one exact actual Windows owned Wiki directory/database-name pin or personal SQLite WAL writer regression; source and binary SHA pinned; no model, personal state, GUI or installation' },
context => runWindowsNativeLibtest(context, options));
