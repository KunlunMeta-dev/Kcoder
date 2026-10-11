#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

fn workspace_root() -> PathBuf {
    kcoder_test_harness::workspace_root().expect("应解析当前 KCoder 工作区")
}

#[test]
fn real_runner_redacts_explicit_endpoint_before_any_persistent_sink() {
    let root = workspace_root();
    let target = root.join("target");
    fs::create_dir_all(&target).unwrap();
    let temporary = tempfile::Builder::new()
        .prefix("runner-redaction-")
        .tempdir_in(&target)
        .unwrap();
    let script = temporary.path().join("emit-secret.sh");
    fs::write(
        &script,
        r#"#!/usr/bin/env bash
set -euo pipefail
printf '%s' "${CUSTOM_API_KEY:0:19}"
sleep 0.05
printf '%s\n' "${CUSTOM_API_KEY:19}"
printf '%s' "${CUSTOM_API_KEY:0:13}" >&2
sleep 0.05
printf '%s\n' "${CUSTOM_API_KEY:13}" >&2
"#,
    )
    .unwrap();
    let mut permissions = fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&script, permissions).unwrap();

    let matrix = temporary.path().join("matrix.toml");
    let script_relative = relative_unix(&root, &script);
    fs::write(
        &matrix,
        format!(
            "schema_version=2\n[[suite]]\nid='redaction'\ntiers=['pr']\ncommand=['{script_relative}']\nsummary={{parser='exit-code',allow_zero=true}}\npass_env=['KCODER_E2E_MODEL_CREDENTIAL_ENV']\nsecret_env_selectors=['KCODER_E2E_MODEL_CREDENTIAL_ENV']\n"
        ),
    )
    .unwrap();
    let artifacts = temporary.path().join("artifacts");
    let secret = "https://runner-user:runner-pass@example.invalid/v1/chat?token=query-secret";
    let output = Command::new(env!("CARGO_BIN_EXE_kcoder_test_runner"))
        .current_dir(&root)
        .args([
            "--tier",
            "pr",
            "--matrix",
            &relative_unix(&root, &matrix),
            "--artifacts",
            &relative_unix(&root, &artifacts),
        ])
        .env("KCODER_E2E_MODEL_CREDENTIAL_ENV", "CUSTOM_API_KEY")
        .env("CUSTOM_API_KEY", secret)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "真实 runner 失败: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let mut persisted = Vec::new();
    collect_files(&artifacts, &mut persisted);
    assert!(
        persisted
            .iter()
            .any(|path| path.ends_with("aggregate.json")),
        "runner 必须持久化 aggregate"
    );
    assert!(
        persisted.iter().any(|path| path.ends_with("manifest.json")),
        "runner 必须持久化 manifest"
    );
    let execution_path = persisted
        .iter()
        .find(|path| path.ends_with("execution.json"))
        .expect("runner 必须持久化每个 suite 的 execution manifest");
    let execution: serde_json::Value =
        serde_json::from_slice(&fs::read(execution_path).unwrap()).unwrap();
    assert_eq!(execution["terminal"], true);
    assert_eq!(execution["executed"], true);
    assert_eq!(execution["status"], "passed");
    assert_eq!(execution["platform_arch"], std::env::consts::ARCH);
    assert!(
        execution["argv"]
            .as_array()
            .is_some_and(|argv| !argv.is_empty())
    );
    assert!(execution["cwd"].as_str().is_some_and(|cwd| !cwd.is_empty()));
    assert!(
        execution["git_commit"]
            .as_str()
            .is_some_and(|commit| commit.len() == 40)
    );
    assert!(execution["seed"].as_u64().is_some());
    assert!(
        execution["runner_version"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert_eq!(execution["nested_artifacts"], serde_json::json!([]));
    assert!(
        !execution_path.parent().unwrap().join("artifacts").exists(),
        "无 artifact placeholder 的 suite 不得获得空假目录"
    );
    let mut redacted_logs = 0;
    for path in persisted {
        let bytes = fs::read(&path).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            !text.contains(secret),
            "{} 泄露完整 endpoint",
            path.display()
        );
        assert!(
            !text.contains("runner-user")
                && !text.contains("runner-pass")
                && !text.contains("query-secret"),
            "{} 泄露 endpoint userinfo/query",
            path.display()
        );
        if path.extension().and_then(|value| value.to_str()) == Some("log")
            && text.contains("[REDACTED]")
        {
            redacted_logs += 1;
        }
    }
    assert_eq!(redacted_logs, 2, "stdout/stderr 都必须在落盘前流式脱敏");
}

