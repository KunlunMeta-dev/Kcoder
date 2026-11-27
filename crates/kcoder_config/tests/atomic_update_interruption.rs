#![cfg(target_os = "linux")]

#[cfg(feature = "private-file-test-hooks")]
use kcoder_config::PrivateDirectory;
use kcoder_config::{
    read_settings_file, set_dotted_value, update_settings_file,
    validate_and_resolve_settings_document,
};
#[cfg(feature = "private-file-test-hooks")]
use kcoder_fs::AtomicReplaceTestCheckpoint;
use serde_json::{Value, json};
use std::fs;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::Command;
#[cfg(feature = "private-file-test-hooks")]
use std::time::{Duration, Instant};
use tempfile::tempdir;

#[cfg(feature = "private-file-test-hooks")]
#[test]
fn directory_sync_eio_reports_error_after_complete_settings_publication() {
    let temp = tempdir().unwrap();
    let path = temp.path().join("settings.json");
    fs::write(&path, br#"{"model":"old-model"}"#).unwrap();

    PrivateDirectory::open_existing(temp.path())
        .unwrap()
        .inject_pre_sync_failure_once()
        .unwrap();

    let result = update_settings_file(&path, |settings| {
        set_dotted_value(settings, "model", Value::String("new-model".into()))
    });

    let error = result.unwrap_err();
    assert!(
        error.to_string().contains("Input/output error"),
        "{error:#}"
    );
    let published = read_settings_file(&path).unwrap();
    assert_eq!(published["model"], "new-model");

    update_settings_file(&path, |settings| {
        set_dotted_value(settings, "model", Value::String("recovered-model".into()))
    })
    .unwrap();
    assert_eq!(
        read_settings_file(&path).unwrap()["model"],
        "recovered-model"
    );
}

#[test]
fn sigxfsz_during_settings_temp_write_keeps_old_file_and_allows_recovery() {
    const CHILD_FLAG: &str = "KCODER_CONFIG_P2_RLIMIT_CHILD";
    const SETTINGS_PATH: &str = "KCODER_CONFIG_P2_SETTINGS_PATH";

    if std::env::var(CHILD_FLAG).as_deref() == Ok("1") {
        let path = PathBuf::from(std::env::var_os(SETTINGS_PATH).unwrap());
        unsafe {
            libc::signal(libc::SIGXFSZ, libc::SIG_DFL);
        }
        let core_limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        assert_eq!(
            unsafe { libc::setrlimit(libc::RLIMIT_CORE, &core_limit) },
            0
        );
        let file_limit = libc::rlimit {
            rlim_cur: 4096,
            rlim_max: 4096,
        };
        assert_eq!(
            unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &file_limit) },
            0
        );
        let large_model = format!("synthetic-{}", "x".repeat(1024 * 1024));
        update_settings_file(&path, |settings| {
            set_dotted_value(settings, "model", Value::String(large_model))
        })
        .unwrap();
        panic!("SIGXFSZ did not interrupt the large temporary write");
    }

    let temp = tempdir().unwrap();
    let path = temp.path().join("settings.json");
    fs::write(&path, br#"{"model":"old-model"}"#).unwrap();
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "sigxfsz_during_settings_temp_write_keeps_old_file_and_allows_recovery",
            "--nocapture",
            "--test-threads=1",
        ])
        .env_clear()
        .env(CHILD_FLAG, "1")
        .env(SETTINGS_PATH, &path)
        .status()
        .unwrap();
    assert_eq!(child.signal(), Some(libc::SIGXFSZ), "{child:?}");

    assert_eq!(
        read_settings_file(&path).unwrap()["model"],
        "old-model",
        "the published settings must remain the previous complete version"
    );
    update_settings_file(&path, |settings| {
        set_dotted_value(settings, "model", Value::String("recovered-model".into()))
    })
    .unwrap();
    assert_eq!(
        read_settings_file(&path).unwrap()["model"],
        "recovered-model"
    );
}

