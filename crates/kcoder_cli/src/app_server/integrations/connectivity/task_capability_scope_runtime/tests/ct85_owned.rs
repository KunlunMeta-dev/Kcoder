//! Actual resident/source ownership through the app-server turn dispatcher.
use super::*;
use crate::app_server::ct85_test_support;
use sha2::{Digest, Sha256};

fn owned_tree_snapshot(path: &std::path::Path) -> Result<Vec<(String, String)>> {
    let config = std::path::PathBuf::from(
        std::env::var_os("KCODER_CONFIG_DIR").context("owned profile missing")?,
    );
    let owned = config
        .parent()
        .context("owned root missing")?
        .canonicalize()?;
    let root = path.canonicalize()?;
    ensure!(root.starts_with(&owned), "snapshot outside owned test root");
    let mut entries = Vec::new();
    for entry in walkdir::WalkDir::new(&root).follow_links(false) {
        let entry = entry?;
        let relative = entry
            .path()
            .strip_prefix(&root)?
            .to_string_lossy()
            .into_owned();
        let value = if entry.file_type().is_dir() {
            "directory".to_owned()
        } else if entry.file_type().is_file() {
            format!("file:{:x}", Sha256::digest(std::fs::read(entry.path())?))
        } else if entry.file_type().is_symlink() {
            format!(
                "symlink:{}",
                std::fs::read_link(entry.path())?.to_string_lossy()
            )
        } else {
            anyhow::bail!("unexpected owned test entry");
        };
        entries.push((relative, value));
    }
    entries.sort();
    Ok(entries)
}

#[test]
fn source_owned_turn_cannot_be_relabelled_after_reconnect() {
    ct85_test_support::run_owned_case(
        concat!(module_path!(), "::owned_dispatch"),
        "source-owned-reconnect",
    );
}

#[test]
fn source_owned_history_cannot_be_durably_forked_without_original_authority() {
    ct85_test_support::run_owned_case(
        concat!(module_path!(), "::owned_dispatch"),
        "source-owned-fork-durable",
    );
}

#[test]
fn source_owned_history_cannot_be_ephemerally_forked_without_original_authority() {
    ct85_test_support::run_owned_case(
        concat!(module_path!(), "::owned_dispatch"),
        "source-owned-fork-ephemeral",
    );
}

#[test]
fn ordinary_turn_works_with_integrations_disabled() {
    ct85_test_support::run_owned_case(
        concat!(module_path!(), "::owned_dispatch"),
        "ordinary-foreground",
    );
}

#[test]
fn native_configuration_rejects_different_state_with_same_session_id() {
    ct85_test_support::run_owned_case(
        concat!(module_path!(), "::owned_dispatch"),
        "same-session-state-replacement",
    );
}

#[test]
fn newly_created_native_resident_is_not_public_before_source_configuration() {
    ct85_test_support::run_owned_case(
        concat!(module_path!(), "::owned_dispatch"),
        "native-created-exposure",
    );
}

#[test]
fn revoked_source_error_does_not_expose_private_authority_details() {
    ct85_test_support::run_owned_case(
        concat!(module_path!(), "::owned_dispatch"),
        "source-private-error",
    );
}

#[test]
fn active_native_turn_rejects_concurrent_public_turn_and_forks() {
    ct85_test_support::run_owned_case(
        concat!(module_path!(), "::owned_dispatch"),
        "source-concurrent-turn-forks",
    );
}

#[test]
fn source_revoked_while_waiting_for_activity_gate_is_not_accepted() {
    ct85_test_support::run_owned_case(
        concat!(module_path!(), "::owned_dispatch"),
        "source-revoked-at-gate",
    );
}

