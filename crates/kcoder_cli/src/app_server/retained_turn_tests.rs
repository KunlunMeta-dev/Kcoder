//! Controlled turn dispatch with real private files, upload and receipt journals.
//! Faults are thread-keyed and injected only after durable Accepted, before spawn.
use super::*;
use kcoder_app_protocol::*;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex as SyncMutex};

// ConfigPaths is process-global. Isolate each durable-storage test rather than
// changing environment under concurrent Rust tests or using ephemeral storage.
fn isolated(case: &str) -> bool {
    let name = format!("app_server::retained_turn::tests::{case}");
    if std::env::var("KCODER_B5_WIRE_CASE").as_deref() == Ok(name.as_str()) {
        let root = std::path::PathBuf::from(std::env::var_os("KCODER_B5_WIRE_OWNED_ROOT").unwrap());
        assert!(
            std::path::PathBuf::from(std::env::var_os("KCODER_CONFIG_DIR").unwrap())
                .starts_with(root)
        );
        return false;
    }
    let temp = tempfile::Builder::new()
        .prefix("kcoder-retained-wire-")
        .tempdir()
        .unwrap();
    let log = temp.path().join("child.log");
    let stdout = std::fs::File::create(&log).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &name, "--nocapture"])
        .env("KCODER_B5_WIRE_CASE", &name)
        .env("KCODER_B5_WIRE_OWNED_ROOT", temp.path())
        .env("KCODER_CONFIG_DIR", temp.path().join("config"))
        .env_remove("KCODER_HOME")
        .env("HOME", temp.path())
        .env("XDG_CONFIG_HOME", temp.path().join("xdg"))
        .stdin(std::process::Stdio::null())
        .stdout(stdout.try_clone().unwrap())
        .stderr(stdout)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!(
                "owned retained test child deadline: {}",
                std::fs::read_to_string(&log).unwrap()
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    let raw = std::fs::read_to_string(&log).unwrap();
    assert!(status.success(), "owned child {name} failed: {raw}");
    println!("{raw}");
    true
}

#[derive(Clone, Copy)]
enum Fault {
    Handoff,
    TerminalWrite,
}
static FAULTS: LazyLock<SyncMutex<HashMap<String, Fault>>> = LazyLock::new(Default::default);
pub(super) fn before_handoff(engine: &QueryEngine, identity: &TurnAttemptIdentity) -> Result<()> {
    if let Some(fault) = FAULTS.lock().unwrap().remove(&identity.thread_id) {
        if matches!(fault, Fault::TerminalWrite) {
            let directory = engine
                .session_storage_dir_for(&identity.thread_id)
                .join("turn-attempts");
            // Keep the Accepted record intact. Unlike mode changes, this owned
            // leaf conflict cannot be repaired by opening the private directory.
            std::fs::rename(
                directory.join("attempts.lock"),
                directory.join("owned-attempts.lock.before-terminal-fault"),
            )?;
            std::fs::create_dir(directory.join("attempts.lock"))?;
            let probe = std::fs::OpenOptions::new()
                .append(true)
                .open(directory.join("attempts.lock"));
            assert_eq!(
                probe
                    .expect_err("fault requires actual ledger lock IO rejection")
                    .kind(),
                std::io::ErrorKind::IsADirectory
            );
            println!("terminal persistence fault: actual OS IsADirectory");
        }
        anyhow::bail!(RetentionFailure::Conflict);
    }
    Ok(())
}