#[cfg(feature = "private-file-test-hooks")]
#[test]
fn killed_settings_update_at_atomic_publish_checkpoints_keeps_whole_old_or_new_file() {
    const CHILD_FLAG: &str = "KCODER_CONFIG_P2_ATOMIC_CHILD";
    const SETTINGS_PATH: &str = "KCODER_CONFIG_P2_ATOMIC_SETTINGS_PATH";
    const CHECKPOINT_NAME: &str = "KCODER_CONFIG_P2_ATOMIC_CHECKPOINT";
    const READY_PATH: &str = "KCODER_CONFIG_P2_ATOMIC_READY_PATH";
    const TEST_NAME: &str =
        "killed_settings_update_at_atomic_publish_checkpoints_keeps_whole_old_or_new_file";

    if std::env::var(CHILD_FLAG).as_deref() == Ok("1") {
        let path = PathBuf::from(std::env::var_os(SETTINGS_PATH).unwrap());
        let checkpoint_name = std::env::var(CHECKPOINT_NAME).unwrap();
        let checkpoint = match checkpoint_name.as_str() {
            "after-write-before-file-sync" => AtomicReplaceTestCheckpoint::AfterWriteBeforeFileSync,
            "after-file-sync-before-rename" => {
                AtomicReplaceTestCheckpoint::AfterFileSyncBeforeRename
            }
            "after-rename-before-directory-sync" => {
                AtomicReplaceTestCheckpoint::AfterRenameBeforeDirectorySync
            }
            other => panic!("unknown atomic replacement checkpoint: {other}"),
        };
        let ready_path = PathBuf::from(std::env::var_os(READY_PATH).unwrap());
        let parent = path.parent().unwrap();
        PrivateDirectory::open_existing(parent)
            .unwrap()
            .install_atomic_replace_test_gate(
                std::ffi::OsStr::new("settings.json"),
                checkpoint,
                move || {
                    fs::write(&ready_path, checkpoint_name.as_bytes()).unwrap();
                    loop {
                        std::thread::park();
                    }
                },
            )
            .unwrap();

        update_settings_file(&path, |settings| {
            set_dotted_value(settings, "model", Value::String("new-model".into()))
        })
        .unwrap();
        panic!("the selected atomic replacement checkpoint was not reached");
    }

    let stages = [
        ("after-write-before-file-sync", "old-model"),
        ("after-file-sync-before-rename", "old-model"),
        ("after-rename-before-directory-sync", "new-model"),
    ];

    for (checkpoint_name, expected_model) in stages {
        let temp = tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let ready_path = temp.path().join("checkpoint.ready");
        fs::write(&path, br#"{"model":"old-model","max_retries":0}"#).unwrap();

        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST_NAME, "--test-threads=1"])
            .env_clear()
            .env(CHILD_FLAG, "1")
            .env(SETTINGS_PATH, &path)
            .env(CHECKPOINT_NAME, checkpoint_name)
            .env(READY_PATH, &ready_path)
            .spawn()
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut reached = false;
        while Instant::now() < deadline {
            if fs::read_to_string(&ready_path).is_ok_and(|ready| ready == checkpoint_name) {
                reached = true;
                break;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    panic!("child exited before reaching checkpoint {checkpoint_name}: {status:?}");
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("failed to observe child at checkpoint {checkpoint_name}: {error}");
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }

        if !reached {
            let _ = child.kill();
            let status = child.wait().unwrap();
            panic!("child did not reach checkpoint {checkpoint_name}: {status:?}");
        }

        child.kill().unwrap();
        let status = child.wait().unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL), "{status:?}");

        let published = read_settings_file(&path).unwrap();
        assert_eq!(
            published,
            json!({"model": expected_model, "max_retries": 0}),
            "the canonical file must contain one complete version at {checkpoint_name}"
        );

        update_settings_file(&path, |settings| {
            set_dotted_value(settings, "model", Value::String("recovered-model".into()))
        })
        .unwrap();
        assert_eq!(
            read_settings_file(&path).unwrap(),
            json!({"model": "recovered-model", "max_retries": 0}),
            "the settings file must remain writable after killing the publisher"
        );
    }
}

#[test]
fn missing_mcp_server_name_is_rejected_by_the_runtime_settings_validator() {
    let missing_name = json!({
        "mcp_servers": [{ "transport": "stdio", "command": "synthetic" }]
    });
    assert!(
        validate_and_resolve_settings_document(&missing_name).is_err(),
        "the typed runtime validator must reject a missing McpServerConfig.name"
    );

    let present_name = json!({
        "mcp_servers": [{ "name": "synthetic", "transport": "stdio", "command": "synthetic" }]
    });
    validate_and_resolve_settings_document(&present_name).unwrap();
}
