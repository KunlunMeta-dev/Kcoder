// Explicit State sidecar cases, independent from the source-upload product roster.
const tests = [
  'private_large_context_reopens_without_inflating_bounded_metadata_and_inherits_on_export',
  'absent_context_is_immutable_and_a_new_session_can_capture_a_new_snapshot',
  'pending_intent_keeps_original_bytes_while_corruption_and_missing_payload_stay_blocked',
  'legacy_metadata_keeps_unknown_context_distinct_from_a_captured_empty_snapshot',
  'ordinary_metadata_writes_do_not_repair_or_reread_an_already_published_context_payload',
];

export function windowsMemorySnapshotSelection() {
  const testFilter = 'imported_context_snapshot::tests::';
  return { slug: 'memory-snapshot', testFilter, expectedTests: tests.map(name => testFilter + name) };
}
