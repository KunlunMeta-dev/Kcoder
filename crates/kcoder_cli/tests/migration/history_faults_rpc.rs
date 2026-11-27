//! Linux process-crash acceptance: keep stdin open, SIGSTOP an observed active worker, then SIGKILL.
use super::*;
use kcoder_migration::history_jobs::HistoryJobStore;
use kcoder_migration::history_normalization::HISTORY_NORMALIZATION_REVISION;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::{BufWriter, Read},
    os::unix::process::ExitStatusExt,
    path::Path,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ProcessIdentity {
    pid: u32,
    started: u64,
}
fn process(pid: u32) -> Option<(ProcessIdentity, char)> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, tail) = stat.rsplit_once(") ")?;
    let fields = tail.split_whitespace().collect::<Vec<_>>();
    Some((
        ProcessIdentity {
            pid,
            started: fields.get(19)?.parse().ok()?,
        },
        fields.first()?.chars().next()?,
    ))
}
fn alive(identity: ProcessIdentity) -> bool {
    process(identity.pid)
        .is_some_and(|(current, state)| current == identity && !matches!(state, 'Z' | 'X'))
}
fn stopped_threads(pid: u32) -> bool {
    let Ok(tasks) = fs::read_dir(format!("/proc/{pid}/task")) else {
        return false;
    };
    let mut count = 0;
    for task in tasks {
        let Ok(task) = task else {
            return false;
        };
        let Ok(tid) = task.file_name().to_string_lossy().parse::<u32>() else {
            return false;
        };
        if !process(tid).is_some_and(|(_, state)| matches!(state, 'T' | 't')) {
            return false;
        }
        count += 1;
    }
    count > 0
}
fn hot_journal(path: &Path) -> Option<(u64, String)> {
    let mut file = fs::File::open(path).ok()?;
    let bytes = file.metadata().ok()?.len();
    let mut header = [0u8; 8];
    file.read_exact(&mut header).ok()?;
    (bytes > 512 && header.iter().any(|byte| *byte != 0)).then(|| {
        (
            bytes,
            header
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
        )
    })
}
fn projection_journal(fixture: &Fixture, archive: &str) -> std::path::PathBuf {
    fixture
        .profile
        .join("external-history")
        .join(archive)
        .join(format!(
            "normalized-{:x}",
            Sha256::digest(HISTORY_NORMALIZATION_REVISION.as_bytes())
        ))
        .join("catalog.sqlite3-journal")
}

