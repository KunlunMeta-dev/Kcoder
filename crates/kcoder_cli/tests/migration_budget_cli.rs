//! Actual isolated CLI policy controls never run history work or replace an original receipt.
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    path::PathBuf,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

const LIMITS: [&str; 8] = [
    "--max-total-bytes",
    "2097152",
    "--max-payload-files",
    "64",
    "--min-free-bytes",
    "1048576",
    "--min-free-file-nodes",
    "0",
];

struct Fixture {
    root: tempfile::TempDir,
    profile: PathBuf,
    workspace: PathBuf,
    source: PathBuf,
    binary: PathBuf,
    settings: Vec<u8>,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
        let workspace = root.path().join("workspace");
        let source = root.path().join("claude");
        for directory in [&workspace, &source] {
            fs::create_dir(directory).unwrap();
        }
        let settings = serde_json::to_vec(&json!({
            "credential_store":"file", "active_provider":null, "providers":{}, "mcp_servers":[], "hooks":{}
        })).unwrap();
        fs::write(profile.join("settings.json"), &settings).unwrap();
        let binary = workspace.join(if cfg!(windows) {
            "kcoder.exe"
        } else {
            "kcoder"
        });
        if fs::hard_link(env!("CARGO_BIN_EXE_kcoder"), &binary).is_err() {
            fs::copy(env!("CARGO_BIN_EXE_kcoder"), &binary).unwrap();
        }
        Self {
            root,
            profile,
            workspace,
            source,
            binary,
            settings,
        }
    }
    fn invoke(&self, area: &str, args: &[&str]) -> Output {
        let mut command = Command::new(&self.binary);
        command
            .args([
                "migrate",
                area,
                "--target-profile",
                self.profile.to_str().unwrap(),
            ])
            .args(args)
            .current_dir(&self.workspace)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", self.root.path())
            .env("USERPROFILE", self.root.path())
            .env("KCODER_CONFIG_DIR", &self.profile)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        for name in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let mut child = command.spawn().unwrap();
        let reader = |input: Box<dyn Read + Send>| {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                input
                    .take(2 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .unwrap();
                assert!(bytes.len() <= 2 * 1024 * 1024);
                bytes
            })
        };
        let stdout = reader(Box::new(child.stdout.take().unwrap()));
        let stderr = reader(Box::new(child.stderr.take().unwrap()));
        let started = Instant::now();
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                return Output {
                    status,
                    stdout: stdout.join().unwrap(),
                    stderr: stderr.join().unwrap(),
                };
            }
            if started.elapsed() > Duration::from_secs(60) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("owned policy CLI exceeded its deadline");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn call(&self, area: &str, args: &[&str]) -> Value {
        let output = self.invoke(area, args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    fn selected(&self) -> (String, Value) {
        let session = uuid::Uuid::new_v4().to_string();
        let path = self.source.join(format!("projects/owned/{session}.jsonl"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("{}\n", json!({"type":"user","uuid":"original-user","sessionId":session,"version":"2.1.301","message":{"role":"user","content":"Owned budget fixture; no execution authority."}}))).unwrap();
        let request = uuid::Uuid::new_v4().to_string();
        let view = self.call(
            "history",
            &[
                "select",
                "--source",
                "claude-code",
                "--source-root",
                self.source.to_str().unwrap(),
                "--source-session-id",
                &session,
                "--request-id",
                &request,
                "--resource-max-total-bytes",
                "1048576",
                "--resource-max-payload-files",
                "64",
                "--resource-min-free-bytes",
                "1048576",
                "--resource-min-free-file-nodes",
                "0",
            ],
        );
        (request, view)
    }
    fn budget(&self, id: &str, request: Option<&str>) -> Value {
        let mut args = vec!["read", "--scope", "history", "--job-id", id];
        if let Some(request) = request {
            args.extend(["--request-id", request]);
        }
        self.call("budget", &args)
    }
}

#[test]
fn standalone_policy_raise_reconciles_the_original_receipt_without_running_or_resetting_a_job() {
    let f = Fixture::new();
    let (id, selected) = f.selected();
    let original = f.budget(&id, None);
    assert_eq!(original["ownerJobId"], id);
    assert_eq!(original["budget"]["phase"], "active");
    assert_eq!(original["budget"]["limits"]["maxTotalBytes"], 1048576);
    let revision = original["budget"]["policyRevision"]
        .as_u64()
        .unwrap()
        .to_string();
    let request = uuid::Uuid::new_v4().to_string();
    let mut args = vec![
        "increase",
        "--scope",
        "history",
        "--job-id",
        &id,
        "--request-id",
        &request,
        "--expected-policy-revision",
        &revision,
    ];
    args.extend(LIMITS);
    assert!(!f.invoke("budget", &args).status.success());
    assert_eq!(f.budget(&id, None), original);
    args.push("--confirm");
    let receipt = f.call("budget", &args);
    assert_eq!(receipt["jobId"], id);
    assert_eq!(receipt["requestId"], request);
    assert_eq!(receipt["limits"]["maxTotalBytes"], 2097152);
    assert_eq!(
        f.call("budget", &args),
        receipt,
        "same accepted intent retains its original receipt"
    );
    let after = f.budget(&id, Some(&request));
    assert_eq!(after["initialLimits"]["maxTotalBytes"], 1048576);
    assert_eq!(after["budget"]["requestedReceipt"], receipt);
    fs::rename(&f.source, f.root.path().join("source-withheld")).unwrap();
    assert_eq!(f.budget(&id, Some(&request)), after);
    let reopened = f.call("history", &["read", "--job-id", &id]);
    assert_eq!(
        reopened, selected,
        "policy-only changes do not alter execution or cancellation state"
    );
    assert_eq!(
        fs::read(f.profile.join("settings.json")).unwrap(),
        f.settings
    );
}

#[test]
fn missing_job_reads_and_unconfirmed_legacy_attachment_create_no_resource_namespace() {
    let f = Fixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    assert!(
        !f.invoke("budget", &["read", "--scope", "history", "--job-id", &id])
            .status
            .success()
    );
    let mut attach = vec![
        "attach",
        "--scope",
        "history",
        "--job-id",
        &id,
        "--expected-sequence",
        "0",
    ];
    attach.extend(LIMITS);
    assert!(!f.invoke("budget", &attach).status.success());
    assert!(!f.profile.join("migrations").exists());
    assert!(!f.profile.join("external-history").exists());
    assert_eq!(
        fs::read(f.profile.join("settings.json")).unwrap(),
        f.settings
    );
}

#[test]
fn explicit_legacy_accounting_attachment_keeps_original_history_and_does_not_read_the_source() {
    let f = Fixture::new();
    let (id, selected) = f.selected();
    let done = f.call(
        "history",
        &[
            "run",
            "--job-id",
            &id,
            "--expected-sequence",
            &selected["sequence"].to_string(),
        ],
    );
    let journal_path = f
        .profile
        .join("migrations/history")
        .join(format!("{id}.json"));
    let mut journal: Value = serde_json::from_slice(&fs::read(&journal_path).unwrap()).unwrap();
    let group = journal["resourceBudget"]["reference"]["group"]
        .as_str()
        .unwrap()
        .to_owned();
    journal["version"] = json!(3);
    journal.as_object_mut().unwrap().remove("resourceBudget");
    fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
    fs::remove_file(
        f.profile
            .join("migrations/history")
            .join(format!("{id}.resource.birth")),
    )
    .unwrap();
    let ledger_path = f.profile.join("external-history/managed-v2/lifecycle.json");
    let mut ledger: Value = serde_json::from_slice(&fs::read(&ledger_path).unwrap()).unwrap();
    ledger["resource_groups"]
        .as_object_mut()
        .unwrap()
        .remove(&group);
    for archive in ledger["archives"].as_object_mut().unwrap().values_mut() {
        archive.as_object_mut().unwrap().remove("resource_budget");
    }
    fs::write(ledger_path, serde_json::to_vec(&ledger).unwrap()).unwrap();
    fs::rename(&f.source, f.root.path().join("source-withheld")).unwrap();
    let old_view = f.call("history", &["read", "--job-id", &id]);
    assert_eq!(old_view, done);
    assert_eq!(f.budget(&id, None)["budget"]["phase"], "legacy_untracked");
    let sequence = old_view["sequence"].to_string();
    let mut args = vec![
        "attach",
        "--scope",
        "history",
        "--job-id",
        &id,
        "--expected-sequence",
        &sequence,
    ];
    args.extend(LIMITS);
    let original_journal = fs::read(&journal_path).unwrap();
    assert!(!f.invoke("budget", &args).status.success());
    assert_eq!(fs::read(&journal_path).unwrap(), original_journal);
    args.push("--confirm");
    let attached = f.call("budget", &args);
    assert_eq!(attached["budget"]["phase"], "active");
    assert_eq!(f.call("budget", &args), attached);
    assert_eq!(f.call("history", &["read", "--job-id", &id]), old_view);
    assert_eq!(
        fs::read(f.profile.join("settings.json")).unwrap(),
        f.settings
    );
}

#[test]
fn batch_policy_is_changed_only_through_its_original_parent_and_plan() {
    use kcoder_migration::{
        assets::AssetTarget,
        batch::{BatchActionKind, BatchSource, default_resolution, history::HistoryBatchSource},
        history_discovery::HistoryCatalog,
        history_jobs::HistoryJobStore,
        mcp::McpTarget,
        providers::ProviderTarget,
        store::{BatchTargets, MigrationStore},
    };
    use kcoder_types::migration::MigrationSourceKind;
    let f = Fixture::new();
    let session = uuid::Uuid::new_v4().to_string();
    let directory = f.source.join("projects/parent-fixture");
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        directory.join(format!("{session}.jsonl")),
        format!(
            "{}\n",
            json!({
                "type":"user","uuid":"original","sessionId":session,"version":"2.1.301",
                "message":{"role":"user","content":"Owned original batch history."}
            })
        ),
    )
    .unwrap();
    let catalog =
        HistoryCatalog::discover(&f.source, MigrationSourceKind::ClaudeCode, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    let selection = catalog
        .selection(&page.items[0].source_handle)
        .unwrap()
        .pin()
        .unwrap();
    let store = MigrationStore::open_or_create(&f.profile).unwrap();
    let source = BatchSource::History(Box::new(HistoryBatchSource::new(selection).unwrap()));
    let scanned = store.create_batch_scan(vec![source]).unwrap();
    let choices = scanned
        .inventory
        .items
        .iter()
        .filter_map(|item| default_resolution(&scanned, item))
        .collect::<Vec<_>>();
    let provider = ProviderTarget::open(&f.profile).unwrap();
    let mcp = McpTarget::open(&f.profile).unwrap();
    let assets = AssetTarget::open(&f.profile).unwrap();
    let history = HistoryJobStore::open(&f.profile).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: Some(&history),
        credentials: None,
    };
    let planned = store
        .prepare_batch(&scanned.job_id, scanned.sequence, &choices, &targets)
        .unwrap();
    let plan = planned.batch.as_ref().unwrap().plan_id.as_ref().unwrap();
    let done = store
        .run_batch(
            &planned.job_id,
            plan,
            "owned-parent-run",
            planned.sequence,
            false,
            &targets,
        )
        .unwrap();
    let child = done
        .batch
        .as_ref()
        .unwrap()
        .actions
        .iter()
        .find_map(|action| match &action.action {
            BatchActionKind::History { plan } => Some(plan.history_job_id.as_str()),
            _ => None,
        })
        .unwrap();
    assert_eq!(f.budget(child, None)["ownerJobId"], done.job_id);
    let read = f.call(
        "budget",
        &["read", "--scope", "batch", "--job-id", &done.job_id],
    );
    assert_eq!(read["phase"], "active");
    let revision = read["policyRevision"].to_string();
    let request = uuid::Uuid::new_v4().to_string();
    let policy = [
        "--max-total-bytes",
        "42949672960",
        "--max-payload-files",
        "10000",
        "--min-free-bytes",
        "134217728",
        "--min-free-file-nodes",
        "32",
        "--confirm",
    ];
    let mut child_change = vec![
        "increase",
        "--scope",
        "history",
        "--job-id",
        child,
        "--request-id",
        &request,
        "--expected-policy-revision",
        &revision,
    ];
    child_change.extend(policy);
    let rejected = f.invoke("budget", &child_change);
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("history_resource_parent_required"));
    let mut parent_change = vec![
        "increase",
        "--scope",
        "batch",
        "--job-id",
        &done.job_id,
        "--plan-id",
        plan,
        "--request-id",
        &request,
        "--expected-policy-revision",
        &revision,
    ];
    parent_change.extend(policy);
    let receipt = f.call("budget", &parent_change);
    assert_eq!(receipt["jobId"], done.job_id);
    assert_eq!(receipt["limits"]["maxTotalBytes"], 42949672960_u64);
    assert_eq!(f.call("budget", &parent_change), receipt);
    assert_eq!(
        serde_json::to_value(store.read(&done.job_id).unwrap()).unwrap(),
        serde_json::to_value(&done).unwrap()
    );
    assert_eq!(
        fs::read(f.profile.join("settings.json")).unwrap(),
        f.settings
    );
}
