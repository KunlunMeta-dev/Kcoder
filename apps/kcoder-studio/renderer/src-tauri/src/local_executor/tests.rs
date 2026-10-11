use super::*;
use std::ffi::OsString;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::process::Stdio;
use std::sync::{Mutex as TestMutex, MutexGuard, OnceLock};
#[cfg(unix)]
use std::time::{Duration, Instant};

fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<TestMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| TestMutex::new(()))
        .lock()
        .expect("env lock should be available")
}

fn restore_env(key: &str, value: Option<OsString>) {
    if let Some(value) = value {
        std::env::set_var(key, value);
    } else {
        std::env::remove_var(key);
    }
}

fn import_test_root(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "wework-import-{label}-{}-{nanos}",
        std::process::id()
    ))
}

#[test]
fn parses_success_response_line() {
    let line = r#"{"type":"response","id":"req-1","ok":true,"result":{"value":1}}"#;
    let message = parse_executor_line(line).expect("line should parse");

    match message {
        ExecutorLine::Response(response) => assert_eq!(response.id, "req-1"),
        ExecutorLine::Event(_) => panic!("expected response line"),
    }
}

#[test]
fn parses_event_line() {
    let line =
        r#"{"type":"event","event":"response.completed","payload":{"localTaskId":"task-1"}}"#;
    let message = parse_executor_line(line).expect("line should parse");

    assert!(matches!(message, ExecutorLine::Event(_)));
}

#[test]
fn stderr_output_uses_diagnostic_label_in_app_logs() {
    let label = LocalExecutorOutputStream::Stderr.log_label();

    assert_eq!(label, "Local executor diagnostic");
    assert!(!label.contains("stderr"));
}

#[test]
fn codex_local_config_remote_apps_reports_missing_or_false_as_disabled() {
    assert!(!read_remote_apps_enabled_from_config(""));
    assert!(!read_remote_apps_enabled_from_config("[features]\n"));
    assert!(!read_remote_apps_enabled_from_config(
        "[features]\napps = false\n"
    ));
    assert!(!read_remote_apps_enabled_from_config(
        "[other]\napps = true\n"
    ));
}

#[test]
fn codex_home_initialization_defaults_remote_apps_to_enabled() {
    let options: CodexHomeInitializeOptions =
        serde_json::from_value(serde_json::json!({ "migrateNativeHome": true })).unwrap();

    assert!(options.remote_apps_enabled);
}

