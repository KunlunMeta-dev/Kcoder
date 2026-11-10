use super::*;

/// The settings facade must expose the continuous-work group exactly once so a
/// host can read the valve without reaching into a private module.
#[test]
fn facade_reexports_the_continuous_work_group_with_its_default() {
    let group: ContinuousWorkSettings = ContinuousWorkSettings::default();
    assert!(group.dispatch_enabled());
    let from_json: ContinuousWorkSettings = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(group, from_json);
}
