use super::*;
use kcoder_api::native_model_request::NativeModelRequestError;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_knowledge::WikiModelRequest;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

#[derive(Default)]
struct Facts {
    denied: AtomicBool,
    revoked: AtomicBool,
    calls: AtomicUsize,
    settlements: Mutex<Vec<NativeModelRequestSettlement>>,
}
struct Fixture {
    facts: Arc<Facts>,
    pending: bool,
    final_usage: bool,
}
impl Provider for Fixture {
    fn name(&self) -> &'static str {
        "wiki-admission-fixture"
    }
    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        assert_eq!(request.model, "fixture");
        assert_eq!(request.max_tokens, 1024);
        assert!(request.tools.is_empty());
        self.facts.calls.fetch_add(1, Ordering::SeqCst);
        if self.pending {
            return Ok(Box::pin(futures::stream::pending()));
        }
        let mut events = vec![Ok(serde_json::from_value(serde_json::json!({
            "type":"message_start", "message":{"id":"original","role":"assistant","content":[],"model":"fixture","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":17,"output_tokens":0}}
        })).unwrap()), Ok(StreamEvent::ContentBlockDelta { index:0, delta:kcoder_types::ContentDelta::TextDelta {text:"{}".into()} })];
        if self.final_usage {
            events.push(Ok(serde_json::from_value(serde_json::json!({
                "type":"message_delta", "delta":{"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":9}}
            })).unwrap()));
        }
        events.push(Ok(StreamEvent::MessageStop));
        Ok(Box::pin(futures::stream::iter(events)))
    }
}
impl WikiRequestAdmission for Facts {
    fn reserve(
        &self,
        _: &ProviderWikiModel,
        request: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease + '_>> {
        ensure!(
            !self.denied.load(Ordering::SeqCst),
            "fixture admission denied"
        );
        assert_eq!(request.model, "fixture");
        assert_eq!(request.max_tokens, 1024);
        assert!(request.system.is_some());
        Ok(Box::new(Lease(self)))
    }
}
struct Lease<'a>(&'a Facts);
impl NativeModelRequestLease for Lease<'_> {
    fn check_current(&self) -> Result<(), NativeModelRequestError> {
        if self.0.revoked.load(Ordering::SeqCst) {
            Err(NativeModelRequestError::Denied)
        } else {
            Ok(())
        }
    }
    fn finish(
        self: Box<Self>,
        settlement: NativeModelRequestSettlement,
    ) -> Result<(), NativeModelRequestError> {
        self.0.settlements.lock().unwrap().push(settlement);
        Ok(())
    }
}
fn model(facts: &Arc<Facts>, pending: bool, final_usage: bool) -> ProviderWikiModel {
    ProviderWikiModel {
        provider: Arc::new(Fixture {
            facts: facts.clone(),
            pending,
            final_usage,
        }),
        model: "fixture".into(),
        max_output_tokens: Some(4096),
        reasoning: None,
        configuration: None,
    }
}
fn request() -> WikiModelRequest {
    WikiModelRequest {
        stage: "analysis",
        system: "evidence".into(),
        user: "source".into(),
        max_output_tokens: 1024,
    }
}

#[tokio::test]
async fn admission_denial_prevents_actual_provider_call() {
    let facts = Arc::new(Facts::default());
    facts.denied.store(true, Ordering::SeqCst);
    assert!(
        model(&facts, false, true)
            .complete_admitted_with_progress(request(), 4096, &|_, _| Ok(()), facts.as_ref())
            .await
            .is_err()
    );
    assert_eq!(facts.calls.load(Ordering::SeqCst), 0);
    assert!(facts.settlements.lock().unwrap().is_empty());
}

#[tokio::test]
async fn final_and_start_only_usage_keep_distinct_coverage() {
    for final_usage in [false, true] {
        let facts = Arc::new(Facts::default());
        let (_, usage) = model(&facts, false, final_usage)
            .complete_admitted_with_progress(request(), 4096, &|_, _| Ok(()), facts.as_ref())
            .await
            .unwrap();
        assert_eq!(usage.is_some(), final_usage);
        let settlements = facts.settlements.lock().unwrap();
        assert_eq!(settlements.len(), 1);
        let end = &settlements[0];
        assert_eq!(end.end, NativeModelRequestEnd::MessageStop);
        assert!(end.request_dispatched);
        assert_eq!(end.usage_from_delta, final_usage);
        assert_eq!(end.usage.as_ref().unwrap().input_tokens, 17);
        assert_eq!(
            end.usage.as_ref().unwrap().output_tokens,
            if final_usage { 9 } else { 0 }
        );
    }
}

#[tokio::test]
async fn pending_stream_is_rechecked_without_new_provider_call() {
    let facts = Arc::new(Facts::default());
    let model = model(&facts, true, false);
    let progress = |_, _| Ok(());
    let work = model.complete_admitted_with_progress(request(), 4096, &progress, facts.as_ref());
    tokio::pin!(work);
    tokio::select! {
        result=&mut work => panic!("pending call returned early: {result:?}"),
        _=tokio::time::sleep(std::time::Duration::from_millis(20)) => {}
    }
    assert_eq!(facts.calls.load(Ordering::SeqCst), 1);
    facts.revoked.store(true, Ordering::SeqCst);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), &mut work)
            .await
            .unwrap()
            .is_err()
    );
    let settlements = facts.settlements.lock().unwrap();
    assert_eq!(settlements.len(), 1);
    assert!(settlements[0].request_dispatched);
    assert!(settlements[0].usage.is_none());
    assert_ne!(settlements[0].end, NativeModelRequestEnd::MessageStop);
    assert_eq!(facts.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn dropping_pending_future_settles_original_unknown_call_once() {
    let facts = Arc::new(Facts::default());
    let model = model(&facts, true, false);
    let progress = |_, _| Ok(());
    {
        let work =
            model.complete_admitted_with_progress(request(), 4096, &progress, facts.as_ref());
        tokio::pin!(work);
        tokio::select! {
            result=&mut work => panic!("pending call returned early: {result:?}"),
            _=tokio::time::sleep(std::time::Duration::from_millis(20)) => {}
        }
    }
    let settlements = facts.settlements.lock().unwrap();
    assert_eq!(settlements.len(), 1);
    assert_eq!(settlements[0].end, NativeModelRequestEnd::Dropped);
    assert!(settlements[0].request_dispatched);
    assert!(settlements[0].usage.is_none());
    assert_eq!(facts.calls.load(Ordering::SeqCst), 1);
}
