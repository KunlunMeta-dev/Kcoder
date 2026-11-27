use super::*;
#[path = "tests/target_admission.rs"]
mod target_admission;
#[test]
fn latest_accepted_without_a_terminal_does_not_reuse_a_previous_completed_result() {
    use kcoder_state::turn_attempt_store::{TurnAttemptCompletion, TurnAttemptRecord};
    let record = |accepted, completed| TurnAttemptRecord {
        version: 1,
        client_presentation: None,
        identity: kcoder_types::TurnAttemptIdentity {
            thread_id: "thread".into(),
            turn_id: format!("turn-{accepted}"),
            attempt_id: format!("attempt-{accepted}"),
        },
        parent_attempt_id: None,
        retry_operation_id: None,
        accepted_at_ms: accepted,
        input_context_hash: "a".repeat(64),
        request_fingerprint: None,
        retained_input: None,
        status: if completed {
            kcoder_types::TurnAttemptStatus::Completed
        } else {
            kcoder_types::TurnAttemptStatus::Accepted
        },
        completion: if completed {
            Some(TurnAttemptCompletion {
                status: kcoder_types::TurnAttemptStatus::Completed,
                finished_at_ms: accepted + 1,
                error: None,
                provider_failure: None,
                partial_output: String::new(),
                partial_output_truncated: false,
                committed_history_uuid: None,
            })
        } else {
            None
        },
    };
    assert!(latest_turn(&[record(10, true), record(20, false)]).is_none());
    assert_eq!(
        latest_turn(&[record(20, true)]).unwrap().turn_id.as_deref(),
        Some("turn-20")
    );
    assert!(
        latest_turn(&[record(10, true), record(20, true)]).is_none(),
        "wall-clock values cannot establish which completed turn was last"
    );
    assert!(
        latest_turn(&[record(20, true), record(20, false)]).is_none(),
        "ambiguous latest observations remain unknown"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn unarchived_live_source_without_storage_root_is_observable_but_a_linked_root_fails_closed()
-> Result<()> {
    let fixture = Fixture::new()?;
    let mut peer = fixture.engine()?;
    let guard = host::attach(&mut peer, fixture.paths.clone())?.context("live peer")?;
    let storage = peer.client_storage_root();
    assert!(
        !storage.exists(),
        "an Interactive session creates its storage root lazily"
    );
    let observed = guard.source()?.observe_status()?;
    assert_eq!(observed.thread_id, peer.session_id());
    assert!(observed.archived_at.is_none());
    assert!(
        !storage.exists(),
        "observation never creates the storage root"
    );
    let elsewhere = fixture.root.path().join("elsewhere");
    std::fs::create_dir(&elsewhere)?;
    std::fs::create_dir_all(storage.parent().context("storage parent")?)?;
    std::os::unix::fs::symlink(&elsewhere, &storage)?;
    assert!(
        guard.source()?.observe_status().is_err(),
        "a linked storage root is not treated as absent"
    );
    std::fs::remove_file(&storage)?;
    std::fs::write(&storage, b"not a directory")?;
    assert!(
        guard.source()?.observe_status().is_err(),
        "a non-directory storage root is not treated as absent"
    );
    Ok(())
}

#[tokio::test]
async fn actual_local_tool_pages_cold_history_without_creating_a_destination_or_caching_permission()
-> Result<()> {
    let fixture = Fixture::new()?;
    let mut source = fixture.engine()?;
    let _source_owner =
        host::attach(&mut source, fixture.paths.clone())?.context("real source owner")?;
    let mut peer = fixture.engine()?;
    let _peer_owner = host::attach(&mut peer, fixture.paths.clone())?.context("real live peer")?;
    let mut expected = HashSet::new();
    for number in 0..12 {
        let engine = fixture.engine()?;
        engine
            .state
            .commit_message_with_uuid(
                kcoder_types::Message::user_text(format!("Owned cold history {number}")),
                &uuid::Uuid::new_v4().to_string(),
            )
            .await?;
        expected.insert(engine.session_id());
    }
    let foreign_workspace = fixture.root.path().join("other-workspace");
    kcoder_config::PrivateDirectory::open_or_create(&foreign_workspace)?;
    let foreign = fixture.engine_for_workspace(foreign_workspace)?;
    foreign
        .state
        .commit_message_with_uuid(
            kcoder_types::Message::user_text("Other workspace history"),
            &uuid::Uuid::new_v4().to_string(),
        )
        .await?;
    let list = source
        .active_tool_registry()
        .get("ListSessions")
        .context("real ListSessions contribution")?
        .clone();
    let context = ToolContext::new(source.state.clone());
    let mut cursor = None;
    let mut first_cursor = None;
    let mut found = HashSet::new();
    let mut live = 0;
    for page in 0..4 {
        let input = cursor
            .as_ref()
            .map_or_else(|| json!({}), |cursor| json!({"cursor":cursor}));
        let output = list.call(input, &context).await?;
        let listing: Value = serde_json::from_str(tool_text(&output)?)?;
        assert_eq!(listing["coverage"], "workspace_history");
        let rows = listing["targets"].as_array().context("target rows")?;
        assert!(rows.len() <= 10);
        for row in rows {
            let id = row["threadId"].as_str().context("actual ID")?;
            assert_ne!(id, source.session_id());
            assert_ne!(id, foreign.session_id());
            if id == peer.session_id() {
                live += 1;
                assert_eq!(row["status"], "idle");
            } else {
                assert!(expected.contains(id));
                assert!(
                    found.insert(id.to_owned()),
                    "cold targets are not duplicated across pages"
                );
                assert_eq!(row["status"], "unknown");
                assert_eq!(
                    row["allowedModes"],
                    json!(["enqueue_only"]),
                    "cold data admission does not invent an automatic-wake owner"
                );
            }
        }
        cursor = listing["nextCursor"].as_str().map(str::to_owned);
        if page == 0 {
            first_cursor = cursor.clone();
        }
        if cursor.is_none() {
            break;
        }
    }
    assert!(cursor.is_none());
    assert_eq!(found, expected);
    assert_eq!(live, 1);
    source
        .settings
        .write()
        .unwrap()
        .tools
        .disabled
        .push("ListSessions".into());
    assert!(
        list.call(
            json!({"cursor":first_cursor.context("multi-page cursor")?}),
            &context
        )
        .await
        .is_err(),
        "a previously issued directory cursor never caches an allow verdict"
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    Ok(())
}
use kcoder_tools::{ToolContext, ToolRegistry};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
fn tool_text(output: &kcoder_tools::ToolOutput) -> Result<&str> {
    match output.content.as_slice() {
        [kcoder_types::ContentBlock::Text { text }] => Ok(text),
        _ => anyhow::bail!("expected a real single text tool result"),
    }
}

#[tokio::test]
async fn stale_locator_keeps_cold_target_visible_without_claiming_or_repairing_it() -> Result<()> {
    use std::io::Read;
    let fixture = Fixture::new()?;
    let mut source = fixture.engine()?;
    let mut source_guard =
        host::attach(&mut source, fixture.paths.clone())?.context("actual Source holder")?;
    let mut peer = fixture.engine()?;
    let mut peer_guard =
        host::attach(&mut peer, fixture.paths.clone())?.context("actual destination holder")?;
    for engine in [&source, &peer] {
        engine
            .state
            .commit_message_with_uuid(
                kcoder_types::Message::user_text("Original owned user history"),
                &uuid::Uuid::new_v4().to_string(),
            )
            .await?;
    }
    let address = peer_guard.source()?.address()?;
    let service = PeerMessageService::capture(fixture.paths.clone(), source.state.cwd(), None)?;
    let directory = service
        .live_registry(false)?
        .context("actual locator registry")?;
    let mut saved = None;
    directory.visit_entry_names_bounded(32, |name| {
        if name
            .to_string_lossy()
            .starts_with(&format!("{}.", peer.session_id()))
        {
            let mut bytes = Vec::new();
            directory
                .open_single_link_regular_file(name)?
                .take(2049)
                .read_to_end(&mut bytes)?;
            saved = Some((name.to_owned(), bytes));
        }
        Ok(())
    })?;
    assert!(registry::live_candidates(&service)?.contains(&address));
    let (name, bytes) = saved.context("original published locator")?;
    peer_guard.retire_writer().await;
    // Process death can leave the original public locator bytes behind. An
    // unlocked inode carries no resident fact and remains untouched here.
    directory.atomic_replace(&name, &bytes)?;
    assert!(!registry::live_candidates(&service)?.contains(&address));
    let mut after = Vec::new();
    directory
        .open_single_link_regular_file(&name)?
        .read_to_end(&mut after)?;
    assert_eq!(after, bytes);
    let output = source
        .active_tool_registry()
        .get("ListSessions")
        .context("actual discovery contribution")?
        .call(json!({}), &ToolContext::new(source.state.clone()))
        .await?;
    let value: Value = serde_json::from_str(tool_text(&output)?)?;
    let row = value["targets"]
        .as_array()
        .context("target directory")?
        .iter()
        .find(|row| row["threadId"] == peer.session_id())
        .context("original cold target remains discoverable")?;
    assert_eq!(row["presence"], "not_resident");
    assert_eq!(row["allowedModes"], json!(["enqueue_only"]));
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    source_guard.retire_writer().await;
    Ok(())
}
struct NoModel(Arc<AtomicUsize>);
impl kcoder_api::Provider for NoModel {
    fn name(&self) -> &'static str {
        "owned-peer-no-model"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Box::pin(futures::stream::empty()))
    }
}
struct Fixture {
    root: tempfile::TempDir,
    paths: kcoder_config::ConfigPaths,
    calls: Arc<AtomicUsize>,
}
impl Fixture {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        let profile = root.path().join("profile");
        let directory = kcoder_config::PrivateDirectory::open_or_create(&profile)?;
        directory.atomic_replace(
            std::ffi::OsStr::new("settings.json"),
            br#"{"cross_session_messages":{"enabled":true,"wake_idle":true}}"#,
        )?;
        let workspace = root.path().join("workspace");
        kcoder_config::PrivateDirectory::open_or_create(&workspace)?;
        let paths = kcoder_config::ConfigPaths::with_config_dir_and_executable_dir(
            &workspace, profile, None,
        );
        Ok(Self {
            root,
            paths,
            calls: Arc::new(AtomicUsize::new(0)),
        })
    }
    fn engine(&self) -> Result<QueryEngine> {
        self.engine_for_workspace(self.root.path().join("workspace"))
    }
    fn engine_for_workspace(&self, workspace: PathBuf) -> Result<QueryEngine> {
        // Shared physical history root makes the directory prove each native
        // session's actual base workspace rather than trusting its file path.
        let history = self.root.path().join("workspace").join("history");
        kcoder_config::PrivateDirectory::open_or_create(&history)?;
        let state = AppState::new(&workspace);
        state.with_history_path(history.join(format!("{}.jsonl", state.session_id())));
        let mut settings = Settings {
            permission_mode: kcoder_config::PermissionMode::Yolo,
            ..Settings::default()
        };
        settings.tools.profile = ToolProfile::Full;
        Ok(QueryEngine::new_with_folder_trust(
            Arc::new(NoModel(self.calls.clone())),
            state,
            ToolRegistry::new(),
            PermissionEngine::from_settings(&settings),
            settings,
            kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
            kcoder_skills::SkillRegistry::empty(),
            Arc::new(kcoder_tools::DenyAllUserQuestioner),
            workspace,
            Some(true),
        )
        .with_settings_persistence_path(self.paths.user_settings.clone()))
    }
}
#[tokio::test]
async fn actual_tool_hosts_share_native_mailbox_and_recheck_the_original_live_source() -> Result<()>
{
    let fixture = Fixture::new()?;
    let mut sender = fixture.engine()?;
    let mut target = fixture.engine()?;
    let sender_guard =
        host::attach(&mut sender, fixture.paths.clone())?.context("sender guard required")?;
    let target_guard =
        host::attach(&mut target, fixture.paths.clone())?.context("target guard required")?;
    sender
        .state
        .commit_message_with_uuid(
            kcoder_types::Message::user_text(
                "Owned source user authorizes this fixture's peer message",
            ),
            &uuid::Uuid::new_v4().to_string(),
        )
        .await?;
    let ctx = ToolContext::new(sender.state.clone());
    let list = sender
        .active_tool_registry()
        .get("ListSessions")
        .context("real discovery tool")?
        .call(json!({}), &ctx)
        .await?;
    assert!(!list.is_error);
    let listing: Value = serde_json::from_str(tool_text(&list)?)?;
    let peer = &listing["targets"][0];
    assert_eq!(listing["targets"].as_array().unwrap().len(), 1);
    assert_eq!(peer["threadId"], target.session_id());
    assert_eq!(peer["status"], "idle");
    let address: SessionAddressV1 = serde_json::from_value(peer["address"].clone())?;
    let intent = AgentMessageIntent {
        reply_to_message_id: None,
        target_thread_id: target.session_id(),
        target_address: Some(address),
        client_message_id: "owned-message".into(),
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        text: "Actual native peer body".into(),
    };
    let send = sender
        .active_tool_registry()
        .get("SendSessionMessage")
        .context("real sender tool")?
        .call(serde_json::to_value(&intent)?, &ctx)
        .await?;
    assert!(!send.is_error, "{}", tool_text(&send)?);
    let receipt: AgentMessageReceipt = serde_json::from_str(tool_text(&send)?)?;
    assert_eq!(receipt.status, AgentMessageStatus::Queued);
    let original = sender_guard
        .source()?
        .check_original(&OriginalSourceCheck::for_intent(&intent)?)?;
    assert_eq!(
        original.attestation.claims.source_address,
        sender_guard.source()?.address()?
    );
    let applied = target
        .apply_peer_messages_at_idle()
        .await
        .map_err(anyhow::Error::msg)?;
    assert_eq!(applied.len(), 1);
    assert_eq!(
        applied[0].message().peer_agent_data().unwrap().1,
        "Actual native peer body"
    );
    assert!(
        !target
            .peer_idle_wake_authorized(&applied)
            .await
            .map_err(anyhow::Error::msg)?,
        "enqueue-only is never a wake grant"
    );
    let get = sender
        .active_tool_registry()
        .get("GetSessionMessageReceipt")
        .context("real receipt tool")?
        .call(json!({"clientMessageId":"owned-message"}), &ctx)
        .await?;
    assert!(!get.is_error);
    assert_eq!(
        serde_json::from_str::<Value>(tool_text(&get)?)?["receipt"]["status"],
        "applied"
    );
    let mut pending = intent;
    pending.client_message_id = "after-disconnect".into();
    let result = sender
        .active_tool_registry()
        .get("SendSessionMessage")
        .unwrap()
        .call(serde_json::to_value(&pending)?, &ctx)
        .await?;
    assert!(!result.is_error);
    drop(sender_guard);
    assert!(
        target
            .apply_peer_messages_at_idle()
            .await
            .map_err(anyhow::Error::msg)?
            .is_empty()
    );
    let service = target_guard.source()?.service().clone();
    let source = service.message_source(&sender.session_id())?;
    assert_eq!(
        service
            .mailbox()?
            .get_by_client_id(&source, "after-disconnect")?
            .unwrap()
            .status,
        AgentMessageStatus::Queued
    );
    assert_eq!(
        fixture.calls.load(Ordering::SeqCst),
        0,
        "discovery/delivery/get never call a model"
    );
    drop(target_guard);
    assert!(
        registry::live_candidates(&service)?.is_empty(),
        "only owned live locators are cleaned"
    );
    Ok(())
}