struct CountingProvider(Arc<std::sync::atomic::AtomicUsize>);
impl kcoder_api::Provider for CountingProvider {
    fn name(&self) -> &'static str {
        "retained-wire-controlled"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(kcoder_api::ApiErrorKind::Api {
            error_type: "controlled_provider".into(),
            message: "retained recovery must not dispatch".into(),
        })
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    engine: QueryEngine,
    factory: AppServerEngineFactory,
    authority: retention_context::VerifiedRetentionAuthority,
    scope: Scope,
    params: TurnStartParams,
    calls: Arc<std::sync::atomic::AtomicUsize>,
}
impl Fixture {
    fn private_request(&self, method: &str, params: Value) -> PrivateRetentionRequestV1 {
        serde_json::from_value(json!({ "jsonrpc":"2.0", "id":9, "method":method,
            "params":params, "kcoderPrivateRetention": { "version":1,
                "context": self.scope.context, "workspaceTargetId":"registered-target" } }))
        .unwrap()
    }
    fn resident(
        &self,
        tx: &mpsc::Sender<Value>,
    ) -> (ThreadManager, ResidentTurnState, Arc<AtomicU64>) {
        let lease = SessionLease::acquire(&self.engine.session_lease_target()).unwrap();
        let sequence = Arc::new(AtomicU64::new(1));
        let state = ResidentTurnState::new(
            tx.clone(),
            kcoder_config::PermissionMode::Bypass,
            Arc::new(AtomicU64::new(2000000)),
            Arc::new(StdMutex::new(InteractionReceipts::default())),
        );
        let runtime = build_resident_thread_runtime(
            self.engine.clone(),
            lease,
            0,
            state.clone(),
            tx.clone(),
            "controlled-server".into(),
            sequence.clone(),
        );
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        (manager, state, sequence)
    }
}
fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let account = temp.path().join("account");
    PrivateDirectory::open_or_create(&account).unwrap();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let settings = kcoder_config::Settings {
        history_enabled: false,
        permission_mode: kcoder_config::PermissionMode::Bypass,
        ..Default::default()
    };
    let factory = AppServerEngineFactory::new(
        Arc::new(CountingProvider(calls.clone())),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        temp.path().to_path_buf(),
        None,
        true,
        kcoder_engine::WorkspaceRuntimeServices::try_new_for_client(temp.path(), "retained-wire")
            .unwrap(),
        None,
        temp.path().join("short-ids"),
    );
    let engine = factory
        .create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))
        .unwrap();
    let thread = engine.session_id();
    engine
        .state
        .with_history_path(temp.path().join(format!("{thread}.jsonl")));
    engine.state.save_history().unwrap();
    let authority = retention_context::capture(
        retention_context::RetentionLaunchConfiguration {
            parent: RetentionParentLaunchV1::LocalOs,
            account_root: account,
            optional: false,
            revocation_verifier: None,
        },
        &engine,
    )
    .unwrap();
    let context = TrustedRetentionContextV1 {
        gateway_namespace_id: "installation".into(),
        device_id: "device".into(),
        authorization_generation: "generation".into(),
        target_fingerprint: "target".into(),
        principal: RetentionPrincipalV1::LocalOs,
    };
    let dummy: PrivateRetentionRequestV1 = serde_json::from_value(json!({"jsonrpc":"2.0","id":1,
        "method":METHOD_ATTACHMENT_RETENTION_READ,"params":{"trustedContext":context,
            "selector":{"by":"clientRequestId","clientRequestId":format!("r1.root.1.{}","a".repeat(32))}},
        "kcoderPrivateRetention":{"version":1,"context":context,"workspaceTargetId":"registered-target"}})).unwrap();
    let scope = authority.retention_scope(&dummy).unwrap();
    let service = authority.retention_service();
    let admission = service.upload_admission().unwrap();
    let bytes = b"durable retained bytes";
    let mut upload: RetentionUploadParamsV1 = serde_json::from_value(json!({
        "ownerRequest":{"clientOwnerRequestId":format!("o1.{}.{}.{}", admission.root_namespace,admission.admission_epoch,"1".repeat(32)),"immutableParameters":{}},
        "clientUploadId":format!("u1.{}.{}.{}",admission.root_namespace,admission.admission_epoch,"2".repeat(32)),
        "trustedContext":context,"filename":"note.txt","size":bytes.len(),"contentSha256":hex_sha256(bytes)})).unwrap();
    service.start_wire_upload(&scope, &upload).unwrap();
    upload.offset = Some(0);
    upload.length = Some(bytes.len() as u64);
    upload.chunk_sha256 = Some(hex_sha256(bytes));
    service.chunk_wire_upload(&scope, &upload, bytes).unwrap();
    let RetentionUploadLookupV1::Present { recovery, .. } =
        service.finish_wire_upload(&scope, &upload).unwrap().lookup
    else {
        panic!("upload absent")
    };
    let stage = recovery.stage_ref.unwrap();
    let reserved = service
        .reserve(
            &scope,
            &format!(
                "r1.{}.{}.{}",
                admission.root_namespace,
                admission.admission_epoch,
                "3".repeat(32)
            ),
            &thread,
            std::slice::from_ref(&stage),
        )
        .unwrap();
    let params: TurnStartParams = serde_json::from_value(json!({"threadId":thread,"clientMessageId":"stable-message",
        "input":[{"type":"text","text":"inspect note"}],"retention":{
            "references":[{"retentionId":reserved.retention_id,"expectedRevision":reserved.revision,"entryIds":[stage.entry_id]}],
            "attachments":[{"entryId":stage.entry_id,"filename":"note.txt","mimeType":"text/plain"}]}})).unwrap();
    Fixture {
        _temp: temp,
        engine,
        factory,
        authority,
        scope,
        params,
        calls,
    }
}

