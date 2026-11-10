use super::*;
use crate::test_support::{engine_builder::TestEngineBuilder, providers::RequestRecordingProvider};
use futures::StreamExt;
use kcoder_types::{Message, MessagesRequest};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Observer {
    calls: Arc<AtomicUsize>,
    reject: bool,
}
#[async_trait::async_trait]
impl NativeTurnAdmissionObserver for Observer {
    async fn accepted(&self, _: &QueryEngine, _: &TurnAttemptIdentity) -> Result<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        ensure!(!self.reject, "controlled denied admission");
        Ok(())
    }
}
fn engine(root: &std::path::Path) -> (QueryEngine, Arc<Mutex<Vec<MessagesRequest>>>) {
    kcoder_config::PrivateDirectory::open_existing(root)
        .unwrap()
        .open_child(std::ffi::OsStr::new("test-config"), true)
        .unwrap();
    let captured = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(root)
        .provider(Arc::new(RequestRecordingProvider {
            requests: captured.clone(),
        }))
        .build_with_profile_directory();
    engine
        .state
        .add_message(Message::user_text("Do the accepted bounded task."));
    (engine, captured)
}

#[tokio::test]
async fn installed_but_unbound_admission_sends_no_model_request() {
    let root = tempfile::tempdir().unwrap();
    let (base, requests) = engine(root.path());
    let engine = base
        .with_native_turn_admission_observer(Arc::new(Observer {
            calls: Arc::default(),
            reject: false,
        }))
        .unwrap();
    let events = engine
        .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
        .collect::<Vec<_>>()
        .await;
    assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::Error(code) if code == "NATIVE_TASK_ADMISSION_UNAVAILABLE")));
    assert!(requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn actual_native_scope_binds_once_before_model_and_cannot_be_borrowed_afterwards() {
    let root = tempfile::tempdir().unwrap();
    let (base, requests) = engine(root.path());
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = base
        .with_native_turn_admission_observer(Arc::new(Observer {
            calls: calls.clone(),
            reject: false,
        }))
        .unwrap();
    let identity = TurnAttemptIdentity {
        thread_id: engine.session_id(),
        turn_id: "turn".into(),
        attempt_id: "attempt".into(),
    };
    engine
        .state
        .history_attempt_scope(identity.clone())
        .unwrap()
        .run(async {
            engine
                .observe_native_turn_acceptance(&identity)
                .await
                .unwrap();
            engine
                .observe_native_turn_acceptance(&identity)
                .await
                .unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            let events = engine
                .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
                .collect::<Vec<_>>()
                .await;
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, crate::EngineEvent::Error(_))),
                "{events:?}"
            );
            assert_eq!(requests.lock().unwrap().len(), 1);
        })
        .await;
    assert!(!engine.native_turn_admission_ready());
}

#[tokio::test]
async fn failed_callback_leaves_the_gate_closed() {
    let root = tempfile::tempdir().unwrap();
    let (base, requests) = engine(root.path());
    let engine = base
        .with_native_turn_admission_observer(Arc::new(Observer {
            calls: Arc::default(),
            reject: true,
        }))
        .unwrap();
    let identity = TurnAttemptIdentity {
        thread_id: engine.session_id(),
        turn_id: "turn".into(),
        attempt_id: "attempt".into(),
    };
    engine
        .state
        .history_attempt_scope(identity.clone())
        .unwrap()
        .run(async {
            assert!(
                engine
                    .observe_native_turn_acceptance(&identity)
                    .await
                    .is_err()
            );
            let _ = engine
                .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
                .collect::<Vec<_>>()
                .await;
            assert!(requests.lock().unwrap().is_empty());
        })
        .await;
}
