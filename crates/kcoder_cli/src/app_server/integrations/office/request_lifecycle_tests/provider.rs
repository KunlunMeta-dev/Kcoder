//! Deterministic transport records requests assembled by the actual Engine.
use super::*;

pub(super) struct LifecycleProvider {
    pub inner: DeferredProvider,
    pub phase: Mutex<&'static str>,
    pub captured: Mutex<Vec<(&'static str, MessagesRequest)>>,
    pub summary_refs: Mutex<Vec<OfficeArtifactRef>>,
}
impl LifecycleProvider {
    pub fn new() -> Self {
        Self {
            inner: DeferredProvider {
                requests: Mutex::new(Vec::new()),
                phase: AtomicUsize::new(0),
                arguments: arguments(),
                script: Mutex::new(VecDeque::new()),
            },
            phase: Mutex::new("first"),
            captured: Mutex::new(Vec::new()),
            summary_refs: Mutex::new(Vec::new()),
        }
    }
    pub fn phase(&self, phase: &'static str) {
        *self.phase.lock().unwrap() = phase;
    }
    pub fn tool(&self, call: &str, name: &str, input: Value) {
        self.inner
            .script
            .lock()
            .unwrap()
            .push_back(ContentBlock::ToolUse {
                id: call.into(),
                name: name.into(),
                input,
            });
    }
    pub fn is_compact(request: &MessagesRequest) -> bool {
        request.system.as_deref().is_some_and(|system| {
            system.starts_with("You are an isolated conversation summarizer.")
        })
    }
}
impl kcoder_api::Provider for LifecycleProvider {
    fn name(&self) -> &'static str {
        "owned-actual-context-lifecycle-recorder"
    }
    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let phase = *self.phase.lock().unwrap();
        self.captured.lock().unwrap().push((phase, request.clone()));
        let stream = if Self::is_compact(&request) {
            let refs = serde_json::to_string(&*self.summary_refs.lock().unwrap()).unwrap();
            // Only the real summarizer request receives this fixture response.
            // Engine validates it, commits a compact boundary and persists it.
            let text = format!(
                "<analysis>Retain immutable references rather than full document bodies.</analysis><summary>Two generated documents remain available by immutable artifact references: {refs}. The original source selection changed from none to inherit_current at its native boundary. Continue by reading canonical references when necessary.</summary>"
            );
            Box::pin(async_stream::stream! {
                yield Ok(StreamEvent::MessageStart { message: kcoder_types::StreamingMessage {
                    id:"actual-context-summary".into(), role:"assistant".into(), content:vec![],
                    model:"deterministic-fixture".into(),stop_reason:None,stop_sequence:None,usage:None,
                }});
                yield Ok(StreamEvent::ContentBlockStart {index:0,content_block:ContentBlock::Text{text:String::new()}});
                yield Ok(StreamEvent::ContentBlockDelta {index:0,delta:kcoder_types::ContentDelta::TextDelta{text}});
                yield Ok(StreamEvent::ContentBlockStop {index:0});
                yield Ok(StreamEvent::MessageDelta {delta:kcoder_types::MessageDeltaFields {
                    stop_reason:Some("end_turn".into()),stop_sequence:None,usage:None,
                }});
                yield Ok(StreamEvent::MessageStop);
            }) as kcoder_api::ProviderStream
        } else {
            kcoder_api::Provider::stream_messages(&self.inner, request)?
        };
        // No vendor measured this fixture request. Leave usage unavailable so
        // compaction uses the production conservative estimator, never a fake
        // small usage anchor for a much larger preserved context.
        Ok(stream)
    }
}
