//! Deterministic evolution integration tests (scripted providers only).

mod canary;
mod distill;
mod eval;
mod jobs;
mod maintenance;
mod recording;
mod review;
mod signals;
mod target_tool;
mod target_workflow;

use super::ScopeKind;
use crate::QueryEngine;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_config::Settings;
use kcoder_evolution::EvolutionStore;
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_permissions::PermissionEngine;
use kcoder_skills::SkillRegistry;
use kcoder_state::AppState;
use kcoder_tools::{Tool, ToolRegistry};
use kcoder_types::evolution::{EvolutionMode, TargetKey};
use kcoder_types::{ContentBlock, ContentDelta, Message, MessagesRequest, StreamEvent, Usage};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub(super) const SKILL: &str = "deploy-check";
pub(super) const OTHER_SKILL: &str = "release-notes";

pub(super) fn key(value: &str) -> TargetKey {
    TargetKey::parse(value).unwrap()
}

pub(super) fn skill_key() -> TargetKey {
    key("skill:user_created:deploy-check")
}

pub(super) fn settings(mode: EvolutionMode) -> Settings {
    let mut settings = crate::test_support::engine_builder::fixture_settings();
    settings.model = "test-model".into();
    settings.evolution.enabled = true;
    settings.evolution.mode = mode;
    settings
}

/// Replies are served in order; when exhausted, `{"items": []}` is returned.
#[derive(Default)]
pub(super) struct ScriptedProvider {
    pub(super) replies: Mutex<VecDeque<Vec<StreamEvent>>>,
    pub(super) requests: Mutex<Vec<MessagesRequest>>,
    pub(super) hang: bool,
}

impl ScriptedProvider {
    pub(super) fn with_texts(texts: &[&str]) -> Arc<Self> {
        let provider = Self::default();
        for text in texts {
            provider
                .replies
                .lock()
                .unwrap()
                .push_back(text_events(text, 120, 30));
        }
        Arc::new(provider)
    }

    pub(super) fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

impl Provider for ScriptedProvider {
    fn name(&self) -> &'static str {
        "scripted"
    }

    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        if self.hang {
            return Ok(Box::pin(futures::stream::pending()));
        }
        let events = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| text_events("{\"items\": []}", 1, 1));
        Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
    }
}

fn start() -> StreamEvent {
    StreamEvent::MessageStart {
        message: kcoder_types::StreamingMessage {
            id: "msg".into(),
            role: "assistant".into(),
            content: Vec::new(),
            model: "test-model".into(),
            stop_reason: None,
            stop_sequence: None,
            usage: None,
        },
    }
}

fn stop(reason: &str, input: u32, output: u32) -> Vec<StreamEvent> {
    vec![
        StreamEvent::MessageDelta {
            delta: kcoder_types::MessageDeltaFields {
                stop_reason: Some(reason.into()),
                stop_sequence: None,
                usage: Some(Usage {
                    input_tokens: input,
                    output_tokens: output,
                    total_tokens: None,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: None,
                    iterations: None,
                }),
            },
        },
        StreamEvent::MessageStop,
    ]
}

pub(super) fn text_events(text: &str, input: u32, output: u32) -> Vec<StreamEvent> {
    let mut events = vec![
        start(),
        StreamEvent::ContentBlockStart {
            index: 0,
            content_block: ContentBlock::Text {
                text: String::new(),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::TextDelta { text: text.into() },
        },
        StreamEvent::ContentBlockStop { index: 0 },
    ];
    events.extend(stop("end_turn", input, output));
    events
}

pub(super) fn tool_events(name: &str, input: &serde_json::Value) -> Vec<StreamEvent> {
    let mut events = vec![
        start(),
        StreamEvent::ContentBlockStart {
            index: 0,
            content_block: ContentBlock::ToolUse {
                id: "call-1".into(),
                name: name.into(),
                input: serde_json::json!({}),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::InputJsonDelta {
                partial_json: input.to_string(),
            },
        },
        StreamEvent::ContentBlockStop { index: 0 },
    ];
    events.extend(stop("tool_use", 200, 50));
    events
}

pub(super) struct Fixture {
    pub(super) project: tempfile::TempDir,
    pub(super) data: tempfile::TempDir,
    pub(super) engine: QueryEngine,
}

pub(super) fn write_skill(project: &Path, name: &str, body: &str) {
    let directory = project.join(".kcoder/skills").join(name);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: Checks {name}\n---\n{body}\n"),
    )
    .unwrap();
}

pub(super) fn engine_for(
    project: &Path,
    data: &Path,
    settings: Settings,
    provider: Arc<dyn Provider>,
    state: AppState,
) -> QueryEngine {
    let engine = QueryEngine::new(
        provider,
        state,
        ToolRegistry::new()
            .register(kcoder_tools::SkillTool)
            .register(kcoder_tools::SkillManageTool),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::with_path(data.join("memories.json"))),
        SkillRegistry::load_project_only(project).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        project.to_path_buf(),
    );
    engine.set_evolution_data_root(data.join("profile"));
    engine
}