#[test]
fn root_manifest_is_finalized_when_secret_registration_fails() {
    let fixture = RunnerFixture::new("root-finalizer");
    fs::write(
        &fixture.matrix,
        "schema_version=2\n[[suite]]\nid='never-starts'\ntiers=['pr']\ncommand=['true']\nsummary={parser='exit-code',allow_zero=true}\npass_env=['SHORT_SECRET']\nsecret_env=['SHORT_SECRET']\n",
    )
    .unwrap();
    let output = fixture
        .command()
        .env("SHORT_SECRET", "short")
        .output()
        .unwrap();
    assert!(!output.status.success());

    let run = only_run(&fixture.artifacts);
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(run.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["status"], "failed");
    assert!(manifest["finished_at_ms"].as_u64().is_some());
    assert!(!run.join("state").exists(), "失败收尾必须清理 root state");
}

#[test]
fn stop_on_failure_records_every_selected_suite_as_terminal_not_run() {
    let fixture = RunnerFixture::new("selection-ledger");
    fs::write(
        &fixture.matrix,
        "schema_version=2\n[[suite]]\nid='first'\ntiers=['pr']\ncommand=['false']\nsummary={parser='exit-code',allow_zero=true}\n[[suite]]\nid='second'\ntiers=['pr']\ncommand=['true']\nsummary={parser='exit-code',allow_zero=true}\n",
    )
    .unwrap();
    let output = fixture.command().output().unwrap();
    assert!(!output.status.success());

    let run = only_run(&fixture.artifacts);
    let aggregate: serde_json::Value =
        serde_json::from_slice(&fs::read(run.join("artifacts/aggregate.json")).unwrap()).unwrap();
    assert_eq!(
        aggregate["selected"],
        serde_json::json!(["first", "second"])
    );
    assert_eq!(aggregate["outcomes"][0]["status"], "failed");
    assert_eq!(aggregate["outcomes"][1]["status"], "not-run");
    assert_eq!(
        aggregate["execution_manifests"].as_array().unwrap().len(),
        2
    );
    let second: serde_json::Value =
        serde_json::from_slice(&fs::read(run.join("cases/second/execution.json")).unwrap())
            .unwrap();
    assert_eq!(second["terminal"], true);
    assert_eq!(second["executed"], false);
    assert_eq!(second["status"], "not-run");
    assert!(!run.join("cases/second/logs").exists());
}

struct RunnerFixture {
    _temporary: tempfile::TempDir,
    root: PathBuf,
    matrix: PathBuf,
    artifacts: PathBuf,
}

impl RunnerFixture {
    fn new(prefix: &str) -> Self {
        let root = workspace_root();
        let target = root.join("target");
        fs::create_dir_all(&target).unwrap();
        let temporary = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir_in(&target)
            .unwrap();
        let matrix = temporary.path().join("matrix.toml");
        let artifacts = temporary.path().join("artifacts");
        Self {
            _temporary: temporary,
            root,
            matrix,
            artifacts,
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_kcoder_test_runner"));
        command.current_dir(&self.root).args([
            "--tier",
            "pr",
            "--matrix",
            &relative_unix(&self.root, &self.matrix),
            "--artifacts",
            &relative_unix(&self.root, &self.artifacts),
        ]);
        command
    }
}

fn only_run(artifacts: &Path) -> PathBuf {
    let runs = fs::read_dir(artifacts)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(runs.len(), 1);
    runs.into_iter().next().unwrap()
}

fn relative_unix(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/")
}

fn collect_files(root: &Path, output: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if entry.file_type().unwrap().is_dir() {
            collect_files(&path, output);
        } else {
            output.push(path);
        }
    }
}
