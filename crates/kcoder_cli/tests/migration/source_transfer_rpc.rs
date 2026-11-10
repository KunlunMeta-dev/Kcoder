//! Real stdio processes exercise the source-only parent boundary without executing source code.
#[path = "source_instructions_rpc.rs"]
mod instructions;
use super::{TestAppServer as Process, Value, json};
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

struct TestAppServer {
    inner: Option<Process>,
    stderr: Arc<Mutex<Vec<u8>>>,
    reader: Option<std::thread::JoinHandle<()>>,
}
impl TestAppServer {
    fn observe(mut process: Process) -> Self {
        let mut stderr = process.child.stderr.take().unwrap();
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let saved = bytes.clone();
        let reader = std::thread::spawn(move || {
            let mut chunk = [0; 1024];
            loop {
                let count = match stderr.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => count,
                };
                let mut saved = saved.lock().unwrap();
                let retained = count.min((16 * 1024usize).saturating_sub(saved.len()));
                saved.extend_from_slice(&chunk[..retained]);
            }
        });
        Self {
            inner: Some(process),
            stderr: bytes,
            reader: Some(reader),
        }
    }
    fn response(&mut self, id: i64) -> Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            match self
                .inner
                .as_ref()
                .unwrap()
                .rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(Ok(line)) => {
                    let value: Value = serde_json::from_str(&line).unwrap();
                    if value["id"] == id {
                        return value;
                    }
                }
                other => {
                    let status = self.inner.as_mut().unwrap().child.try_wait().unwrap();
                    panic!(
                        "owned source stdio response {id}: {other:?}; status={status:?}; bounded owned stderr={}",
                        String::from_utf8_lossy(&self.stderr.lock().unwrap())
                    );
                }
            }
        }
    }
}
impl std::ops::Deref for TestAppServer {
    type Target = Process;
    fn deref(&self) -> &Self::Target {
        self.inner.as_ref().unwrap()
    }
}
impl std::ops::DerefMut for TestAppServer {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.inner.as_mut().unwrap()
    }
}
impl Drop for TestAppServer {
    fn drop(&mut self) {
        drop(self.inner.take());
        self.reader.take().unwrap().join().unwrap();
    }
}