#[test]
#[ignore = "run only as the owned subprocess of a CT-85 test"]
fn owned_dispatch() {
    match ct85_test_support::owned_case().as_str() {
        "source-owned-reconnect" => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(run_original_runtime_mode(
                false,
                false,
                false,
                None,
                true,
                false,
                Some(Ct85Case::Relabel),
            ))
            .unwrap(),
        "source-owned-fork-durable" | "source-owned-fork-ephemeral" => {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(run_original_runtime_mode(
                    false,
                    false,
                    false,
                    None,
                    true,
                    false,
                    Some(Ct85Case::Fork(
                        ct85_test_support::owned_case() == "source-owned-fork-ephemeral",
                    )),
                ))
                .unwrap()
        }
        "ordinary-foreground" => ordinary_foreground(),
        "same-session-state-replacement" => reject_same_session_state_replacement(),
        "native-created-exposure" => native_created_exposure(),
        "source-private-error" => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(run_original_runtime_mode(
                false,
                true,
                false,
                None,
                true,
                false,
                Some(Ct85Case::SensitiveError),
            ))
            .unwrap(),
        "source-concurrent-turn-forks" => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(run_original_runtime_mode(
                false,
                false,
                false,
                None,
                true,
                false,
                Some(Ct85Case::Concurrent),
            ))
            .unwrap(),
        "source-revoked-at-gate" => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(run_original_runtime_mode(
                false,
                false,
                false,
                None,
                true,
                false,
                Some(Ct85Case::GateRevocation),
            ))
            .unwrap(),
        _ => panic!("unknown CT-85 owned case"),
    }
}

struct ReplaceOriginalState;
impl NativeRuntimePolicyInstaller for ReplaceOriginalState {
    fn install(
        &self,
        _: &NativeIntegrationContext,
        _: &IntegrationRequest,
        _: &PreparedRuntimeTask,
        mut engine: QueryEngine,
    ) -> Result<QueryEngine> {
        let original = engine.state.clone();
        let reopened = kcoder_state::AppState::new(original.cwd());
        reopened
            .resume_from_history(&original.history_path().context("original history absent")?)?;
        ensure!(
            reopened.session_id() == original.session_id(),
            "fixture session differs"
        );
        ensure!(
            !reopened.shares_state_with(&original),
            "fixture reused original State"
        );
        engine.state = reopened;
        Ok(engine)
    }
}

fn reject_same_session_state_replacement() {
    let fixture =
        crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
    ct85_test_support::prepare_workspace(&fixture.workspace);
    let settings = kcoder_config::Settings {
        history_enabled: false,
        permission_mode: kcoder_config::PermissionMode::Bypass,
        max_retries: 0,
        ..crate::test_fixtures::settings_with_default_provider()
    };
    let requests = Arc::new(StdMutex::new(Vec::new()));
    let owner = Arc::new(kcoder_config::create_private_temp_dir("ct85-owner").unwrap());
    let services = kcoder_engine::WorkspaceRuntimeServices::new(&fixture.workspace, "ct85-owner")
        .with_private_client_storage(owner);
    let factory = AppServerEngineFactory::new(
        Arc::new(ForegroundProvider {
            requests: requests.clone(),
        }),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        fixture.workspace.clone(),
        None,
        true,
        services,
        None,
        fixture.profile.join("short-ids"),
    );
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let engine =
                factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
            let thread = engine.session_id();
            engine
                .state
                .with_history_path(fixture.profile.join(format!("{thread}.jsonl")));
            engine
                .state
                .add_message(kcoder_types::Message::user_text("original session"));
            engine.state.save_history()?;
            let lease = SessionLease::acquire(&engine.session_lease_target())?;
            let (outbound, _notifications) = mpsc::channel(256);
            let sequence = Arc::new(AtomicU64::new(1));
            let turn_state = ResidentTurnState::new(
                outbound.clone(),
                kcoder_config::PermissionMode::Bypass,
                Arc::new(AtomicU64::new(2_000_000)),
                Arc::new(StdMutex::new(InteractionReceipts::default())),
            );
            let resident = build_resident_thread_runtime(
                engine.clone(),
                lease,
                0,
                turn_state,
                outbound,
                "ct85-replacement".into(),
                sequence,
            );
            let mut manager = ThreadManager::default();
            assert!(manager.insert(resident).is_ok());
            let mut driver = fixture.driver();
            let mut spec = fixture.spec();
            spec.existing_thread_id = Some(thread.clone());
            spec.configuration.model.model = engine.active_model_configuration_summary()?;
            driver.accept_task(&fixture.context, &fixture.request("ct85-swap"), spec)?;
            let configure = driver
                .next_command(&fixture.context)?
                .context("configure missing")?;
            let error = driver
                .configure_command(
                    &fixture.context,
                    &configure.ticket().clone(),
                    &mut manager,
                    Some(&ReplaceOriginalState),
                )
                .expect_err("a distinct same-ID State must not replace the resident");
            assert_eq!(error.to_string(), "RUNTIME_CANDIDATE_OWNER_MISMATCH");
            let current = manager
                .engine(&thread)
                .context("original resident missing")?;
            assert!(current.state.shares_state_with(&engine.state));
            assert_eq!(current.state.messages(), engine.state.messages());
            assert!(!driver.has_commands());
            assert!(requests.lock().unwrap().is_empty());
            for resident in manager.drain() {
                resident.shutdown().await;
            }
            Ok::<_, anyhow::Error>(())
        })
        .unwrap();
}