fn archive_failure_inventory(fixture: &Fixture, current: &Value) {
    let Some(archive) = current["job"]["archiveId"].as_str() else {
        return;
    };
    if !archive.starts_with("archive-")
        || !archive
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return;
    }
    let root = fixture.profile.join("external-history").join(archive);
    let mut directories = vec![(String::new(), root)];
    let mut entries = Vec::new();
    while let Some((prefix, directory)) = directories.pop() {
        let Ok(children) = fs::read_dir(directory) else {
            continue;
        };
        for entry in children.take(32).flatten() {
            let name = entry
                .file_name()
                .to_string_lossy()
                .chars()
                .take(128)
                .collect::<String>();
            let Ok(metadata) = entry.path().symlink_metadata() else {
                continue;
            };
            let path = format!("{prefix}{name}");
            entries.push(json!({"name":path,"directory":metadata.is_dir(),"symlink":metadata.is_symlink(),"bytes":metadata.len()}));
            if prefix.is_empty() && metadata.is_dir() && !metadata.is_symlink() {
                directories.push((format!("{name}/"), entry.path()));
            }
            if entries.len() >= 64 {
                break;
            }
        }
        if entries.len() >= 64 {
            break;
        }
    }
    eprintln!(
        "migration_owned_failure_inventory {}",
        json!({"entries":entries})
    );
}
fn descendants(root: u32) -> Vec<ProcessIdentity> {
    let mut pending = vec![root];
    let mut seen = BTreeSet::new();
    let mut found = Vec::new();
    while let Some(parent) = pending.pop() {
        let Ok(tasks) = fs::read_dir(format!("/proc/{parent}/task")) else {
            continue;
        };
        for task in tasks {
            let task = task.unwrap();
            let Ok(children) = fs::read_to_string(task.path().join("children")) else {
                continue;
            };
            for child in children
                .split_whitespace()
                .map(|value| value.parse::<u32>().unwrap())
            {
                if seen.insert(child) {
                    assert!(
                        seen.len() <= 256,
                        "owned fixture descendant budget exceeded"
                    );
                    if let Some((identity, _)) = process(child) {
                        found.push(identity);
                        pending.push(child);
                    }
                }
            }
        }
    }
    found
}
struct ChildAudit(Vec<ProcessIdentity>);
impl Drop for ChildAudit {
    fn drop(&mut self) {
        for identity in &self.0 {
            if alive(*identity) {
                // SAFETY: this exact PID/start-time pair was captured below the owned stopped host.
                unsafe {
                    libc::kill(identity.pid as libc::pid_t, libc::SIGKILL);
                }
            }
        }
    }
}
fn kill_active(
    server: &mut TestAppServer,
    fixture: &Fixture,
    key: &str,
    observed: &Value,
    require_hot_journal: bool,
) -> Value {
    assert!(
        server.stdin.is_some(),
        "stdin must stay open until the real process crash"
    );
    assert!(server.child.try_wait().unwrap().is_none());
    let pid = server.child.id();
    assert_ne!(pid, std::process::id());
    let identity = process(pid).unwrap().0;
    let journal = projection_journal(fixture, observed["job"]["archiveId"].as_str().unwrap());
    let fault_deadline = Instant::now() + Duration::from_secs(15);
    let journal_at_kill = loop {
        if require_hot_journal && hot_journal(&journal).is_none() {
            assert!(
                Instant::now() < fault_deadline,
                "no active rollback journal observed in the owned normalization worker"
            );
            std::thread::sleep(Duration::from_micros(50));
            continue;
        }
        // SAFETY: Child owns this unreaped PID; STOP makes the durable phase observation race-free.
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGSTOP) }, 0);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if process(pid)
                .is_some_and(|(current, state)| current == identity && matches!(state, 'T' | 't'))
                && stopped_threads(pid)
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "owned host never entered SIGSTOP"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        let snapshot = hot_journal(&journal);
        if !require_hot_journal || snapshot.is_some() {
            break snapshot;
        }
        // SAFETY: resume only this still-owned stopped host if STOP missed the transaction window.
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGCONT) }, 0);
        assert!(
            Instant::now() < fault_deadline,
            "STOP repeatedly crossed the owned journal transaction window"
        );
    };
    let children = ChildAudit(descendants(pid));
    // Do not open SQLite alongside a stopped writer: observe only its durable job envelope.
    let envelope: Value = serde_json::from_slice(
        &fs::read(
            fixture
                .profile
                .join("migrations/history")
                .join(format!("{key}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    let mut frozen = envelope["view"].clone();
    frozen["confirmedRecords"] = observed["job"]["normalization"]["normalizedRecords"].clone();
    assert_eq!(
        frozen["stage"], observed["job"]["stage"],
        "the host passed the selected fault phase before STOP"
    );
    assert!(frozen["sequence"].as_u64().unwrap() >= observed["job"]["sequence"].as_u64().unwrap());
    if let Some(confirmed) = observed["job"]["normalization"]["normalizedRecords"].as_u64() {
        assert!(confirmed > 0);
        assert!(
            frozen["normalization"]["normalizedRecords"]
                .as_u64()
                .unwrap()
                < frozen["normalization"]["sourceRecords"].as_u64().unwrap()
        );
    }
    assert_eq!(frozen["cancelRequested"], false);
    // SAFETY: the same Child is still unreaped and stopped; this is SIGKILL, never graceful EOF/cancel.
    assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) }, 0);
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = server.child.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "SIGKILL did not terminate the owned host"
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    assert_eq!(status.signal(), Some(libc::SIGKILL));
    assert!(!alive(identity));
    let deadline = Instant::now() + Duration::from_secs(5);
    while children.0.iter().any(|identity| alive(*identity)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        children.0.iter().all(|identity| !alive(*identity)),
        "owned child processes survived the host crash"
    );
    eprintln!(
        "migration_crash_evidence {}",
        json!({"platform":"linux","pid":pid,"exitSignal":status.signal(),"stdinOpenAtKill":server.stdin.is_some(),"phase":frozen["stage"],"acknowledgedSequence":observed["job"]["sequence"],"frozenSequence":frozen["sequence"],"confirmedRecords":observed["job"]["normalization"]["normalizedRecords"],"frozenRecords":frozen["normalization"]["normalizedRecords"],"ownedDescendants":children.0.len(),"ownedDescendantsRemaining":0,"journalBytesAtKill":journal_at_kill.as_ref().map(|value|value.0),"journalHeaderAtKill":journal_at_kill.as_ref().map(|value|&value.1)})
    );
    frozen
}