struct ModelObserver {
    endpoint: String,
    requests: Arc<AtomicUsize>,
    inference: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl ModelObserver {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let inference = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (seen, posts, done) = (requests.clone(), inference.clone(), stop.clone());
        let worker = std::thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        socket
                            .set_read_timeout(Some(Duration::from_secs(1)))
                            .unwrap();
                        let mut bytes = [0; 4096];
                        if let Ok(length) = socket.read(&mut bytes) {
                            seen.fetch_add(1, Ordering::AcqRel);
                            if bytes[..length].starts_with(b"POST ") {
                                posts.fetch_add(1, Ordering::AcqRel);
                            }
                        }
                        let _ = socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("owned model observer failed: {error}"),
                }
            }
        });
        Self {
            endpoint,
            requests,
            inference,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for ModelObserver {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}

struct Profile {
    root: PathBuf,
    workspace: PathBuf,
    profile: PathBuf,
    settings: PathBuf,
    source: PathBuf,
}
impl Profile {
    fn new(root: &Path, name: &str, endpoint: &str) -> Self {
        let root = root.join(name);
        let workspace = root.join("workspace");
        let profile = root.join("profile");
        let source = root.join("originals");
        for directory in [&root, &workspace, &profile, &source] {
            kcoder_config::PrivateDirectory::open_or_create(directory).unwrap();
        }
        let settings = profile.join("settings.json");
        std::fs::write(
            &settings,
            json!({
                "credential_store":"file", "active_provider":"isolated-source-transfer",
                "providers":{"isolated-source-transfer":{
                    "api_format":"openai_chat_completions", "endpoint":endpoint,
                    "default_model":"never-call-this-model", "no_proxy":true,
                    "context_window_tokens":128000, "output_headroom_tokens":8192,
                    "max_output_tokens":8192
                }}
            })
            .to_string(),
        )
        .unwrap();
        Self {
            root,
            workspace,
            profile,
            settings,
            source,
        }
    }
    fn start(&self, source_only: bool) -> TestAppServer {
        self.start_with_overlay(source_only, &self.settings)
    }
    fn start_with_overlay(&self, source_only: bool, overlay: &Path) -> TestAppServer {
        let mut builder = Process::builder(&self.workspace, overlay)
            .config_dir(&self.profile)
            .without_scenario();
        if source_only {
            builder
                .extra_args
                .push("--migration-source-parent-local-v1".into());
        }
        for (name, path) in [
            ("HOME", self.root.clone()),
            ("USERPROFILE", self.root.clone()),
            ("CLAUDE_CONFIG_DIR", self.source.clone()),
            ("CODEX_HOME", self.root.join("absent-codex")),
            ("XDG_CONFIG_HOME", self.root.join("xdg-config")),
            ("XDG_DATA_HOME", self.root.join("xdg-data")),
            ("XDG_STATE_HOME", self.root.join("xdg-state")),
            ("XDG_CACHE_HOME", self.root.join("xdg-cache")),
        ] {
            builder.extra_env.push((name.into(), path.into_os_string()));
        }
        TestAppServer::observe(builder.spawn())
    }
}

fn rpc(server: &mut TestAppServer, id: &mut i64, method: &str, params: Value) -> Value {
    *id += 1;
    server.send(json!({"jsonrpc":"2.0","id":*id,"method":method,"params":params}));
    let response = server.response(*id);
    assert!(response.get("error").is_none(), "{response}");
    response["result"].clone()
}
fn internal(server: &mut TestAppServer, id: &mut i64, operation: &str, params: Value) -> Value {
    rpc(
        server,
        id,
        &format!("migration/sourceTransfer/internal/{operation}"),
        params,
    )
}
fn initialize(server: &mut TestAppServer, id: &mut i64, authorized: bool) {
    let result = rpc(
        server,
        id,
        "initialize",
        json!({"protocolVersion":"2026-07-27",
        "clientInfo":{"name":"owned-source-transfer-stdio","version":"1"}}),
    );
    assert_eq!(
        result["capabilities"]["experimental"]["migrationSourceTransferParentLaunchV1"],
        true
    );
    assert_eq!(
        result["capabilities"]["experimental"]["migrationSourceTransferInternalV1"],
        authorized
    );
    assert_eq!(
        result["capabilities"]["experimental"]["migrationSourceTransferTargetRecoveryV1"],
        authorized
    );
    assert_eq!(
        result["capabilities"]["experimental"]["migrationSourceTransferAttemptsV1"],
        authorized
    );
    // A source-only parent never acquires the unrelated retention authority.
    assert_eq!(
        result["capabilities"]["experimental"]["workspaceOperationReceiptsV2"],
        false
    );
}
fn accept(
    server: &mut TestAppServer,
    id: &mut i64,
    request: &str,
    role: &str,
    proof: &Value,
) -> String {
    *id += 1;
    server.send(
        json!({"jsonrpc":"2.0","id":*id,"method":"migration/sourceTransfer/internal/peer/accept",
        "params":{"requestId":request,"role":role},"kcoderPrivateMigrationSource":proof}),
    );
    let result = server.response(*id);
    assert!(result.get("error").is_none(), "{result}");
    result["result"]["peerRef"].as_str().unwrap().to_owned()
}
fn bound(request: &str, peer: &str, mut params: Value) -> Value {
    params["requestId"] = json!(request);
    params["peerRef"] = json!(peer);
    params
}
fn internal_error(
    server: &mut TestAppServer,
    id: &mut i64,
    operation: &str,
    params: Value,
) -> Value {
    *id += 1;
    server.send(json!({"jsonrpc":"2.0","id":*id,
        "method":format!("migration/sourceTransfer/internal/{operation}"),"params":params}));
    let response = server.response(*id);
    assert!(response.get("error").is_some(), "{response}");
    response["error"].clone()
}
fn stop(mut server: TestAppServer) {
    drop(server.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = server.child.try_wait().unwrap() {
            assert!(status.success(), "owned app-server exit: {status}");
            return;
        }
        assert!(Instant::now() < deadline, "owned app-server did not stop");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn migration_source_stdio_parent_boundary_and_two_profile_transfer_reconcile_receipts() {
    let root = tempfile::tempdir().unwrap();
    let observer = ModelObserver::new();
    let source_profile = Profile::new(root.path(), "source", &observer.endpoint);
    let target_profile = Profile::new(root.path(), "target", &observer.endpoint);
    let source_program = source_profile.source.join("never-run.sh");
    std::fs::write(&source_program, "printf invoked > \"$0.marker\"\n").unwrap();
    let original = json!({"model":"source-model", "mcpServers":{"inert":{"command":"sh", "args":[source_program]}}}).to_string();
    std::fs::write(source_profile.source.join("settings.json"), &original).unwrap();
    std::fs::write(
        source_profile.source.join("auth.json"),
        "PRIVATE_AUTH_MUST_NOT_TRANSFER",
    )
    .unwrap();
    let original_sha = format!("{:x}", Sha256::digest(original.as_bytes()));
    let target_settings = std::fs::read(&target_profile.settings).unwrap();
    let mut id = 0;

    let mut ordinary = source_profile.start(false);
    initialize(&mut ordinary, &mut id, false);
    id += 1;
    ordinary.send(json!({"jsonrpc":"2.0","id":id,"method":"migration/sourceTransfer/internal/identity","params":{}}));
    assert_eq!(
        ordinary.response(id)["error"]["message"],
        "source_transfer_authority_unavailable"
    );
    id += 1;
    ordinary.send(json!({"jsonrpc":"2.0","id":id,"method":"server/info","params":{},"kcoderPrivateMigrationSource":{}}));
    assert_eq!(ordinary.response(id)["error"]["code"], -32602);
    stop(ordinary);

    let mut source = source_profile.start(true);
    let mut target = target_profile.start(true);
    initialize(&mut source, &mut id, true);
    initialize(&mut target, &mut id, true);
    let source_identity = internal(&mut source, &mut id, "identity", json!({}));
    let target_identity = internal(&mut target, &mut id, "identity", json!({}));
    assert_ne!(source_identity["authority"], target_identity["authority"]);
    assert_eq!(source_identity["chunkBytes"], 128 * 1024);
    let request = uuid::Uuid::new_v4().to_string();
    let endpoint = |identity: &Value, fingerprint: &str| {
        json!({"authority":identity["authority"],
        "targetFingerprint":fingerprint,"principal":{"kind":"localOs"}})
    };
    let proof = json!({"version":1,"requestId":request,
        "source":endpoint(&source_identity,"owned-source"),"target":endpoint(&target_identity,"owned-target")});
    let source_peer = accept(&mut source, &mut id, &request, "source", &proof);
    let target_peer = accept(&mut target, &mut id, &request, "target", &proof);
    id += 1;
    let mut forged = proof.clone();
    forged["source"]["authority"] = target_identity["authority"].clone();
    source.send(
        json!({"jsonrpc":"2.0","id":id,"method":"migration/sourceTransfer/internal/peer/accept",
        "params":{"requestId":request,"role":"source"},"kcoderPrivateMigrationSource":forged}),
    );
    assert_eq!(
        source.response(id)["error"]["message"],
        "source_transfer_peer_authority_changed"
    );
    id += 1;
    source.write_raw(format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"migration/sourceTransfer/internal/identity\",\"params\":{{}},\"params\":{{}}}}\n").as_bytes());
    assert_eq!(source.response(id)["error"]["code"], -32602);

    let discovered = rpc(
        &mut source,
        &mut id,
        "migration/discover",
        json!({"sources":["claude-code"]}),
    );
    let selected = discovered["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| {
            entry["scope"] == "user"
                && entry["availableCategories"]
                    .as_array()
                    .is_some_and(|categories| categories.contains(&json!("mcp")))
        })
        .unwrap();
    let selections = json!([{"kind":"configuration","sourceId":selected["sourceId"]}]);
    let destination = internal(
        &mut target,
        &mut id,
        "target/grant",
        bound(&request, &target_peer, json!({})),
    );
    let prepared = internal(
        &mut source,
        &mut id,
        "source/prepare",
        bound(
            &request,
            &source_peer,
            json!({"destination":destination,"selections":selections}),
        ),
    );
    internal(
        &mut source,
        &mut id,
        "source/capture",
        bound(&request, &source_peer, json!({})),
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let state = internal(
            &mut source,
            &mut id,
            "source/state",
            bound(&request, &source_peer, json!({})),
        );
        if state["capture"]["status"] != "running" {
            assert_eq!(state["capture"]["status"], "ready", "{state}");
            assert_eq!(state["state"]["ready"], true);
            break;
        }
        assert!(Instant::now() < deadline, "owned capture failed to settle");
        std::thread::sleep(Duration::from_millis(10));
    }
    let exported = internal(
        &mut source,
        &mut id,
        "source/manifest",
        bound(&request, &source_peer, json!({})),
    );
    let manifest = &exported["manifest"];
    assert_eq!(manifest["entries"].as_array().unwrap().len(), 1);
    assert_eq!(
        manifest["entries"][0]["content"]["sourceIdentity"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    // The actual source process is stopped, not a mocked disconnected endpoint.
    let source_cancel = internal(
        &mut source,
        &mut id,
        "source/cancel",
        bound(
            &request,
            &source_peer,
            json!({"commandId":uuid::Uuid::new_v4().to_string()}),
        ),
    );
    let frozen_source_control = source_cancel["snapshotControl"].clone();
    assert_eq!(frozen_source_control["cancelled"], true);
    stop(source);
    let recovered = internal(
        &mut target,
        &mut id,
        "peer/recover-target",
        json!({"requestId":request}),
    );
    let recovery_peer = recovered["peerRef"].as_str().unwrap().to_owned();
    assert_ne!(recovery_peer, target_peer);
    assert_eq!(recovered["targetAuthority"], target_identity["authority"]);
    internal(
        &mut target,
        &mut id,
        "target/cancel",
        bound(
            &request,
            &recovery_peer,
            json!({"commandId":uuid::Uuid::new_v4().to_string()}),
        ),
    );
    let cancelled = internal(
        &mut target,
        &mut id,
        "target/summary",
        bound(&request, &recovery_peer, json!({})),
    );
    assert!(cancelled["state"].is_null() && cancelled["progress"].is_null());
    assert_eq!(cancelled["admissionControl"]["cancelled"], true);
    assert_eq!(
        internal_error(
            &mut target,
            &mut id,
            "target/begin",
            bound(&request, &target_peer, json!({"manifest":manifest}))
        )["message"],
        "source_transfer_cancelled"
    );
    assert_eq!(
        internal_error(
            &mut target,
            &mut id,
            "target/grant",
            bound(&request, &recovery_peer, json!({}))
        )["message"],
        "source_transfer_recovery_scope"
    );
    internal(
        &mut target,
        &mut id,
        "target/cancel",
        bound(
            &request,
            &recovery_peer,
            json!({"commandId":uuid::Uuid::new_v4().to_string()}),
        ),
    );
    assert_eq!(
        internal_error(
            &mut target,
            &mut id,
            "target/resume",
            bound(
                &request,
                &recovery_peer,
                json!({"expectedAdmissionControl":cancelled["admissionControl"],"expectedOperationControl":null})
            )
        )["message"],
        "source_transfer_revision_conflict"
    );
    let current = internal(
        &mut target,
        &mut id,
        "target/summary",
        bound(&request, &recovery_peer, json!({})),
    );
    internal(
        &mut target,
        &mut id,
        "target/resume",
        bound(
            &request,
            &recovery_peer,
            json!({"expectedAdmissionControl":current["admissionControl"],"expectedOperationControl":null}),
        ),
    );
    let mut source = source_profile.start(true);
    initialize(&mut source, &mut id, true);
    let source_peer = accept(&mut source, &mut id, &request, "source", &proof);
    let source_unchanged = internal(
        &mut source,
        &mut id,
        "source/state",
        bound(&request, &source_peer, json!({})),
    );
    assert_eq!(source_unchanged["snapshotControl"], frozen_source_control);
    assert_eq!(source_unchanged["state"], source_cancel["state"]);
    internal(
        &mut source,
        &mut id,
        "source/resume",
        bound(
            &request,
            &source_peer,
            json!({"expectedSequence":source_cancel["state"]["sequence"],
            "expectedCancelWatermark":source_cancel["state"]["cancelWatermark"],
            "expectedSnapshotControl":frozen_source_control}),
        ),
    );
    let run_attempt = uuid::Uuid::new_v4().to_string();
    let claim = |attempt: &str| json!({"attemptId":attempt,"kind":"run","callDigest":"a".repeat(64),"selectionDigest":"b".repeat(64)});
    assert_eq!(
        internal(
            &mut target,
            &mut id,
            "target/attempt/claim",
            bound(&request, &target_peer, claim(&run_attempt))
        )["admitted"],
        true
    );
    let mut competitor = target_profile.start(true);
    initialize(&mut competitor, &mut id, true);
    let competitor_peer = accept(&mut competitor, &mut id, &request, "target", &proof);
    assert_eq!(
        internal(
            &mut competitor,
            &mut id,
            "target/attempt/claim",
            bound(&request, &competitor_peer, claim(&run_attempt))
        )["admitted"],
        false
    );
    assert_eq!(
        internal_error(
            &mut competitor,
            &mut id,
            "target/attempt/claim",
            bound(
                &request,
                &competitor_peer,
                claim(&uuid::Uuid::new_v4().to_string())
            )
        )["message"],
        "source_transfer_attempt_busy"
    );
    assert_eq!(
        internal_error(
            &mut competitor,
            &mut id,
            "target/begin",
            bound(&request, &competitor_peer, json!({"manifest":manifest}))
        )["message"],
        "source_transfer_attempt_owner_required"
    );
    stop(competitor);
    internal(
        &mut target,
        &mut id,
        "target/begin",
        bound(&request, &target_peer, json!({"manifest":manifest})),
    );
    for entry in manifest["entries"].as_array().unwrap() {
        let entry_id = entry["id"].as_str().unwrap();
        let bytes = entry["bytes"].as_u64().unwrap();
        for index in 0..bytes.div_ceil(128 * 1024) {
            let mut chunk = internal(
                &mut source,
                &mut id,
                "source/chunk",
                bound(
                    &request,
                    &source_peer,
                    json!({"entryId":entry_id,"index":index}),
                ),
            );
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(chunk["dataBase64"].as_str().unwrap())
                .unwrap();
            assert!(decoded.len() <= 128 * 1024);
            let private_canary = b"PRIVATE_AUTH_MUST_NOT_TRANSFER";
            assert!(
                !decoded
                    .windows(private_canary.len())
                    .any(|window| window == private_canary)
            );
            assert_eq!(format!("{:x}", Sha256::digest(&decoded)), chunk["sha256"]);
            chunk["peerRef"] = json!(target_peer);
            let part = internal(&mut target, &mut id, "target/part/write", chunk);
            assert_eq!(part["receipt"]["acceptedParts"], index + 1);
            assert_eq!(
                internal(
                    &mut target,
                    &mut id,
                    "target/part/read",
                    bound(&request, &target_peer, json!({"entryId":entry_id}))
                ),
                part
            );
        }
    }
    internal(
        &mut target,
        &mut id,
        "target/attempt/release",
        bound(&request, &target_peer, json!({"attemptId":run_attempt})),
    );
    stop(source);
    stop(target);
    let mut target = target_profile.start(true);
    initialize(&mut target, &mut id, true);
    let recovered = internal(
        &mut target,
        &mut id,
        "peer/recover-target",
        json!({"requestId":request}),
    );
    let recovery_peer = recovered["peerRef"].as_str().unwrap().to_owned();
    let summary = internal(
        &mut target,
        &mut id,
        "target/summary",
        bound(&request, &recovery_peer, json!({})),
    );
    assert_eq!(summary["progress"]["partsComplete"], true);
    assert_eq!(summary["state"]["ready"], false);
    let finish_attempt = uuid::Uuid::new_v4().to_string();
    let finish_claim = json!({"attemptId":finish_attempt,"kind":"finish","callDigest":"c".repeat(64),"selectionDigest":null});
    assert_eq!(
        internal(
            &mut target,
            &mut id,
            "target/attempt/claim",
            bound(&request, &recovery_peer, finish_claim.clone())
        )["admitted"],
        true
    );
    // Deliberately leave the finish response unread, then reconcile the stored receipt.
    id += 1;
    target.send(
        json!({"jsonrpc":"2.0","id":id,"method":"migration/sourceTransfer/internal/target/finish",
        "params":bound(&request, &recovery_peer, json!({}))}),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    let summary = loop {
        let observed = internal(
            &mut target,
            &mut id,
            "target/summary",
            bound(&request, &recovery_peer, json!({})),
        );
        if !observed["receipt"].is_null() {
            break observed;
        }
        assert!(
            Instant::now() < deadline,
            "owned target finish never published a receipt"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let receipt = json!({"receipt":summary["receipt"]});
    assert_eq!(receipt["receipt"]["requestId"], request);
    assert_eq!(
        receipt["receipt"]["manifestSha256"],
        exported["manifestSha256"]
    );
    stop(target);
    let mut source = source_profile.start(true);
    let mut target = target_profile.start(true);
    initialize(&mut source, &mut id, true);
    initialize(&mut target, &mut id, true);
    let source_peer = accept(&mut source, &mut id, &request, "source", &proof);
    let target_peer = accept(&mut target, &mut id, &request, "target", &proof);
    std::fs::rename(
        &source_profile.source,
        source_profile.root.join("originals-moved"),
    )
    .unwrap();
    let reopened = internal(
        &mut source,
        &mut id,
        "source/prepare",
        bound(
            &request,
            &source_peer,
            json!({"destination":destination,"selections":selections}),
        ),
    );
    assert_eq!(reopened["selectionDigest"], prepared["selectionDigest"]);
    assert_eq!(
        internal(
            &mut target,
            &mut id,
            "target/receipt",
            bound(&request, &target_peer, json!({}))
        ),
        receipt
    );
    assert_eq!(
        internal(
            &mut target,
            &mut id,
            "target/state",
            bound(&request, &target_peer, json!({}))
        )["state"]["ready"],
        true
    );
    let recovered = internal(
        &mut target,
        &mut id,
        "peer/recover-target",
        json!({"requestId":request}),
    );
    let recovered_peer = recovered["peerRef"].as_str().unwrap();
    assert_eq!(
        internal(
            &mut target,
            &mut id,
            "target/attempt/claim",
            bound(&request, recovered_peer, finish_claim)
        )["admitted"],
        false
    );
    assert_eq!(
        internal_error(
            &mut target,
            &mut id,
            "target/finish",
            bound(&request, &target_peer, json!({}))
        )["message"],
        "source_transfer_attempt_owner_required"
    );
    stop(source);
    let native_identity = target_profile
        .profile
        .join("migrations/source-transfer/native.json");
    let held_identity = target_profile.root.join("owned-native-identity.json");
    std::fs::rename(&native_identity, &held_identity).unwrap();
    internal_error(
        &mut target,
        &mut id,
        "peer/recover-target",
        json!({"requestId":request}),
    );
    assert!(!native_identity.exists());
    std::fs::rename(&held_identity, &native_identity).unwrap();
    stop(target);
    assert_eq!(
        std::fs::read(&target_profile.settings).unwrap(),
        target_settings
    );
    let moved = source_profile.root.join("originals-moved");
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(std::fs::read(moved.join("settings.json")).unwrap())
        ),
        original_sha
    );
    assert!(!moved.join("never-run.sh.marker").exists());
    assert_eq!(observer.inference.load(Ordering::Acquire), 0);
    assert_eq!(observer.requests.load(Ordering::Acquire), 0);
    let owned_root = root.path().to_path_buf();
    root.close().unwrap();
    assert!(!owned_root.exists());
}

#[path = "source_transfer_credentials_rpc.rs"]
mod private_credentials;