pub(super) fn fixture_with(settings: Settings, provider: Arc<dyn Provider>) -> Fixture {
    let project = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    write_skill(
        project.path(),
        SKILL,
        "Run `cargo test --workspace` before deploying, then summarize the result.",
    );
    write_skill(
        project.path(),
        OTHER_SKILL,
        "Write release notes with a summary first.",
    );
    let engine = engine_for(
        project.path(),
        data.path(),
        settings,
        provider,
        AppState::new(project.path()),
    );
    Fixture {
        project,
        data,
        engine,
    }
}

pub(super) fn fixture(mode: EvolutionMode) -> Fixture {
    fixture_with(settings(mode), ScriptedProvider::with_texts(&[]))
}

impl Fixture {
    pub(super) fn store(&self, scope: ScopeKind) -> Arc<EvolutionStore> {
        self.engine
            .evolution
            .store(scope, &self.engine.cwd)
            .expect("store")
    }

    pub(super) fn project_store(&self) -> Arc<EvolutionStore> {
        self.store(ScopeKind::Project)
    }

    pub(super) fn path(&self, name: &str) -> PathBuf {
        self.project.path().join(name)
    }
}

/// Activate a skill through the real `skill` tool; returns the result text.
pub(super) async fn activate(engine: &QueryEngine, name: &str) -> String {
    let context = engine.base_tool_context(100_000, 60_000, 40_000, None);
    let output = kcoder_tools::SkillTool
        .call(serde_json::json!({ "skill": name }), &context)
        .await
        .unwrap();
    let text = output
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    // Persist the activation like a real turn would.
    engine.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: format!("skill-{}", engine.state.messages().len()),
            name: "skill".into(),
            input: serde_json::json!({ "skill": name }),
        }],
        usage: None,
    });
    let id = format!("skill-{}", engine.state.messages().len() - 1);
    engine
        .state
        .add_message(Message::user_content(vec![ContentBlock::ToolResult {
            tool_use_id: id,
            content: vec![ContentBlock::Text { text: text.clone() }],
            is_error: Some(false),
        }]));
    text
}

/// Append one tool call with its result to the transcript.
pub(super) fn tool_call(
    engine: &QueryEngine,
    name: &str,
    input: serde_json::Value,
    output: &str,
    is_error: bool,
) {
    let id = format!("call-{}", engine.state.messages().len());
    engine.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: id.clone(),
            name: name.into(),
            input,
        }],
        usage: None,
    });
    engine
        .state
        .add_message(Message::user_content(vec![ContentBlock::ToolResult {
            tool_use_id: id,
            content: vec![ContentBlock::Text {
                text: output.into(),
            }],
            is_error: Some(is_error),
        }]));
}

/// Start one main-thread turn with `user_text`.
pub(super) fn begin_turn(
    engine: &QueryEngine,
    user_text: &str,
) -> crate::turn_driver::TurnDriverActiveGuard {
    engine.state.add_message(Message::user_text(user_text));
    crate::turn_driver::TurnDriverActiveGuard::new(engine)
}

/// Finish the turn with a final answer.
pub(super) fn end_turn(engine: &QueryEngine, guard: crate::turn_driver::TurnDriverActiveGuard) {
    engine.state.add_message(Message::assistant_text("Done."));
    drop(guard);
}

/// Wait until `condition` holds (bounded).
pub(super) async fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
    for _ in 0..400 {
        if condition() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    condition()
}

pub(super) async fn wait_idle(engine: &QueryEngine) {
    wait_until(|| {
        !engine
            .evolution
            .job_running
            .load(std::sync::atomic::Ordering::SeqCst)
    })
    .await;
}
