//! Real Engine, builtin file tools, private workflow store and native launch.
//! The deterministic Provider selects tools; it does not prove model quality.
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_config::{PrivateDirectory, Settings};
use kcoder_engine::QueryEngine;
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_permissions::PermissionEngine;
use kcoder_skills::SkillRegistry;
use kcoder_state::{AppState, TaskStatus};
use kcoder_tools::{
    DenyAllUserQuestioner, FileReadTool, FileWriteTool, Tool, ToolContext, ToolError, ToolOutput,
    ToolRegistry,
    workflow::{WorkflowNativeLaunch, WorkflowNativeLaunchObserver, WorkflowTool},
};
use kcoder_types::{
    ContentBlock, ContentDelta, MessageDeltaFields, MessagesRequest, StreamEvent, StreamingMessage,
    workflow::*,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

struct PhysicalReadGate {
    enabled: AtomicBool,
    revoked: AtomicBool,
    entered: AtomicUsize,
    release: tokio::sync::Semaphore,
}
impl Default for PhysicalReadGate {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            revoked: AtomicBool::new(false),
            entered: AtomicUsize::new(0),
            release: tokio::sync::Semaphore::new(0),
        }
    }
}
struct GatedNativeRead(Arc<PhysicalReadGate>);
#[async_trait::async_trait]
impl Tool for GatedNativeRead {
    fn name(&self) -> String {
        FileReadTool.name()
    }
    fn description(&self) -> String {
        FileReadTool.description()
    }
    fn input_schema(&self) -> Value {
        FileReadTool.input_schema()
    }
    fn is_read_only(&self) -> bool {
        true
    }
    fn is_concurrency_safe(&self, input: &Value) -> bool {
        FileReadTool.is_concurrency_safe(input)
    }
    async fn call(&self, input: Value, context: &ToolContext) -> Result<ToolOutput, ToolError> {
        if self.0.enabled.load(Ordering::SeqCst) {
            self.0.entered.fetch_add(1, Ordering::SeqCst);
            let permit = tokio::select! {
                _ = context.cancelled() => return Err(ToolError::Aborted),
                permit = self.0.release.acquire() => permit.map_err(|_|ToolError::Aborted)?,
            };
            drop(permit);
            if self.0.revoked.load(Ordering::SeqCst) {
                return Err(ToolError::Execution(
                    "owned native read permission revoked".into(),
                ));
            }
        }
        FileReadTool.call(input, context).await
    }
}
#[derive(Clone)]
struct FixedProvider {
    calls: Arc<AtomicUsize>,
    stages: Arc<Mutex<BTreeMap<String, usize>>>,
    omit_write: bool,
}
fn events(tool: Option<(&str, Value)>) -> Vec<StreamEvent> {
    let mut values = vec![StreamEvent::MessageStart {
        message: StreamingMessage {
            id: uuid::Uuid::new_v4().to_string(),
            role: "assistant".into(),
            content: vec![],
            model: "owned-role-model".into(),
            stop_reason: None,
            stop_sequence: None,
            usage: None,
        },
    }];
    if let Some((name, input)) = tool {
        values.push(StreamEvent::ContentBlockStart {
            index: 0,
            content_block: ContentBlock::ToolUse {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.into(),
                input: json!({}),
            },
        });
        values.push(StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::InputJsonDelta {
                partial_json: input.to_string(),
            },
        });
        values.push(StreamEvent::ContentBlockStop { index: 0 });
        values.push(StreamEvent::MessageDelta {
            delta: MessageDeltaFields {
                stop_reason: Some("tool_use".into()),
                stop_sequence: None,
                usage: None,
            },
        });
    } else {
        values.push(StreamEvent::ContentBlockStart {
            index: 0,
            content_block: ContentBlock::Text {
                text: String::new(),
            },
        });
        values.push(StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::TextDelta {
                text: "{\"ok\":true}".into(),
            },
        });
        values.push(StreamEvent::ContentBlockStop { index: 0 });
        values.push(StreamEvent::MessageDelta {
            delta: MessageDeltaFields {
                stop_reason: Some("end_turn".into()),
                stop_sequence: None,
                usage: None,
            },
        });
    }
    values.push(StreamEvent::MessageStop);
    values
}
impl Provider for FixedProvider {
    fn name(&self) -> &'static str {
        "owned-collaboration-fixture"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let text = request
            .messages
            .iter()
            .map(|message| message.preview(128 * 1024))
            .collect::<Vec<_>>()
            .join("\n");
        let member = ["reader_a", "reader_b", "writer_a", "writer_b", "verify"]
            .into_iter()
            .find(|name| text.contains(&format!("member {name}")))
            .expect("original role instruction");
        // debug_session_id groups child diagnostics under their parent. It is
        // deliberately not used as an actor or per-child execution identity.
        let turn = {
            let mut stages = self.stages.lock().unwrap();
            let stage = stages.entry(member.into()).or_default();
            let value = *stage;
            *stage += 1;
            value
        };
        let writer = text.contains("member writer_a") || text.contains("member writer_b");
        if writer && turn > 0 {
            for message in request.messages.iter() {
                if let kcoder_types::Message::User { content, .. } = message {
                    for block in content {
                        if let ContentBlock::ToolResult { content, .. } = block {
                            eprintln!("owned {member} tool response: {content:?}");
                        }
                    }
                }
            }
        }
        let tool = if writer
            && !self.omit_write
            && ((member == "writer_a" && turn == 0) || (member == "writer_b" && turn == 1))
        {
            Some((
                "write",
                json!({"file_path":"report.txt","content":if member == "writer_a" {"first actual output"}else{"final actual output"}}),
            ))
        } else if turn == 0 && !(writer && self.omit_write) {
            Some((
                "read",
                json!({"file_path":if member == "writer_b" || member == "verify" {"report.txt"}else{"input.txt"},"format":"raw"}),
            ))
        } else {
            None
        };
        if let Some((name, _)) = &tool {
            assert!(
                request.tools.iter().any(|tool| tool.name == *name),
                "the actual role registry must include its requested tool"
            );
        }
        Ok(Box::pin(futures::stream::iter(
            events(tool).into_iter().map(Ok),
        )))
    }
}
struct NativeFixtureFactory {
    settings: Settings,
    provider: Arc<dyn Provider>,
}
impl kcoder_engine::ClientModelConfiguration for NativeFixtureFactory {
    fn settings(&self, _: &str) -> anyhow::Result<Settings> {
        Ok(self.settings.clone())
    }
    fn provider(&self, _: &Settings) -> anyhow::Result<Arc<dyn Provider>> {
        Ok(self.provider.clone())
    }
}
#[derive(Default)]
struct Launch(Mutex<Vec<WorkflowNativeLaunch>>);
impl WorkflowNativeLaunchObserver for Launch {
    fn before_dispatch(
        &self,
        launch: &WorkflowNativeLaunch,
    ) -> Result<(), kcoder_tools::ToolError> {
        self.0.lock().unwrap().push(launch.clone());
        Ok(())
    }
}
fn plan() -> WorkflowCollaborationPlan {
    let member = |id: &str, role: WorkflowCollaborationRole, depends: Vec<String>| {
        WorkflowCollaborationMember {
            id: id.into(),
            title: id.into(),
            role,
            instructions: format!(
                "Execute original member {id}. Use the original builtin tools before reporting."
            ),
            model_selection: WorkflowAgentModelSelection::InheritCurrent,
            input_bindings: [("brief".into(), "/input/brief".into())].into(),
            depends_on: depends,
            allowed_write_paths: if role.is_writer() {
                vec!["report.txt".into()]
            } else {
                vec![]
            },
            acceptance_criteria: vec!["Actual declared file actions and checks succeed".into()],
            artifact_requirements: if role.is_writer() {
                vec![WorkflowArtifactRequirement {
                    path: "report.txt".into(),
                    min_bytes: 1,
                    required: true,
                    unique_content: true,
                    require_changed: true,
                    forbidden_literals: vec!["PLACEHOLDER".into()],
                }]
            } else {
                vec![]
            },
            output_schema: json!({"type":"object","properties":{"ok":{"const":true}},"required":["ok"],"additionalProperties":false}),
            result_check: WorkflowCodeConfig {
                source: "return result.ok === true;".into(),
                timeout_ms: 1000,
            },
            max_turns: 3,
        }
    };
    WorkflowCollaborationPlan {
        version: 1,
        input_schema: json!({"type":"object","properties":{"brief":{"type":"string"}},"required":["brief"]}),
        members: vec![
            member(
                "writer_b",
                WorkflowCollaborationRole::Writer,
                vec!["writer_a".into()],
            ),
            member("reader_a", WorkflowCollaborationRole::Researcher, vec![]),
            member("reader_b", WorkflowCollaborationRole::Researcher, vec![]),
            member(
                "writer_a",
                WorkflowCollaborationRole::Writer,
                vec!["reader_a".into(), "reader_b".into()],
            ),
            member(
                "verify",
                WorkflowCollaborationRole::Verifier,
                vec!["writer_b".into()],
            ),
        ],
    }
}
/// Fresh installations ship no Provider. Apply this fixture's explicit
/// Provider profile without inheriting model variants.
fn settings_with_declared_provider() -> Settings {
    let mut settings = Settings::default();
    let mut provider = kcoder_config::default_active_provider_config();
    provider.models.clear();
    settings
        .providers
        .insert("collaboration-fixture".to_string(), provider);
    settings.active_provider = Some("collaboration-fixture".to_string());
    settings
        .apply_provider(None)
        .expect("fixture Provider profile must apply");
    settings
}