fn start(fixture: &Fixture) -> TestAppServer {
    let mut builder = TestAppServer::builder(&fixture.workspace, &fixture.overlay)
        .config_dir(&fixture.profile)
        .discard_stderr();
    for (name, value) in [
        ("HOME", fixture.root.path()),
        ("USERPROFILE", fixture.root.path()),
        ("CLAUDE_CONFIG_DIR", fixture.claude.as_path()),
        ("CODEX_HOME", fixture.codex.as_path()),
        ("KCODER_TUI_LAB_REQUEST_DIR", fixture.workspace.as_path()),
    ] {
        let value = if name == "KCODER_TUI_LAB_REQUEST_DIR" {
            value.join("model-requests")
        } else {
            value.to_path_buf()
        };
        builder
            .extra_env
            .push((name.into(), value.into_os_string()));
    }
    let mut server = builder.spawn();
    rpc(
        &mut server,
        1,
        "initialize",
        json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"migration-process-crash-linux","version":"test"}}),
    );
    server
}

fn read_checkpoint(server: &mut TestAppServer, key: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        server.send(json!({"jsonrpc":"2.0","id":20,"method":"migration/history/read","params":{"jobId":key}}));
        let response = server.response(20);
        if response["error"]["message"] == "history_catalog_busy" {
            assert!(
                Instant::now() < deadline,
                "owned SQLite observation remained busy: {response}"
            );
            std::thread::sleep(Duration::from_millis(2));
            continue;
        }
        assert!(response.get("error").is_none(), "{response}");
        return response["result"].clone();
    }
}

