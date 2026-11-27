//! A real Source revocation races the real Native peer adapter's second check.
use super::*;
use crate::app_server::session_messages::idle_turn::{
    PeerIdleTurnContext, pre_admission_barrier, start_peer_idle_turn,
};

fn attempts(fixture: &Fixture) -> Result<Vec<kcoder_state::turn_attempt_store::TurnAttemptRecord>> {
    kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
        &fixture.original_artifacts.join(&fixture.target),
        &fixture.target,
    )?
    .context("the real seed attempt store")?
    .list_with_budget(256, 4 * 1024 * 1024)
}

fn accounting(fixture: &Fixture) -> Result<(u64, u64)> {
    let mailbox = fixture
        .service
        .profile_path()
        .join("peer-router-v1")
        .join(format!(
            "mailbox-{}",
            fixture.service.identity()?.workspace_id
        ));
    let disk: Value = serde_json::from_slice(&std::fs::read(mailbox.join("messages.json"))?)?;
    let child = disk["binding"]["child"]
        .as_str()
        .context("the original archive binding")?;
    ensure!(
        child.starts_with("receipt-archive-") && !child.contains(['/', '\\']),
        "owned archive leaf"
    );
    let db = rusqlite::Connection::open_with_flags(
        mailbox.join(child).join("catalog.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let checkpoint: Vec<u8> = db.query_row(
        "SELECT body FROM receipt_archive_checkpoint WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    let checkpoint: Value = serde_json::from_slice(&checkpoint)?;
    let used = checkpoint["peerWakeBudgets"][&fixture.target]["used"]
        .as_u64()
        .context("the original real budget")?;
    let claims: u64 = db.query_row(
        "SELECT count(*) FROM receipt_archive_rows WHERE message_id LIKE 'claim/%'",
        [],
        |row| row.get(0),
    )?;
    Ok((used, claims))
}

pub(super) async fn run() -> Result<()> {
    let mut fixture = Fixture::new().await?;
    let (cold, mut idle, mut manager, _driver_events) = fixture.driver(true)?;
    let original = fixture
        .send(
            "one-original-pre-admission-wake",
            AgentMessageMode::WakeIfIdle,
        )
        .await?;
    let runtime = activate(&cold.owner, &fixture.target).await?;
    assert!(manager.insert_cold_peer(runtime).is_ok());
    let seed = attempts(&fixture)?;
    assert_eq!(seed.len(), 1);
    assert_eq!(seed[0].status, kcoder_types::TurnAttemptStatus::Completed);
    let (outbound, mut events) = mpsc::channel(128);
    let next_turn_id = Arc::new(AtomicU64::new(1));
    let sequence = Arc::new(AtomicU64::new(1));
    let cancel = CancellationToken::new();
    for denial in 0..3 {
        fixture
            .source
            .settings
            .write()
            .unwrap()
            .tools
            .disabled
            .clear();
        let runtime = manager
            .try_peer_idle_runtime(&fixture.target)
            .context("the actual idle runtime and registration")?;
        let witnesses = runtime
            .engine
            .apply_peer_messages_at_idle()
            .await
            .map_err(anyhow::Error::msg)?;
        assert_eq!(witnesses.len(), 1);
        assert!(witnesses[0].has_pending_idle_wake_admission());
        let gate = pre_admission_barrier::arm(&fixture.target);
        let settings = fixture.source.settings.clone();
        let context = PeerIdleTurnContext {
            outbound: outbound.clone(),
            server_id: "owned-pre-admission".into(),
            sequence: sequence.clone(),
            next_turn_id: next_turn_id.clone(),
            cancel: cancel.clone(),
            attended: false,
        };
        let rejection = start_peer_idle_turn(runtime, witnesses, context);
        let revoke = async move {
            tokio::time::timeout(Duration::from_secs(10), gate.reached())
                .await
                .unwrap();
            settings
                .write()
                .unwrap()
                .tools
                .disabled
                .push("SendSessionMessage".into());
            drop(gate);
        };
        let (result, ()) = tokio::join!(rejection, revoke);
        assert!(
            !matches!(result, Ok(true)),
            "a revoked Source cannot start a peer turn"
        );
        assert_eq!(
            fixture.calls.lock().unwrap().len(),
            1,
            "pre-admission rejection cannot dispatch a Provider"
        );
        assert!(
            events.try_recv().is_err(),
            "an unaccepted peer cannot announce a turn"
        );
        let observed = attempts(&fixture)?;
        if observed.len() != 1 {
            let observation = json!({"denial":denial,"original":original,"seed":seed,"observed":observed,
                "target":fixture.target,"history":fixture.target_history,"artifacts":fixture.original_artifacts});
            PrivateDirectory::open_existing(&std::env::current_dir()?)?.atomic_replace(
                OsStr::new("pre-admission-rejection.json"),
                &serde_json::to_vec_pretty(&observation)?,
            )?;
            let retained = fixture._workspace.take().map(tempfile::TempDir::keep);
            eprintln!("original pre-admission workspace retained at {retained:?}");
        }
        assert_eq!(
            observed.len(),
            1,
            "a denied pre-admission cannot create a Native attempt or displace the seed terminal"
        );
        assert_eq!(observed[0].identity, seed[0].identity);
        assert_eq!(
            observed[0].status,
            kcoder_types::TurnAttemptStatus::Completed
        );
        assert_eq!(
            serde_json::to_value(&observed[0])?,
            serde_json::to_value(&seed[0])?,
            "the original authoritative last-turn record must remain unchanged"
        );
        assert_eq!(
            accounting(&fixture)?,
            (0, 0),
            "a denied pre-admission spends no claim"
        );
    }
    fixture
        .source
        .settings
        .write()
        .unwrap()
        .tools
        .disabled
        .clear();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            idle.tick(&manager, Some(&fixture.service));
            if fixture.calls.lock().unwrap().len() == 2 && !manager.is_turn_running(&fixture.target)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    let all = attempts(&fixture)?;
    assert_eq!(all.len(), 2);
    assert!(
        all.iter()
            .all(|a| a.status == kcoder_types::TurnAttemptStatus::Completed)
    );
    let receipt = fixture
        .service
        .mailbox()?
        .get_record_by_message_id(&original.message_id)?
        .unwrap()
        .receipt;
    assert_eq!(receipt.message_id, original.message_id);
    assert_eq!(receipt.client_message_id, original.client_message_id);
    assert_eq!(receipt.status, AgentMessageStatus::Applied);
    assert_eq!(
        accounting(&fixture)?,
        (1, 1),
        "the same original Wake is accepted exactly once"
    );
    idle.shutdown().await;
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
    fixture.close().await
}
