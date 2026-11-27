//! Diagnostic checks use owned profiles and never query public search engines.
use serde_json::json;
use std::io::Read;
use std::{
    path::Path,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

// Concurrent fork/exec can briefly inherit another fixture's open advisory lease.
static DIAGNOSTIC_OWNER: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn invoke(root: &Path, args: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kcoder"));
    command
        .args(args)
        .current_dir(root)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("KCODER_CONFIG_DIR", root.join("profile"))
        .env("KCODER_SEARXNG_RUNTIME", root.join("missing-runtime"))
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
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let read = |stream: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stream.take(256 * 1024 + 1).read_to_end(&mut bytes).unwrap();
            assert!(
                bytes.len() <= 256 * 1024,
                "diagnostic output exceeded its fixture budget"
            );
            bytes
        })
    };
    let stdout = read(Box::new(stdout));
    let stderr = read(Box::new(stderr));
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return Output {
                status,
                stdout: stdout.join().unwrap(),
                stderr: stderr.join().unwrap(),
            };
        }
        if start.elapsed() > Duration::from_secs(20) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("owned MCP diagnostic process exceeded its deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("profile")).unwrap();
    std::fs::create_dir(root.path().join("missing-runtime")).unwrap();
    std::fs::write(
        root.path().join("profile/settings.json"),
        json!({"credential_store":"file","mcp_servers":[]}).to_string(),
    )
    .unwrap();
    root
}
fn overlay(root: &Path, disabled: bool, url: &str) {
    std::fs::write(
        root.join("selected.json"),
        json!({"mcp_servers":[{"name":"searxng","transport":"searxng","url":url}],
        "mcp_disabled_servers":if disabled {vec!["searxng"]}else{vec![]}})
        .to_string(),
    )
    .unwrap();
}
#[cfg(unix)]
#[test]
fn mcp_diagnostic_resolves_private_native_refs_in_the_selected_profile_and_masks_failures() {
    let _owner = DIAGNOSTIC_OWNER
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    use kcoder_config::{
        CredentialStoreMode,
        imported_credentials::{ImportedCredentialStore, mcp::McpSecretValues},
    };
    use std::collections::BTreeMap;
    const SECRET: &str = "SYNTHETIC_MCP_REFERENCE_SECRET";
    let root = fixture();
    let profile = root.path().join("profile");
    let script = kcoder_test_harness::workspace_root()
        .expect("resolve current workspace")
        .join("crates/kcoder_cli")
        .join("tests/fixtures/private_mcp.py");
    let mut config: kcoder_types::McpServerConfig = serde_json::from_value(json!({
        "name":"owned-private", "command":"python3", "args":[script,root.path().join("closed")],
        "policy":{"required_env":["TOKEN"],"startup_timeout_secs":3}
    }))
    .unwrap();
    let store = ImportedCredentialStore::open(&profile).unwrap();
    let backend = kcoder_config::OsCredentialBackend::new();
    let reference = store
        .prepare_mcp(
            &config,
            &["TOKEN".into()],
            &[],
            CredentialStoreMode::File,
            &backend,
        )
        .unwrap();
    let payload = McpSecretValues {
        env: BTreeMap::from([("TOKEN".into(), SECRET.into())]),
        headers: BTreeMap::new(),
    };
    store
        .stage(&reference, &payload.encode().unwrap(), &backend)
        .unwrap();
    config.policy.credential_ref = Some(reference.mcp_reference().unwrap());
    store
        .publish_group(
            "group-dddddddddddddddddddddddddddddddd",
            std::slice::from_ref(&reference),
            &backend,
            |settings| {
                settings["mcp_servers"] = json!([config]);
                Ok(())
            },
        )
        .unwrap();
    let output = invoke(root.path(), &["mcp", "test", "owned-private"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 tools discovered"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains(SECRET));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(SECRET));
    let pid: i32 = std::fs::read_to_string(root.path().join("closed.pid"))
        .unwrap()
        .parse()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    // The transport may terminate its owned peer instead of waiting for graceful EOF.
    while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        unsafe { libc::kill(pid, 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH),
        "owned peer must exit when the diagnostic connection closes"
    );
    kcoder_config::ProfileSettingsFile::new(
        kcoder_config::PrivateDirectory::open_existing(&profile).unwrap(),
    )
    .unwrap()
    .update(|settings| {
        settings["mcp_servers"][0]["command"] = "missing-private-command".into();
        Ok(())
    })
    .unwrap();
    let changed = invoke(root.path(), &["mcp", "test", "owned-private"]);
    assert!(!changed.status.success());
    assert!(!String::from_utf8_lossy(&changed.stderr).contains(SECRET));
    assert!(!String::from_utf8_lossy(&changed.stdout).contains("MCP test completed"));
}
#[test]
fn mcp_diagnostics_honor_overlay_and_distinguish_adapter_discovery_from_search_success() {
    let _owner = DIAGNOSTIC_OWNER
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let root = fixture();
    overlay(root.path(), false, "http://127.0.0.1:1/");
    let listed = invoke(
        root.path(),
        &["--settings-file", "selected.json", "mcp", "list"],
    );
    assert!(
        listed.status.success(),
        "{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    let text = String::from_utf8_lossy(&listed.stdout);
    assert!(
        text.contains("searxng [searxng] enabled") && text.contains("external search instance")
    );
    let tested = invoke(
        root.path(),
        &["--settings-file", "selected.json", "mcp", "test", "searxng"],
    );
    assert!(
        tested.status.success(),
        "{}",
        String::from_utf8_lossy(&tested.stderr)
    );
    let text = String::from_utf8_lossy(&tested.stdout);
    assert!(text.contains("1 tools discovered in") && text.contains("  - search"));
    assert!(text.contains("not exercised") && text.contains("MCP test completed"));
    let doctor = invoke(root.path(), &["--settings-file", "selected.json", "doctor"]);
    assert!(
        doctor.status.success(),
        "{}",
        String::from_utf8_lossy(&doctor.stderr)
    );
    let text = String::from_utf8_lossy(&doctor.stdout);
    assert!(
        text.contains("MCP: 1 configured; live connectivity not tested")
            && text.contains("searxng")
    );
}
#[test]
fn mcp_diagnostics_missing_bundled_component_and_disabled_servers_fail_explicitly() {
    let _owner = DIAGNOSTIC_OWNER
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let root = fixture();
    overlay(root.path(), false, "");
    let listed = invoke(
        root.path(),
        &["--settings-file", "selected.json", "mcp", "list"],
    );
    assert!(listed.status.success());
    assert!(
        String::from_utf8_lossy(&listed.stdout).contains("bundled service; random loopback port")
    );
    let tested = invoke(
        root.path(),
        &["--settings-file", "selected.json", "mcp", "test", "searxng"],
    );
    assert!(!tested.status.success());
    assert!(String::from_utf8_lossy(&tested.stderr).contains("Failed to connect to 'searxng'"));
    assert!(!String::from_utf8_lossy(&tested.stdout).contains("MCP test completed"));
    overlay(root.path(), true, "http://127.0.0.1:1/");
    let tested = invoke(
        root.path(),
        &["--settings-file", "selected.json", "mcp", "test", "searxng"],
    );
    assert!(!tested.status.success());
    assert!(String::from_utf8_lossy(&tested.stderr).contains("is disabled"));
}
#[test]
fn mcp_diagnostics_do_not_fall_back_after_invalid_settings_or_execute_untrusted_jsonc_projects() {
    let _owner = DIAGNOSTIC_OWNER
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let root = fixture();
    std::fs::write(root.path().join("selected.json"), "{invalid private-canary").unwrap();
    let invalid = invoke(
        root.path(),
        &["--settings-file", "selected.json", "mcp", "list"],
    );
    assert!(!invalid.status.success());
    assert!(!String::from_utf8_lossy(&invalid.stdout).contains("No MCP servers configured"));
    // The fixture HOME is trusted by default; revoke it explicitly before testing the gate.
    kcoder_config::FolderTrustStore::load(&root.path().join("profile"))
        .never(root.path())
        .unwrap();
    std::fs::create_dir(root.path().join(".kcoder")).unwrap();
    std::fs::write(
        root.path().join(".kcoder/settings.json"),
        r#"{ // project JSONC
        "mcp_servers": [{"name":"searxng","transport":"searxng","url":"http://127.0.0.1:1/"}]
    }"#,
    )
    .unwrap();
    let tested = invoke(root.path(), &["mcp", "test", "searxng"]);
    assert!(!tested.status.success());
    assert!(String::from_utf8_lossy(&tested.stderr).contains("requires a trusted directory"));
    assert!(!String::from_utf8_lossy(&tested.stdout).contains("Connecting to"));
}