#[tokio::test]
async fn fixed_native_workflow_uses_real_roles_file_tools_and_machine_artifact_checks() {
    for (omit_write, bad_verifier) in [(false, false), (true, false), (false, true)] {
        let temp = tempfile::tempdir().unwrap();
        let root = PrivateDirectory::open_existing(temp.path()).unwrap();
        let workspace = root.create_private_child(OsStr::new("workspace")).unwrap();
        workspace
            .atomic_replace(OsStr::new("input.txt"), b"original input evidence")
            .unwrap();
        let profile = root.create_private_child(OsStr::new("profile")).unwrap();
        let settings = Settings {
            training_mode: true,
            permission_mode: kcoder_config::PermissionMode::Auto,
            allowed_tools: vec!["read".into(), "write".into(), "Workflow".into()],
            model: "owned-role-model".into(),
            max_tokens: Some(1024),
            ..settings_with_declared_provider()
        };
        profile
            .atomic_replace(
                OsStr::new("settings.json"),
                &serde_json::to_vec(&settings).unwrap(),
            )
            .unwrap();
        let cwd = temp.path().join("workspace");
        let profile_path = temp.path().join("profile");
        let calls = Arc::new(AtomicUsize::new(0));
        let provider: Arc<dyn Provider> = Arc::new(FixedProvider {
            calls: calls.clone(),
            stages: Arc::new(Mutex::new(BTreeMap::new())),
            omit_write,
        });
        let factory = Arc::new(NativeFixtureFactory {
            settings: settings.clone(),
            provider: provider.clone(),
        });
        let physical_gate = Arc::new(PhysicalReadGate::default());
        let engine = QueryEngine::new(
            provider,
            AppState::new(&cwd),
            ToolRegistry::new()
                .register(GatedNativeRead(physical_gate.clone()))
                .register(FileWriteTool)
                .register(WorkflowTool),
            PermissionEngine::from_settings(&settings),
            settings,
            MemoryManager::global_only(MemoryStore::empty()),
            SkillRegistry::load_project_only(&cwd).unwrap(),
            Arc::new(DenyAllUserQuestioner),
            cwd.clone(),
        )
        .with_settings_persistence_path(profile_path.join("settings.json"))
        .with_client_model_configuration(factory);
        let library =
            kcoder_workflow::store::WorkflowStore::new(profile_path.join("workflow-library"));
        let draft = library
            .create("Actual original roles", "Owned fixed-version acceptance")
            .unwrap();
        let mut requested_plan = plan();
        if bad_verifier {
            requested_plan
                .members
                .iter_mut()
                .find(|member| member.role == WorkflowCollaborationRole::Verifier)
                .unwrap()
                .model_selection = WorkflowAgentModelSelection::Explicit {
                profile: None,
                provider: Some("collaboration-fixture".into()),
                model: "different-owned-model".into(),
                expected_revision: None,
            };
        }
        let applied = library
            .initialize_collaboration(&draft.id, draft.revision, &requested_plan, |_| Ok(()))
            .unwrap();
        let mut independent_readers = applied.nodes.clone();
        for member in independent_readers.iter_mut().filter(|node| {
            node.config
                .collaboration_role
                .as_ref()
                .is_some_and(|role| role.role == WorkflowCollaborationRole::Researcher)
        }) {
            member.depends_on.retain(|id| id != "collaboration_input");
        }
        let applied = library
            .patch_nodes(&draft.id, applied.revision, independent_readers, vec![])
            .unwrap();
        let saved = library.save(&draft.id, applied.revision).unwrap();
        let launch = Arc::new(Launch::default());
        let output=engine.start_workflow_with_native_observer(json!({"definition_id":saved.id,"version":1,"args":{"brief":"Use the declared original input and produce the final report"},"timeout_seconds":15,"max_concurrency":4}),launch.clone()).await.unwrap();
        let value: Value = serde_json::from_str(
            &output
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>(),
        )
        .unwrap();
        let run = value["run_id"].as_str().unwrap();
        let final_task = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if let Some(task) = engine.state.task(run)
                    && matches!(
                        task.status,
                        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
                    )
                {
                    break task;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(launch.0.lock().unwrap().len(), 1);
        assert_eq!(launch.0.lock().unwrap()[0].definition_id, saved.id);
        assert_eq!(launch.0.lock().unwrap()[0].version, 1);
        if final_task.status != TaskStatus::Completed && !omit_write && !bad_verifier {
            eprintln!(
                "native children: {:?}",
                engine
                    .state
                    .tasks()
                    .values()
                    .filter(|task| task.kind == kcoder_state::TaskKind::Subagent)
                    .map(|task| (
                        &task.id,
                        &task.status,
                        task.artifact_requirements.len(),
                        &task.artifact_validation_report
                    ))
                    .collect::<Vec<_>>()
            );
        }
        assert_eq!(
            final_task.status == TaskStatus::Completed,
            !omit_write && !bad_verifier,
            "{final_task:?}"
        );
        if !omit_write && !bad_verifier {
            let source_directory = std::path::Path::new(value["state_file"].as_str().unwrap())
                .parent()
                .unwrap();
            assert!(source_directory.starts_with(&cwd));
            let original_evidence =
                std::fs::read(source_directory.join("collaboration-artifacts-v1.json")).unwrap();
            let original_calls = calls.load(Ordering::SeqCst);
            for mutation in ["unchanged", "changed", "missing", "revoked"] {
                physical_gate.enabled.store(true, Ordering::SeqCst);
                physical_gate
                    .revoked
                    .store(mutation == "revoked", Ordering::SeqCst);
                let before_read = physical_gate.entered.load(Ordering::SeqCst);
                // Earlier released runs do not leave permits for this gate.
                while let Ok(permit) = physical_gate.release.try_acquire() {
                    permit.forget();
                }

                if mutation == "changed" {
                    std::fs::write(cwd.join("report.txt"), "externally changed final bytes")
                        .unwrap();
                }
                if mutation == "missing" {
                    std::fs::write(cwd.join("report.txt"), "final actual output").unwrap();
                    std::fs::rename(
                        cwd.join("report.txt"),
                        cwd.join("retained-original-report.txt"),
                    )
                    .unwrap();
                }
                let resumed = engine.start_workflow_with_native_observer(json!({"definition_id":saved.id,"version":1,"args":{"brief":"Use the declared original input and produce the final report"},"reuse_from_run":run,"timeout_seconds":15,"max_concurrency":4}),launch.clone()).await.unwrap();
                let resumed: Value = serde_json::from_str(
                    &resumed
                        .content
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<String>(),
                )
                .unwrap();
                let recovered_id = resumed["run_id"].as_str().unwrap();
                tokio::time::timeout(Duration::from_secs(5), async {
                    while physical_gate.entered.load(Ordering::SeqCst) == before_read {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
                tokio::time::sleep(Duration::from_millis(50)).await;
                assert_eq!(
                    engine.state.task(recovered_id).unwrap().status,
                    TaskStatus::Running,
                    "parallel roots must await the physical initializer: {mutation}"
                );
                assert_eq!(
                    calls.load(Ordering::SeqCst),
                    original_calls,
                    "no parallel root may start a model/write while initialization is gated"
                );
                physical_gate.release.add_permits(1);

                let recovered = tokio::time::timeout(Duration::from_secs(20), async {
                    loop {
                        if let Some(task) = engine.state.task(recovered_id)
                            && matches!(
                                task.status,
                                TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
                            )
                        {
                            break task;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .unwrap();
                assert_eq!(
                    recovered.status == TaskStatus::Completed,
                    mutation == "unchanged",
                    "{mutation}: {:?}",
                    recovered.output
                );
                assert_eq!(
                    calls.load(Ordering::SeqCst),
                    original_calls,
                    "completed writes must never replay during {mutation}"
                );
                assert_eq!(
                    std::fs::read(source_directory.join("collaboration-artifacts-v1.json"))
                        .unwrap(),
                    original_evidence,
                    "original write receipts remain unchanged"
                );
                assert_eq!(
                    engine.state.task(run).unwrap().status,
                    TaskStatus::Completed
                );
                if mutation == "changed" {
                    assert_eq!(
                        std::fs::read_to_string(cwd.join("report.txt")).unwrap(),
                        "externally changed final bytes"
                    );
                }
                if mutation == "missing" {
                    assert!(!cwd.join("report.txt").exists());
                    // Restore only this owned fixture after proving no product replay.
                    std::fs::rename(
                        cwd.join("retained-original-report.txt"),
                        cwd.join("report.txt"),
                    )
                    .unwrap();
                }
            }
            physical_gate.enabled.store(false, Ordering::SeqCst);
        }
        if bad_verifier {
            assert!(
                final_task
                    .output
                    .as_deref()
                    .unwrap_or_default()
                    .contains("verifier must retain"),
                "{final_task:?}"
            );
        }
        if !omit_write {
            assert_eq!(
                std::fs::read_to_string(cwd.join("report.txt")).unwrap(),
                "final actual output"
            );
            assert!(calls.load(Ordering::SeqCst) >= if bad_verifier { 9 } else { 10 });
        } else {
            assert!(!cwd.join("report.txt").exists());
        }
    }
}

#[path = "collaboration_native/recovery.rs"]
mod recovery;
