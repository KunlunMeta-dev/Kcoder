//! A pre-registration busy refusal is "not accepted", retried with the same
//! persisted request identity, and bounded into a durable busy rejection.
use super::*;
use std::time::{Duration, Instant};

fn busy() -> Value {
    json!({"error":{"code":kcoder_runtime_driver::TURN_BUSY_BEFORE_REGISTRATION_CODE,
        "message":kcoder_runtime_driver::TURN_BUSY_BEFORE_REGISTRATION_MESSAGE}})
}

fn turn_params(command: &NativeRuntimeCommand) -> Value {
    let (method, params) = rpc(command);
    assert_eq!(method, "turn/start");
    params.clone()
}

#[test]
fn busy_refusal_requeues_the_same_request_identity_after_backoff_then_accepts() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    let first = queued_turn(&fixture, &mut driver, "busy-then-accept");
    let first_params = driver
        .storage()
        .bindings()
        .get("busy-then-accept")
        .unwrap()
        .unwrap()
        .client_message_id;
    driver
        .observe_response(&fixture.context, &first, &busy())
        .unwrap();
    let refused = driver
        .read_operation(&fixture.context, "busy-then-accept")
        .unwrap()
        .unwrap();
    // Not unknown: the refusal precedes registration, so nothing executed.
    assert_ne!(refused.phase, IntegrationOperationPhase::Unknown);
    assert!(!refused.phase.is_terminal());
    assert!(refused.runtime_acceptance.is_none());
    // The retry waits for its backoff instead of spinning on a held gate.
    driver.release_due_busy_turns(Instant::now());
    assert!(driver.next_command(&fixture.context).unwrap().is_none());
    driver.release_due_busy_turns(Instant::now() + Duration::from_secs(2));
    let retry = driver.next_command(&fixture.context).unwrap().unwrap();
    assert_ne!(ticket(&retry).id(), first.id());
    let params = turn_params(&retry);
    assert_eq!(params["clientMessageId"], json!(first_params));
    driver.observe_response(&fixture.context, &ticket(&retry), &json!({"result":{"turn":{"id":"turn-fixture","threadId":"thread-fixture","status":"running"}}})).unwrap();
    let accepted = driver
        .read_operation(&fixture.context, "busy-then-accept")
        .unwrap()
        .unwrap();
    assert_eq!(accepted.phase, IntegrationOperationPhase::Accepted);
    // The settled retry leaves no residual busy state to re-dispatch.
    driver.release_due_busy_turns(Instant::now() + Duration::from_secs(60));
    assert!(driver.next_command(&fixture.context).unwrap().is_none());
}

#[test]
fn exhausted_busy_window_is_a_durable_rejection_not_an_unknown_outcome() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    let first = queued_turn(&fixture, &mut driver, "busy-exhausted");
    driver
        .observe_response(&fixture.context, &first, &busy())
        .unwrap();
    driver.test_expire_busy_window("busy-exhausted");
    driver.release_due_busy_turns(Instant::now() + Duration::from_secs(2));
    let retry = driver.next_command(&fixture.context).unwrap().unwrap();
    driver
        .observe_response(&fixture.context, &ticket(&retry), &busy())
        .unwrap();
    let rejected = driver
        .read_operation(&fixture.context, "busy-exhausted")
        .unwrap()
        .unwrap();
    assert_eq!(rejected.phase, IntegrationOperationPhase::Rejected);
    assert_eq!(rejected.error.unwrap().code, "RUNTIME_THREAD_BUSY");
    assert!(rejected.runtime_acceptance.is_none());
    driver.release_due_busy_turns(Instant::now() + Duration::from_secs(60));
    assert!(driver.next_command(&fixture.context).unwrap().is_none());
}

#[test]
fn other_turn_errors_keep_the_conservative_unknown_outcome() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    for (operation, response) in [
        // Same code with another meaning is not proof of a pre-registration refusal.
        (
            "busy-code-other-message",
            json!({"error":{"code":-32003,"message":"Turn admission already pending"}}),
        ),
        (
            "admission-error",
            json!({"error":{"code":-32022,"message":"NATIVE_INPUT_SOURCE_ADMISSION_REQUIRED"}}),
        ),
    ] {
        let turn = queued_turn(&fixture, &mut driver, operation);
        driver
            .observe_response(&fixture.context, &turn, &response)
            .unwrap();
        let receipt = driver
            .read_operation(&fixture.context, operation)
            .unwrap()
            .unwrap();
        assert_eq!(
            receipt.phase,
            IntegrationOperationPhase::Unknown,
            "{operation}"
        );
        driver.release_due_busy_turns(Instant::now() + Duration::from_secs(60));
        assert!(driver.next_command(&fixture.context).unwrap().is_none());
    }
}

#[test]
fn running_resident_found_before_routing_waits_under_the_same_bound() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    let first = queued_turn(&fixture, &mut driver, "busy-before-routing");
    driver
        .defer_generated_busy_turn(&fixture.context, &first)
        .unwrap();
    let waiting = driver
        .read_operation(&fixture.context, "busy-before-routing")
        .unwrap()
        .unwrap();
    assert_ne!(waiting.phase, IntegrationOperationPhase::Unknown);
    assert!(waiting.runtime_acceptance.is_none());
    driver.release_due_busy_turns(Instant::now() + Duration::from_secs(2));
    let retry = driver.next_command(&fixture.context).unwrap().unwrap();
    assert_eq!(ticket(&retry).operation_id(), "busy-before-routing");
    // A ticket can only be deferred once; the stale one is no longer pending.
    assert!(
        driver
            .defer_generated_busy_turn(&fixture.context, &first)
            .is_err()
    );
}
