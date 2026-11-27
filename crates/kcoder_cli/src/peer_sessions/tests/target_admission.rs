use super::*;
use futures::StreamExt;
use tokio_util::sync::CancellationToken;

struct HeldProvider;
struct ActualTestTurn {
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl Drop for ActualTestTurn {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
impl ActualTestTurn {
    async fn cancel_and_finish(mut self) -> Result<()> {
        self.cancel.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(5), self.task.take().unwrap())
            .await??;
        Ok(())
    }
    async fn abort(mut self) {
        let task = self.task.take().unwrap();
        task.abort();
        let _ = task.await;
    }
}
impl kcoder_api::Provider for HeldProvider {
    fn name(&self) -> &'static str {
        "owned-turn-admission-held-provider"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        Ok(Box::pin(futures::stream::pending()))
    }
}
fn held_engine(fixture: &Fixture) -> Result<QueryEngine> {
    let workspace = fixture.root.path().join("workspace");
    let history = workspace.join("history");
    kcoder_config::PrivateDirectory::open_or_create(&history)?;
    let state = AppState::new(&workspace);
    state.with_history_path(history.join(format!("{}.jsonl", state.session_id())));
    let mut settings = Settings {
        permission_mode: kcoder_config::PermissionMode::Yolo,
        ..Settings::default()
    };
    settings.tools.profile = ToolProfile::Full;
    settings.context_window_tokens = Some(128_000);
    settings.context_output_headroom = Some(1024);
    settings.max_tokens = Some(128);
    settings.model = "owned-held-model".into();
    settings.api_format = Some(kcoder_config::ApiFormat::OpenaiChatCompletions);
    Ok(QueryEngine::new_with_folder_trust(
        Arc::new(HeldProvider),
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
    .with_settings_persistence_path(fixture.paths.user_settings.clone()))
}
async fn start_actual_stream(
    engine: &QueryEngine,
) -> Result<(ActualTestTurn, kcoder_types::TurnAttemptIdentity)> {
    let cancel = CancellationToken::new();
    let execution = engine.clone();
    let token = cancel.clone();
    let task = tokio::spawn(async move {
        let mut stream =
            execution.run_turn_stream_with_cancel(&kcoder_permissions::AutoAllowPrompt, token);
        while stream.next().await.is_some() {}
    });
    let owned = ActualTestTurn {
        cancel,
        task: Some(task),
    };
    let observed = engine.owned_turn_observer();
    let identity = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Ok(Some(identity)) = observed.current_identity() {
                break identity;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .context("actual owned foreground did not register")?;
    Ok((owned, identity))
}

#[tokio::test]
async fn actual_target_owner_admits_current_turn_and_rejects_new_cancelled_turn_without_queueing()
-> Result<()> {
    let fixture = Fixture::new()?;
    let mut sender = fixture.engine()?;
    let mut target = held_engine(&fixture)?;
    let source_owner = host::attach(&mut sender, fixture.paths.clone())?.unwrap();
    let target_owner = host::attach(&mut target, fixture.paths.clone())?.unwrap();
    sender
        .state
        .commit_message_with_uuid(
            kcoder_types::Message::user_text("Owned original sender input"),
            "owned-original-input",
        )
        .await?;
    target
        .state
        .commit_message_with_uuid(
            kcoder_types::Message::user_text("Owned held target turn"),
            "owned-held-target-input",
        )
        .await?;
    let (turn, actual) = start_actual_stream(&target).await?;
    let request = AgentMessageIntent {
        reply_to_message_id: None,
        target_thread_id: target.session_id(),
        target_address: Some(target_owner.source()?.address()?),
        client_message_id: "actual-current-turn-message".into(),
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: Some(actual.turn_id.clone()),
        text: "Owned current-turn reference".into(),
    };
    let tool = sender
        .active_tool_registry()
        .get("SendSessionMessage")
        .unwrap()
        .clone();
    let context = ToolContext::new(sender.state.clone());
    let output = tool.call(serde_json::to_value(&request)?, &context).await?;
    let first: AgentMessageReceipt = serde_json::from_str(tool_text(&output)?)?;
    assert_eq!(first.status, AgentMessageStatus::Queued);
    turn.cancel_and_finish().await?;
    assert!(
        target
            .owned_turn_observer()
            .current_identity()
            .map_err(anyhow::Error::msg)?
            .is_none()
    );
    let output = tool.call(serde_json::to_value(&request)?, &context).await?;
    let original: AgentMessageReceipt = serde_json::from_str(tool_text(&output)?)?;
    assert_eq!(
        original.message_id, first.message_id,
        "the original CID is reconciled after its target turn ends"
    );
    let mut stale = request.clone();
    stale.client_message_id = "actual-new-cancelled-turn-message".into();
    let source = source_owner.source()?;
    let service = source.service();
    let queue = service.mailbox()?;
    let source_identity = service.message_source(&sender.session_id())?;
    let revision_before_rejection = queue.revision()?;
    let error = match tool.call(serde_json::to_value(&stale)?, &context).await {
        Err(error) => error,
        Ok(_) => anyhow::bail!("expected a pre-admission rejection"),
    };
    let error_payload = match error {
        kcoder_tools::ToolError::Execution(payload) => payload,
        other => anyhow::bail!("expected a pre-admission rejection, got {other}"),
    };
    let rejection: serde_json::Value = serde_json::from_str(&error_payload)?;
    assert_eq!(rejection["code"], "peer_message_target_turn_changed");
    assert_eq!(rejection["status"], "rejected_before_admission");
    assert_eq!(rejection["clientMessageId"], stale.client_message_id);
    assert_eq!(queue.revision()?, revision_before_rejection);
    assert!(
        queue
            .get_by_client_id(&source_identity, &stale.client_message_id)?
            .is_none()
    );
    assert!(
        queue
            .pending_for_target(&target.session_id())?
            .iter()
            .all(|row| row.receipt.client_message_id != stale.client_message_id)
    );
    Ok(())
}

#[tokio::test]
async fn pending_owned_commit_pins_only_the_original_fd_while_all_weak_authorization_is_revoked()
-> Result<()> {
    use kcoder_cli_storage::session_lease::SessionLease;
    let fixture = Fixture::new()?;
    let engine = held_engine(&fixture)?;
    let history = engine.session_lease_target();
    let mut lease = SessionLease::acquire(&history)?;
    super::super::turn_retirement::bind(&mut lease, &engine, None);
    let witness = lease.native_witness()?;
    let (turn, actual) = start_actual_stream(&engine).await?;
    let observer = engine.owned_turn_observer();
    let pin = observer
        .admit_expected(&actual.turn_id)
        .await
        .map_err(anyhow::Error::msg)?;
    drop(lease);
    assert!(
        witness.verify_target(&history).is_err(),
        "a pending commit cannot keep generic authorization alive"
    );
    assert!(observer.try_admit_expected(&actual.turn_id).is_err());
    assert!(
        SessionLease::open(&history, false).is_err(),
        "the original FD remains locked until its admitted worker exits"
    );
    turn.abort().await;
    drop(pin);
    let replacement = SessionLease::open(&history, false)?;
    replacement.native_witness()?.verify_target(&history)?;
    drop(replacement);
    let mut lease = SessionLease::open(&history, false)?;
    super::super::turn_retirement::bind(&mut lease, &engine, None);
    let ordinary_observer = engine.owned_turn_observer();
    drop(lease);
    assert!(
        SessionLease::open(&history, false).is_ok(),
        "an ordinary observer never retains a lease FD"
    );
    drop(ordinary_observer);
    Ok(())
}
