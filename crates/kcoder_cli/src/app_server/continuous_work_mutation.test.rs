//! Same-module regressions for the draft continuous-work mutation dispatch.
use super::*;
use std::path::{Path, PathBuf};

fn owned_directory(root: &Path, name: &str) -> PathBuf {
    let path = root.join(name);
    std::fs::create_dir_all(&path).unwrap();
    kcoder_config::set_user_only_dir_permissions(&path).unwrap();
    path
}

fn owned_host() -> (tempfile::TempDir, HostWorkScope, ContinuousWorkStore) {
    let owned = tempfile::Builder::new()
        .prefix("kcoder-continuous-work-mutation-")
        .tempdir()
        .unwrap();
    let root = owned.path().canonicalize().unwrap();
    let profile = owned_directory(&root, "config");
    let workspace = owned_directory(&root, "work");
    let host = HostWorkScope::capture(&profile, &workspace, None).unwrap();
    let store = ContinuousWorkStore::open_or_create(host.profile_path()).unwrap();
    (owned, host, store)
}

fn submit_params() -> ContinuousWorkInputSubmitParams {
    serde_json::from_value(json!({"threadId":"thread-1","workId":"work-1",
        "inputId":"input-1","requestId":"request-1","expectedRevision":1,
        "text":"New requirement"}))
    .unwrap()
}

fn control_params() -> ContinuousWorkControlParams {
    serde_json::from_value(json!({"threadId":"thread-1","workId":"work-1",
        "requestId":"req-1","expectedRevision":1,"action":"pause",
        "target":{"kind":"work"}}))
    .unwrap()
}

#[test]
fn control_params_reject_action_target_mismatch_and_zero_revision() {
    let pause = json!({"threadId":"thread-1","workId":"work-1","requestId":"req-1",
        "expectedRevision":4,"action":"pause","target":{"kind":"work"}});
    assert!(parse(method::CONTROL, &pause).is_ok());
    let mut mismatched = pause.clone();
    mismatched["action"] = json!("cancel_run");
    assert!(parse(method::CONTROL, &mismatched).is_err());
    let mut zero = pause.clone();
    zero["expectedRevision"] = json!(0);
    assert!(parse(method::CONTROL, &zero).is_err());
    let mut submit = serde_json::to_value(submit_params()).unwrap();
    submit["expectedRevision"] = json!(0);
    assert!(parse(method::INPUT_SUBMIT, &submit).is_err());
}

#[test]
fn submitting_to_an_unknown_work_reports_not_found_and_writes_nothing() {
    let (_owned, host, store) = owned_host();
    let error = persist_submit(&host, &store, true, submit_params()).unwrap_err();
    assert_eq!(error_message(&error), "CONTINUOUS_WORK_NOT_FOUND");
    assert!(store.read_work(host.scope(), "work-1").unwrap().is_none());
    let source = input_source(&host, "thread-1");
    assert!(
        store
            .read_input(host.scope(), "work-1", &source, "input-1")
            .unwrap()
            .is_none()
    );
    assert!(store.list_inputs(host.scope(), "work-1", None).is_err());
    let error = persist_control(&host, &store, false, control_params()).unwrap_err();
    assert_eq!(error_message(&error), "CONTINUOUS_WORK_NOT_FOUND");
}

#[test]
fn mutation_methods_stay_unavailable_without_the_read_capability() {
    // A client that negotiated neither read nor mutation keeps its own queue.
    assert!(!negotiate(false, Some(&true)));
    assert!(!negotiate(true, None));
    assert!(!negotiate(true, Some(&false)));
    // Nothing consumes a persisted input or applies a control yet, so the one
    // advertisement switch stays off even for a fully negotiated client.
    assert!(!continuous_work_mutation_dispatch_ready());
    assert!(!negotiate(true, Some(&true)));
    for method in [method::INPUT_SUBMIT, method::INPUT_READ, method::CONTROL] {
        assert!(!allowed(false, false, method), "{method}");
    }
    assert!(!allowed(false, false, method::LIST));
}