#[test]
fn imports_codex_initialization_content_again() {
    let root = import_test_root("codex");
    let home = root.join("home");
    let destination = root.join("destination");
    fs::create_dir_all(home.join(".codex/skills/example")).unwrap();
    fs::write(home.join(".codex/config.toml"), "model = \"gpt-5\"").unwrap();
    fs::write(home.join(".codex/skills/example/SKILL.md"), "example").unwrap();
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join("config.toml"), "old").unwrap();

    let result = import_external_content_from_paths("codex", &home, &destination).unwrap();

    assert_eq!(
        fs::read_to_string(destination.join("config.toml")).unwrap(),
        "model = \"gpt-5\""
    );
    assert!(destination.join("skills/example/SKILL.md").is_file());
    assert_eq!(result.imported_entries, vec!["config.toml", "skills"]);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn maps_claude_instructions_and_skills_to_codex_content() {
    let root = import_test_root("claude");
    let home = root.join("home");
    let destination = root.join("destination");
    fs::create_dir_all(home.join(".claude/skills/example")).unwrap();
    fs::write(home.join(".claude/CLAUDE.md"), "Claude instructions").unwrap();
    fs::write(home.join(".claude/skills/example/SKILL.md"), "example").unwrap();

    let result = import_external_content_from_paths("claude-code", &home, &destination).unwrap();

    assert_eq!(
        fs::read_to_string(destination.join("AGENTS.md")).unwrap(),
        "Claude instructions"
    );
    assert!(destination.join("skills/example/SKILL.md").is_file());
    assert_eq!(result.imported_entries, vec!["CLAUDE.md", "skills"]);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn codex_local_config_remote_apps_reads_features_section() {
    let content = r#"
model = "gpt-5.5"

[features]
apps = true # enables remote apps

[projects."/tmp/example"]
trust_level = "trusted"
"#;

    assert!(read_remote_apps_enabled_from_config(content));
}

#[test]
fn codex_local_config_remote_apps_updates_existing_value() {
    let content = r#"
model = "gpt-5.5"

[features]
  apps = true
shell_environment_policy = "inherit"
"#;

    let next = set_remote_apps_enabled_in_config(content, false);

    assert!(next.contains("[features]\n  apps = false\nshell_environment_policy"));
    assert!(next.contains("model = \"gpt-5.5\""));
}

#[test]
fn codex_local_config_remote_apps_inserts_features_section() {
    let next = set_remote_apps_enabled_in_config("model = \"gpt-5.5\"\n", true);

    assert_eq!(next, "model = \"gpt-5.5\"\n\n[features]\napps = true\n");
}

#[test]
fn codex_local_config_remote_apps_adds_to_existing_features_section() {
    let content = r#"
[features]
shell_environment_policy = "inherit"

[mcp_servers.example]
command = "example"
"#;

    let next = set_remote_apps_enabled_in_config(content, true);

    assert!(next.contains("[features]\napps = true\nshell_environment_policy"));
    assert!(next.contains("[mcp_servers.example]\ncommand = \"example\""));
}

#[test]
fn bundled_sidecar_path_uses_bundled_executable_name() {
    let _guard = env_lock();
    let previous_sidecar = std::env::var_os(LOCAL_EXECUTOR_SIDECAR_ENV);
    std::env::remove_var(LOCAL_EXECUTOR_SIDECAR_ENV);

    let (source, path) = sidecar_source_and_path();
    restore_env(LOCAL_EXECUTOR_SIDECAR_ENV, previous_sidecar);

    assert_eq!(source, "bundled");
    assert_eq!(path, "wegent-executor");
}

#[cfg(unix)]
#[test]
fn links_native_codex_auth_into_isolated_home() {
    let root = import_test_root("codex-auth-link");
    let native_home = root.join("native");
    let wework_home = root.join("wework");
    fs::create_dir_all(&native_home).unwrap();
    fs::write(native_home.join("auth.json"), "native-auth").unwrap();

    link_native_codex_auth(&native_home, &wework_home).unwrap();

    let target = wework_home.join("auth.json");
    assert!(fs::symlink_metadata(&target)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_to_string(target).unwrap(), "native-auth");
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn migrating_codex_home_preserves_linked_native_auth() {
    let root = import_test_root("codex-auth-migration");
    let native_home = root.join("native");
    let wework_home = root.join("wework");
    fs::create_dir_all(&native_home).unwrap();
    fs::write(native_home.join("auth.json"), "native-auth").unwrap();
    fs::write(native_home.join("config.toml"), "model = \"gpt-5\"").unwrap();
    link_native_codex_auth(&native_home, &wework_home).unwrap();

    copy_codex_initialization_files(&native_home, &wework_home).unwrap();

    assert_eq!(
        fs::read_to_string(native_home.join("auth.json")).unwrap(),
        "native-auth"
    );
    assert!(fs::symlink_metadata(wework_home.join("auth.json"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read_to_string(wework_home.join("config.toml")).unwrap(),
        "model = \"gpt-5\""
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn replaces_stale_isolated_codex_auth_link() {
    let root = import_test_root("codex-auth-stale-link");
    let native_home = root.join("native");
    let wework_home = root.join("wework");
    fs::create_dir_all(&native_home).unwrap();
    fs::create_dir_all(&wework_home).unwrap();
    fs::write(native_home.join("auth.json"), "current-auth").unwrap();
    std::os::unix::fs::symlink(
        root.join("missing-auth.json"),
        wework_home.join("auth.json"),
    )
    .unwrap();

    link_native_codex_auth(&native_home, &wework_home).unwrap();

    assert_eq!(
        fs::read_to_string(wework_home.join("auth.json")).unwrap(),
        "current-auth"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn preserves_existing_isolated_codex_auth_file() {
    let root = import_test_root("codex-auth-existing");
    let native_home = root.join("native");
    let wework_home = root.join("wework");
    fs::create_dir_all(&native_home).unwrap();
    fs::create_dir_all(&wework_home).unwrap();
    fs::write(native_home.join("auth.json"), "native-auth").unwrap();
    fs::write(wework_home.join("auth.json"), "isolated-auth").unwrap();

    link_native_codex_auth(&native_home, &wework_home).unwrap();

    assert_eq!(
        fs::read_to_string(wework_home.join("auth.json")).unwrap(),
        "isolated-auth"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn skips_codex_auth_link_when_native_auth_is_missing() {
    let root = import_test_root("codex-auth-missing");
    let native_home = root.join("native");
    let wework_home = root.join("wework");

    link_native_codex_auth(&native_home, &wework_home).unwrap();

    assert!(!wework_home.join("auth.json").exists());
}

#[test]
fn executor_isolation_override_controls_runtime_home() {
    let _guard = env_lock();
    let previous_home = std::env::var_os(LOCAL_EXECUTOR_HOME_ENV);
    let previous_override = std::env::var_os(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV);
    let previous_shared_home = std::env::var_os(LOCAL_EXECUTOR_SHARED_HOME_ENV);
    let home = PathBuf::from("/tmp/wework-isolation-override");
    std::env::set_var(LOCAL_EXECUTOR_HOME_ENV, &home);
    std::env::remove_var(LOCAL_EXECUTOR_SHARED_HOME_ENV);

    std::env::remove_var(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV);
    assert_eq!(
        local_executor_isolation_enabled().expect("default isolation should resolve"),
        cfg!(debug_assertions)
    );

    std::env::set_var(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV, "true");
    assert_eq!(
        local_executor_runtime_home_path().expect("isolated home should resolve"),
        home.join(LOCAL_EXECUTOR_RUNTIME_DIR_NAME)
            .join(local_executor_instance_name())
    );

    std::env::set_var(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV, "false");
    assert_eq!(
        local_executor_runtime_home_path().expect("shared home should resolve"),
        home
    );

    restore_env(LOCAL_EXECUTOR_HOME_ENV, previous_home);
    restore_env(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV, previous_override);
    restore_env(LOCAL_EXECUTOR_SHARED_HOME_ENV, previous_shared_home);
}

#[test]
fn executor_isolation_override_rejects_invalid_values() {
    let _guard = env_lock();
    let previous_override = std::env::var_os(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV);
    std::env::set_var(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV, "sometimes");

    let error = local_executor_isolation_enabled().expect_err("invalid override should fail");

    restore_env(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV, previous_override);
    assert_eq!(
        error,
        "KCODER_STUDIO_EXECUTOR_ISOLATION_OVERRIDE must be true or false, got \"sometimes\""
    );
}

#[test]
fn local_executor_log_path_follows_build_mode() {
    let _guard = env_lock();
    let previous_home = std::env::var_os(LOCAL_EXECUTOR_HOME_ENV);
    let previous_log_dir = std::env::var_os(LOCAL_EXECUTOR_LOG_DIR_ENV);
    std::env::set_var(LOCAL_EXECUTOR_HOME_ENV, "/tmp/wegent-executor-debug");
    std::env::remove_var(LOCAL_EXECUTOR_LOG_DIR_ENV);

    let path = local_executor_log_path().expect("log path should resolve");
    restore_env(LOCAL_EXECUTOR_HOME_ENV, previous_home);
    restore_env(LOCAL_EXECUTOR_LOG_DIR_ENV, previous_log_dir);

    if cfg!(debug_assertions) {
        assert!(path.starts_with("/tmp/wegent-executor-debug/app-runtime"));
    } else {
        assert_eq!(
            path,
            PathBuf::from("/tmp/wegent-executor-debug/logs/executor.log")
        );
    }
    assert_eq!(
        path.file_name().and_then(|name| name.to_str()),
        Some("executor.log")
    );
}

#[cfg(unix)]
#[test]
fn branded_executor_home_stays_under_shared_root() {
    let home = Path::new("/tmp/wework-test-home");

    assert_eq!(
        default_local_executor_home_path(home, None),
        PathBuf::from("/tmp/wework-test-home/.wegent-executor")
    );
    assert_eq!(
        default_local_executor_home_path(home, Some("com.example.demo-renderer")),
        PathBuf::from("/tmp/wework-test-home/.wegent-executor/apps/com.example.demo-renderer")
    );
}

#[cfg(unix)]
#[test]
fn default_runtime_home_and_log_paths_follow_build_mode() {
    let _guard = env_lock();
    let previous_home = std::env::var_os("HOME");
    let previous_executor_home = std::env::var_os(LOCAL_EXECUTOR_HOME_ENV);
    let previous_log_dir = std::env::var_os(LOCAL_EXECUTOR_LOG_DIR_ENV);
    std::env::set_var("HOME", "/tmp/wework-test-home");
    std::env::remove_var(LOCAL_EXECUTOR_HOME_ENV);
    std::env::remove_var(LOCAL_EXECUTOR_LOG_DIR_ENV);

    let home = local_executor_home_path().expect("executor home should resolve");
    let log = local_executor_log_path().expect("log path should resolve");

    restore_env("HOME", previous_home);
    restore_env(LOCAL_EXECUTOR_HOME_ENV, previous_executor_home);
    restore_env(LOCAL_EXECUTOR_LOG_DIR_ENV, previous_log_dir);

    assert_eq!(
        home,
        default_local_executor_home_path(
            Path::new("/tmp/wework-test-home"),
            LOCAL_EXECUTOR_NAMESPACE,
        )
    );
    if cfg!(debug_assertions) {
        assert_eq!(
            log,
            home.join(LOCAL_EXECUTOR_RUNTIME_DIR_NAME)
                .join(local_executor_instance_name())
                .join("logs")
                .join(LOCAL_EXECUTOR_LOG_FILE_NAME)
        );
    } else {
        assert_eq!(log, home.join("logs").join(LOCAL_EXECUTOR_LOG_FILE_NAME));
    }
}

#[test]
fn read_local_executor_log_tail_limits_content() {
    let dir = std::env::temp_dir().join(format!(
        "studio-local-executor-log-tail-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("logs")).expect("test log dir should be created");
    let log_path = dir.join("logs").join("executor.log");
    fs::write(&log_path, "old log line\nrecent executor failure\n")
        .expect("test log should be written");

    let log = read_local_executor_log_tail(&log_path, 24).expect("log should be read");

    assert!(log.truncated);
    assert_eq!(log.path, log_path.display().to_string());
    assert_eq!(log.content, "recent executor failure\n");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_local_executor_log_tail_limits_to_last_twenty_lines() {
    let dir = std::env::temp_dir().join(format!(
        "studio-local-executor-log-lines-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("logs")).expect("test log dir should be created");
    let log_path = dir.join("logs").join("executor.log");
    let content = (1..=25)
        .map(|line| format!("line-{line}"))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&log_path, content).expect("test log should be written");

    let log = read_local_executor_log_tail(&log_path, 200 * 1024).expect("log should be read");

    assert!(log.truncated);
    assert_eq!(log.line_count, 20);
    assert!(log.content.starts_with("line-6\n"));
    assert!(log.content.ends_with("line-25"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_executor_processes_filters_executor_binary() {
    let output = r#"
111 /bin/zsh -c echo wegent-executor
222 /Applications/KCoder Studio.app/Contents/MacOS/wegent-executor --app
333 /usr/local/bin/wegent-executor --config /tmp/device-config.json
"#;

    assert_eq!(
        parse_executor_processes(output),
        vec![
            LocalExecutorProcessInfo {
                pid: 222,
                path: "/Applications/KCoder Studio.app/Contents/MacOS/wegent-executor".to_string(),
            },
            LocalExecutorProcessInfo {
                pid: 333,
                path: "/usr/local/bin/wegent-executor".to_string(),
            },
        ]
    );
}

#[test]
fn ready_event_updates_status_device_id() {
    let inner = Arc::new(Mutex::new(LocalExecutorInner::default()));
    let event = ExecutorEvent {
        event: "executor.ready".to_string(),
        payload: json!({
            "device_id": "configured-device",
            "ready": true,
            "version": "1.9.0",
        }),
    };

    let _ = update_ready_event_inner(&inner, &event);

    let status = inner.lock().expect("state should lock");
    assert!(status.running);
    assert!(status.ready);
    assert_eq!(status.device_id.as_deref(), Some("configured-device"));
    assert_eq!(status.version.as_deref(), Some("1.9.0"));
    assert_eq!(status.error, None);
}

#[test]
fn backend_env_marks_current_app_device_without_changing_device_id() {
    let _guard = env_lock();
    let previous_home = std::env::var_os(LOCAL_EXECUTOR_HOME_ENV);
    let previous_codex_home = std::env::var_os(WEGENT_CODEX_HOME_ENV);
    let previous_override = std::env::var_os(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV);
    let previous_shared_home = std::env::var_os(LOCAL_EXECUTOR_SHARED_HOME_ENV);
    let previous_log_dir = std::env::var_os(LOCAL_EXECUTOR_LOG_DIR_ENV);
    std::env::set_var(LOCAL_EXECUTOR_HOME_ENV, "/tmp/wework-instance-executor");
    std::env::remove_var(WEGENT_CODEX_HOME_ENV);
    std::env::remove_var(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV);
    std::env::remove_var(LOCAL_EXECUTOR_SHARED_HOME_ENV);
    std::env::remove_var(LOCAL_EXECUTOR_LOG_DIR_ENV);
    let inner = LocalExecutorInner {
        backend_connection: Some(LocalExecutorBackendConnection {
            backend_url: "https://cloud.example.com".to_string(),
            auth_token: "wg-token".to_string(),
        }),
        device_id: Some("local-device-abc".to_string()),
        ..LocalExecutorInner::default()
    };

    let envs = local_executor_backend_env(&inner)
        .into_iter()
        .collect::<HashMap<_, _>>();

    restore_env(LOCAL_EXECUTOR_HOME_ENV, previous_home);
    restore_env(WEGENT_CODEX_HOME_ENV, previous_codex_home);
    restore_env(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV, previous_override);
    restore_env(LOCAL_EXECUTOR_SHARED_HOME_ENV, previous_shared_home);
    restore_env(LOCAL_EXECUTOR_LOG_DIR_ENV, previous_log_dir);

    assert_eq!(
        envs.get("WEGENT_BACKEND_URL").map(String::as_str),
        Some("https://cloud.example.com")
    );
    assert_eq!(
        envs.get("WEGENT_AUTH_TOKEN").map(String::as_str),
        Some("wg-token")
    );
    assert_eq!(
        envs.get("WEGENT_APP_IPC_DEVICE_ID").map(String::as_str),
        Some("local-device-abc")
    );
    assert_eq!(
        envs.get("DEVICE_ID").map(String::as_str),
        Some("local-device-abc")
    );
    assert_eq!(envs.get("DEVICE_TYPE").map(String::as_str), Some("app"));
    let executor_home_env = envs
        .get(LOCAL_EXECUTOR_HOME_ENV)
        .expect("executor home env should be passed to sidecar");
    let codex_home_env = envs
        .get(CODEX_HOME_ENV)
        .expect("codex home env should be passed to sidecar");
    let log_dir_env = envs
        .get(LOCAL_EXECUTOR_LOG_DIR_ENV)
        .expect("log dir env should be passed to sidecar");
    if cfg!(debug_assertions) {
        assert!(executor_home_env.starts_with("/tmp/wework-instance-executor/app-runtime/wework-"));
        assert_eq!(codex_home_env, &format!("{executor_home_env}/codex"));
        assert!(log_dir_env.starts_with("/tmp/wework-instance-executor/app-runtime/wework-"));
    } else {
        assert_eq!(executor_home_env, "/tmp/wework-instance-executor");
        assert_eq!(codex_home_env, "/tmp/wework-instance-executor/codex");
        assert_eq!(log_dir_env, "/tmp/wework-instance-executor/logs");
    }
}

#[test]
fn sidecar_env_forces_stdio_and_dynamic_gateway_without_backend_connection() {
    let _guard = env_lock();
    let envs = local_executor_backend_env(&LocalExecutorInner::default())
        .into_iter()
        .collect::<HashMap<_, _>>();

    assert_eq!(
        envs.get(APP_IPC_DEVICE_ID_ENV).map(String::as_str),
        Some(LOCAL_EXECUTOR_DEVICE_ID)
    );
    assert_eq!(
        envs.get("DEVICE_ID").map(String::as_str),
        Some(LOCAL_EXECUTOR_DEVICE_ID)
    );
    assert_eq!(
        envs.get(SESSION_GATEWAY_HOST_ENV).map(String::as_str),
        Some("127.0.0.1")
    );
    assert_eq!(
        envs.get(SESSION_GATEWAY_PORT_ENV).map(String::as_str),
        Some("0")
    );
    assert_eq!(
        envs.get(SESSION_GATEWAY_PUBLIC_BASE_URL_ENV)
            .map(String::as_str),
        Some("")
    );
    assert!(!envs.contains_key("WEGENT_BACKEND_URL"));
    assert!(!envs.contains_key("WEGENT_AUTH_TOKEN"));
}

#[test]
fn replacing_backend_connection_is_idempotent() {
    let connection = LocalExecutorBackendConnection {
        backend_url: "https://cloud.example.com".to_string(),
        auth_token: "wg-token".to_string(),
    };
    let mut inner = LocalExecutorInner::default();

    assert!(replace_backend_connection(
        &mut inner,
        Some(connection.clone())
    ));
    assert!(!replace_backend_connection(
        &mut inner,
        Some(connection.clone())
    ));
    assert!(replace_backend_connection(&mut inner, None));
    assert!(!replace_backend_connection(&mut inner, None));
}

#[test]
fn backend_env_includes_normalized_developer_path() {
    let _guard = env_lock();
    let previous_path = std::env::var_os("PATH");
    let previous_extra = std::env::var_os("WEGENT_EXTRA_PATHS");
    std::env::set_var("PATH", "/usr/bin:/bin");
    std::env::set_var("WEGENT_EXTRA_PATHS", "/custom/bin:/opt/homebrew/bin");

    let envs = local_executor_backend_env(&LocalExecutorInner::default())
        .into_iter()
        .collect::<HashMap<_, _>>();

    restore_env("PATH", previous_path);
    restore_env("WEGENT_EXTRA_PATHS", previous_extra);

    let path = envs.get("PATH").expect("PATH should be present");
    assert!(path.starts_with("/usr/bin:/bin:/custom/bin:/opt/homebrew/bin"));
    assert_eq!(path.matches("/opt/homebrew/bin").count(), 1);
    assert!(path.contains("/opt/homebrew/sbin"));
    assert!(path.contains("/usr/local/bin"));
}

#[test]
fn backend_env_includes_file_edit_hook_command() {
    let _guard = env_lock();
    let previous_hook = std::env::var_os("WEGENT_FILE_EDIT_HOOK_COMMAND");
    std::env::remove_var("WEGENT_FILE_EDIT_HOOK_COMMAND");

    let envs = local_executor_backend_env(&LocalExecutorInner::default())
        .into_iter()
        .collect::<HashMap<_, _>>();

    restore_env("WEGENT_FILE_EDIT_HOOK_COMMAND", previous_hook);

    assert_eq!(
            envs.get("WEGENT_FILE_EDIT_HOOK_COMMAND").map(String::as_str),
            Some(
                "curl -s -X POST http://127.0.0.1:3456/api/file-edit-log -H \"Content-Type: application/json\" -d @-"
            )
        );
}

#[test]
fn backend_env_preserves_custom_file_edit_hook_command() {
    let _guard = env_lock();
    let previous_hook = std::env::var_os("WEGENT_FILE_EDIT_HOOK_COMMAND");
    std::env::set_var(
        "WEGENT_FILE_EDIT_HOOK_COMMAND",
        "custom-file-edit-hook --stdin",
    );

    let envs = local_executor_backend_env(&LocalExecutorInner::default())
        .into_iter()
        .collect::<HashMap<_, _>>();

    restore_env("WEGENT_FILE_EDIT_HOOK_COMMAND", previous_hook);

    assert_eq!(
        envs.get("WEGENT_FILE_EDIT_HOOK_COMMAND")
            .map(String::as_str),
        Some("custom-file-edit-hook --stdin")
    );
}

#[test]
fn backend_env_builds_file_edit_hook_command_from_configured_endpoint() {
    let _guard = env_lock();
    let previous_hook = std::env::var_os("WEGENT_FILE_EDIT_HOOK_COMMAND");
    let previous_endpoint = std::env::var_os("KCODER_STUDIO_FILE_EDIT_LOG_ENDPOINT");
    std::env::remove_var("WEGENT_FILE_EDIT_HOOK_COMMAND");
    std::env::set_var(
        "KCODER_STUDIO_FILE_EDIT_LOG_ENDPOINT",
        "http://127.0.0.1:4567/custom-file-edit-log",
    );

    let envs = local_executor_backend_env(&LocalExecutorInner::default())
        .into_iter()
        .collect::<HashMap<_, _>>();

    restore_env("WEGENT_FILE_EDIT_HOOK_COMMAND", previous_hook);
    restore_env("KCODER_STUDIO_FILE_EDIT_LOG_ENDPOINT", previous_endpoint);

    assert_eq!(
            envs.get("WEGENT_FILE_EDIT_HOOK_COMMAND")
                .map(String::as_str),
            Some(
                "curl -s -X POST http://127.0.0.1:4567/custom-file-edit-log -H \"Content-Type: application/json\" -d @-"
            )
        );
}

#[cfg(unix)]
#[test]
fn configured_sidecar_kill_stops_grandchild_process_group() {
    let dir = std::env::temp_dir().join(format!(
        "studio-local-executor-process-group-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("test dir should be created");
    let pid_path = dir.join("grandchild.pid");
    let script_path = dir.join("sidecar.sh");
    fs::write(
        &script_path,
        format!(
            r#"#!/usr/bin/env bash
set -euo pipefail
(
  trap '' TERM
  while true; do sleep 10; done
) &
echo "$!" > "{}"
wait
"#,
            pid_path.display()
        ),
    )
    .expect("sidecar script should be written");
    let mut permissions = fs::metadata(&script_path)
        .expect("sidecar metadata should be readable")
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&script_path, permissions).expect("sidecar script should be executable");

    let mut command = Command::new(script_path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_managed_process_group(&mut command);
    let child = command.spawn().expect("sidecar should start");
    let child = LocalExecutorChild::Process(ManagedProcessChild::new(child));
    let grandchild_pid =
        wait_for_pid_file(&pid_path, Duration::from_secs(2)).expect("grandchild pid");
    let _cleanup = ProcessCleanup::new(grandchild_pid);

    child.kill();

    assert!(
        wait_until_dead(grandchild_pid, Duration::from_secs(2)),
        "grandchild process should be stopped when sidecar is killed"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[cfg(unix)]
struct ProcessCleanup {
    pid: u32,
}

#[cfg(unix)]
impl ProcessCleanup {
    fn new(pid: u32) -> Self {
        Self { pid }
    }
}

#[cfg(unix)]
impl Drop for ProcessCleanup {
    fn drop(&mut self) {
        if process_alive(self.pid) {
            let _ = std::process::Command::new("kill")
                .args(["-KILL", &self.pid.to_string()])
                .status();
        }
    }
}

#[cfg(unix)]
fn wait_for_pid_file(path: &PathBuf, timeout: Duration) -> Option<u32> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(value) = fs::read_to_string(path) {
            if let Ok(pid) = value.trim().parse::<u32>() {
                return Some(pid);
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

#[cfg(unix)]
fn wait_until_dead(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !process_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    !process_alive(pid)
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}
