//! Explicit per-case subprocess isolation for Engine tests.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const ROOT_ENV: &str = "KCODER_ENGINE_OWNED_TEST_ROOT";
const CASE_ENV: &str = "KCODER_ENGINE_OWNED_TEST_CASE";
const MARKER: &str = "kcoder-engine-owned-test-v1\n";

/// Always start one ignored dispatcher in a newly created private child.
/// The parent never treats an inherited environment marker as child authority.
pub(crate) fn run_owned_case(qualified_dispatcher: &str, case: &str) {
    let mut builder = tempfile::Builder::new();
    builder.prefix("kcoder-engine-owned-test-");
    #[cfg(unix)]
    let owned = builder.tempdir_in("/tmp").expect("create owned test root");
    #[cfg(not(unix))]
    let owned = builder.tempdir().expect("create owned test root");
    kcoder_config::set_user_only_dir_permissions(owned.path()).expect("secure owned test root");
    let root = owned.path().canonicalize().expect("canonical owned root");
    let root_dir =
        kcoder_config::PrivateDirectory::open_existing(&root).expect("open owned test root");
    root_dir
        .verify_private_directory()
        .expect("verify private test root");
    for name in ["config", "home", "tmp", "work"] {
        root_dir
            .create_private_child(std::ffi::OsStr::new(name))
            .expect("create owned private test child")
            .verify_private_directory()
            .expect("verify private test child");
    }
    std::fs::write(root.join("marker"), MARKER).expect("write owned test marker");
    std::fs::write(root.join("work/AGENTS.md"), "Owned test workspace.\n")
        .expect("write owned project boundary");

    let output = std::fs::File::create(root.join("stdout.log")).expect("create owned stdout");
    let errors = std::fs::File::create(root.join("stderr.log")).expect("create owned stderr");
    let mut command = Command::new(std::env::current_exe().expect("current test executable"));
    command.env_clear();
    // The child gets a private home inside its owned root, never the user's.
    command.env("HOME", root.join("home"));
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
        .expect("write owned shell wrapper");
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700))
            .expect("secure owned shell wrapper");
        std::fs::write(&bash_env, "").expect("write owned shell environment");
        std::fs::set_permissions(&bash_env, std::fs::Permissions::from_mode(0o600))
            .expect("secure owned shell environment");
        command
            .env(
                "PATH",
                "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            )
            .env("SHELL", shell)
            .env("BASH_ENV", bash_env)
            .process_group(0);
    }
    #[cfg(windows)]
    {
        let root_dir = PathBuf::from(std::env::var_os("SYSTEMROOT").expect("SYSTEMROOT"));
        let path =
            std::env::join_paths([root_dir.join("System32"), root_dir]).expect("system PATH");
        // Do not fall back to a user's login shell for tests without shell fixtures.
        command
            .env("PATH", path)
            .env("SHELL", root.join("missing-bash"));
    }
    let dispatcher = qualified_dispatcher
        .split_once("::")
        .map(|(_, suffix)| suffix)
        .unwrap_or(qualified_dispatcher);
    command
        .current_dir(root.join("work"))
        .env(ROOT_ENV, &root)
        .env(CASE_ENV, case)
        .env("KCODER_CONFIG_DIR", root.join("config"))
        .env("KCODER_HOME", root.join("config"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_CACHE_HOME", root.join("config"))
        .env("XDG_DATA_HOME", root.join("config"))
        .env("XDG_STATE_HOME", root.join("config"))
        .env("TMPDIR", root.join("tmp"))
        .env("TMP", root.join("tmp"))
        .env("TEMP", root.join("tmp"))
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
                    // The unreaped child owns this process group, so its ID cannot be reused yet.
                    libc::kill(-(child_id as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                let kept = owned.keep();
                panic!(
                    "owned test {case} timed out; evidence retained at {}",
                    kept.display()
                );
            }
            Err(error) => {
                let kept = owned.keep();
                panic!(
                    "owned test {case} has an unknown child status ({error}); evidence retained at {}",
                    kept.display()
                );
            }
        }
    };
    #[cfg(unix)]
    if !owned_group_is_settled(child_id) {
        let kept = owned.keep();
        panic!(
            "owned test {case} left an unconfirmed process group; evidence retained at {}",
            kept.display()
        );
    }
    let stdout = std::fs::read_to_string(root.join("stdout.log")).expect("read owned stdout");
    let stderr = std::fs::read_to_string(root.join("stderr.log")).expect("read owned stderr");
    let summary = stdout
        .lines()
        .rev()
        .find(|line| line.starts_with("test result: "));
    let passed = status.success()
        && stdout.lines().any(|line| line == "running 1 test")
        && summary.is_some_and(|line| {
            line.starts_with("test result: ok. 1 passed; 0 failed; 0 ignored;")
        });
    assert!(
        passed,
        "owned test {case} failed ({status}):\n{stdout}\n{stderr}"
    );
}

