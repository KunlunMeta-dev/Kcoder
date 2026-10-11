use super::*;

pub(super) fn lifecycle_test_engine(cwd: &Path) -> QueryEngine {
    TestEngineBuilder::new(cwd).build()
}

pub(super) struct PrefireStreamDrop(pub(super) Arc<AtomicUsize>);

impl Drop for PrefireStreamDrop {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

pub(super) fn test_engine_with_settings(
    provider: Arc<dyn Provider>,
    cwd: &Path,
    settings: Settings,
) -> QueryEngine {
    TestEngineBuilder::new(cwd)
        .provider(provider)
        .settings(settings)
        .build()
}

pub(super) fn test_engine_with_memory_manager(
    provider: Arc<dyn Provider>,
    cwd: &Path,
    settings: Settings,
    memory_manager: MemoryManager,
) -> QueryEngine {
    TestEngineBuilder::new(cwd)
        .provider(provider)
        .settings(settings)
        .memory_manager(memory_manager)
        .build()
}

pub(super) fn assistant_tool_use(id: &str, name: &str) -> Message {
    Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: id.to_string(),
            name: name.to_string(),
            input: serde_json::json!({"file_path": format!("{id}.txt")}),
        }],
        usage: None,
    }
}

pub(super) fn user_tool_result(id: &str, text: String) -> Message {
    Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: id.to_string(),
            content: vec![ContentBlock::Text { text }],
            is_error: Some(false),
        }],
    }
}

pub(super) fn tool_result_text(message: &Message) -> &str {
    let Message::User { content, .. } = message else {
        panic!("expected user tool result");
    };
    let Some(ContentBlock::ToolResult { content, .. }) = content.first() else {
        panic!("expected tool result block");
    };
    let Some(ContentBlock::Text { text }) = content.first() else {
        panic!("expected text tool result");
    };
    text
}

#[derive(Debug)]
pub(super) struct HangingPrefireProvider {
    pub(super) requests: Arc<AtomicUsize>,
    pub(super) dropped: Arc<AtomicUsize>,
}

impl Provider for HangingPrefireProvider {
    fn name(&self) -> &'static str {
        "hanging-prefire"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        let guard = PrefireStreamDrop(Arc::clone(&self.dropped));
        Ok(Box::pin(async_stream::stream! {
            let _guard = guard;
            std::future::pending::<()>().await;
            yield Ok(StreamEvent::MessageStop);
        }))
    }
}