struct ForegroundProvider {
    requests: Arc<StdMutex<Vec<Value>>>,
}

fn native_created_exposure() {
    let fixture =
        crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
    ct85_test_support::prepare_workspace(&fixture.workspace);
    let settings = kcoder_config::Settings {
        history_enabled: false,
        permission_mode: kcoder_config::PermissionMode::Bypass,
        max_retries: 0,
        ..crate::test_fixtures::settings_with_default_provider()
    };
    let requests = Arc::new(StdMutex::new(Vec::new()));
    let owner = Arc::new(kcoder_config::create_private_temp_dir("ct85-exposure").unwrap());
    let services =
        kcoder_engine::WorkspaceRuntimeServices::new(&fixture.workspace, "ct85-exposure")
            .with_private_client_storage(owner);
    let factory = AppServerEngineFactory::new(
        Arc::new(ForegroundProvider {
            requests: requests.clone(),
        }),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        fixture.workspace.clone(),
        None,
        true,
        services,
        None,
        fixture.profile.join("short-ids"),
    );
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let mut engine = factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
        let workspace_engine = engine.clone();
        let mut manager = ThreadManager::default();
        let (outbound, _events) = mpsc::channel(256);
        let sequence = Arc::new(AtomicU64::new(1));
        let ids = Arc::new(AtomicU64::new(2_000_000));
        let receipts = Arc::new(StdMutex::new(InteractionReceipts::default()));
        let mut automations = project_automations::ProjectAutomations::new(
            engine.cron_scheduler(), false, fixture.workspace.to_string_lossy().into_owned(),
        );
        let mut native_state = ConnectionState {
            initialized: true,
            studio_work_modes_v1: true,
            native_source_dispatch: true,
            request_origin: request_origin::RequestOrigin::NativeSource,
            ..Default::default()
        };
        let mut spec = fixture.spec();
        spec.configuration.model.model = engine.active_model_configuration_summary()?;
        assert!(spec.existing_thread_id.is_none());
        let request = fixture.request("ct85-native-created-exposure");
        let authority = Arc::new(RevocableAuthority {
            enabled: AtomicBool::new(true),
            provider_checks: AtomicUsize::new(0),
            admission_checks: AtomicUsize::new(0),
            async_current: None,
        });
        let native = Arc::new(fixture.context.recapture_for_owned_service()?);
        let (mut pump, client) = NativeRuntimePump::new();
        let caller = tokio::spawn(async move { client.accept(native, request, spec, authority).await });
        let generated = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                if let Some(generated) = pump.next_request(&mut manager)? {
                    return Ok::<_, anyhow::Error>(generated);
                }
                let event = pump.receive().await;
                pump.observe(event, &outbound, &manager).await?;
            }
        }).await??;
        assert_eq!(generated.method, "thread/start");
        assert!(generated.thread_initializer.is_none(), "fixture exercises the original non-pre-start path");
        crate::app_server::thread_creation_requests::dispatch(
            generated.method, serde_json::json!(generated.ticket.id()), generated.params,
            &mut engine, &workspace_engine, &factory, kcoder_config::PermissionMode::Bypass,
            &generated.outbound, &ids, &receipts, &mut manager, "ct85-native-created",
            &sequence, &mut automations, &None, &mut native_state,

        ).await?;
        let thread = engine.session_id();
        assert!(manager.owns(&thread), "the actual native-created resident must exist");
        let original_messages = engine.state.messages();
        let attempts_before = TurnAttemptStore::open_existing(&engine.session_storage_dir_for(&thread), &thread)?
            .map(|store| store.list()).transpose()?;
        let (client_outbound, mut client_events) = mpsc::channel(64);
        let mut client_state = ConnectionState {
            initialized: true,
            request_origin: request_origin::RequestOrigin::ClientFrame,
            ..Default::default()
        };
        let mut attachments = AttachmentDirectories::default();
        crate::app_server::turn_requests::dispatch(
            "turn/start", serde_json::json!(1),
            serde_json::json!({"threadId":thread,"input":[{"type":"text","text":"unowned early input"}]}),
            &mut engine, &factory, &client_outbound, &mut manager, "ct85-foreign",
            &sequence, &mut client_state, &mut attachments, None,
        ).await?;
        let response = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let frame = client_events.recv().await.context("early response channel closed")?;
                if frame["id"] == 1 { return Ok::<_, anyhow::Error>(frame); }
            }
        }).await??;
        assert_eq!(response["error"]["code"], -32022, "{response}");
        assert_eq!(response["error"]["message"], "NATIVE_INPUT_SOURCE_ADMISSION_REQUIRED");
        let after = TurnAttemptStore::open_existing(&engine.session_storage_dir_for(&thread), &thread)?
            .map(|store| store.list()).transpose()?;
        assert_eq!(after, attempts_before);
        assert_eq!(engine.state.messages(), original_messages);
        assert!(requests.lock().unwrap().is_empty());
        caller.abort();
        let _ = caller.await;
        pump.close().await;
        for resident in manager.drain() { resident.shutdown().await; }
        Ok::<_, anyhow::Error>(())
    }).unwrap();
}
impl kcoder_api::Provider for ForegroundProvider {
    fn name(&self) -> &'static str {
        "ct85-ordinary-foreground"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn stream_messages(
        &self,
        request: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests
            .lock()
            .unwrap()
            .push(serde_json::to_value(request).unwrap());
        Ok(Box::pin(futures::stream::iter([
            Ok(kcoder_types::StreamEvent::ContentBlockStart {
                index: 0,
                content_block: kcoder_types::ContentBlock::Text {
                    text: String::new(),
                },
            }),
            Ok(kcoder_types::StreamEvent::ContentBlockDelta {
                index: 0,
                delta: kcoder_types::ContentDelta::TextDelta {
                    text: "ordinary response".into(),
                },
            }),
            Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 0 }),
            Ok(kcoder_types::StreamEvent::MessageStop),
        ])))
    }
}

