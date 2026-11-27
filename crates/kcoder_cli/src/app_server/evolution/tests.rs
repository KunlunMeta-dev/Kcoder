use super::*;
use clap::Parser;
use kcoder_config::{PrivateDirectory, SettingsLoader};
use std::ffi::OsStr;

struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    engine: QueryEngine,
    factory: AppServerEngineFactory,
}

fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_existing(root.path()).unwrap();
    parent.create_private_child(OsStr::new("profile")).unwrap();
    parent
        .create_private_child(OsStr::new("workspace"))
        .unwrap();
    let profile = root.path().join("profile");
    let cwd = root.path().join("workspace");
    let path = profile.join("settings.json");
    std::fs::write(&path, "{\"providers\":{},\"history_enabled\":false}").unwrap();
    let cli = crate::Cli::parse_from(["kcoder"]);
    let loader = SettingsLoader::new(&cwd)
        .with_config_dir(&profile)
        .with_executable_dir(&cwd);
    let settings = loader.load().unwrap().settings;
    let provider = Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
        crate::tui_dev_mock::TuiDevScenario::FullTurn,
    ));
    let owner = Arc::new(kcoder_config::create_private_temp_dir("evolution-rpc-tests").unwrap());
    let services = kcoder_engine::WorkspaceRuntimeServices::new(&cwd, "evolution-rpc-tests")
        .with_private_client_storage(owner);
    let engine = QueryEngine::try_new_for_client_with_services(
        provider.clone(),
        kcoder_state::AppState::new(&cwd),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings.clone(),
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        cwd.clone(),
        Some(true),
        services.clone(),
    )
    .unwrap()
    .with_settings_persistence_path(path.clone());
    let factory = AppServerEngineFactory::new(
        provider,
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        cwd.clone(),
        None,
        true,
        services,
        Some(path),
        cwd.join("test-ids"),
    )
    .with_session_configuration(loader, cli, false)
    .unwrap();
    Fixture {
        _root: root,
        profile,
        engine,
        factory,
    }
}

impl Fixture {
    /// Dispatch one request and collect the response plus any notification.
    async fn call(&self, state: &mut ConnectionState, name: &str, params: Value) -> Vec<Value> {
        let (tx, mut rx) = mpsc::channel(8);
        let manager = ThreadManager::default();
        let handled = dispatch(
            name,
            &json!(7),
            &params,
            &self.engine,
            &self.factory,
            &manager,
            &tx,
            state,
        )
        .await
        .unwrap();
        assert!(handled);
        while state.knowledge_rpc_tasks.join_next().await.is_some() {}
        drop(tx);
        let mut frames = Vec::new();
        while let Some(frame) = rx.recv().await {
            frames.push(frame);
        }
        frames
    }
}

fn negotiated() -> ConnectionState {
    ConnectionState {
        self_evolution_v1: true,
        ..ConnectionState::default()
    }
}

#[test]
fn capability_requires_a_user_settings_file_and_an_ordinary_connection() {
    let f = fixture();
    let mut capabilities = kcoder_app_protocol::ServerCapabilities::default();
    assert!(negotiate(&f.engine, false, &mut capabilities));
    assert_eq!(
        capabilities.experimental.get(CAPABILITY_SELF_EVOLUTION_V1),
        Some(&true)
    );
    assert!(!negotiate(&f.engine, true, &mut capabilities));
    assert_eq!(
        capabilities.experimental.get(CAPABILITY_SELF_EVOLUTION_V1),
        Some(&false)
    );
}

#[test]
fn every_protocol_method_is_dispatched() {
    for name in [
        method::STATUS,
        method::TARGETS_LIST,
        method::TARGET_READ,
        method::PROPOSAL_DECIDE,
        method::OVERLAY_UPDATE,
        method::PREFERENCE_LIST,
        method::PREFERENCE_UPDATE,
        method::RATE,
        method::RATINGS_LIST,
        method::DATA_CLEAR,
        method::SETTINGS_READ,
        method::SETTINGS_SAVE,
        method::TARGET_DISTILL,
    ] {
        assert!(handles(name), "{name}");
    }
    assert!(!handles(method::CHANGED));
    assert!(!handles("evolution/unknown"));
}

#[tokio::test]
async fn methods_without_the_negotiated_capability_are_refused_without_side_effects() {
    let f = fixture();
    let mut state = ConnectionState::default();
    let frames = f
        .call(
            &mut state,
            method::DATA_CLEAR,
            json!({"scope": "all", "confirm": true}),
        )
        .await;
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0]["error"]["code"], -32601);
    assert_eq!(frames[0]["error"]["data"]["kind"], "evolution_unsupported");
    assert!(!f.profile.join("evolution").exists());
}

