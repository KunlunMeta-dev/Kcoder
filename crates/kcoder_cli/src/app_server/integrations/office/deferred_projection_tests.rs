//! Actual Engine search/execute/Node/canonical-storage acceptance, no paid model.
//! Default execution is gated because the native Node path must be explicit.
use crate::app_server::integrations::core::NativeIntegrationContext;
use crate::app_server::integrations::office::{
    native_host::{
        NativeOfficeAcceptedTurnAuthority, NativeOfficeComposition, NativeOfficeInstalledPaths,
        NativeOfficeProviders,
    },
    turn_binding::install_office_for_accepted_turn,
};
use anyhow::Result;
use futures::StreamExt;
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
use kcoder_tools::ToolRegistry;
use kcoder_types::{
    ClientPresentationV1, ContentBlock, Message, MessagesRequest, SharedMessages, StreamEvent,
    StudioWorkMode, TurnAttemptIdentity, TurnAttemptStatus, integrations::office::*,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    ffi::OsStr,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

struct Fixture {
    _temp: tempfile::TempDir,
    context: NativeIntegrationContext,
    engine: QueryEngine,
    identity: TurnAttemptIdentity,
    provider: Arc<DeferredProvider>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let parent = PrivateDirectory::open_existing(temp.path()).unwrap();
        parent.create_private_child(OsStr::new("profile")).unwrap();
        parent
            .create_private_child(OsStr::new("workspace"))
            .unwrap();
        let profile = temp.path().join("profile");
        let workspace = temp.path().join("workspace");
        let provider = Arc::new(DeferredProvider {
            requests: Mutex::new(Vec::new()),
            phase: AtomicUsize::new(0),
            arguments: arguments(),
            script: Mutex::new(VecDeque::new()),
        });
        let settings = kcoder_config::Settings {
            history_enabled: false,
            context_window_tokens: Some(1_000_000),
            context_output_headroom: Some(10_000),
            max_tokens: Some(1024),
            ..Default::default()
        };
        let engine = QueryEngine::try_new_for_client_with_services(
            provider.clone(),
            kcoder_state::AppState::new(&workspace),
            ToolRegistry::new(),
            kcoder_permissions::PermissionEngine::from_settings(&settings),
            settings,
            kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
            kcoder_skills::SkillRegistry::empty(),
            Arc::new(kcoder_tools::DenyAllUserQuestioner),
            workspace.clone(),
            Some(true),
            kcoder_engine::WorkspaceRuntimeServices::new(
                &workspace,
                "owned-deferred-office-acceptance",
            ),
        )
        .unwrap()
        .with_settings_persistence_path(profile.join("settings.json"))
        .with_client_presentation(Some(ClientPresentationV1 {
            version: 1,
            studio_work_mode: Some(StudioWorkMode::Kworker),
            inline_widgets: true,
            isolated_widgets: false,
        }));
        engine.settings.write().unwrap().integrations.office.enabled = true;
        let context = NativeIntegrationContext::capture(
            &profile,
            &workspace,
            "owned-deferred-office-acceptance",
            "config-r1",
        )
        .unwrap();
        let identity = TurnAttemptIdentity {
            thread_id: engine.session_id(),
            turn_id: "native-deferred-turn".into(),
            attempt_id: "native-deferred-attempt".into(),
        };
        TurnAttemptStore::open(
            &engine.session_storage_dir_for(&identity.thread_id),
            &identity.thread_id,
        )
        .unwrap()
        .begin(TurnAttemptRecord {
            client_presentation: None,
            version: 1,
            identity: identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "a".repeat(64),
            request_fingerprint: Some("b".repeat(64)),
            retained_input: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        })
        .unwrap();
        Self {
            _temp: temp,
            context,
            engine,
            identity,
            provider,
        }
    }
    fn paths(&self) -> NativeOfficeInstalledPaths {
        let node = std::env::var_os("KCODER_OFFICE_COMPONENT_TEST_NODE")
            .expect("explicit actual Node path");
        NativeOfficeInstalledPaths::from_native_installation(
            Path::new(&node),
            &kcoder_test_harness::workspace_root()
                .expect("resolve current workspace")
                .join("crates/kcoder_cli")
                .join("../../apps/kcoder-office-components"),
        )
        .unwrap()
    }
    fn providers(&self) -> NativeOfficeProviders {
        NativeOfficeProviders {
            tasks: Some(Arc::new(NativeOfficeAcceptedTurnAuthority)),
            ..Default::default()
        }
    }
    fn install(&self) -> QueryEngine {
        install_office_for_accepted_turn(
            &self.context,
            &self.identity,
            self.engine.clone(),
            self.paths(),
            self.providers(),
            "actual-deferred-office-source-r1".into(),
        )
        .unwrap()
    }
    fn composition(&self) -> NativeOfficeComposition {
        NativeOfficeComposition::observe(
            &self.context,
            &self.engine,
            self.paths(),
            self.providers(),
        )
        .unwrap()
        .unwrap()
    }
}
fn arguments() -> Value {
    json!({"specification":{"schemaVersion":1,"kind":"docx","title":"实际默认延迟生成与私有完整来源","paragraphs":(0..16).map(|index|json!({"text":format!("DEFERRED_CANONICAL_LITERAL_{index}:{}","private-original-source-".repeat(140))})).collect::<Vec<_>>()},"sourceRefs":[]})
}
struct DeferredProvider {
    requests: Mutex<Vec<MessagesRequest>>,
    phase: AtomicUsize,
    arguments: Value,
    script: Mutex<VecDeque<ContentBlock>>,
}
impl kcoder_api::Provider for DeferredProvider {
    fn name(&self) -> &'static str {
        "owned-real-deferred-office-recorder"
    }
    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let maintenance = is_session_memory_request(&request);
        self.requests.lock().unwrap().push(request);
        let phase = if maintenance {
            usize::MAX
        } else {
            self.phase.fetch_add(1, Ordering::SeqCst)
        };
        let response_text = if maintenance {
            kcoder_engine::context::DEFAULT_SESSION_MEMORY_TEMPLATE.replace(
                "_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_",
                "Owned Office artifact and canonical source acceptance",
            )
        } else {
            "Actual immutable source and artifact were recorded; no reader claim.".into()
        };
        let scripted = if maintenance {
            None
        } else {
            self.script.lock().unwrap().pop_front()
        };
        let block = scripted.unwrap_or_else(|| match phase {
            0 => ContentBlock::ToolUse {
                id: "native-discover-office".into(),
                name: "tool_search".into(),
                input: json!({"query":"OfficeDocument","limit":1}),
            },
            1 => ContentBlock::ToolUse {
                id: "native-execute-office".into(),
                name: "tool_execute".into(),
                input: json!({"tool_name":"OfficeDocument","arguments":self.arguments}),
            },
            _ => ContentBlock::Text {
                text: String::new(),
            },
        });
        let invokes_tool = matches!(&block, ContentBlock::ToolUse { .. });
        Ok(Box::pin(async_stream::stream! {
            yield Ok(StreamEvent::MessageStart { message: kcoder_types::StreamingMessage {
                id: format!("owned-response-{phase}"), role: "assistant".into(), content: vec![],
                model: "deterministic-fixture".into(), stop_reason: None, stop_sequence: None, usage: None,
            }});
            yield Ok(StreamEvent::ContentBlockStart{index:0,content_block:block});
            if !invokes_tool {
                yield Ok(StreamEvent::ContentBlockDelta { index: 0, delta: kcoder_types::ContentDelta::TextDelta {
                    text: response_text,
                }});
            }
            yield Ok(StreamEvent::ContentBlockStop{index:0});
            yield Ok(StreamEvent::MessageDelta{delta:kcoder_types::MessageDeltaFields{stop_reason:Some(if invokes_tool{"tool_use"}else{"end_turn"}.into()),stop_sequence:None,usage:None}});
            yield Ok(StreamEvent::MessageStop);
        }))
    }
}
fn wrapped_input(messages: &SharedMessages) -> Option<Value> {
    messages.iter().find_map(|message| match message {
        Message::Assistant { content, .. } => content.iter().find_map(|block| match block {
            ContentBlock::ToolUse { id, name, input }
                if id == "native-execute-office" && name == "tool_execute" =>
            {
                Some(input.clone())
            }
            _ => None,
        }),
        _ => None,
    })
}
fn edit_wrapper(
    messages: &SharedMessages,
    edit: impl Fn(&mut String, &mut Value),
) -> SharedMessages {
    let mut messages = messages.to_vec();
    let mut renamed = Vec::new();
    for message in &mut messages {
        if let Message::Assistant { content, .. } = message {
            for block in content {
                if let ContentBlock::ToolUse { id, name, input } = block
                    && name == "tool_execute"
                {
                    let original = id.clone();
                    edit(id, input);
                    if original != *id {
                        renamed.push((original, id.clone()));
                    }
                }
            }
        }
    }
    for message in &mut messages {
        if let Message::User { content, .. } = message {
            for block in content {
                if let ContentBlock::ToolResult { tool_use_id, .. } = block
                    && let Some((_, new)) = renamed.iter().find(|(old, _)| old == tool_use_id)
                {
                    *tool_use_id = new.clone();
                }
            }
        }
    }
    SharedMessages::from(messages)
}
async fn one_request(engine: &QueryEngine) {
    let events = engine
        .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
        .collect::<Vec<_>>()
        .await;
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, kcoder_engine::EngineEvent::Error(_))),
        "{events:?}"
    );
}

