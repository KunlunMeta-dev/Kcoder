use std::any::TypeId;
use std::sync::Arc;

use futures::{StreamExt, stream};
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_config::Settings;
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_permissions::{AutoAllowPrompt, PermissionEngine};
use kcoder_skills::SkillRegistry;
use kcoder_state::AppState;
use kcoder_tools::{DenyAllUserQuestioner, ToolRegistry};
use kcoder_types::{ContentBlock, ContentDelta, Message, MessagesRequest, StreamEvent};

#[test]
fn historical_query_facade_reexports_engine_types() {
    assert_eq!(
        TypeId::of::<kcoder_query::EngineEvent>(),
        TypeId::of::<kcoder_engine::EngineEvent>()
    );
    assert_eq!(
        TypeId::of::<kcoder_query::QueryEngine>(),
        TypeId::of::<kcoder_engine::QueryEngine>()
    );
}

struct PublicQueryProvider;

impl Provider for PublicQueryProvider {
    fn name(&self) -> &'static str {
        "public-query-contract"
    }

    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        assert!(
            request
                .messages
                .iter()
                .any(|message| matches!(message, Message::User { .. }))
        );
        Ok(Box::pin(stream::iter([
            Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text {
                    text: String::new(),
                },
            }),
            Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: "公开查询成功".to_string(),
                },
            }),
            Ok(StreamEvent::ContentBlockStop { index: 0 }),
            Ok(StreamEvent::MessageStop),
        ])))
    }
}

#[tokio::test]
async fn public_query_facade_runs_a_real_turn_through_its_exported_api() {
    let temporary = tempfile::tempdir().unwrap();
    let settings = Settings::default();
    let state = AppState::new(temporary.path());
    state.add_message(Message::user_text("通过 kcoder_query 发起请求"));
    let engine = kcoder_query::QueryEngine::new_for_client(
        Arc::new(PublicQueryProvider),
        state,
        ToolRegistry::new(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::empty(),
        Arc::new(DenyAllUserQuestioner),
        temporary.path().to_path_buf(),
    );

    let events = engine
        .run_turn_stream(&AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert!(events.iter().any(|event| matches!(event, kcoder_query::EngineEvent::AssistantTextDelta(text) if text == "公开查询成功")));
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, kcoder_query::EngineEvent::AssistantMessageDone))
            .count(),
        1
    );
}