fn owned_status_attempt(
    thread: &str,
    number: usize,
    accepted: u64,
) -> kcoder_state::turn_attempt_store::TurnAttemptRecord {
    kcoder_state::turn_attempt_store::TurnAttemptRecord {
        version: 1,
        client_presentation: None,
        identity: kcoder_types::TurnAttemptIdentity {
            thread_id: thread.into(),
            turn_id: format!("owned-status-turn-{number}"),
            attempt_id: format!("owned-status-attempt-{number}"),
        },
        parent_attempt_id: None,
        retry_operation_id: None,
        accepted_at_ms: accepted,
        input_context_hash: "a".repeat(64),
        request_fingerprint: None,
        retained_input: None,
        status: kcoder_types::TurnAttemptStatus::Accepted,
        completion: None,
    }
}

fn finish_owned_status_attempt(
    store: &kcoder_state::turn_attempt_store::TurnAttemptStore,
    record: &kcoder_state::turn_attempt_store::TurnAttemptRecord,
) -> Result<()> {
    store.finish(
        &record.identity,
        kcoder_state::turn_attempt_store::TurnAttemptCompletion {
            status: kcoder_types::TurnAttemptStatus::Completed,
            finished_at_ms: record.accepted_at_ms + 1,
            error: None,
            provider_failure: None,
            partial_output: String::new(),
            partial_output_truncated: false,
            committed_history_uuid: None,
        },
    )?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_target_with_long_native_history_can_be_discovered_and_receive_the_original_message()
-> Result<()> {
    let fixture = Fixture::new()?;
    let mut sender = fixture.engine()?;
    let mut target = fixture.engine()?;
    let _sender_guard =
        host::attach(&mut sender, fixture.paths.clone())?.context("sender guard")?;
    let target_guard = host::attach(&mut target, fixture.paths.clone())?.context("target guard")?;
    let target_id = target.session_id();
    let store = kcoder_state::turn_attempt_store::TurnAttemptStore::open(
        &target.session_storage_dir_for(&target_id),
        &target_id,
    )?;
    for number in 0..256 {
        let record = owned_status_attempt(&target_id, number, number as u64 + 1);
        store.begin(record.clone())?;
        finish_owned_status_attempt(&store, &record)?;
    }
    let at_limit = target_guard.source()?.observe_status()?;
    assert_eq!(at_limit.status, kcoder_app_protocol::ThreadStatus::Idle);
    assert!(at_limit.last_turn.is_none());
    let extra = owned_status_attempt(&target_id, 256, 257);
    store.begin(extra.clone())?;
    finish_owned_status_attempt(&store, &extra)?;
    let observed = target_guard.source()?.observe_status()?;
    assert_eq!(observed.status, kcoder_app_protocol::ThreadStatus::Unknown);
    assert!(observed.last_turn.is_none());
    assert_eq!(
        observed.presence,
        kcoder_app_protocol::cross_session_messages::AgentMessageTargetPresence::Resident
    );
    sender
        .state
        .commit_message_with_uuid(
            kcoder_types::Message::user_text("Owned source authorizes a long-history peer"),
            &uuid::Uuid::new_v4().to_string(),
        )
        .await?;
    let context = ToolContext::new(sender.state.clone());
    let listed = sender
        .active_tool_registry()
        .get("ListSessions")
        .context("actual list")?
        .call(json!({}), &context)
        .await?;
    let listing: Value = serde_json::from_str(tool_text(&listed)?)?;
    let row = listing["targets"]
        .as_array()
        .context("targets")?
        .iter()
        .find(|row| row["threadId"] == target_id)
        .context("live long-history target")?;
    assert_eq!(row["status"], "unknown");
    assert!(row.get("lastTurn").is_none_or(Value::is_null));
    let intent = AgentMessageIntent {
        reply_to_message_id: None,
        target_thread_id: target_id,
        target_address: Some(serde_json::from_value(row["address"].clone())?),
        client_message_id: "long-live-original".into(),
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        text: "Original long-history peer message".into(),
    };
    let output = sender
        .active_tool_registry()
        .get("SendSessionMessage")
        .context("actual sender")?
        .call(serde_json::to_value(&intent)?, &context)
        .await?;
    let receipt: AgentMessageReceipt = serde_json::from_str(tool_text(&output)?)?;
    assert_eq!(receipt.client_message_id, intent.client_message_id);
    assert_eq!(receipt.status, AgentMessageStatus::Queued);
    let applied = target
        .apply_peer_messages_at_idle()
        .await
        .map_err(anyhow::Error::msg)?;
    assert_eq!(applied.len(), 1);
    assert_eq!(
        applied[0].message().peer_agent_data().unwrap().1,
        intent.text
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
async fn live_target_with_clock_rollback_or_corrupt_ledger_never_claims_idle_or_a_last_turn()
-> Result<()> {
    let fixture = Fixture::new()?;
    let mut target = fixture.engine()?;
    let guard = host::attach(&mut target, fixture.paths.clone())?.context("target guard")?;
    let target_id = target.session_id();
    let directory = target.session_storage_dir_for(&target_id);
    let store = kcoder_state::turn_attempt_store::TurnAttemptStore::open(&directory, &target_id)?;
    let completed = owned_status_attempt(&target_id, 1, 200);
    store.begin(completed.clone())?;
    finish_owned_status_attempt(&store, &completed)?;
    store.begin(owned_status_attempt(&target_id, 2, 100))?;
    let observed = guard.source()?.observe_status()?;
    assert_eq!(observed.status, kcoder_app_protocol::ThreadStatus::Unknown);
    assert!(observed.last_turn.is_none());
    let attempts = directory.join("turn-attempts");
    let file = std::fs::read_dir(attempts)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .find(|path| path.to_string_lossy().ends_with(".attempt.json"))
        .context("owned attempt record")?;
    std::fs::write(file, b"{broken")?;
    assert!(
        guard.source()?.observe_status().is_err(),
        "corruption is not a budget observation"
    );
    Ok(())
}

#[tokio::test]
async fn live_source_rechecks_disabled_tools_and_does_not_accept_a_foreign_state_call() -> Result<()>
{
    let fixture = Fixture::new()?;
    let mut sender = fixture.engine()?;
    let mut target = fixture.engine()?;
    let sender_guard = host::attach(&mut sender, fixture.paths.clone())?.unwrap();
    let _target_guard = host::attach(&mut target, fixture.paths.clone())?.unwrap();
    let source = sender_guard.source()?;
    sender
        .state
        .commit_message_with_uuid(
            kcoder_types::Message::user_text(
                "Owned source user authorizes this fixture's peer message",
            ),
            &uuid::Uuid::new_v4().to_string(),
        )
        .await?;

    let intent = AgentMessageIntent {
        reply_to_message_id: None,
        target_thread_id: target.session_id(),
        target_address: Some(source.service().address(&target.session_id())?),
        client_message_id: "original".into(),
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        text: "Original bound contribution".into(),
    };
    let send = sender
        .active_tool_registry()
        .get("SendSessionMessage")
        .unwrap();
    let foreign = fixture.engine()?;
    assert!(
        send.call(
            serde_json::to_value(&intent)?,
            &ToolContext::new(foreign.state)
        )
        .await
        .is_err()
    );
    let result = send
        .call(
            serde_json::to_value(&intent)?,
            &ToolContext::new(sender.state.clone()),
        )
        .await?;
    assert!(!result.is_error);
    let check = OriginalSourceCheck::for_intent(&intent)?;
    source.check_original(&check)?;
    sender
        .settings
        .write()
        .unwrap()
        .tools
        .disabled
        .push("SendSessionMessage".into());
    assert!(source.check_original(&check).is_err());
    assert!(
        target
            .apply_peer_messages_at_idle()
            .await
            .map_err(anyhow::Error::msg)?
            .is_empty()
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
async fn disabling_failed_gateway_preserves_history_lease_and_normal_engine() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut engine = fixture.engine()?;
    let mut runtime =
        host::attach(&mut engine, fixture.paths.clone())?.context("original interactive owner")?;
    let owner = engine.state.inspection_lifecycle_identity();
    let history = engine.session_lease_target();
    let settings = serde_json::to_value(&*engine.settings.read().unwrap())?;
    engine = engine.without_session_communication()?;
    runtime.disable_communication();
    for name in [
        "ListSessions",
        "SendSessionMessage",
        "GetSessionMessageReceipt",
    ] {
        assert!(engine.active_tool_registry().get(name).is_none());
    }
    assert!(!engine.has_peer_message_host());
    assert_eq!(owner.try_matches(&engine.state), Some(true));
    assert_eq!(
        serde_json::to_value(&*engine.settings.read().unwrap())?,
        settings
    );
    runtime.native_witness()?.verify_target(&history)?;
    assert!(
        kcoder_cli_storage::session_lease::SessionLease::acquire(&history).is_err(),
        "ordinary coding keeps its exclusive native owner after communication is disabled"
    );
    assert!(runtime.source().is_err());
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
async fn interactive_clear_rebinds_the_actual_native_owner_without_reusing_old_tools() -> Result<()>
{
    let fixture = Fixture::new()?;
    let mut sender = fixture.engine()?;
    let mut target = fixture.engine()?;
    let local = host::attach(&mut sender, fixture.paths.clone())?;
    let _target = host::attach(&mut target, fixture.paths.clone())?.context("target")?;
    sender
        .state
        .commit_message_with_uuid(
            kcoder_types::Message::user_text("Original owned conversation"),
            &uuid::Uuid::new_v4().to_string(),
        )
        .await?;
    let old_id = sender.session_id();
    let old_history = sender.session_lease_target();
    let old_bytes = std::fs::read(&old_history)?;
    let old_source = local.as_ref().context("local")?.source()?;
    let old_tool = sender
        .active_tool_registry()
        .get("ListSessions")
        .context("old tool")?
        .clone();
    let runtime =
        InteractivePeerRuntime::capture(&mut sender, fixture.paths.clone(), local, None, None)?;
    sender.start_new_session_with_lifecycle()?;
    assert_ne!(sender.session_id(), old_id);
    sender = sender.refresh_interactive_session_hosts().await?;
    let new_history = sender.session_lease_target();
    assert_ne!(new_history, old_history);
    assert!(old_source.address().is_err());
    assert!(
        old_tool
            .call(json!({}), &ToolContext::new(sender.state.clone()))
            .await
            .is_err()
    );
    assert!(kcoder_cli_storage::session_lease::SessionLease::acquire(&new_history).is_err());
    assert_eq!(std::fs::read(&old_history)?, old_bytes);
    let new_tool = sender
        .active_tool_registry()
        .get("ListSessions")
        .context("new tool")?
        .clone();
    let result = new_tool
        .call(json!({}), &ToolContext::new(sender.state.clone()))
        .await?;
    let listing: Value = serde_json::from_str(tool_text(&result)?)?;
    assert!(
        listing["targets"]
            .as_array()
            .context("targets")?
            .iter()
            .any(|row| row["threadId"] == target.session_id())
    );
    let keep_engine_alive = sender.clone();
    runtime.close().await;
    assert!(
        kcoder_cli_storage::session_lease::SessionLease::acquire(&new_history).is_ok(),
        "cloned Engine hooks cannot retain the departed REPL's native owner"
    );
    assert!(
        keep_engine_alive
            .refresh_interactive_session_hosts()
            .await
            .is_err()
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
async fn interactive_model_refresh_rotates_contributions_and_retains_original_admission_facts()
-> Result<()> {
    let fixture = Fixture::new()?;
    let mut sender = fixture.engine()?;
    let mut target = fixture.engine()?;
    let local = host::attach(&mut sender, fixture.paths.clone())?.context("local")?;
    let _target = host::attach(&mut target, fixture.paths.clone())?.context("target")?;
    sender
        .state
        .commit_message_with_uuid(
            kcoder_types::Message::user_text("Original user permits the owned peer fixture"),
            &uuid::Uuid::new_v4().to_string(),
        )
        .await?;
    let old_source = local.source()?;
    let old_send = sender
        .active_tool_registry()
        .get("SendSessionMessage")
        .context("old send")?
        .clone();
    let intent = AgentMessageIntent {
        reply_to_message_id: None,
        client_message_id: "before-model-refresh".into(),
        target_thread_id: target.session_id(),
        target_address: Some(old_source.service().address(&target.session_id())?),
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        text: "Original stable operation survives a model switch".into(),
    };
    let context = ToolContext::new(sender.state.clone());
    old_send
        .call(serde_json::to_value(&intent)?, &context)
        .await?;
    old_source.check_original(&OriginalSourceCheck::for_intent(&intent)?)?;
    let old_binding = sender.session_communication_binding();
    let history = sender.session_lease_target();
    let owner = InteractivePeerRuntime::capture(
        &mut sender,
        fixture.paths.clone(),
        Some(local),
        None,
        None,
    )?;
    sender.settings.write().unwrap().model = "actual-model-replacement".into();
    sender = sender.refresh_interactive_session_hosts().await?;
    assert!(!old_binding.matches(&sender));
    assert!(
        old_source
            .check_original(&OriginalSourceCheck::for_intent(&intent)?)
            .is_err()
    );
    assert!(
        old_send
            .call(serde_json::to_value(&intent)?, &context)
            .await
            .is_err()
    );
    assert!(kcoder_cli_storage::session_lease::SessionLease::acquire(&history).is_err());
    let applied = target
        .apply_peer_messages_at_idle()
        .await
        .map_err(anyhow::Error::msg)?;
    assert_eq!(
        applied.len(),
        1,
        "the original CID remains verifiable through the new current source"
    );
    let current_get = sender
        .active_tool_registry()
        .get("GetSessionMessageReceipt")
        .context("current get")?
        .clone();
    let receipt = current_get
        .call(
            json!({"clientMessageId": intent.client_message_id}),
            &context,
        )
        .await?;
    assert_eq!(
        serde_json::from_str::<Value>(tool_text(&receipt)?)?["receipt"]["status"],
        "applied"
    );
    sender.settings.write().unwrap().model_capabilities.tools = false;
    sender = sender.refresh_interactive_session_hosts().await?;
    assert!(sender.active_tool_registry().get("ListSessions").is_none());
    assert!(
        current_get
            .call(
                json!({"clientMessageId": intent.client_message_id}),
                &context
            )
            .await
            .is_err()
    );
    owner.close().await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    Ok(())
}