async fn response(rx: &mut mpsc::Receiver<Value>, id: i64) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let value = rx.recv().await.expect("response channel closed");
            if value.get("id") == Some(&json!(id)) {
                return value;
            }
        }
    })
    .await
    .expect("response deadline")
}
async fn drain(manager: &mut ThreadManager) {
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
}
async fn dispatch(
    f: &mut Fixture,
    manager: &mut ThreadManager,
    sequence: &Arc<AtomicU64>,
    tx: &mpsc::Sender<Value>,
    id: Value,
) -> Result<DispatchControl> {
    super::super::turn_requests::dispatch(
        "turn/start",
        id,
        serde_json::to_value(&f.params)?,
        &mut f.engine,
        &f.factory,
        tx,
        manager,
        "controlled-server",
        sequence,
        &mut ConnectionState::default(),
        &mut AttachmentDirectories::default(),
        Some(Authority {
            service: f.authority.retention_service(),
            scope: &f.scope,
        }),
    )
    .await
}

#[tokio::test]
async fn retained_closed_ack_same_id_readback_consumes_without_provider_replay() {
    if isolated("retained_closed_ack_same_id_readback_consumes_without_provider_replay") {
        return;
    }
    let mut f = fixture();
    let (tx, rx) = mpsc::channel(32);
    drop(rx);
    let (mut manager, _, sequence) = f.resident(&tx);
    assert!(
        dispatch(&mut f, &mut manager, &sequence, &tx, json!(1))
            .await
            .is_err()
    );
    let records = turn_attempts::records(&f.engine, &f.params.thread_id).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].status, TurnAttemptStatus::Interrupted);
    let artifact = &records[0].retained_input.as_ref().unwrap().artifacts[0];
    let root = f
        .engine
        .session_storage_dir_for(&f.params.thread_id)
        .join("attachments");
    assert_eq!(
        std::fs::read(root.join(&artifact.artifact_name)).unwrap(),
        b"durable retained bytes"
    );
    drain(&mut manager).await;
    let (tx, mut rx) = mpsc::channel(32);
    let (mut manager, _, sequence) = f.resident(&tx);
    dispatch(&mut f, &mut manager, &sequence, &tx, json!(2))
        .await
        .unwrap();
    let response = response(&mut rx, 2).await;
    assert_eq!(response["result"]["turn"]["status"], "interrupted");
    assert_eq!(
        response["result"]["turn"]["attemptId"],
        records[0].identity.attempt_id
    );
    let receipt = turn_receipts::query(
        json!({"threadId":f.params.thread_id,"clientMessageId":"stable-message"}),
        &manager,
        &f.engine,
    )
    .await
    .unwrap()
    .receipt
    .unwrap();
    assert_eq!(
        receipt.attempt_id.as_deref(),
        Some(records[0].identity.attempt_id.as_str())
    );
    let id = &f.params.retention.as_ref().unwrap().references[0].retention_id;
    let terminal = f
        .authority
        .retention_service()
        .read(
            &f.scope,
            &RetentionReceiptSelectorV1::RetentionId {
                retention_id: id.clone(),
            },
        )
        .unwrap()
        .receipt
        .unwrap();
    assert_eq!(terminal.state, RetentionReceiptStateV1::Transferred);
    let request=f.private_request(METHOD_ATTACHMENT_RETENTION_CONSUME,json!({"trustedContext":f.scope.context,
        "acks":[{"retentionId":id,"terminalRevision":terminal.revision,"clientAckId":"stable-ack"}]}));
    for _ in 0..2 {
        let result = dispatch_receipts(&f.authority, &f.engine, &request).unwrap();
        assert_eq!(
            result.result.consume_results[0].status,
            RetentionConsumeStatusV1::Consumed
        );
    }
    assert_eq!(
        turn_attempts::records(&f.engine, &f.params.thread_id)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    drain(&mut manager).await;
}