#[tokio::test]
async fn status_settings_and_errors_round_trip_through_dispatch() {
    let f = fixture();
    let mut state = negotiated();
    let status = f.call(&mut state, method::STATUS, json!({})).await;
    assert_eq!(status.len(), 1);
    let result = &status[0]["result"];
    assert_eq!(result["enabled"], false);
    assert_eq!(
        result["skillFileEditsSupported"],
        kcoder_tools::skill_file_evolution::skill_file_edits_supported()
    );
    assert_eq!(result["targets"].as_array().unwrap().len(), 5);
    assert!(
        !f.profile.join("evolution").exists(),
        "reads create no storage"
    );

    let read = f.call(&mut state, method::SETTINGS_READ, json!({})).await;
    let mut settings = read[0]["result"]["settings"].clone();
    let revision = read[0]["result"]["revision"].clone();
    settings["enabled"] = json!(true);
    let saved = f
        .call(
            &mut state,
            method::SETTINGS_SAVE,
            json!({"settings": settings, "expectedRevision": revision}),
        )
        .await;
    assert_eq!(saved.len(), 2, "{saved:?}");
    assert_eq!(saved[0]["result"]["settings"]["enabled"], true);
    assert_eq!(saved[1]["method"], method::CHANGED);
    assert_eq!(saved[1]["params"]["reason"], "settings");

    let stale = f
        .call(
            &mut state,
            method::SETTINGS_SAVE,
            json!({"settings": settings, "expectedRevision": revision}),
        )
        .await;
    assert_eq!(
        stale[0]["error"]["data"]["kind"],
        "evolution_revision_conflict"
    );

    let status = f.call(&mut state, method::STATUS, json!({})).await;
    assert_eq!(status[0]["result"]["enabled"], true);

    let invalid = f
        .call(
            &mut state,
            method::DATA_CLEAR,
            json!({"scope": "all", "confirm": false}),
        )
        .await;
    assert_eq!(invalid[0]["error"]["code"], -32602);
    assert_eq!(invalid[0]["id"], 7);

    let unknown_field = f
        .call(
            &mut state,
            method::STATUS,
            json!({"workspace": "/tmp", "extra": 1}),
        )
        .await;
    assert_eq!(unknown_field[0]["error"]["code"], -32602);

    let missing = f
        .call(
            &mut state,
            method::TARGET_READ,
            json!({"targetKey": "skill:bundled:missing"}),
        )
        .await;
    assert_eq!(
        missing[0]["error"]["data"]["kind"],
        "evolution_target_not_found"
    );

    let subagent = f
        .call(
            &mut state,
            method::RATE,
            json!({"threadId": "thread-1", "subagentId": "agent-1", "turnId": "turn-1", "rating": "up"}),
        )
        .await;
    assert_eq!(
        subagent[0]["error"]["data"]["kind"],
        "evolution_target_not_found"
    );

    let rated = f
        .call(
            &mut state,
            method::RATE,
            json!({"threadId": "thread-1", "turnId": "turn-1", "rating": "down", "reason": "wrong"}),
        )
        .await;
    assert_eq!(rated[0]["result"]["recorded"], false);

    // The ratable-turn projection resolves threads like `evolution/rate`.
    let listed = f
        .call(
            &mut state,
            method::RATINGS_LIST,
            json!({"threadId": "thread-1"}),
        )
        .await;
    assert_eq!(listed.len(), 1, "a read emits no notification");
    assert_eq!(
        listed[0]["result"],
        json!({"items": [], "truncated": false})
    );
    let child = f
        .call(
            &mut state,
            method::RATINGS_LIST,
            json!({"threadId": "thread-1", "subagentId": "agent-1"}),
        )
        .await;
    assert_eq!(
        child[0]["error"]["data"]["kind"],
        "evolution_target_not_found"
    );
    let calls = f
        .call(
            &mut state,
            method::RATE,
            json!({"threadId": "thread-1", "turnId": "turn-1", "toolCallIds": [""], "rating": "up"}),
        )
        .await;
    assert_eq!(calls[0]["error"]["code"], -32602);

    let cleared = f
        .call(
            &mut state,
            method::DATA_CLEAR,
            json!({"scope": "user", "confirm": true}),
        )
        .await;
    assert_eq!(cleared[0]["result"]["cleared"], true);
    assert_eq!(cleared[1]["params"]["reason"], "cleared");
}