fn wait_fault_phase(
    server: &mut TestAppServer,
    key: &str,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view = read_checkpoint(server, key);
        if predicate(&view) {
            return view;
        }
        assert!(
            Instant::now() < deadline,
            "owned fault phase was not observed: {view}"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn source(fixture: &Fixture, large: bool) -> PathBuf {
    let path = fixture.source(0);
    let session = path.file_stem().unwrap().to_str().unwrap();
    let mut file = BufWriter::new(fs::File::create(&path).unwrap());
    writeln!(file,"{}",json!({"type":"assistant","uuid":"old-call-message","sessionId":session,"version":"2.1.301","message":{"role":"assistant","content":[{"type":"tool_use","id":"old-call","name":"Bash","input":{"command":format!("touch {}",fixture.workspace.join("NEVER_REPLAY_CRASH_HISTORY").display())}}]}})).unwrap();
    if large {
        write!(file,"{{\"type\":\"user\",\"uuid\":\"old-result\",\"parentUuid\":\"old-call-message\",\"sessionId\":\"{session}\",\"version\":\"2.1.301\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"tool_result\",\"tool_use_id\":\"old-call\",\"content\":\"ARCHIVE_CRASH_PREFIX ").unwrap();
        let chunk = vec![b'x'; 1024 * 1024];
        for _ in 0..64 {
            file.write_all(&chunk).unwrap();
        }
        writeln!(file, " ARCHIVE_CRASH_TAIL\"}}]}}}}").unwrap();
    } else {
        writeln!(file,"{}",json!({"type":"user","uuid":"old-result","parentUuid":"old-call-message","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"old-call","content":"NORMALIZATION_CRASH_RESULT"}]}})).unwrap();
        for index in 0..10_000 {
            writeln!(file,"{}",json!({"type":"user","uuid":format!("message-{index}"),"parentUuid":if index==0 {"old-result".into()} else {format!("message-{}",index-1)},"sessionId":session,"version":"2.1.301","message":{"role":"user","content":format!("Confirmed historical request {index}")}})).unwrap();
        }
    }
    file.flush().unwrap();
    drop(file);
    path
}
fn digest(path: &Path) -> String {
    let mut file = fs::File::open(path).unwrap();
    let mut hash = Sha256::new();
    let mut chunk = vec![0; 1024 * 1024];
    loop {
        let count = file.read(&mut chunk).unwrap();
        if count == 0 {
            break;
        }
        hash.update(&chunk[..count]);
    }
    format!("{:x}", hash.finalize())
}
fn selected(server: &mut TestAppServer, key: &str) -> Value {
    let page = rpc(
        server,
        2,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    assert_eq!(page["totalItems"], 1);
    create(server, &page, &page["items"][0], key)
}
fn assert_no_model_or_tool_execution(fixture: &Fixture, server: &mut TestAppServer) {
    assert!(
        !fixture
            .workspace
            .join("NEVER_REPLAY_CRASH_HISTORY")
            .exists()
    );
    let requests = fixture.workspace.join("model-requests");
    assert!(
        !requests.exists() || fs::read_dir(requests).unwrap().next().is_none(),
        "migration issued a model request"
    );
    assert_eq!(
        rpc(server, 20, "thread/list", json!({}))["threads"],
        json!([])
    );
}
fn continue_same_job(
    fixture: &Fixture,
    server: &mut TestAppServer,
    key: &str,
    frozen: &Value,
    records: u64,
    prefix: Option<&Value>,
) -> Value {
    let journal = projection_journal(fixture, frozen["archiveId"].as_str().unwrap());
    let journal_before_observation = hot_journal(&journal);
    let native = HistoryJobStore::open_existing(&fixture.profile)
        .unwrap()
        .unwrap()
        .read(key)
        .unwrap();
    let restored = read_checkpoint(server, key);
    assert_eq!(serde_json::to_value(native).unwrap(), restored["job"]);
    let needs_recovery = restored["job"]["failureCode"] == "history_projection_recovery_required";
    if prefix.is_some() {
        assert!(
            needs_recovery,
            "the SIGKILL hot journal was not surfaced: {restored}"
        );
        assert_eq!(restored["job"]["sequence"], frozen["sequence"]);
        assert_eq!(restored["job"]["normalization"], frozen["normalization"]);
    }
    assert_eq!(restored["workerRunning"], false);
    assert_eq!(restored["job"]["cancelRequested"], false);
    assert_eq!(restored["job"]["stage"], frozen["stage"]);
    assert!(restored["job"]["sequence"].as_u64().unwrap() >= frozen["sequence"].as_u64().unwrap());
    if let Some(confirmed) = frozen["normalization"]["normalizedRecords"].as_u64() {
        assert!(
            restored["job"]["normalization"]["normalizedRecords"]
                .as_u64()
                .unwrap()
                >= confirmed
        );
    }
    if let Some(confirmed) = frozen["confirmedRecords"]
        .as_u64()
        .filter(|_| !needs_recovery)
    {
        assert!(
            restored["job"]["normalization"]["normalizedRecords"]
                .as_u64()
                .unwrap()
                >= confirmed,
            "a confirmed RPC watermark was lost after the process crash"
        );
    }
    assert_eq!(
        selected(server, key)["job"],
        restored["job"],
        "the original requestId must reconcile to the same archive job"
    );
    assert_eq!(
        rpc(server, 21, "migration/history/jobs", json!({}))["jobs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        hot_journal(&journal),
        journal_before_observation,
        "read/reconciliation/list must not recover or discard a hot journal"
    );
    if let Some(prefix) = prefix.filter(|_| !needs_recovery) {
        assert_eq!(
            rpc(
                server,
                22,
                "migration/history/transcript",
                json!({"jobId":key})
            )["items"],
            *prefix
        );
    }
    rpc(
        server,
        23,
        "migration/history/run",
        json!({"jobId":key,"expectedSequence":restored["job"]["sequence"]}),
    );
    let mut last_records = restored["job"]["normalization"]["normalizedRecords"]
        .as_u64()
        .unwrap_or(0);
    let mut last_sequence = restored["job"]["sequence"].as_u64().unwrap();
    // 10k durable records: each is fsynced before acknowledgement, so total time
    // follows disk and CPU load. The deadline only bounds a hang: it moves with
    // every durable checkpoint advance.
    const STALL_LIMIT: Duration = Duration::from_secs(120);
    let mut deadline = Instant::now() + STALL_LIMIT;
    let done = loop {
        let current = read_checkpoint(server, key);
        if current["job"]["stage"] == "failed" || Instant::now() >= deadline {
            archive_failure_inventory(fixture, &current);
            if current["workerRunning"] == false
                && current["job"]["stage"] == "normalized"
                && current["job"]["failureCode"] == "history_projection_recovery_required"
            {
                let store = HistoryJobStore::open_existing(&fixture.profile)
                    .unwrap()
                    .unwrap();
                let (observed, execution) = store.observe_execution(key).unwrap();
                if execution == kcoder_migration::history_jobs::HistoryExecutionState::Stopped {
                    // This fixture-only explicit reconciliation uses the same owned job
                    // and current CAS. It cannot execute any source tool or model.
                    let probe = store.step(key, observed.sequence, 10, |_| true);
                    eprintln!(
                        "migration_owned_stopped_writer_probe {}",
                        match probe {
                            Ok(view) => json!({"stage":view.stage,"failureCode":view.failure_code}),
                            Err(error) =>
                                json!({"error":format!("{error:#}").chars().take(1024).collect::<String>()}),
                        }
                    );
                }
            }
        }
        assert_ne!(current["job"]["stage"], "failed", "{current}");
        assert!(current["job"]["sequence"].as_u64().unwrap() >= last_sequence);
        if current["job"]["sequence"].as_u64().unwrap() > last_sequence {
            deadline = Instant::now() + STALL_LIMIT;
        }
        last_sequence = current["job"]["sequence"].as_u64().unwrap();
        if let Some(watermark) = current["job"]["normalization"]["normalizedRecords"].as_u64() {
            assert!(watermark >= last_records);
            if current["job"]["failureCode"].is_null() {
                assert!(
                    watermark >= frozen["confirmedRecords"].as_u64().unwrap_or(0),
                    "writer recovery lost a previously acknowledged normalization watermark"
                );
            }
            last_records = watermark;
        }
        if current["job"]["stage"] == "normalized"
            && current["workerRunning"] == false
            && current["job"]["failureCode"].is_null()
        {
            break current;
        }
        assert!(
            Instant::now() < deadline,
            "explicit crash recovery did not settle: {current}"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(done["job"]["jobId"], key);
    assert_eq!(done["job"]["archiveId"], frozen["archiveId"]);
    assert_eq!(done["job"]["normalization"]["sourceRecords"], records);
    assert_eq!(done["job"]["normalization"]["normalizedRecords"], records);
    assert_eq!(done["job"]["normalization"]["recordsWithDiagnostics"], 0);
    if let Some(confirmed) = frozen["confirmedRecords"].as_u64() {
        assert!(
            done["job"]["normalization"]["normalizedRecords"]
                .as_u64()
                .unwrap()
                >= confirmed
        );
    }
    if let Some(prefix) = prefix {
        assert_eq!(
            rpc(
                server,
                24,
                "migration/history/transcript",
                json!({"jobId":key})
            )["items"],
            *prefix
        );
    }
    assert_no_model_or_tool_execution(fixture, server);
    done
}

#[test]
fn archive_sigkill_recovers_the_original_job_without_replaying_a_source_tool() {
    let fixture = Fixture::new();
    let path = source(&fixture, true);
    let before = digest(&path);
    let mut server = start(&fixture);
    let key = uuid::Uuid::new_v4().to_string();
    selected(&mut server, &key);
    rpc(
        &mut server,
        3,
        "migration/history/run",
        json!({"jobId":key,"expectedSequence":0}),
    );
    let active = wait_fault_phase(&mut server, &key, |value| {
        value["workerRunning"] == true
            && value["job"]["stage"] == "archiving"
            && value["job"]["archived"] == false
            && value["progress"]["phase"] == "copying"
            && value["progress"]["processed"]
                .as_u64()
                .is_some_and(|bytes| {
                    bytes > 0 && bytes < value["progress"]["total"].as_u64().unwrap_or(0)
                })
    });
    let frozen = kill_active(&mut server, &fixture, &key, &active, false);
    assert_eq!(frozen["archived"], false);
    drop(server);
    let mut reopened = start(&fixture);
    let done = continue_same_job(&fixture, &mut reopened, &key, &frozen, 2, None);
    assert_eq!(digest(&path), before);
    eprintln!(
        "migration_crash_recovery {}",
        json!({"platform":"linux","fault":"archiving_sigkill","jobId":key,"finalSequence":done["job"]["sequence"],"normalizedRecords":2,"sourceUnchanged":true,"modelRequests":0,"historicalToolReplays":0})
    );
    let pid = reopened.child.id();
    reopened.shutdown();
    assert!(process(pid).is_none());
}

#[test]
fn normalization_sigkill_preserves_confirmed_rows_and_continues_from_the_same_watermark() {
    let fixture = Fixture::new();
    let path = source(&fixture, false);
    let before = digest(&path);
    let mut server = start(&fixture);
    let key = uuid::Uuid::new_v4().to_string();
    selected(&mut server, &key);
    rpc(
        &mut server,
        3,
        "migration/history/run",
        json!({"jobId":key,"expectedSequence":0}),
    );
    let active = wait_fault_phase(&mut server, &key, |value| {
        value["workerRunning"] == true
            && value["job"]["stage"] == "normalizing"
            && value["job"]["normalization"]["normalizedRecords"]
                .as_u64()
                .is_some_and(|count| (20..9900).contains(&count))
    });
    let prefix = rpc(
        &mut server,
        4,
        "migration/history/transcript",
        json!({"jobId":key}),
    )["items"]
        .clone();
    assert_eq!(prefix.as_array().unwrap().len(), 10);
    let frozen = kill_active(&mut server, &fixture, &key, &active, true);
    drop(server);
    let recovery = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut reopened = start(&fixture);
        let done = continue_same_job(
            &fixture,
            &mut reopened,
            &key,
            &frozen,
            10_002,
            Some(&prefix),
        );
        assert_eq!(digest(&path), before);
        eprintln!(
            "migration_crash_recovery {}",
            json!({"platform":"linux","fault":"normalizing_sigkill","jobId":key,"finalSequence":done["job"]["sequence"],"normalizedRecords":10_002,"confirmedPrefixPreserved":true,"sourceUnchanged":true,"modelRequests":0,"historicalToolReplays":0})
        );
        let pid = reopened.child.id();
        reopened.shutdown();
        assert!(process(pid).is_none());
    }));
    if let Err(panic) = recovery {
        // Retain only this owned synthetic source/profile for read-only crash diagnosis.
        eprintln!(
            "migration_crash_owned_failure_fixture {}",
            fixture.root.keep().display()
        );
        std::panic::resume_unwind(panic);
    }
}

struct OwnedWriter(std::process::Child);
impl Drop for OwnedWriter {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

#[test]
fn normalized_job_explicit_run_recovers_a_crashed_projection_writer() {
    // The same test executable is the owned writer fixture; no production fault seam is added.
    if let Some(profile) = std::env::var_os("KCODER_MIGRATION_FAULT_COMPLETED_PROFILE") {
        let profile = std::path::PathBuf::from(profile);
        let key = std::env::var("KCODER_MIGRATION_FAULT_COMPLETED_JOB").unwrap();
        let store = HistoryJobStore::open_existing(&profile).unwrap().unwrap();
        let archive_id = store.read(&key).unwrap().archive_id.unwrap();
        let projection = store
            .archive_reader(&key)
            .unwrap()
            .projection(HISTORY_NORMALIZATION_REVISION, true)
            .unwrap()
            .unwrap();
        assert!(projection.progress().unwrap().normalization_complete);
        let database = profile
            .join("external-history")
            .join(archive_id)
            .join(format!(
                "normalized-{:x}",
                Sha256::digest(HISTORY_NORMALIZATION_REVISION.as_bytes())
            ))
            .join("catalog.sqlite3");
        // The real projection lease authenticates the owned test database. This fixture-only
        // uncommitted write forces dirty-page spill so SIGKILL leaves a durable hot journal.
        let connection = rusqlite::Connection::open_with_flags(
            database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap();
        connection.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; UPDATE projection_header SET body=zeroblob(1048576) WHERE id=1;").unwrap();
        connection.cache_flush().unwrap();
        fs::write(profile.join("completed-writer-ready"), b"ready").unwrap();
        loop {
            std::hint::black_box((&projection, &connection));
            std::thread::park_timeout(Duration::from_secs(1));
        }
    }
    let fixture = Fixture::new();
    let source = fixture.source(2);
    let before = digest(&source);
    let mut server = start(&fixture);
    let key = uuid::Uuid::new_v4().to_string();
    selected(&mut server, &key);
    rpc(
        &mut server,
        3,
        "migration/history/run",
        json!({"jobId":key,"expectedSequence":0}),
    );
    let done = wait_fault_phase(&mut server, &key, |value| {
        value["job"]["stage"] == "normalized" && value["workerRunning"] == false
    });
    let prefix = rpc(
        &mut server,
        4,
        "migration/history/transcript",
        json!({"jobId":key}),
    )["items"]
        .clone();
    let envelope = fixture
        .profile
        .join("migrations/history")
        .join(format!("{key}.json"));
    let checkpoint = fs::read(&envelope).unwrap();
    server.shutdown();

    let test_name = format!(
        "{}::normalized_job_explicit_run_recovers_a_crashed_projection_writer",
        module_path!().split_once("::").unwrap().1
    );
    let mut writer = OwnedWriter(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test_name.as_str(), "--nocapture"])
            .env("KCODER_MIGRATION_FAULT_COMPLETED_PROFILE", &fixture.profile)
            .env("KCODER_MIGRATION_FAULT_COMPLETED_JOB", &key)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let pid = writer.0.id();
    let deadline = Instant::now() + Duration::from_secs(15);
    let journal = projection_journal(&fixture, done["job"]["archiveId"].as_str().unwrap());
    let observed_journal = loop {
        assert!(
            writer.0.try_wait().unwrap().is_none(),
            "owned completed writer exited"
        );
        assert!(
            Instant::now() < deadline,
            "owned completed writer produced no hot journal"
        );
        if !fixture.profile.join("completed-writer-ready").exists()
            || hot_journal(&journal).is_none()
        {
            std::thread::sleep(Duration::from_micros(50));
            continue;
        }
        // SAFETY: this unreaped Child owns the exact PID and is the only process stopped.
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGSTOP) }, 0);
        while !stopped_threads(pid) {
            assert!(
                Instant::now() < deadline,
                "owned completed writer did not stop"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        if let Some(snapshot) = hot_journal(&journal) {
            break snapshot;
        }
        // SAFETY: resume only the same owned Child if STOP missed its transaction window.
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGCONT) }, 0);
    };
    let children = ChildAudit(descendants(pid));
    writer.0.kill().unwrap();
    assert_eq!(writer.0.wait().unwrap().signal(), Some(libc::SIGKILL));
    assert!(children.0.iter().all(|identity| !alive(*identity)));
    assert_eq!(hot_journal(&journal), Some(observed_journal));
    assert_eq!(fs::read(&envelope).unwrap(), checkpoint);
    let mut frozen = done["job"].clone();
    frozen["confirmedRecords"] = json!(2);
    let mut reopened = start(&fixture);
    let recovered = continue_same_job(&fixture, &mut reopened, &key, &frozen, 2, Some(&prefix));
    assert_eq!(recovered["job"]["sequence"], done["job"]["sequence"]);
    assert_eq!(fs::read(envelope).unwrap(), checkpoint);
    assert_eq!(digest(&source), before);
    eprintln!(
        "migration_crash_recovery {}",
        json!({"platform":"linux","fault":"normalized_projection_writer_sigkill","jobId":key,"finalSequence":recovered["job"]["sequence"],"normalizedRecords":2,"confirmedPrefixPreserved":true,"sourceUnchanged":true,"modelRequests":0,"historicalToolReplays":0})
    );
    let pid = reopened.child.id();
    reopened.shutdown();
    assert!(process(pid).is_none());
}