fn ordinary_foreground() {
    let temp = ct85_test_support::owned_tempdir();
    let workspace = temp.path().join("workspace");
    let profile = temp.path().join("profile");
    kcoder_config::PrivateDirectory::open_or_create(&workspace).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
    ct85_test_support::prepare_workspace(&workspace);
    let settings = kcoder_config::Settings {
        history_enabled: false,
        permission_mode: kcoder_config::PermissionMode::Bypass,
        max_retries: 0,
        ..crate::test_fixtures::settings_with_default_provider()
    };
    let requests = Arc::new(StdMutex::new(Vec::new()));
    let owner =
        Arc::new(kcoder_config::create_private_temp_dir_in(temp.path(), "sessions").unwrap());
    let services = kcoder_engine::WorkspaceRuntimeServices::new(&workspace, "ct85-ordinary")
        .with_private_client_storage(owner);
    let factory = AppServerEngineFactory::new(
        Arc::new(ForegroundProvider {
            requests: requests.clone(),
        }),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        workspace,
        None,
        true,
        services,
        None,
        profile.join("short-ids"),
    );
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut engine = factory
                .create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
            let thread = engine.session_id();
            engine.state.with_history_path(profile.join(format!("{thread}.jsonl")));
            engine.state.save_history()?;
            assert!(!engine.native_input_requires_source_admission());
            let lease = SessionLease::acquire(&engine.session_lease_target())?;
            let (outbound, mut notifications) = mpsc::channel(256);
            let sequence = Arc::new(AtomicU64::new(1));
            let turn_state = ResidentTurnState::new(
                outbound.clone(),
                kcoder_config::PermissionMode::Bypass,
                Arc::new(AtomicU64::new(2_000_000)),
                Arc::new(StdMutex::new(InteractionReceipts::default())),
            );
            let resident = build_resident_thread_runtime(
                engine.clone(), lease, 0, turn_state, outbound.clone(),
                "ct85-ordinary".into(), sequence.clone(),
            );
            let mut manager = ThreadManager::default();
            assert!(manager.insert(resident).is_ok());
            let mut connection = ConnectionState {
                initialized: true,
                request_origin: request_origin::RequestOrigin::ClientFrame,
                ..Default::default()
            };
            assert!(connection.integration_context.is_none());
            assert!(!connection.integration_office_v1);
            assert!(!connection.integration_task_capability_scope_v1);
            let mut attachments = AttachmentDirectories::default();
            crate::app_server::turn_requests::dispatch(
                "turn/start", serde_json::json!(42),
                serde_json::json!({"threadId":thread.as_str(),"input":[{"type":"text","text":"ordinary user request"}]}),
                &mut engine, &factory, &outbound, &mut manager, "ct85-ordinary", &sequence,
                &mut connection, &mut attachments, None,
            ).await?;
            let (response, terminal) = tokio::time::timeout(std::time::Duration::from_secs(15), async {
                let mut response = None;
                let mut terminal = None;
                while response.is_none() || terminal.is_none() {
                    let frame = notifications.recv().await.context("foreground response channel closed")?;
                    if frame["id"] == 42 { response = Some(frame.clone()); }
                    if frame["method"] == "turn/completed" { terminal = Some(frame); }
                }
                Ok::<_, anyhow::Error>((response.unwrap(), terminal.unwrap()))
            }).await??;
            assert!(response.get("result").is_some(), "{response}");
            assert_eq!(terminal["params"]["turn"]["status"], "completed", "{terminal}");
            let completed_turn = terminal["params"]["turn"]["id"]
                .as_str().context("ordinary terminal turn missing")?.to_owned();
            {
                let requests = requests.lock().unwrap();
                assert_eq!(requests.len(), 1);
                assert!(requests[0].to_string().contains("ordinary user request"));
            }
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                while manager.is_turn_running(&thread) { tokio::task::yield_now().await; }
            }).await?;
            let workspace_engine = engine.clone();
            let ids = Arc::new(AtomicU64::new(2_300_000));
            let receipts = Arc::new(StdMutex::new(InteractionReceipts::default()));
            for (index, ephemeral) in [false, true].into_iter().enumerate() {
                let id = 70 + index as i64;
                crate::app_server::thread_restore_requests::dispatch(
                    "thread/fork", serde_json::json!(id),
                    serde_json::json!({"threadId":thread.as_str(),"lastTurnId":completed_turn.as_str(),"ephemeral":ephemeral}),
                    &mut engine, &workspace_engine, &factory, kcoder_config::PermissionMode::Bypass,
                    &outbound, &ids, &receipts, &mut manager, "ct85-ordinary", &sequence,
                    &mut connection,
                ).await?;
                let frame = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                    loop {
                        let frame = notifications.recv().await.context("ordinary fork response missing")?;
                        if frame["id"] == id { return Ok::<_, anyhow::Error>(frame); }
                    }
                }).await??;
                assert!(frame.get("result").is_some(), "{frame}");
                assert!(frame["result"]["thread"]["id"].is_string(), "{frame}");
                assert_eq!(frame["result"]["ephemeral"].as_bool().unwrap_or(false), ephemeral);
            }
            let attenuated = factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?
                .with_native_input_only_context("original native input".into(), 128)?;
            let original_input = attenuated.native_input_context_identity().context("original input identity missing")?;
            assert_eq!(attenuated.matches_native_input_context_identity(&original_input), Some(true));
            let rebuilt = attenuated.clone().with_native_input_only_context("original native input".into(), 128)?;
            assert_eq!(rebuilt.matches_native_input_context_identity(&original_input), Some(false));
            let installation = crate::app_server::integrations::core::runtime_driver::NativeInputInstallation::default();
            assert!(!installation.permits_reuse(&attenuated)?);
            installation.record_installed(&attenuated)?;
            for _ in 0..3 {
                assert!(installation.permits_reuse(&attenuated)?);
            }
            assert!(installation.permits_reuse(&rebuilt).is_err());
            assert!(installation.record_installed(&rebuilt).is_err());
            let attenuated_thread = attenuated.session_id();
            let lease = SessionLease::acquire(&attenuated.session_lease_target())?;
            let turn_state = ResidentTurnState::new(
                outbound.clone(), kcoder_config::PermissionMode::Bypass, ids.clone(), receipts.clone(),
            );
            let resident = build_resident_thread_runtime(
                attenuated.clone(), lease, 0, turn_state, outbound.clone(),
                "ct85-attenuation".into(), sequence.clone(),
            );
            assert!(manager.insert(resident).is_ok());
            let mut different_candidate = factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
            different_candidate.state = attenuated.state.clone();
            let different_candidate = different_candidate.with_required_native_host_source_admission()?;
            assert!(manager.lease(&attenuated_thread).context("attenuated lease missing")?.matches_target(&different_candidate.session_lease_target()));
            let error = manager.replace_host_turn_engine(&attenuated_thread, different_candidate)
                .expect_err("a source marker must not replace input attenuation");
            assert_eq!(error.to_string(), "Thread candidate cannot remove its native input attenuation");
            let unchanged = attenuated.clone().with_required_native_host_source_admission()?;
            manager.replace_host_turn_engine(&attenuated_thread, unchanged)?;
            let widened = attenuated.clone()
                .with_native_input_only_context("different native input".into(), 4096)?
                .with_required_native_host_source_admission()?;
            let error = manager.replace_host_turn_engine(&attenuated_thread, widened)
                .expect_err("a same-State replacement must not widen or replace its input attenuation");
            assert_eq!(error.to_string(), "Thread candidate cannot remove its native input attenuation");
            for resident in manager.drain() { resident.shutdown().await; }
            let original = engine.clone().with_required_native_host_source_admission()?;
            let same = original.clone().with_required_native_host_source_admission()?;
            assert_eq!(same.preserves_native_host_source_from(&original), Some(true));
            let mut foreign = same.clone();
            foreign.state = kcoder_state::AppState::new(engine.state.cwd());
            assert_eq!(foreign.native_host_source_lifecycle_is_current(), Some(false));
            assert_eq!(foreign.preserves_native_host_source_from(&original), Some(false));
            assert!(foreign.with_required_native_host_source_admission().is_err());
            engine.state.start_new_session()?;
            assert_eq!(original.native_host_source_lifecycle_is_current(), Some(false));
            assert!(original.with_required_native_host_source_admission().is_err());
            Ok::<_, anyhow::Error>(())
        })
        .unwrap();
}