#[test]
fn retained_prepare_gap_reserves_sequence_without_acceptance_or_ghost_history() {
    if isolated("retained_prepare_gap_reserves_sequence_without_acceptance_or_ghost_history") {
        return;
    }
    let f = fixture();
    let lease = SessionLease::acquire(&f.engine.session_lease_target()).unwrap();
    assert!(lease.matches_target(&f.engine.session_lease_target()));
    let identity = TurnAttemptIdentity {
        thread_id: f.params.thread_id.clone(),
        turn_id: "turn-1".into(),
        attempt_id: "turn-1".into(),
    };
    let history = f.engine.state.messages();
    let Preparation::Fresh(first) = prepare(
        Authority {
            service: f.authority.retention_service(),
            scope: &f.scope,
        },
        &f.engine,
        &f.params,
        &identity,
        "inspect note",
    )
    .unwrap() else {
        panic!("unexpected receipt")
    };
    assert_eq!(first.identity(), &identity);
    drop(first);
    assert_eq!(
        turn_admissions::latest(&f.engine, &f.params.thread_id, 0).unwrap(),
        1
    );
    assert!(
        turn_attempts::records(&f.engine, &f.params.thread_id)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        serde_json::to_value(f.engine.state.messages()).unwrap(),
        serde_json::to_value(history).unwrap()
    );
    assert!(
        turn_attempts::strict_client_message_turn(
            &f.engine.session_storage_dir_for(&f.params.thread_id),
            &f.params.thread_id,
            "stable-message"
        )
        .unwrap()
        .is_none()
    );
    let next = TurnAttemptIdentity {
        turn_id: "turn-2".into(),
        attempt_id: "turn-2".into(),
        ..identity.clone()
    };
    let Preparation::Fresh(recovered) = prepare(
        Authority {
            service: f.authority.retention_service(),
            scope: &f.scope,
        },
        &f.engine,
        &f.params,
        &next,
        "inspect note",
    )
    .unwrap() else {
        panic!("unexpected receipt")
    };
    assert_eq!(recovered.identity(), &identity);
    assert_eq!(
        turn_admissions::latest(&f.engine, &f.params.thread_id, 0).unwrap(),
        1
    );
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn retained_determinate_handoff_failure_terminalizes_without_spawn() {
    if isolated("retained_determinate_handoff_failure_terminalizes_without_spawn") {
        return;
    }
    let mut f = fixture();
    let (tx, mut rx) = mpsc::channel(32);
    let (mut manager, state, sequence) = f.resident(&tx);
    FAULTS
        .lock()
        .unwrap()
        .insert(f.params.thread_id.clone(), Fault::Handoff);
    dispatch(&mut f, &mut manager, &sequence, &tx, json!(1))
        .await
        .unwrap();
    assert_eq!(
        response(&mut rx, 1).await["result"]["turn"]["status"],
        "interrupted"
    );
    let records = turn_attempts::records(&f.engine, &f.params.thread_id).unwrap();
    assert_eq!(records[0].status, TurnAttemptStatus::Interrupted);
    assert!(records[0].retained_input.is_some());
    assert_eq!(
        turn_receipts::terminal_status(&f.engine, &f.params.thread_id, "turn-1").as_deref(),
        Some("interrupted")
    );
    assert!(state.active_turn.lock().await.is_none());
    assert!(!state.running.load(Ordering::SeqCst));
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    drain(&mut manager).await;
}

#[tokio::test]
async fn retained_terminal_write_failure_remains_unknown_and_original_id_recovers() {
    if isolated("retained_terminal_write_failure_remains_unknown_and_original_id_recovers") {
        return;
    }
    let mut f = fixture();
    let (tx, mut rx) = mpsc::channel(32);
    let (mut manager, state, sequence) = f.resident(&tx);
    FAULTS
        .lock()
        .unwrap()
        .insert(f.params.thread_id.clone(), Fault::TerminalWrite);
    dispatch(&mut f, &mut manager, &sequence, &tx, json!(1))
        .await
        .unwrap();
    let first_response = response(&mut rx, 1).await;
    let root = f
        .engine
        .session_storage_dir_for(&f.params.thread_id)
        .join("turn-attempts");
    std::fs::remove_dir(root.join("attempts.lock")).unwrap();
    std::fs::rename(
        root.join("owned-attempts.lock.before-terminal-fault"),
        root.join("attempts.lock"),
    )
    .unwrap();
    assert_eq!(first_response["result"]["turn"]["status"], "unknown");
    assert_eq!(
        turn_attempts::records(&f.engine, &f.params.thread_id).unwrap()[0].status,
        TurnAttemptStatus::Accepted
    );
    assert!(state.active_turn.lock().await.is_none());
    assert!(!state.running.load(Ordering::SeqCst));
    dispatch(&mut f, &mut manager, &sequence, &tx, json!(2))
        .await
        .unwrap();
    let recovered = response(&mut rx, 2).await;
    assert_eq!(recovered["result"]["turn"]["status"], "interrupted");
    assert_eq!(
        recovered["result"]["turn"]["attemptId"],
        first_response["result"]["turn"]["attemptId"]
    );
    assert_eq!(
        turn_attempts::records(&f.engine, &f.params.thread_id)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    drain(&mut manager).await;
}

fn deletion_receipt(f: &Fixture) -> RetentionReceiptV1 {
    f.authority
        .retention_service()
        .read(
            &f.scope,
            &RetentionReceiptSelectorV1::RetentionId {
                retention_id: f.params.retention.as_ref().unwrap().references[0]
                    .retention_id
                    .clone(),
            },
        )
        .unwrap()
        .receipt
        .unwrap()
}

async fn delete_retained_thread(f: &mut Fixture, id: i64) -> Value {
    let workspace = f.engine.clone();
    let (tx, mut rx) = mpsc::channel(32);
    let mut manager = ThreadManager::default();
    super::super::thread_delete_requests::dispatch(
        method::THREAD_DELETE,
        json!(id),
        json!({"threadId":f.params.thread_id}),
        (&mut f.engine, &workspace),
        &tx,
        &mut manager,
        Some(&f.authority),
        &mut ConnectionState::default(),
    )
    .await
    .unwrap();
    response(&mut rx, id).await
}

fn account_snapshot(path: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    fn walk(root: &Path, path: &Path, rows: &mut Vec<(PathBuf, Vec<u8>)>) {
        let mut names: Vec<_> = std::fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        names.sort();
        for child in names {
            if child.is_dir() {
                rows.push((child.strip_prefix(root).unwrap().to_path_buf(), Vec::new()));
                walk(root, &child, rows);
            } else {
                rows.push((
                    child.strip_prefix(root).unwrap().to_path_buf(),
                    std::fs::read(child).unwrap(),
                ));
            }
        }
    }
    let mut rows = Vec::new();
    walk(path, path, &mut rows);
    rows
}

#[tokio::test]
async fn retained_thread_delete_ready_is_durable_and_new_reserve_is_zero_effect() {
    if isolated("retained_thread_delete_ready_is_durable_and_new_reserve_is_zero_effect") {
        return;
    }
    let mut f = fixture();
    let original = deletion_receipt(&f);
    let history = f.engine.state.history_path().unwrap();
    let session = f.engine.session_storage_dir_for(&f.params.thread_id);
    std::fs::create_dir_all(&session).unwrap();
    std::fs::write(
        session.join("owned-recovery-marker"),
        b"keep until consumed",
    )
    .unwrap();
    assert_eq!(
        delete_retained_thread(&mut f, 51).await["result"]["deleted"],
        true
    );
    let witness = kcoder_state::read_session_history_deletion(&history, &f.engine.cwd)
        .unwrap()
        .unwrap();
    assert!(!history.exists());
    assert!(!session.exists());
    assert_eq!(
        deletion_receipt(&f).state,
        RetentionReceiptStateV1::Consumed
    );
    assert_eq!(
        delete_retained_thread(&mut f, 52).await["result"]["deleted"],
        true
    );
    assert_eq!(
        kcoder_state::read_session_history_deletion(&history, &f.engine.cwd)
            .unwrap()
            .unwrap(),
        witness
    );
    let before = account_snapshot(&f._temp.path().join("account"));
    let request = f.private_request(METHOD_ATTACHMENT_RETENTION_RESERVE, json!({
        "trustedContext":f.scope.context,"clientRequestId":original.client_request_id,
        "threadId":f.params.thread_id,"stageRefs":original.entries.iter().map(|r| &r.stage_ref).collect::<Vec<_>>(),
    }));
    assert!(dispatch_receipts(&f.authority, &f.engine, &request).is_err());
    assert_eq!(account_snapshot(&f._temp.path().join("account")), before);
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn retained_thread_delete_preserves_accepted_artifact_proof_until_recovered() {
    if isolated("retained_thread_delete_preserves_accepted_artifact_proof_until_recovered") {
        return;
    }
    let mut f = fixture();
    let history = f.engine.state.history_path().unwrap();
    let session = f.engine.session_storage_dir_for(&f.params.thread_id);
    let identity = TurnAttemptIdentity {
        thread_id: f.params.thread_id.clone(),
        turn_id: "turn-1".into(),
        attempt_id: "turn-1".into(),
    };
    let input = {
        let _lease = SessionLease::acquire(&f.engine.session_lease_target()).unwrap();
        let Preparation::Fresh(prepared) = prepare(
            Authority {
                service: f.authority.retention_service(),
                scope: &f.scope,
            },
            &f.engine,
            &f.params,
            &identity,
            "inspect note",
        )
        .unwrap() else {
            panic!("unexpected receipt")
        };
        save_turn_client_message_id(
            &f.engine,
            &identity.thread_id,
            &identity.turn_id,
            f.params.client_message_id.as_deref(),
        )
        .unwrap();
        turn_attempts::begin_with_retained_input(
            &f.engine,
            &identity,
            false,
            hex_sha256(b"context"),
            &f.params,
            prepared.input.clone(),
        )
        .unwrap();
        prepared.input.clone()
    };
    assert_eq!(
        deletion_receipt(&f).state,
        RetentionReceiptStateV1::Materializing
    );
    let target = session
        .join("attachments")
        .join(&input.artifacts[0].artifact_name);
    let saved = target.with_extension("owned-before-conflict");
    let bytes = std::fs::read(&target).unwrap();
    std::fs::rename(&target, &saved).unwrap();
    std::fs::write(&target, b"foreign replacement must survive").unwrap();
    assert!(
        delete_retained_thread(&mut f, 61)
            .await
            .get("error")
            .is_some()
    );
    let witness = kcoder_state::read_session_history_deletion(&history, &f.engine.cwd)
        .unwrap()
        .unwrap();
    assert!(session.exists());
    assert_eq!(
        std::fs::read(&target).unwrap(),
        b"foreign replacement must survive"
    );
    assert_eq!(std::fs::read(&saved).unwrap(), bytes);
    assert_eq!(
        turn_attempts::records(&f.engine, &identity.thread_id).unwrap()[0].status,
        TurnAttemptStatus::Accepted
    );
    assert_eq!(
        deletion_receipt(&f).state,
        RetentionReceiptStateV1::Materializing
    );
    // Restore the exact original inode, not a byte-equivalent substitute.
    std::fs::remove_file(&target).unwrap();
    std::fs::rename(&saved, &target).unwrap();
    {
        let _lifecycle = acquire_thread_lifecycle_locks(&f.engine, &[&identity.thread_id]).unwrap();
        let _lease = SessionLease::acquire_existing_history(&history).unwrap();
        super::super::thread_retention_cleanup::complete(
            &f.authority,
            &f.engine,
            &history,
            &witness,
        )
        .unwrap();
        assert_eq!(
            turn_attempts::records(&f.engine, &identity.thread_id).unwrap()[0].status,
            TurnAttemptStatus::Interrupted
        );
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        assert_eq!(
            deletion_receipt(&f).state,
            RetentionReceiptStateV1::Consumed
        );
    }
    assert_eq!(
        delete_retained_thread(&mut f, 62).await["result"]["deleted"],
        true
    );
    assert!(!session.exists());
    assert_eq!(
        kcoder_state::read_session_history_deletion(&history, &f.engine.cwd)
            .unwrap()
            .unwrap(),
        witness
    );
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn retained_thread_delete_unknown_materialization_keeps_original_recovery() {
    if isolated("retained_thread_delete_unknown_materialization_keeps_original_recovery") {
        return;
    }
    let mut f = fixture();
    let history = f.engine.state.history_path().unwrap();
    let session = f.engine.session_storage_dir_for(&f.params.thread_id);
    let identity = TurnAttemptIdentity {
        thread_id: f.params.thread_id.clone(),
        turn_id: "turn-1".into(),
        attempt_id: "turn-1".into(),
    };
    {
        let _lease = SessionLease::acquire(&f.engine.session_lease_target()).unwrap();
        let Preparation::Fresh(prepared) = prepare(
            Authority {
                service: f.authority.retention_service(),
                scope: &f.scope,
            },
            &f.engine,
            &f.params,
            &identity,
            "inspect note",
        )
        .unwrap() else {
            panic!("unexpected receipt")
        };
        drop(prepared); // Durable materialization exists, but no Accepted record.
    }
    let original = account_snapshot(&session);
    assert!(
        delete_retained_thread(&mut f, 71)
            .await
            .get("error")
            .is_some()
    );
    let witness = kcoder_state::read_session_history_deletion(&history, &f.engine.cwd)
        .unwrap()
        .unwrap();
    assert_eq!(account_snapshot(&session), original);
    assert_eq!(
        deletion_receipt(&f).state,
        RetentionReceiptStateV1::Materializing
    );
    assert!(
        turn_attempts::records(&f.engine, &identity.thread_id)
            .unwrap()
            .is_empty()
    );
    assert!(
        delete_retained_thread(&mut f, 72)
            .await
            .get("error")
            .is_some()
    );
    assert_eq!(
        kcoder_state::read_session_history_deletion(&history, &f.engine.cwd)
            .unwrap()
            .unwrap(),
        witness
    );
    assert_eq!(account_snapshot(&session), original);
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn retained_thread_delete_missing_ordinary_source_never_purges_artifacts() {
    if isolated("retained_thread_delete_missing_ordinary_source_never_purges_artifacts") {
        return;
    }
    let mut f = fixture();
    let other_thread = uuid::Uuid::new_v4().to_string();
    let history = f.engine.state.history_path().unwrap();
    let foreign_artifacts = f.engine.session_storage_dir_for(&other_thread);
    std::fs::create_dir_all(&foreign_artifacts).unwrap();
    std::fs::write(
        foreign_artifacts.join("unproven-source-marker"),
        b"keep unknown source",
    )
    .unwrap();
    let original = account_snapshot(&foreign_artifacts);
    let ledger = account_snapshot(&f._temp.path().join("account"));
    let workspace = f.engine.clone();
    let (tx, mut rx) = mpsc::channel(32);
    let mut manager = ThreadManager::default();
    super::super::thread_delete_requests::dispatch(
        method::THREAD_DELETE,
        json!(81),
        json!({"threadId":other_thread}),
        (&mut f.engine, &workspace),
        &tx,
        &mut manager,
        Some(&f.authority),
        &mut ConnectionState::default(),
    )
    .await
    .unwrap();
    let result = response(&mut rx, 81).await;
    let error_message = result["error"]["message"].as_str().unwrap();
    assert!(
        error_message.contains("ordinary thread deletion witness unavailable"),
        "unexpected thread deletion error: {error_message}"
    );
    assert_eq!(account_snapshot(&foreign_artifacts), original);
    assert_eq!(account_snapshot(&f._temp.path().join("account")), ledger);
    assert!(history.exists());
    assert_eq!(deletion_receipt(&f).state, RetentionReceiptStateV1::Ready);
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn retained_thread_delete_missing_lease_requires_bound_witness_before_write() {
    if isolated("retained_thread_delete_missing_lease_requires_bound_witness_before_write") {
        return;
    }
    let mut f = fixture();
    let history = f.engine.state.history_path().unwrap();
    let lease_path = history.with_extension("lease");
    let control = history.with_extension("hctl").join("source.json");
    let session = f.engine.session_storage_dir_for(&f.params.thread_id);
    std::fs::create_dir_all(&session).unwrap();
    std::fs::write(
        session.join("owned-recovery-marker"),
        b"keep until cleanup completes",
    )
    .unwrap();
    let witness = {
        let _lifecycle = acquire_thread_lifecycle_locks(&f.engine, &[&f.params.thread_id]).unwrap();
        let _lease = SessionLease::acquire_existing_history(&history).unwrap();
        kcoder_state::mark_session_history_deleted(&history, &f.engine.cwd).unwrap()
    };
    // Simulate a durable recovery state; this is not a physical power-loss test.
    std::fs::remove_file(&lease_path).unwrap();
    assert!(!history.exists());
    let original_control = std::fs::read(&control).unwrap();
    let original_ledger = account_snapshot(&f._temp.path().join("account"));
    let original_session = account_snapshot(&session);
    let saved_control = control.with_extension("owned-before-missing-proof");
    std::fs::rename(&control, &saved_control).unwrap();
    assert!(
        delete_retained_thread(&mut f, 91)
            .await
            .get("error")
            .is_some()
    );
    assert!(
        !lease_path.exists(),
        "missing proof must not create a lease"
    );
    assert!(!control.exists());
    assert_eq!(std::fs::read(&saved_control).unwrap(), original_control);
    std::fs::rename(&saved_control, &control).unwrap();
    let mut foreign: Value = serde_json::from_slice(&original_control).unwrap();
    foreign["deletion"]["workspace"] = json!(f._temp.path().join("foreign-workspace"));
    let foreign_bytes = serde_json::to_vec(&foreign).unwrap();
    std::fs::write(&control, &foreign_bytes).unwrap();
    assert!(
        delete_retained_thread(&mut f, 92)
            .await
            .get("error")
            .is_some()
    );
    assert!(
        !lease_path.exists(),
        "foreign proof must not create a lease"
    );
    assert_eq!(std::fs::read(&control).unwrap(), foreign_bytes);
    assert_eq!(
        account_snapshot(&f._temp.path().join("account")),
        original_ledger
    );
    assert_eq!(account_snapshot(&session), original_session);
    std::fs::write(&control, &original_control).unwrap();
    let hostile = f._temp.path().join("foreign-lease-target");
    std::fs::write(&hostile, b"foreign lease bytes").unwrap();
    std::os::unix::fs::symlink(&hostile, &lease_path).unwrap();
    assert!(
        delete_retained_thread(&mut f, 93)
            .await
            .get("error")
            .is_some()
    );
    assert_eq!(std::fs::read(&hostile).unwrap(), b"foreign lease bytes");
    assert_eq!(account_snapshot(&session), original_session);
    std::fs::remove_file(&lease_path).unwrap();
    std::fs::create_dir(&lease_path).unwrap();
    assert!(
        delete_retained_thread(&mut f, 94)
            .await
            .get("error")
            .is_some()
    );
    assert!(lease_path.is_dir());
    assert_eq!(account_snapshot(&session), original_session);
    std::fs::remove_dir(&lease_path).unwrap();
    {
        let _busy = SessionLease::acquire(&history).unwrap();
        assert!(
            delete_retained_thread(&mut f, 95)
                .await
                .get("error")
                .is_some()
        );
        assert_eq!(account_snapshot(&session), original_session);
    }
    assert_eq!(std::fs::read(&control).unwrap(), original_control);
    assert_eq!(
        account_snapshot(&f._temp.path().join("account")),
        original_ledger
    );
    std::fs::remove_file(&lease_path).unwrap();
    assert_eq!(
        delete_retained_thread(&mut f, 96).await["result"]["deleted"],
        true
    );
    assert!(lease_path.is_file());
    assert!(!session.exists());
    assert_eq!(
        kcoder_state::read_session_history_deletion(&history, &f.engine.cwd)
            .unwrap()
            .unwrap(),
        witness
    );
    assert_eq!(
        deletion_receipt(&f).state,
        RetentionReceiptStateV1::Consumed
    );
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
}
