use std::collections::{BTreeMap, HashSet};

use crate::EngineEvent;
use crate::path_preview::{PathPreviewProbe, PathPreviewUpdate};

const MAX_PROBES: usize = 64;
const MAX_TOOL_ID_BYTES: usize = 1024;
const MAX_ATTEMPT_BYTES: usize = 4 * 1024 * 1024;

/// Temporary state for one actual provider invocation, never persisted as tool input.
/// Dropping a generator cannot yield clears; consumers must also clear on turn termination.
pub(crate) struct PathPreviewRuntime {
    attempt_id: String,
    enabled: bool,
    scanned: usize,
    seen_indices: HashSet<usize>,
    seen_ids: HashSet<String>,
    probes: BTreeMap<usize, (String, PathPreviewProbe)>,
}

impl PathPreviewRuntime {
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            attempt_id: if enabled {
                uuid::Uuid::new_v4().to_string()
            } else {
                String::new()
            },
            enabled,
            scanned: 0,
            seen_indices: HashSet::new(),
            seen_ids: HashSet::new(),
            probes: BTreeMap::new(),
        }
    }

    pub(crate) fn start(&mut self, index: usize, tool: Option<(&str, &str)>) -> Vec<EngineEvent> {
        if !self.enabled {
            return vec![];
        }
        let mut events = vec![];
        if let Some((id, mut probe)) = self.probes.remove(&index) {
            events.extend(self.events(&id, probe.invalidate()));
        }
        let Some((id, name)) = tool.filter(|(_, name)| matches!(*name, "write" | "edit")) else {
            return events;
        };
        if id.len() > MAX_TOOL_ID_BYTES {
            return events;
        }
        if self.seen_indices.contains(&index) || self.seen_ids.contains(id) {
            let duplicate = self
                .probes
                .iter()
                .find_map(|(index, (existing, _))| (existing == id).then_some(*index));
            if let Some(index) = duplicate {
                let (id, mut probe) = self.probes.remove(&index).unwrap();
                events.extend(self.events(&id, probe.invalidate()));
            }
            return events;
        }
        if self.seen_indices.len() == MAX_PROBES {
            events.extend(self.clear());
            return events;
        }
        self.seen_indices.insert(index);
        self.seen_ids.insert(id.to_owned());
        self.probes
            .insert(index, (id.to_owned(), PathPreviewProbe::new(name)));
        events
    }

    pub(crate) fn push(&mut self, index: usize, id: &str, delta: &str) -> Vec<EngineEvent> {
        if !self.enabled
            || !self
                .probes
                .get(&index)
                .is_some_and(|(existing, _)| existing == id)
        {
            return vec![];
        }
        if delta.len() >= MAX_ATTEMPT_BYTES - self.scanned {
            return self.clear();
        }
        self.scanned += delta.len();
        let updates = self.probes.get_mut(&index).unwrap().1.push(delta);
        self.events(id, updates)
    }

    pub(crate) fn finish(
        &mut self,
        index: usize,
        id: &str,
        input: &serde_json::Value,
    ) -> Vec<EngineEvent> {
        let Some((existing, mut probe)) = self.probes.remove(&index) else {
            return vec![];
        };
        let updates = if existing == id {
            probe.finish(input).1
        } else {
            probe.invalidate()
        };
        self.events(&existing, updates)
    }

    pub(crate) fn clear(&mut self) -> Vec<EngineEvent> {
        self.enabled = false;
        let mut events = vec![];
        for (_, (id, mut probe)) in std::mem::take(&mut self.probes) {
            events.extend(self.events(&id, probe.invalidate()));
        }
        events
    }

    fn events(&self, id: &str, updates: Vec<PathPreviewUpdate>) -> Vec<EngineEvent> {
        updates
            .into_iter()
            .map(|update| EngineEvent::ToolPathPreview {
                attempt_id: self.attempt_id.clone(),
                id: id.to_owned(),
                path: match update {
                    PathPreviewUpdate::Set(path) => Some(path),
                    PathPreviewUpdate::Clear => None,
                },
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::engine_builder::{
        TestEngineBuilder, settings_using_main_summary_runtime,
    };
    use futures::StreamExt;
    use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
    use kcoder_tools::{Tool, ToolContext, ToolError, ToolOutput, ToolRegistry};
    use kcoder_types::{ContentBlock, ContentDelta, Message, MessagesRequest, StreamEvent};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    #[derive(Clone, Copy, Debug)]
    enum Scenario {
        Complete,
        DuplicateKey,
        Retry,
        Failure,
        Hanging,
        Eof,
        MissingStop,
        DuplicateBlock,
    }

    #[derive(Debug)]
    struct PreviewProvider {
        scenario: Scenario,
        calls: AtomicUsize,
        request_flags: Arc<Mutex<Vec<bool>>>,
    }

    fn start(index: usize, name: &str) -> StreamEvent {
        StreamEvent::ContentBlockStart {
            index,
            content_block: ContentBlock::ToolUse {
                id: format!("tool-{index}"),
                name: name.into(),
                input: serde_json::json!({}),
            },
        }
    }

    fn delta(index: usize, json: &str) -> StreamEvent {
        StreamEvent::ContentBlockDelta {
            index,
            delta: ContentDelta::InputJsonDelta {
                partial_json: json.into(),
            },
        }
    }

    impl Provider for PreviewProvider {
        fn name(&self) -> &'static str {
            "path-preview-test"
        }
        fn stream_messages(
            &self,
            request: MessagesRequest,
        ) -> Result<ProviderStream, ApiErrorKind> {
            self.request_flags
                .lock()
                .unwrap()
                .push(request.path_first_tools);
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let scenario = self.scenario;
            Ok(Box::pin(async_stream::stream! {
                if call > usize::from(matches!(scenario, Scenario::Retry)) {
                    yield Ok(StreamEvent::ContentBlockStart { index: 0, content_block: ContentBlock::Text { text: "done".into() } });
                    yield Ok(StreamEvent::ContentBlockStop { index: 0 });
                    yield Ok(StreamEvent::MessageStop);
                    return;
                }
                yield Ok(start(0, "write"));
                yield Ok(delta(0, r#"{"file_path":"first.txt""#));
                match scenario {
                    Scenario::Retry if call == 0 => {
                        yield Err(ApiErrorKind::Api { error_type: "stream_incomplete".into(), message: "connection reset while streaming".into() });
                        return;
                    }
                    Scenario::Failure => {
                        yield Ok(StreamEvent::Error { error: kcoder_types::ApiError { error_type: "authentication_error".into(), message: "denied".into() } });
                        return;
                    }
                    Scenario::Hanging => { futures::future::pending::<()>().await; }
                    Scenario::Eof => return,
                    Scenario::MissingStop => { yield Ok(StreamEvent::MessageStop); return; }
                    Scenario::DuplicateBlock => { yield Ok(start(0, "write")); yield Ok(delta(0, r#"{"file_path":"replacement.txt""#)); }
                    _ => {}
                }
                if matches!(scenario, Scenario::DuplicateKey) {
                    yield Ok(delta(0, r#", "file_path":"final.txt""#));
                }
                yield Ok(delta(0, r#", "content":"hello"}"#));
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
                yield Ok(start(1, "edit"));
                yield Ok(delta(1, r#"{"file_path":"second.txt", "old_string":"x", "new_string":"y"}"#));
                yield Ok(StreamEvent::ContentBlockStop { index: 1 });
                yield Ok(StreamEvent::MessageStop);
            }))
        }
    }

    struct RecordingTool {
        name: &'static str,
        inputs: Arc<Mutex<Vec<serde_json::Value>>>,
    }

    #[async_trait::async_trait]
    impl Tool for RecordingTool {
        fn name(&self) -> String {
            self.name.into()
        }
        fn description(&self) -> String {
            "Record final tool input".into()
        }
        fn input_schema(&self) -> serde_json::Value {
            serde_json::json!({"type":"object", "properties":{"file_path":{"type":"string"}}, "required":["file_path"]})
        }
        fn is_concurrency_safe(&self, _: &serde_json::Value) -> bool {
            false
        }
        async fn call(
            &self,
            input: serde_json::Value,
            _: &ToolContext,
        ) -> Result<ToolOutput, ToolError> {
            self.inputs.lock().unwrap().push(input);
            Ok(ToolOutput::text("done"))
        }
    }

    fn engine(
        path: &std::path::Path,
        scenario: Scenario,
    ) -> (crate::QueryEngine, Arc<Mutex<Vec<serde_json::Value>>>) {
        let (engine, inputs, _) = engine_with_request_flags(path, scenario);
        (engine, inputs)
    }

    fn engine_with_request_flags(
        path: &std::path::Path,
        scenario: Scenario,
    ) -> (
        crate::QueryEngine,
        Arc<Mutex<Vec<serde_json::Value>>>,
        Arc<Mutex<Vec<bool>>>,
    ) {
        let inputs = Arc::new(Mutex::new(vec![]));
        let request_flags = Arc::new(Mutex::new(vec![]));
        let registry = ToolRegistry::new()
            .register(RecordingTool {
                name: "write",
                inputs: inputs.clone(),
            })
            .register(RecordingTool {
                name: "edit",
                inputs: inputs.clone(),
            });
        let engine = TestEngineBuilder::new(path)
            .provider(Arc::new(PreviewProvider {
                scenario,
                calls: AtomicUsize::new(0),
                request_flags: request_flags.clone(),
            }))
            .settings(kcoder_config::Settings {
                max_retries: 1,
                retry_base_delay_ms: 0,
                permission_mode: kcoder_config::PermissionMode::Bypass,
                ..settings_using_main_summary_runtime(kcoder_config::Settings::default())
            })
            .tool_registry(registry)
            .build();
        engine.state.add_message(Message::user_text("run tools"));
        (engine, inputs, request_flags)
    }

    fn hints(events: &[EngineEvent]) -> Vec<(&str, &str, Option<&str>)> {
        events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::ToolPathPreview {
                    attempt_id,
                    id,
                    path,
                } => Some((attempt_id.as_str(), id.as_str(), path.as_deref())),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn path_first_wire_training_disables_ordering_with_preview_enabled() {
        let tmp = tempfile::tempdir().unwrap();
        let (engine, inputs, request_flags) =
            engine_with_request_flags(tmp.path(), Scenario::Complete);
        let engine = engine.with_tool_path_previews(true);
        engine.settings.write().unwrap().training_mode = true;
        let _events = engine
            .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
            .collect::<Vec<_>>()
            .await;
        assert_eq!(inputs.lock().unwrap().len(), 2);
        assert_eq!(*request_flags.lock().unwrap(), vec![false, false]);
    }

    #[tokio::test]
    async fn path_preview_runtime_default_off_preserves_real_tool_calls() {
        let tmp = tempfile::tempdir().unwrap();
        let (engine, inputs, request_flags) =
            engine_with_request_flags(tmp.path(), Scenario::Complete);
        let events = engine
            .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
            .collect::<Vec<_>>()
            .await;
        assert!(hints(&events).is_empty());
        assert_eq!(*request_flags.lock().unwrap(), vec![false, false]);
        assert_eq!(inputs.lock().unwrap().len(), 2);
        assert!(!engine.tool_path_previews);
        assert!(
            engine
                .clone()
                .with_tool_path_previews(true)
                .tool_path_previews
        );
        assert!(!engine.tool_path_previews);
    }

    #[tokio::test]
    async fn path_preview_runtime_enabled_emits_before_execution_and_retires_both_tools() {
        let tmp = tempfile::tempdir().unwrap();
        let (engine, inputs, request_flags) =
            engine_with_request_flags(tmp.path(), Scenario::Complete);
        let engine = engine.with_tool_path_previews(true);
        let mut stream = engine.run_turn_stream(&kcoder_permissions::AutoAllowPrompt);
        let mut events = vec![];
        loop {
            let event = stream
                .next()
                .await
                .expect("path preview must precede stream completion");
            let is_hint = matches!(event, EngineEvent::ToolPathPreview { path: Some(_), .. });
            events.push(event);
            if is_hint {
                break;
            }
        }
        assert!(inputs.lock().unwrap().is_empty());
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, EngineEvent::ToolUseStarted { .. }))
        );
        events.extend(stream.collect::<Vec<_>>().await);
        assert_eq!(*request_flags.lock().unwrap(), vec![true, true]);
        let hints = hints(&events);
        assert_eq!(hints.len(), 4);
        assert_eq!(
            hints
                .iter()
                .map(|(_, id, path)| (*id, *path))
                .collect::<Vec<_>>(),
            vec![
                ("tool-0", Some("first.txt")),
                ("tool-0", None),
                ("tool-1", Some("second.txt")),
                ("tool-1", None)
            ]
        );
        assert!(hints.iter().all(|(attempt, _, _)| *attempt == hints[0].0));
        assert!(uuid::Uuid::parse_str(hints[0].0).is_ok());
        assert_eq!(inputs.lock().unwrap()[0]["file_path"], "first.txt");
        assert_eq!(inputs.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn path_preview_runtime_failure_clears_preview_without_replaying_published_output() {
        let tmp = tempfile::tempdir().unwrap();
        let (engine, inputs) = engine(tmp.path(), Scenario::Retry);
        let events = engine
            .with_tool_path_previews(true)
            .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
            .collect::<Vec<_>>()
            .await;
        let hints = hints(&events);
        assert_eq!(hints.len(), 2);
        assert_eq!(hints[0].0, hints[1].0);
        assert_eq!(hints[0].1, hints[1].1);
        assert_eq!(hints[1].2, None);
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, EngineEvent::ProviderRetry(_)))
        );
        assert!(events.iter().any(|event| matches!(
            event,
            EngineEvent::Error(_) | EngineEvent::ProviderFailed { .. }
        )));
        assert!(inputs.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn path_preview_runtime_invalid_preview_does_not_change_final_execution() {
        for (scenario, expected) in [
            (Scenario::DuplicateKey, "final.txt"),
            (Scenario::DuplicateBlock, "replacement.txt"),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let (engine, inputs) = engine(tmp.path(), scenario);
            let events = engine
                .with_tool_path_previews(true)
                .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
                .collect::<Vec<_>>()
                .await;
            let hints = hints(&events);
            assert_eq!(hints[0].2, Some("first.txt"));
            assert_eq!(hints[1].2, None);
            assert_eq!(inputs.lock().unwrap()[0]["file_path"], expected);
            assert_eq!(inputs.lock().unwrap().len(), 2);
        }
    }

    #[tokio::test]
    async fn path_preview_runtime_exits_clear_before_terminal_events() {
        for scenario in [
            Scenario::Failure,
            Scenario::Hanging,
            Scenario::Eof,
            Scenario::MissingStop,
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let (engine, inputs) = engine(tmp.path(), scenario);
            let engine = engine.with_tool_path_previews(true);
            let mut stream = engine.run_turn_stream(&kcoder_permissions::AutoAllowPrompt);
            let mut events = vec![];
            while let Some(event) = stream.next().await {
                if matches!(event, EngineEvent::ToolPathPreview { path: Some(_), .. })
                    && matches!(scenario, Scenario::Hanging)
                {
                    engine.cancel();
                }
                events.push(event);
            }
            assert_eq!(
                hints(&events)
                    .iter()
                    .map(|(_, _, path)| *path)
                    .collect::<Vec<_>>(),
                vec![Some("first.txt"), None],
                "{scenario:?}"
            );
            let clear = events
                .iter()
                .position(|event| matches!(event, EngineEvent::ToolPathPreview { path: None, .. }))
                .unwrap();
            if let Some(terminal) = events.iter().position(|event| {
                matches!(
                    event,
                    EngineEvent::Error(_)
                        | EngineEvent::ProviderFailed { .. }
                        | EngineEvent::StreamAborted { .. }
                )
            }) {
                assert!(clear < terminal, "{scenario:?}");
            }
            assert!(inputs.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn path_preview_runtime_terminal_verdict_never_previews_rejected_tools() {
        let tmp = tempfile::tempdir().unwrap();
        let (engine, inputs) = engine(tmp.path(), Scenario::Complete);
        let events = engine
            .with_tool_path_previews(true)
            .with_terminal_verdict_turn(true)
            .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
            .collect::<Vec<_>>()
            .await;
        assert!(hints(&events).is_empty());
        assert!(inputs.lock().unwrap().is_empty());
    }

    #[test]
    fn path_preview_runtime_request_byte_limit_clears_all_and_stays_disabled() {
        let mut previews = PathPreviewRuntime::new(true);
        for index in 0..4 {
            previews.start(index, Some((&index.to_string(), "write")));
            previews.push(
                index,
                &index.to_string(),
                r#"{"file_path":"a", "content":""#,
            );
        }
        let body = "x".repeat(1024 * 1024 - 100);
        for index in 0..4 {
            previews.push(index, &index.to_string(), &body);
        }
        let clears = previews.push(0, "0", &"x".repeat(1024));
        assert_eq!(clears.len(), 4);
        assert!(
            clears
                .iter()
                .all(|event| matches!(event, EngineEvent::ToolPathPreview { path: None, .. }))
        );
        assert!(previews.start(4, Some(("late", "write"))).is_empty());
        assert!(previews.push(4, "late", r#"{"file_path":"b"}"#).is_empty());
    }

    #[test]
    fn path_preview_runtime_only_supported_tools_and_correct_identity() {
        let mut previews = PathPreviewRuntime::new(true);
        previews.start(0, Some(("a", "bash")));
        assert!(previews.push(0, "a", r#"{"file_path":"a"}"#).is_empty());
        previews.start(1, Some(("b", "edit")));
        assert!(previews.push(1, "wrong", r#"{"file_path":"a"}"#).is_empty());
        assert_eq!(previews.push(1, "b", r#"{"file_path":"a"}"#).len(), 1);
        assert_eq!(previews.start(2, Some(("b", "edit"))).len(), 1);
        assert!(previews.push(2, "b", r#"{"file_path":"a"}"#).is_empty());
        let long_id = "x".repeat(MAX_TOOL_ID_BYTES + 1);
        assert!(previews.start(3, Some((&long_id, "write"))).is_empty());
        assert!(
            previews
                .push(3, &long_id, r#"{"file_path":"a"}"#)
                .is_empty()
        );
        assert!(!previews.seen_indices.contains(&3));
        assert!(previews.probes.is_empty());
    }

    #[test]
    fn path_preview_runtime_probe_limit_clears_and_disables_attempt() {
        let mut previews = PathPreviewRuntime::new(true);
        for index in 0..64 {
            assert!(
                previews
                    .start(index, Some((&index.to_string(), "write")))
                    .is_empty()
            );
            assert_eq!(
                previews
                    .push(index, &index.to_string(), r#"{"file_path":"a""#)
                    .len(),
                1
            );
        }
        assert_eq!(previews.start(64, Some(("overflow", "edit"))).len(), 64);
        assert!(previews.push(0, "0", ",").is_empty());
        assert!(previews.start(65, Some(("later", "write"))).is_empty());
        assert!(
            previews
                .push(65, "later", r#"{"file_path":"a"}"#)
                .is_empty()
        );
    }
}