pub(super) struct RelabelFixture<'a> {
    pub(super) engine: &'a mut QueryEngine,
    pub(super) factory: &'a AppServerEngineFactory,
    pub(super) manager: &'a mut ThreadManager,
    pub(super) outbound: &'a mpsc::Sender<Value>,
    pub(super) notifications: &'a mut mpsc::Receiver<Value>,
    pub(super) sequence: &'a Arc<AtomicU64>,
    pub(super) thread: &'a str,
    pub(super) authority: &'a Arc<RevocableAuthority>,
    pub(super) calls: &'a Arc<AtomicUsize>,
    pub(super) case: Ct85Case,
}

pub(super) async fn check_active_native_turn(fixture: RelabelFixture<'_>) -> Result<()> {
    let RelabelFixture {
        engine,
        factory,
        manager,
        outbound,
        notifications,
        sequence,
        thread,
        calls,
        ..
    } = fixture;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    assert!(manager.is_turn_running(thread));
    let store = TurnAttemptStore::open_existing(&engine.session_storage_dir_for(thread), thread)?
        .context("active original attempt missing")?;
    let attempts = store.list()?;
    assert_eq!(attempts.len(), 1);
    let messages = engine.state.messages();
    let mut foreign = ConnectionState {
        initialized: true,
        request_origin: request_origin::RequestOrigin::ClientFrame,
        ..Default::default()
    };
    let mut attachments = AttachmentDirectories::default();
    let id = 345678901;
    crate::app_server::turn_requests::dispatch(
        "turn/start", serde_json::json!(id),
        serde_json::json!({"threadId":thread,"input":[{"type":"text","text":"concurrent foreign input"}]}),
        engine, factory, outbound, manager, "ct85-concurrent", sequence,
        &mut foreign, &mut attachments, None,
    ).await?;
    let response = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let frame = notifications
                .recv()
                .await
                .context("concurrent turn response closed")?;
            if frame["id"] == id {
                return Ok::<_, anyhow::Error>(frame);
            }
        }
    })
    .await??;
    assert_eq!(response["error"]["code"], -32022, "{response}");
    assert_eq!(
        response["error"]["message"],
        "NATIVE_INPUT_SOURCE_ADMISSION_REQUIRED"
    );
    let workspace = engine.clone();
    let ids = Arc::new(AtomicU64::new(2_400_000));
    let receipts = Arc::new(StdMutex::new(InteractionReceipts::default()));
    for (index, ephemeral) in [false, true].into_iter().enumerate() {
        let fork_id = id + 10 + index as i64;
        crate::app_server::thread_restore_requests::dispatch(
            "thread/fork", serde_json::json!(fork_id),
            serde_json::json!({"threadId":thread,"lastTurnId":attempts[0].identity.turn_id.as_str(),"ephemeral":ephemeral}),
            engine, &workspace, factory, kcoder_config::PermissionMode::Bypass,
            outbound, &ids, &receipts, manager, "ct85-concurrent", sequence, &mut foreign,
        ).await?;
        let response = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let frame = notifications
                    .recv()
                    .await
                    .context("concurrent fork response closed")?;
                if frame["id"] == fork_id {
                    return Ok::<_, anyhow::Error>(frame);
                }
            }
        })
        .await??;
        assert_eq!(response["error"]["code"], -32036, "{response}");
        assert!(
            response["error"]["message"]
                .as_str()
                .is_some_and(
                    |message| message.contains("completed") || message.contains("incomplete")
                ),
            "{response}"
        );
        assert!(manager.is_turn_running(thread));
        assert_eq!(store.list()?, attempts);
        assert_eq!(engine.state.messages(), messages);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    Ok(())
}

