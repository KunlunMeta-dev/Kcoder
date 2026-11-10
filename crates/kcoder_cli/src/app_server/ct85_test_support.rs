//! Per-case child ownership for tests which initialize the real app-server.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const ROOT: &str = "KCODER_CT85_HOST_TEST_ROOT";
const CASE: &str = "KCODER_CT85_HOST_TEST_CASE";
const MARKER: &str = "kcoder-ct85-host-owned-test-v1\n";

/// Always spawn a new private child; inherited environment is not authority.
pub(super) fn run_owned_case(qualified_dispatcher: &str, case: &str) {
    let mut builder = tempfile::Builder::new();
    builder.prefix("kcoder-ct85-host-");
    let owned = builder.tempdir().expect("create owned test root");
    kcoder_config::set_user_only_dir_permissions(owned.path()).expect("secure owned test root");
    let root = owned.path().canonicalize().expect("canonical owned root");
    let directory = kcoder_config::PrivateDirectory::open_existing(&root).unwrap();
    directory.verify_private_directory().unwrap();
    for name in ["config", "tmp", "work"] {
        directory
            .create_private_child(OsStr::new(name))
            .unwrap()
            .verify_private_directory()
            .unwrap();
    }
    std::fs::write(root.join("marker"), MARKER).unwrap();
    std::fs::write(root.join("work/AGENTS.md"), "Owned test workspace.\n").unwrap();
    let output = std::fs::File::create(root.join("stdout.log")).unwrap();
    let errors = std::fs::File::create(root.join("stderr.log")).unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.env_clear();
    for key in ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::process::CommandExt;
        let shell = root.join("owned-bash");
        let bash_env = root.join("bash-env");
        std::fs::write(
            &shell,
            "#!/bin/sh\nexec /bin/bash --noprofile --norc \"$@\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(&bash_env, "").unwrap();
        std::fs::set_permissions(&bash_env, std::fs::Permissions::from_mode(0o600)).unwrap();
        command
            .env("PATH", "/usr/bin:/bin")
            .env("SHELL", shell)
            .env("BASH_ENV", bash_env)
            .process_group(0);
    }
    #[cfg(windows)]
    {
        let system = PathBuf::from(std::env::var_os("SYSTEMROOT").expect("SYSTEMROOT"));
        command
            .env(
                "PATH",
                std::env::join_paths([system.join("System32"), system]).unwrap(),
            )
            .env("SHELL", root.join("missing-bash"));
    }
    let dispatcher = qualified_dispatcher
        .split_once("::")
        .map(|(_, suffix)| suffix)
        .unwrap_or(qualified_dispatcher);
    command
        .current_dir(root.join("work"))
        .env(ROOT, &root)
        .env(CASE, case)
        .env("KCODER_CONFIG_DIR", root.join("config"))
        .env("KCODER_HOME", root.join("config"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_CACHE_HOME", root.join("config"))
        .env("XDG_DATA_HOME", root.join("config"))
        .env("XDG_STATE_HOME", root.join("config"))
        .env("TMPDIR", root.join("tmp"))
        .env("TMP", root.join("tmp"))
        .env("TEMP", root.join("tmp"))
        // The real dispatch future needs the 16 MiB stack production runtime
        // threads have; libtest's default 2 MiB test thread overflows in debug.
        .env("RUST_MIN_STACK", (16 * 1024 * 1024).to_string())
        .args([
            "--exact",
            dispatcher,
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::from(output))
        .stderr(Stdio::from(errors));
    let mut child = command.spawn().expect("start owned test child");
    #[cfg(unix)]
    let child_id = child.id();
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                #[cfg(unix)]
                unsafe {
                    // The live, unreaped child owns this process group ID.
                    libc::kill(-(child_id as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                let kept = owned.keep();
                panic!("owned test {case} timed out; retained {}", kept.display());
            }
            Err(error) => {
                let kept = owned.keep();
                panic!(
                    "owned test {case} status unknown ({error}); retained {}",
                    kept.display()
                );
            }
        }
    };
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(-(child_id as i32), 0) };
        if result >= 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
            let kept = owned.keep();
            panic!(
                "owned test {case} left an unconfirmed process group; retained {}",
                kept.display()
            );
        }
    }
    let stdout = std::fs::read_to_string(root.join("stdout.log")).unwrap();
    let stderr = std::fs::read_to_string(root.join("stderr.log")).unwrap();
    let summary = stdout
        .lines()
        .rev()
        .find(|line| line.starts_with("test result: "));
    let passed = status.success()
        && stdout.lines().any(|line| line == "running 1 test")
        && summary.is_some_and(|line| {
            line.starts_with("test result: ok. 1 passed; 0 failed; 0 ignored;")
        });
    if !passed {
        let kept = owned.keep();
        panic!(
            "owned test {case} failed ({status}); retained {}:\n{stdout}\n{stderr}",
            kept.display()
        );
    }
}

