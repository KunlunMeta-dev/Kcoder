//! Metadata refresh regressions for the read-only continuous work observation.
use super::*;
use crate::test_support::test_engine;
use crate::work_observation::WorkObservationStatus;

#[test]
fn metadata_refresh_observes_work_without_creating_storage() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = test_engine(workspace.path());
    let mut app = ReplApp::default();

    app.refresh_engine_metadata(&engine);

    // The test profile has no continuous work store, so nothing may be shown and
    // no store may be created by observing.
    assert_eq!(
        app.work_observation.status(),
        &WorkObservationStatus::Absent
    );
    assert!(!app.compact_status_label().contains("work:"));
    assert!(!workspace.path().join("test-config").exists());
}
