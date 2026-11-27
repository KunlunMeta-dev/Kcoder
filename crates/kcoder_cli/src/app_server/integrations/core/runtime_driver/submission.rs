pub(super) use kcoder_runtime_driver::required_thread;

#[cfg(test)]
use super::*;

#[cfg(test)]
mod session_lifetime_tests {
    use super::super::test_support::Fixture;
    use super::*;

    #[test]
    fn paused_queued_input_has_a_durable_rejection_and_cannot_be_replayed() {
        let fixture = Fixture::new();
        let mut driver = fixture.driver();
        let request = fixture.request("session-paused-original-input");
        let mut spec = fixture.spec();
        spec.existing_thread_id = Some("original-task".into());
        assert!(matches!(
            driver
                .accept_task(&fixture.context, &request, spec)
                .unwrap(),
            RuntimeSubmission::Queued
        ));
        driver
            .reject_queued_with_reason(
                &fixture.context,
                "session-paused-original-input",
                "SESSION_PAUSED_NO_CLIENT",
            )
            .unwrap();
        let original = driver
            .read_operation(&fixture.context, "session-paused-original-input")
            .unwrap()
            .unwrap();
        assert_eq!(original.phase, IntegrationOperationPhase::Rejected);
        assert!(original.runtime_acceptance.is_none());
        assert_eq!(original.error.unwrap().code, "SESSION_PAUSED_NO_CLIENT");
        assert!(driver.next_command(&fixture.context).unwrap().is_none());
        drop(driver);
        let restored = NativeRuntimeDriver::load(&fixture.context)
            .unwrap()
            .unwrap();
        assert!(restored.next_operation_id().is_none());
        assert_eq!(
            restored
                .read_operation(&fixture.context, "session-paused-original-input")
                .unwrap()
                .unwrap()
                .phase,
            IntegrationOperationPhase::Rejected
        );
    }
}