pub(super) async fn reject_relabelled_public_turn(fixture: RelabelFixture<'_>) -> Result<()> {
    let RelabelFixture {
        engine,
        factory,
        manager,
        outbound,
        notifications,
        sequence,
        thread,
        authority,
        calls,
        case,
    } = fixture;
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while manager.is_turn_running(thread) {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    let attempt_store =
        TurnAttemptStore::open_existing(&engine.session_storage_dir_for(thread), thread)?
            .context("original Accepted attempt missing")?;
    let attempts_before = attempt_store.list()?;
    assert_eq!(
        attempts_before.len(),
        1,
        "the original native turn was accepted"
    );
    let messages_before = engine.state.messages();
    let provider_calls_before = calls.load(Ordering::SeqCst);
    assert_eq!(
        provider_calls_before, 1,
        "the original native turn ran once"
    );

    // A new transport connection has no private source observer. Neither its
    // client-frame origin nor a JSON label is the original source authority.
    authority.enabled.store(false, Ordering::SeqCst);
    let mut reconnected = ConnectionState {
        initialized: true,
        request_origin: request_origin::RequestOrigin::ClientFrame,
        ..Default::default()
    };
    let mut attachments = AttachmentDirectories::default();
    let request_id = 987654321;
    if matches!(case, Ct85Case::Relabel) {
        // A same-State candidate built for a foreground client cannot remove the
        // source boundary when the native resident is reused.
        let mut relabelled_candidate =
            factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
        relabelled_candidate.state = engine.state.clone();
        assert!(
            manager
                .lease(thread)
                .context("original lease missing")?
                .matches_target(&relabelled_candidate.session_lease_target())
        );
        let replacement = manager
            .replace_host_turn_engine(thread, relabelled_candidate)
            .expect_err("a foreground candidate removed the native source owner");
        assert_eq!(
            replacement.to_string(),
            "Thread candidate cannot remove its native source boundary"
        );
        assert!(
            manager
                .engine(thread)
                .context("resident missing")?
                .state
                .shares_state_with(&engine.state)
        );

        crate::app_server::turn_requests::dispatch(
            "turn/start",
            serde_json::json!(request_id),
            serde_json::json!({
                "threadId": thread,
                "origin": "foreground",
                "input": [{"type":"text", "text":"untrusted relabelled input"}]
            }),
            engine,
            factory,
            outbound,
            manager,
            "ct85-reconnected-client",
            sequence,
            &mut reconnected,
            &mut attachments,
            None,
        )
        .await?;
        let response = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let frame = notifications
                    .recv()
                    .await
                    .context("response channel closed")?;
                if frame["id"] == request_id {
                    return Ok::<_, anyhow::Error>(frame);
                }
            }
        })
        .await??;
        assert_eq!(response["error"]["code"], -32022, "{response}");
        assert_eq!(
            response["error"]["message"],
            "NATIVE_INPUT_SOURCE_ADMISSION_REQUIRED"
        );
        assert_eq!(attempt_store.list()?, attempts_before);
        assert_eq!(engine.state.messages(), messages_before);
        assert_eq!(calls.load(Ordering::SeqCst), provider_calls_before);
        assert!(
            manager
                .engine(thread)
                .context("original resident disappeared")?
                .native_input_requires_source_admission()
        );
    }

    let workspace_engine = engine.clone();
    let interaction_ids = Arc::new(AtomicU64::new(2_200_000));
    let receipts = Arc::new(StdMutex::new(InteractionReceipts::default()));
    let history_path = engine
        .state
        .history_path()
        .context("original history missing")?;
    let profile = history_path.parent().context("original profile missing")?;
    let storage = engine.client_storage_root();
    let owned_config = std::path::PathBuf::from(
        std::env::var_os("KCODER_CONFIG_DIR").context("owned config missing")?,
    );
    let history_before = owned_tree_snapshot(profile)?;
    let attachments_before = owned_tree_snapshot(&storage)?;
    let config_before = owned_tree_snapshot(&owned_config)?;
    let resident_count = manager.resident_engines().len();
    for (index, ephemeral) in [false, true].into_iter().enumerate() {
        if matches!(case, Ct85Case::Fork(expected) if ephemeral != expected) {
            continue;
        }
        let id = request_id + 10 + index as i64;
        crate::app_server::thread_restore_requests::dispatch(
            "thread/fork",
            serde_json::json!(id),
            serde_json::json!({"threadId":thread,"lastTurnId":attempts_before[0].identity.turn_id.as_str(),"ephemeral":ephemeral}),
            engine,
            &workspace_engine,
            factory,
            kcoder_config::PermissionMode::Bypass,
            outbound,
            &interaction_ids,
            &receipts,
            manager,
            "ct85-reconnected-client",
            sequence,
            &mut reconnected,
        )
        .await?;
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let frame = notifications
                    .recv()
                    .await
                    .context("fork response channel closed")?;
                if frame["id"] == id {
                    return Ok::<_, anyhow::Error>(frame);
                }
            }
        })
        .await??;
        assert_eq!(frame["error"]["code"], -32036, "{frame}");
        assert_eq!(
            frame["error"]["message"],
            "This thread belongs to a restricted source. Continue from the original source or start a new thread."
        );
        assert_eq!(attempt_store.list()?, attempts_before);
        assert_eq!(engine.state.messages(), messages_before);
        assert_eq!(calls.load(Ordering::SeqCst), provider_calls_before);
        assert_eq!(manager.resident_engines().len(), resident_count);
        assert_eq!(owned_tree_snapshot(profile)?, history_before);
        assert_eq!(owned_tree_snapshot(&storage)?, attachments_before);
        assert_eq!(owned_tree_snapshot(&owned_config)?, config_before);
    }
    if matches!(case, Ct85Case::Fork(_)) {
        return Ok(());
    }

    // The revoked source remains isolated to its original resident. A distinct
    // foreground session with no source binding may still use the provider.
    let mut independent =
        factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
    let other_thread = independent.session_id();
    assert_ne!(other_thread, thread);
    assert!(!independent.native_input_requires_source_admission());
    let history = engine
        .state
        .history_path()
        .context("original history missing")?;
    independent.state.with_history_path(
        history
            .parent()
            .context("history parent missing")?
            .join(format!("{other_thread}.jsonl")),
    );
    independent.state.save_history()?;
    let lease = SessionLease::acquire(&independent.session_lease_target())?;
    let turn_state = ResidentTurnState::new(
        outbound.clone(),
        kcoder_config::PermissionMode::Bypass,
        Arc::new(AtomicU64::new(2_100_000)),
        Arc::new(StdMutex::new(InteractionReceipts::default())),
    );
    let resident = build_resident_thread_runtime(
        independent.clone(),
        lease,
        0,
        turn_state,
        outbound.clone(),
        "ct85-independent".into(),
        sequence.clone(),
    );
    assert!(manager.insert(resident).is_ok());
    crate::app_server::turn_requests::dispatch(
        "turn/start", serde_json::json!(request_id + 1),
        serde_json::json!({"threadId":other_thread.as_str(),"input":[{"type":"text","text":"ct85 independent foreground request"}]}),
        &mut independent, factory, outbound, manager, "ct85-independent", sequence,
        &mut reconnected, &mut attachments, None,
    ).await?;
    let mut observed_response = false;
    let mut observed_completion = false;
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        while !observed_response || !observed_completion {
            let frame = notifications
                .recv()
                .await
                .context("independent response channel closed")?;
            if frame["id"] == request_id + 1 {
                assert!(frame.get("result").is_some(), "{frame}");
                observed_response = true;
            }
            if frame["method"] == "turn/completed"
                && frame["params"]["turn"]["threadId"] == other_thread
            {
                assert_eq!(frame["params"]["turn"]["status"], "completed", "{frame}");
                observed_completion = true;
            }
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    assert_eq!(calls.load(Ordering::SeqCst), provider_calls_before + 1);
    assert_eq!(attempt_store.list()?, attempts_before);
    assert_eq!(engine.state.messages(), messages_before);
    Ok(())
}