pub(super) fn owned_case() -> String {
    for key in ["HOME", "home", "CODEX_HOME"] {
        assert!(
            std::env::var_os(key).is_none(),
            "owned child inherited {key}"
        );
    }
    let root = PathBuf::from(std::env::var_os(ROOT).expect("owned test root"))
        .canonicalize()
        .unwrap();
    let directory = kcoder_config::PrivateDirectory::open_existing(&root).unwrap();
    directory.verify_private_directory().unwrap();
    for name in ["config", "tmp", "work"] {
        directory
            .open_child(OsStr::new(name), false)
            .unwrap()
            .verify_private_directory()
            .unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(root.join("marker")).unwrap(),
        MARKER
    );
    assert_eq!(
        PathBuf::from(std::env::var_os("KCODER_CONFIG_DIR").unwrap())
            .canonicalize()
            .unwrap(),
        root.join("config")
    );
    assert_eq!(
        std::env::current_dir().unwrap().canonicalize().unwrap(),
        root.join("work").canonicalize().unwrap()
    );
    assert_eq!(
        PathBuf::from(std::env::var_os("TMPDIR").unwrap())
            .canonicalize()
            .unwrap(),
        root.join("tmp")
    );
    std::env::var(CASE).expect("owned test case")
}

pub(super) fn owned_tempdir() -> tempfile::TempDir {
    let _ = owned_case();
    let root = PathBuf::from(std::env::var_os(ROOT).unwrap())
        .canonicalize()
        .unwrap();
    let owned = tempfile::Builder::new()
        .prefix("workspace-")
        .tempdir_in(root.join("tmp"))
        .unwrap();
    kcoder_config::set_user_only_dir_permissions(owned.path()).unwrap();
    kcoder_config::PrivateDirectory::open_existing(owned.path())
        .unwrap()
        .verify_private_directory()
        .unwrap();
    owned
}

pub(super) fn prepare_workspace(workspace: &Path) {
    let _ = owned_case();
    let root = PathBuf::from(std::env::var_os(ROOT).unwrap())
        .canonicalize()
        .unwrap();
    let workspace = workspace.canonicalize().unwrap();
    assert!(workspace.starts_with(root.join("tmp")) && workspace != root.join("tmp"));
    let directory = kcoder_config::PrivateDirectory::open_existing(&workspace).unwrap();
    directory.verify_private_directory().unwrap();
    let kcoder = directory
        .create_private_child(OsStr::new(".kcoder"))
        .unwrap();
    kcoder
        .create_private_child(OsStr::new("skills"))
        .unwrap()
        .verify_private_directory()
        .unwrap();
    kcoder
        .create_private_child(OsStr::new("specs"))
        .unwrap()
        .verify_private_directory()
        .unwrap();
    std::fs::write(
        workspace.join(".kcoder/specs/config.yaml"),
        "schema: kcoder-spec-driven-superpowers\n",
    )
    .unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "Owned test workspace.\n").unwrap();
}