/// A stand-in Engine job under the fixture's data root that stops as soon
/// as it is cancelled, like a real job does.
fn running_job(
    f: &Fixture,
) -> (
    tokio_util::sync::CancellationToken,
    std::thread::JoinHandle<()>,
) {
    let held = kcoder_engine::evolution_job_probe::hold_evolution_job(
        kcoder_types::evolution::EvolutionJobKind::Distill,
        None,
        f.profile.clone(),
    );
    let token = held.token.clone();
    let worker = std::thread::spawn(move || {
        while !held.token.is_cancelled() {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        drop(held);
    });
    (token, worker)
}

#[tokio::test(flavor = "multi_thread")]
async fn clearing_data_and_switching_evolution_off_cancel_running_engine_jobs() {
    let f = fixture();
    let mut state = negotiated();
    let (token, worker) = running_job(&f);
    let cleared = f
        .call(
            &mut state,
            method::DATA_CLEAR,
            json!({"scope": "all", "confirm": true}),
        )
        .await;
    assert!(cleared[0]["error"].is_null(), "{cleared:?}");
    assert!(token.is_cancelled(), "data/clear cancels the Engine job");
    worker.join().unwrap();

    let read = f.call(&mut state, method::SETTINGS_READ, json!({})).await;
    let mut settings = read[0]["result"]["settings"].clone();
    settings["enabled"] = json!(true);
    let saved = f
        .call(
            &mut state,
            method::SETTINGS_SAVE,
            json!({"settings": settings, "expectedRevision": read[0]["result"]["revision"]}),
        )
        .await;
    let (token, worker) = running_job(&f);
    settings["enabled"] = json!(false);
    let off = f
        .call(
            &mut state,
            method::SETTINGS_SAVE,
            json!({"settings": settings, "expectedRevision": saved[0]["result"]["revision"]}),
        )
        .await;
    assert_eq!(off[0]["result"]["settings"]["enabled"], false, "{off:?}");
    assert!(
        token.is_cancelled(),
        "the master switch cancels the Engine job"
    );
    worker.join().unwrap();
}

/// Rewrite the profile's user settings with `extra` merged in.
fn set_user_settings(f: &Fixture, extra: Value) {
    let path = f.profile.join("settings.json");
    let mut document: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for (key, value) in extra.as_object().unwrap() {
        document[key] = value.clone();
    }
    std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
}

#[tokio::test]
async fn manual_distillation_without_a_session_needs_a_configured_model() {
    let f = fixture();
    let mut state = negotiated();
    let disabled = f
        .call(
            &mut state,
            method::TARGET_DISTILL,
            json!({"targetKey": "skill:bundled:git"}),
        )
        .await;
    assert_eq!(disabled.len(), 1, "a request emits no change notice");
    assert_eq!(disabled[0]["result"]["outcome"], "disabled", "{disabled:?}");

    // No thread is open, and the model follows the session: there is no
    // session model, which is reported instead of an unknown target.
    set_user_settings(&f, json!({"evolution": {"enabled": true}}));
    for workspace in [None, Some("/nonexistent-evolution-workspace")] {
        let mut params = json!({"targetKey": "skill:bundled:git"});
        if let Some(workspace) = workspace {
            params["workspace"] = json!(workspace);
        }
        let unavailable = f.call(&mut state, method::TARGET_DISTILL, params).await;
        assert_eq!(
            unavailable[0]["result"]["outcome"], "model_unavailable",
            "{unavailable:?}"
        );
        assert!(
            unavailable[0]["result"]["reason"]
                .as_str()
                .is_some_and(|reason| reason.contains("no session is open")),
            "{unavailable:?}"
        );
    }

    let invalid = f
        .call(
            &mut state,
            method::TARGET_DISTILL,
            json!({"targetKey": "git"}),
        )
        .await;
    assert_eq!(invalid[0]["error"]["code"], -32602);
}

/// Accepting project knowledge for a workspace without an open session
/// writes that workspace's project memory through short-lived hooks.
#[tokio::test]
async fn project_knowledge_of_a_workspace_without_a_session_reaches_its_project_memory() {
    let f = fixture();
    let memory_dir = f.profile.join("memory");
    set_user_settings(&f, json!({"memory_directory": memory_dir}));
    let other = f.profile.parent().unwrap().join("other-workspace");
    std::fs::create_dir_all(&other).unwrap();
    let root = kcoder_evolution::resolve_scope_root(
        &f.profile,
        &kcoder_evolution::EvolutionScope::Project { cwd: other.clone() },
    )
    .unwrap();
    let store = kcoder_evolution::EvolutionStore::open(&root).unwrap();
    let key =
        kcoder_types::evolution::TargetKey::parse("project_knowledge:project:commands.abc123")
            .unwrap();
    let created = store
        .create_proposal(
            kcoder_evolution::ProposalDraft {
                target_key: key.clone(),
                base_revision: "project".into(),
                location: kcoder_types::evolution::ProposalLocation::Overlay,
                changes: kcoder_types::evolution::ProposalChanges {
                    examples: vec![kcoder_types::evolution::ProposalExample {
                        name: "Test command".into(),
                        text: "Run `just verify-evolution` before pushing.".into(),
                    }],
                    ..Default::default()
                },
                pattern_ids: Vec::new(),
                evidence_ids: Vec::new(),
                actor: kcoder_types::evolution::ProposalActor::Auto,
            },
            1,
        )
        .unwrap()
        .proposal;
    let mut state = negotiated();
    let accepted = f
        .call(
            &mut state,
            method::PROPOSAL_DECIDE,
            json!({"workspace": other, "targetKey": key.to_string(),
                "proposalId": created.proposal_id, "decision": "accept", "expectedRevision": "0"}),
        )
        .await;
    assert!(accepted[0]["error"].is_null(), "{accepted:?}");
    let memory = kcoder_memory::MemoryManager::new(
        f.engine.memory_manager.global_store(),
        &other,
        &memory_dir,
    )
    .unwrap();
    assert!(
        memory
            .all_memories()
            .iter()
            .any(|item| item.fact.contains("just verify-evolution")),
        "the workspace's project memory holds the accepted knowledge"
    );
}
