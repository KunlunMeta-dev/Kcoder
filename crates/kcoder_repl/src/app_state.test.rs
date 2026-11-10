//! State regressions for the read-only continuous work observation surface.
use super::*;
use crate::work_observation::WorkObservationStatus;

#[test]
fn default_app_carries_no_work_observation_and_no_status_segment() {
    let app = ReplApp::default();

    // A fresh app has not refreshed metadata yet, so it must not invent a phase.
    assert_eq!(
        app.work_observation.status(),
        &WorkObservationStatus::Absent
    );
    assert!(app.work_observation.status_segment().is_none());
    assert!(!app.compact_status_label().contains("work:"));
}
