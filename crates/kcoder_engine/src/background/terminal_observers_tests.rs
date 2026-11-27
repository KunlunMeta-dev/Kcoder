use super::*;
use crate::native_model_requests::*;
use kcoder_types::MessagesRequest;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Meter {
    state: kcoder_state::AppState,
    run: kcoder_types::BackgroundRunKey,
    observed: Arc<AtomicUsize>,
}
impl NativeModelRequestObserver for Meter {
    fn reserve(
        &self,
        _: &NativeModelRequestContext,
        _: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease>, NativeModelRequestError> {
        Err(NativeModelRequestError::Denied)
    }
    fn observe_execution_terminal(&self) -> Result<(), NativeModelRequestError> {
        assert!(
            self.state
                .background_run_record(&self.run)
                .unwrap()
                .terminal
                .is_some(),
            "notification must follow the original durable terminal"
        );
        self.observed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
#[test]
fn original_publisher_notifies_once_after_commit_and_does_not_retain_meter() {
    let directory = tempfile::tempdir().unwrap();
    let state = kcoder_state::AppState::new(directory.path());
    state.with_history_path(directory.path().join("history.jsonl"));
    let mut task = kcoder_state::Task::new("owned", "Original run");
    task.kind = kcoder_state::TaskKind::Subagent;
    let run = state.start_background_task_run(task).unwrap();
    let registry = TerminalObservers::default();
    let observed = Arc::new(AtomicUsize::new(0));
    let meter: Arc<dyn NativeModelRequestObserver> = Arc::new(Meter {
        state: state.clone(),
        run: run.clone(),
        observed: observed.clone(),
    });
    let weak = Arc::downgrade(&meter);
    registry.register(&meter).unwrap();
    registry.register(&meter).unwrap();
    let (sender, _) = tokio::sync::broadcast::channel(8);
    let publisher =
        super::super::publisher::ScopedPublisher::new(sender, state, run, registry.clone());
    assert_eq!(observed.load(Ordering::SeqCst), 0);
    publisher
        .send(super::super::BackgroundJobEvent::Completed {
            id: "owned".into(),
            output: kcoder_tools::ToolOutput::text("Original result"),
        })
        .unwrap();
    assert_eq!(observed.load(Ordering::SeqCst), 1);
    drop(meter);
    assert!(weak.upgrade().is_none());
    registry.notify();
    assert_eq!(observed.load(Ordering::SeqCst), 1);
}
