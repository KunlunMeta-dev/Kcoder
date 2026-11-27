//! Actual process/transport acceptance; the host fixture is not production PDP/Native wiring.
use super::*;
use agent_client_protocol::schema::v1::{ContentBlock, TextContent};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

struct Host {
    allowed: AtomicBool,
    effects: Mutex<Vec<OutboundEffect>>,
    unknown: Mutex<Vec<OutboundEffect>>,
    receipts: Mutex<Vec<(OutboundEffect, Value)>>,
    deadline: tokio::time::Instant,
    executable: PathBuf,
}
impl OutboundHost for Host {
    fn verify_runner(&self, runner: &InstalledOutboundRunner) -> Result<()> {
        ensure!(
            runner.executable() == self.executable,
            "fixture installation pin mismatch"
        );
        Ok(())
    }
    fn check_current(&self) -> Result<()> {
        ensure!(
            self.allowed.load(Ordering::SeqCst),
            "fixture native grant revoked"
        );
        Ok(())
    }
    fn deadline(&self) -> tokio::time::Instant {
        self.deadline
    }
    fn before_effect(&self, effect: OutboundEffect, _intent: &Value) -> Result<()> {
        self.check_current()?;
        let mut effects = self.effects.lock().unwrap();
        ensure!(
            !effects.contains(&effect),
            "Original fixture effect already dispatched; do not replay"
        );
        effects.push(effect);
        Ok(())
    }
    fn record_receipt(&self, effect: OutboundEffect, value: &Value) -> Result<()> {
        self.receipts.lock().unwrap().push((effect, value.clone()));
        Ok(())
    }
    fn record_unknown(&self, effect: OutboundEffect) -> Result<()> {
        self.unknown.lock().unwrap().push(effect);
        Ok(())
    }
}
fn fixture(mode: &str) -> (tempfile::TempDir, InstalledOutboundRunner, Arc<Host>) {
    let owned = tempfile::tempdir().unwrap();
    let script = owned.path().join("peer.py");
    std::fs::write(
        &script,
        include_bytes!("../../tests/fixtures/outbound_runner.py"),
    )
    .unwrap();
    let owner = std::env::var_os("KCODER_TEST_STDIO_OWNER_BIN").expect("UNMET_PREREQUISITE: build the actual kcoder-process-supervisor and set KCODER_TEST_STDIO_OWNER_BIN");
    let executable = PathBuf::from("/usr/bin/python3");
    let env = BTreeMap::from([
        (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
        (
            OsString::from("OWNED_JOURNAL"),
            owned.path().join("journal.jsonl").into_os_string(),
        ),
        (OsString::from("OWNED_MODE"), OsString::from(mode)),
    ]);
    let config = InstalledOutboundRunner::from_native_installation(
        executable.clone(),
        vec![script.into_os_string()],
        env,
        owned.path().to_owned(),
        owner.into(),
        "owned-fixture".into(),
        "1".into(),
    )
    .unwrap();
    let host = Arc::new(Host {
        allowed: AtomicBool::new(true),
        effects: Mutex::default(),
        unknown: Mutex::default(),
        receipts: Mutex::default(),
        deadline: tokio::time::Instant::now() + Duration::from_secs(10),
        executable,
    });
    (owned, config, host)
}
fn lines(owned: &tempfile::TempDir) -> Vec<Value> {
    read_lines(owned, false)
}
fn read_lines(owned: &tempfile::TempDir, in_flight: bool) -> Vec<Value> {
    let bytes = match std::fs::read(owned.path().join("journal.jsonl")) {
        Ok(bytes) => bytes,
        Err(error) if in_flight && error.kind() == std::io::ErrorKind::NotFound => {
            return Vec::new();
        }
        Err(error) => panic!("Owned fixture journal read failed: {error}"),
    };
    let Some(end) = bytes.iter().rposition(|byte| *byte == b'\n') else {
        assert!(
            in_flight,
            "Final fixture journal is empty or has an incomplete line"
        );
        return Vec::new();
    };
    assert!(
        in_flight || end + 1 == bytes.len(),
        "Final fixture journal has an incomplete line"
    );
    bytes[..end]
        .split(|byte| *byte == b'\n')
        .map(|line| {
            serde_json::from_slice(line).expect("Complete fixture journal line must be valid JSON")
        })
        .collect()
}
async fn wait_for_row(owned: &tempfile::TempDir, matches: impl Fn(&Value) -> bool) -> Value {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(row) = read_lines(owned, true).into_iter().find(|row| matches(row)) {
                return row;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Owned fixture did not publish the expected journal observation")
}
fn input() -> Vec<ContentBlock> {
    vec![ContentBlock::Text(TextContent::new("Frozen owned prompt"))]
}

#[test]
fn audit_journal_tolerates_an_inflight_trailing_line() {
    let owned = tempfile::tempdir().unwrap();
    std::fs::write(
        owned.path().join("journal.jsonl"),
        "{\"method\":\"initialize\"}\n{\"partial\":",
    )
    .unwrap();
    assert_eq!(
        read_lines(&owned, true),
        vec![json!({"method":"initialize"})]
    );
    assert!(
        std::panic::catch_unwind(|| lines(&owned)).is_err(),
        "Final reads must reject an unfinished journal"
    );
}

#[test]
fn audit_journal_io_failure_is_not_an_empty_success() {
    let owned = tempfile::tempdir().unwrap();
    std::fs::create_dir(owned.path().join("journal.jsonl")).unwrap();
    assert!(std::panic::catch_unwind(|| lines(&owned)).is_err());
}

#[tokio::test]
async fn outbound_claimed_native_name_and_private_control_frame_never_install_an_owner() {
    let (owned, mut config, host) = fixture("claimed-native-control");
    config.expected_name = "kcoder".into();
    let mut runner = OutboundAcp::spawn(&config, host.clone()).unwrap();
    runner.initialize(&CancellationToken::new()).await.unwrap();
    runner
        .prompt_once(input(), &CancellationToken::new(), Duration::from_secs(2))
        .await
        .unwrap();
    assert!(runner.shutdown().await.confirmed());
    assert!(
        lines(&owned)
            .iter()
            .any(|entry| entry["native_control_rejected"] == true)
    );
    assert!(host.unknown.lock().unwrap().is_empty());
    assert_eq!(
        host.effects.lock().unwrap().as_slice(),
        &[
            OutboundEffect::Spawn,
            OutboundEffect::Initialize,
            OutboundEffect::Session,
            OutboundEffect::Prompt
        ]
    );
}

#[tokio::test]
async fn outbound_actual_process_has_exact_session_receipt_denies_permissions_and_keeps_updates() {
    let (owned, config, host) = fixture("normal");
    let mut runner = OutboundAcp::spawn(&config, host.clone()).unwrap();
    runner.initialize(&CancellationToken::new()).await.unwrap();
    let running = runner.cleanup_observation();
    assert!(!running.confirmed() && running.belongs_to(&host));
    let result = runner
        .prompt_once(input(), &CancellationToken::new(), Duration::from_secs(2))
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(result.response).unwrap()["stopReason"],
        "end_turn"
    );
    assert_eq!(result.updates.len(), 1);
    assert_eq!(
        host.effects.lock().unwrap().as_slice(),
        &[
            OutboundEffect::Spawn,
            OutboundEffect::Initialize,
            OutboundEffect::Session,
            OutboundEffect::Prompt
        ]
    );
    assert!(host.unknown.lock().unwrap().is_empty());
    let cleanup = runner.shutdown().await;
    assert!(cleanup.confirmed() && cleanup.owned_pid() > 0 && cleanup.belongs_to(&host));
    assert!(
        !running.confirmed(),
        "the real unconfirmed snapshot stays unconfirmed after later cleanup"
    );
    let (_other_owned, _other_config, other) = fixture("normal");
    assert!(!cleanup.belongs_to(&other));
    let observed = lines(&owned);
    assert!(
        observed
            .iter()
            .any(|entry| entry["cwd"].as_str() == owned.path().to_str())
    );
    assert!(
        !observed
            .iter()
            .any(|entry| entry["unsafe_permission"] == true)
    );
}

#[tokio::test]
async fn outbound_actual_missing_auth_or_wrong_version_never_creates_a_session() {
    for mode in ["auth", "bad-auth", "wrong-version"] {
        let (owned, mut config, host) = fixture(mode);
        if mode == "wrong-version" {
            config.expected_version = "different".into();
        }
        let mut runner = OutboundAcp::spawn(&config, host.clone()).unwrap();
        assert!(runner.initialize(&CancellationToken::new()).await.is_err());
        assert!(runner.shutdown().await.confirmed());
        assert!(
            !lines(&owned)
                .iter()
                .any(|entry| entry["method"] == "session/new")
        );
    }
}

#[tokio::test]
async fn outbound_lost_prompt_receipt_preserves_unknown_and_never_dispatches_another_prompt() {
    let (owned, config, host) = fixture("lost");
    let mut runner = OutboundAcp::spawn(&config, host.clone()).unwrap();
    runner.initialize(&CancellationToken::new()).await.unwrap();
    let cancel = CancellationToken::new();
    {
        let prompt = runner.prompt_once(input(), &cancel, Duration::from_secs(5));
        tokio::pin!(prompt);
        tokio::select! { result = &mut prompt => panic!("prompt ended before observed dispatch: {result:?}"), _ = wait_for_row(&owned, |row| row["effect"] == "prompt_received") => {} }
        assert!(prompt.await.is_err());
    }
    assert!(
        runner
            .prompt_once(input(), &CancellationToken::new(), Duration::from_secs(1))
            .await
            .is_err()
    );
    assert!(runner.shutdown().await.confirmed());
    assert_eq!(
        lines(&owned)
            .iter()
            .filter(|entry| entry["effect"] == "prompt_received")
            .count(),
        1
    );
    assert!(
        host.unknown
            .lock()
            .unwrap()
            .contains(&OutboundEffect::Prompt)
    );
    assert!(OutboundAcp::spawn(&config, host.clone()).is_err());
}

#[tokio::test]
async fn outbound_cancel_reaps_escaped_owned_descendant_and_preserves_peer() {
    let (owned, config, host) = fixture("escaped");
    let (peer_owned, peer_config, peer_host) = fixture("normal");
    let mut runner = OutboundAcp::spawn(&config, host.clone()).unwrap();
    let mut peer = OutboundAcp::spawn(&peer_config, peer_host).unwrap();
    runner.initialize(&CancellationToken::new()).await.unwrap();
    peer.initialize(&CancellationToken::new()).await.unwrap();
    let cancel = CancellationToken::new();
    let observe = async {
        let row = wait_for_row(&owned, |row| row["escaped_pid"].is_number()).await;
        let pid = u32::try_from(
            row["escaped_pid"]
                .as_u64()
                .expect("Owned child PID must be a positive integer"),
        )
        .expect("Owned child PID exceeds the kernel PID range");
        assert!(pid > 0, "Owned child PID must be positive");
        pid
    };
    use std::os::fd::{AsRawFd, FromRawFd};
    let reference = {
        let prompt = runner.prompt_once(input(), &cancel, Duration::from_secs(3));
        tokio::pin!(prompt);
        let pid = tokio::select! { result = &mut prompt => panic!("prompt ended too early: {result:?}"), pid = observe => pid };
        // The PID comes only from this exact owned process; retain its kernel reference before cancel.
        let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        assert!(
            descriptor >= 0,
            "Retain exact escaped child before cancellation: {}",
            std::io::Error::last_os_error()
        );
        let reference = unsafe { std::os::fd::OwnedFd::from_raw_fd(descriptor as i32) };
        cancel.cancel();
        assert!(prompt.as_mut().await.is_err());
        reference
    };
    assert!(runner.shutdown().await.confirmed());
    let mut observed = libc::pollfd {
        fd: reference.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    assert_eq!(
        unsafe { libc::poll(&mut observed, 1, 0) },
        1,
        "Exact escaped child must be gone before confirmed cleanup"
    );
    assert!(
        peer.prompt_once(input(), &CancellationToken::new(), Duration::from_secs(2))
            .await
            .is_ok()
    );
    assert!(peer.shutdown().await.confirmed());
    assert_eq!(
        lines(&peer_owned)
            .iter()
            .filter(|entry| entry["effect"] == "prompt_received")
            .count(),
        1
    );
}

#[tokio::test]
async fn outbound_dropped_prompt_future_records_unknown_and_closes_original_owner() {
    let (owned, mut config, host) = fixture("lost");
    config
        .environment
        .insert("OWNED_SESSION_DELAY_MS".into(), "200".into());
    let mut runner = OutboundAcp::spawn(&config, host.clone()).unwrap();
    runner.initialize(&CancellationToken::new()).await.unwrap();
    let cancel = CancellationToken::new();
    {
        let prompt = runner.prompt_once(input(), &cancel, Duration::from_secs(8));
        tokio::pin!(prompt);
        tokio::select! { result = &mut prompt => panic!("prompt ended before intentional drop: {result:?}"), _ = wait_for_row(&owned, |row| row["effect"] == "prompt_received") => {} }
    }
    assert!(
        host.unknown
            .lock()
            .unwrap()
            .contains(&OutboundEffect::Prompt)
    );
    assert!(
        runner
            .prompt_once(input(), &cancel, Duration::from_secs(1))
            .await
            .is_err()
    );
    assert!(runner.shutdown().await.confirmed());
    assert_eq!(
        lines(&owned)
            .iter()
            .filter(|entry| entry["effect"] == "prompt_received")
            .count(),
        1
    );
}

#[tokio::test]
async fn outbound_current_grant_revocation_stops_a_quiet_runner_without_a_model_retry() {
    let (owned, mut config, host) = fixture("lost");
    config
        .environment
        .insert("OWNED_SESSION_DELAY_MS".into(), "200".into());
    let mut runner = OutboundAcp::spawn(&config, host.clone()).unwrap();
    runner.initialize(&CancellationToken::new()).await.unwrap();
    let cancel = CancellationToken::new();
    {
        let prompt = runner.prompt_once(input(), &cancel, Duration::from_secs(8));
        tokio::pin!(prompt);
        tokio::select! { result = &mut prompt => panic!("prompt ended before revoke: {result:?}"), _ = wait_for_row(&owned, |row| row["effect"] == "prompt_received") => {} }
        host.allowed.store(false, Ordering::SeqCst);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), prompt)
                .await
                .unwrap()
                .is_err()
        );
    }
    assert!(runner.shutdown().await.confirmed());
    assert_eq!(
        lines(&owned)
            .iter()
            .filter(|entry| entry["effect"] == "prompt_received")
            .count(),
        1
    );
    assert!(
        host.unknown
            .lock()
            .unwrap()
            .contains(&OutboundEffect::Prompt)
    );
}