#[cfg(unix)]
fn owned_group_is_settled(child_id: u32) -> bool {
    let result = unsafe { libc::kill(-(child_id as i32), 0) };
    result < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

/// Verify the child profile before dispatching any case or constructing Engine.
pub(crate) fn owned_case() -> String {
    let root = PathBuf::from(std::env::var_os(ROOT_ENV).expect("owned child root"));
    let root = root.canonicalize().expect("canonical owned child root");
    let directory =
        kcoder_config::PrivateDirectory::open_existing(&root).expect("open owned child root");
    directory
        .verify_private_directory()
        .expect("verify owned child root");
    for name in ["config", "home", "tmp", "work"] {
        directory
            .open_child(std::ffi::OsStr::new(name), false)
            .expect("open owned child directory")
            .verify_private_directory()
            .expect("verify owned child directory");
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
    std::env::var(CASE_ENV).expect("owned child case")
}

/// Create and verify a private nested fixture even when the caller's umask is permissive.
pub(crate) fn owned_tempdir() -> tempfile::TempDir {
    let _case = owned_case();
    let root = PathBuf::from(std::env::var_os(ROOT_ENV).unwrap())
        .canonicalize()
        .unwrap();
    let owned = tempfile::Builder::new()
        .prefix("workspace-")
        .tempdir_in(root.join("tmp"))
        .expect("create owned nested test directory");
    kcoder_config::set_user_only_dir_permissions(owned.path())
        .expect("secure owned nested test directory");
    kcoder_config::PrivateDirectory::open_existing(owned.path())
        .expect("open owned nested test directory")
        .verify_private_directory()
        .expect("verify owned nested test directory");
    owned
}

/// Place the native guide boundary only inside this child's owned temp tree.
pub(crate) fn prepare_workspace(workspace: &Path) {
    let _case = owned_case();
    let root = PathBuf::from(std::env::var_os(ROOT_ENV).unwrap())
        .canonicalize()
        .unwrap();
    let workspace = workspace.canonicalize().expect("canonical test workspace");
    assert!(workspace.starts_with(root.join("tmp")) && workspace != root.join("tmp"));
    let workspace_directory = kcoder_config::PrivateDirectory::open_existing(&workspace)
        .expect("open owned test workspace");
    workspace_directory
        .verify_private_directory()
        .expect("verify owned test workspace");
    // These local roots stop the production skill/spec ancestor probes before
    // they reach another project's directory. The empty Superpowers schema
    // keeps the TDD gate off for fixtures that exercise ordinary input only.
    let kcoder = workspace_directory
        .create_private_child(std::ffi::OsStr::new(".kcoder"))
        .expect("create owned project metadata");
    kcoder
        .verify_private_directory()
        .expect("verify owned project metadata");
    kcoder
        .create_private_child(std::ffi::OsStr::new("skills"))
        .expect("create owned empty skills boundary")
        .verify_private_directory()
        .expect("verify owned skills boundary");
    kcoder
        .create_private_child(std::ffi::OsStr::new("specs"))
        .expect("create owned empty specs boundary")
        .verify_private_directory()
        .expect("verify owned specs boundary");
    std::fs::write(
        workspace.join(".kcoder/specs/config.yaml"),
        "schema: kcoder-spec-driven-superpowers\n",
    )
    .expect("write owned non-gating specs boundary");
    let mut guide = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(workspace.join("AGENTS.md"))
        .expect("create owned project instruction boundary");
    use std::io::Write;
    guide.write_all(b"Owned test workspace.\n").unwrap();
}

#[test]
fn owned_case_rejects_a_zero_test_child() {
    let result = std::panic::catch_unwind(|| {
        run_owned_case("kcoder_engine::missing_owned_dispatcher", "missing");
    });
    assert!(
        result.is_err(),
        "zero selected child tests must never count as a pass"
    );
}

#[test]
#[ignore = "intentionally failing dispatcher used by its owned parent test"]
fn owned_case_intentional_failure_dispatcher() {
    assert_eq!(owned_case(), "intentional-failure");
    panic!("owned child failure sentinel");
}

#[test]
fn owned_case_rejects_a_failed_child() {
    let result = std::panic::catch_unwind(|| {
        run_owned_case(
            concat!(
                module_path!(),
                "::owned_case_intentional_failure_dispatcher"
            ),
            "intentional-failure",
        );
    });
    assert!(result.is_err(), "a failed child must never count as a pass");
}

#[cfg(unix)]
#[test]
fn owned_case_detects_a_live_process_group() {
    use std::os::unix::process::CommandExt;
    struct OwnedProbe(std::process::Child);
    impl Drop for OwnedProbe {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }
    let mut child = OwnedProbe(
        Command::new("/bin/sleep")
            .arg("10")
            .process_group(0)
            .spawn()
            .expect("start owned group probe"),
    );
    let id = child.0.id();
    assert!(!owned_group_is_settled(id));
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    assert!(owned_group_is_settled(id));
}