#[tokio::test]
#[ignore = "Requires explicit actual Node; selected by owned native default-deferred acceptance"]
async fn actual_default_search_execute_node_generation_projects_wrapper_and_keeps_history_and_prefix()
-> Result<()> {
    let fixture = Fixture::new();
    let engine = fixture.install();
    assert!(
        engine
            .active_tool_registry()
            .get("OfficeDocument")
            .is_none()
    );
    assert!(engine.active_tool_registry().get("tool_search").is_some());
    assert!(engine.active_tool_registry().get("tool_execute").is_some());
    let events = engine
        .submit_message_stream(
            "Create the requested DOCX using its actual Office capability",
            &kcoder_permissions::AutoAllowPrompt,
        )
        .collect::<Vec<_>>()
        .await;
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, kcoder_engine::EngineEvent::Error(_))),
        "{events:?}"
    );
    let memory_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while engine.state.session_memory().is_none() {
        assert!(
            tokio::time::Instant::now() < memory_deadline,
            "owned background session-memory update did not settle"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let composition = fixture.composition();
    let manifests = composition
        .service()
        .store
        .list_artifacts(&fixture.identity.thread_id)?;
    assert_eq!(manifests.len(), 1, "{events:?}");
    let manifest = &manifests[0];
    assert_eq!(manifest.format, OfficeFileFormat::Docx);
    let reference = OfficeArtifactRef {
        id: manifest.id.clone(),
        revision: manifest.revision,
    };
    let (bytes, total) =
        composition
            .service()
            .store
            .read_artifact_chunk(&reference, 0, 512 * 1024)?;
    assert_eq!(&bytes[..2], b"PK");
    assert_eq!(total, manifest.bytes);
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), manifest.sha256);
    let history = engine.state.shared_messages_with_revision().0;
    assert_eq!(
        wrapped_input(&history).unwrap(),
        json!({"tool_name":"OfficeDocument","arguments":fixture.provider.arguments})
    );
    one_request(&engine).await;
    assert_eq!(
        wrapped_input(&engine.state.shared_messages_with_revision().0),
        wrapped_input(&history)
    );
    {
        let requests = fixture.provider.requests.lock().unwrap();
        capture_requests("first-repeat", &requests)?;
        let summary: Vec<_> = requests.iter().map(|request| json!({
            "model":request.model,"messages":request.messages.len(),"systemSha256":format!("{:x}",Sha256::digest(request.system.as_deref().unwrap_or("").as_bytes())),
            "wrapperBytes":wrapped_input(&request.messages).map(|input|serde_json::to_vec(&input).unwrap().len()),
            "last":request.messages.last().map(|message|match message{Message::User{content,..}|Message::Assistant{content,..}=>content.iter().filter_map(|block|match block{ContentBlock::Text{text}=>Some(text.chars().take(80).collect::<String>()),_=>None}).collect::<Vec<_>>()})
        })).collect();
        let main: Vec<_> = requests
            .iter()
            .filter(|request| !is_session_memory_request(request))
            .collect();
        assert_eq!(main.len(), 4, "{summary:?}");
        assert!(
            requests.iter().any(is_session_memory_request),
            "real background maintenance must be exercised"
        );
        for request in requests.iter() {
            assert!(
                !serde_json::to_string(request)?.contains("DEFERRED_CANONICAL_LITERAL"),
                "a valid canonical source must not be repeated in any actual Provider request"
            );
        }
        for request in &main[2..] {
            let input = wrapped_input(&request.messages).unwrap();
            assert_eq!(input["tool_name"], "OfficeDocument");
            assert!(
                input["arguments"]
                    .get("_storedOfficeGenerationSource")
                    .is_some()
            );
            assert!(serde_json::to_vec(&input)?.len() <= 4096);
            assert!(!serde_json::to_string(request)?.contains("DEFERRED_CANONICAL_LITERAL"));
        }
        for request in &main[1..] {
            assert_eq!(request.system, main[0].system);
            assert_eq!(
                serde_json::to_value(&request.tools)?,
                serde_json::to_value(&main[0].tools)?
            );
        }
    }
    let read =
        composition
            .service()
            .store
            .read_canonical_source(&reference, None, 0, 64 * 1024, true)?;
    let descriptor = read.source.unwrap();
    let source = composition.service().store.read_canonical_source(
        &reference,
        Some(&descriptor.specification_sha256),
        0,
        64 * 1024,
        false,
    )?;
    assert!(source.complete);
    let canonical: Value = serde_json::from_str(source.chunk.as_deref().unwrap())?;
    assert_eq!(
        canonical["paragraphs"],
        fixture.provider.arguments["specification"]["paragraphs"]
    );
    // A guessed call or altered arguments cannot borrow the genuine private receipt.
    for changed in [
        edit_wrapper(&history, |id, _| *id = "no-native-receipt".into()),
        edit_wrapper(&history, |_, input| {
            input["arguments"]["specification"]["title"] = json!("changed historical arguments")
        }),
        edit_wrapper(&history, |_, input| {
            input["authority"] = json!("untrusted-extra-field")
        }),
    ] {
        engine.state.set_messages(changed.to_vec());
        let before = fixture.provider.requests.lock().unwrap().len();
        one_request(&engine).await;
        let requests = fixture.provider.requests.lock().unwrap();
        assert_eq!(requests.len(), before + 1);
        let input = requests
            .last()
            .unwrap()
            .messages
            .iter()
            .find_map(|message| match message {
                Message::Assistant { content, .. } => {
                    content.iter().find_map(|block| match block {
                        ContentBlock::ToolUse { name, input, .. } if name == "tool_execute" => {
                            Some(input)
                        }
                        _ => None,
                    })
                }
                _ => None,
            })
            .unwrap();
        assert!(
            input["arguments"]
                .get("_storedOfficeGenerationSource")
                .is_none()
        );
        assert!(serde_json::to_string(input)?.contains("DEFERRED_CANONICAL_LITERAL"));
    }
    // The untouched resident baseline has no Native projection authority.
    fixture.engine.state.set_messages(history.to_vec());
    one_request(&fixture.engine).await;
    assert_eq!(
        wrapped_input(
            &fixture
                .provider
                .requests
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .messages
        )
        .unwrap()["arguments"],
        fixture.provider.arguments
    );
    // Real feature revocation fails before another Provider sees the old source.
    engine.state.set_messages(history.to_vec());
    engine.settings.write().unwrap().integrations.office.enabled = false;
    let before = fixture.provider.requests.lock().unwrap().len();
    let events = engine
        .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
        .collect::<Vec<_>>()
        .await;
    assert!(events.iter().any(|event|matches!(event,kcoder_engine::EngineEvent::Error(code)if code=="NATIVE_OFFICE_PROJECTION_UNAVAILABLE")));
    assert_eq!(fixture.provider.requests.lock().unwrap().len(), before);
    assert_eq!(
        wrapped_input(&engine.state.shared_messages_with_revision().0),
        wrapped_input(&history)
    );
    capture_requests("all-validation", &fixture.provider.requests.lock().unwrap())?;
    // Supplying a cancellation token already revoked remains an actual zero-Provider boundary.
    let token = CancellationToken::new();
    token.cancel();
    let before = fixture.provider.requests.lock().unwrap().len();
    let _ = engine
        .run_turn_stream_with_cancel(&kcoder_permissions::AutoAllowPrompt, token)
        .collect::<Vec<_>>()
        .await;
    assert_eq!(fixture.provider.requests.lock().unwrap().len(), before);
    Ok(())
}

fn capture_requests(stage: &str, requests: &[MessagesRequest]) -> Result<()> {
    let Some(directory) = std::env::var_os("KCODER_OFFICE_DEFERRED_CAPTURE_DIR") else {
        return Ok(());
    };
    let directory = PrivateDirectory::open_existing(Path::new(&directory))?;
    let bytes = serde_json::to_vec_pretty(&json!({
        "evidenceKind":"deterministic Provider over actual Native Engine/Office/Node; not a paid model or cache-hit metric",
        "requests":requests,
    }))?;
    directory.atomic_replace(
        OsStr::new(&format!("{stage}-provider-requests.json")),
        &bytes,
    )
}

fn is_session_memory_request(request: &MessagesRequest) -> bool {
    request.system.is_none() && request.messages.iter().any(|message|match message {
        Message::User { content, .. }=>content.iter().any(|block|matches!(block,ContentBlock::Text{text}if text.starts_with("CRITICAL: This is an internal session-memory maintenance task"))),
        _=>false,
    })
}

#[path = "canonical_reader_tests.rs"]
mod canonical_reader_tests;

#[path = "request_lifecycle_tests.rs"]
mod request_lifecycle_tests;
