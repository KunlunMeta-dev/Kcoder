//! Self-contained private-profile test subprocesses for Engine consumers.
use anyhow::{Context, ensure};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MARKER: &str = "kcoder-isolated-test-profile-v2\n";

/// Invoked synchronously by an owned Hook fixture while its original group is alive.
#[cfg(all(test, unix))]
#[test]
#[ignore = "invoked by the owned Hook fixture with its exact native PID"]
fn record_fixture_hook_group() {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let profile = require_isolated_profile().expect("private Hook test profile");
    let ledger =
        PathBuf::from(std::env::var_os("KCODER_TEST_HOOK_LEDGER").expect("owned Hook ledger"));
    assert_eq!(
        ledger.parent(),
        Some(profile.as_path()),
        "Hook ledger escaped its profile"
    );
    let name = ledger
        .file_name()
        .and_then(|name| name.to_str())
        .expect("owned Hook ledger name");
    let token = name
        .strip_prefix("owned-hook-")
        .and_then(|name| name.strip_suffix(".log"))
        .expect("owned Hook ledger name");
    uuid::Uuid::parse_str(token).expect("owned Hook ledger identity");
    let pid: i32 = std::env::var("KCODER_TEST_HOOK_PID")
        .expect("owned Hook PID")
        .parse()
        .expect("numeric Hook PID");
    assert!(pid > 1, "invalid owned Hook PID");
    let group = unsafe { libc::getpgid(pid) };
    assert_eq!(
        group, pid,
        "owned Hook must lead its original process group"
    );
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&ledger)
        .expect("open original owned Hook ledger");
    let metadata = file.metadata().expect("inspect owned Hook ledger");
    assert!(
        metadata.is_file() && metadata.len() <= 32 * 1024,
        "unsafe owned Hook ledger"
    );
    writeln!(file, "{pid} {group}").expect("record original Hook group");
}

#[cfg(unix)]
fn owned_test_home() -> anyhow::Result<PathBuf> {
    use std::ffi::{CStr, OsString};
    use std::os::unix::ffi::OsStringExt;
    let uid = unsafe { libc::getuid() };
    ensure!(
        uid == unsafe { libc::geteuid() },
        "real and effective user identities differ"
    );
    let mut record: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result = std::ptr::null_mut();
    let mut buffer = vec![0_u8; 64 * 1024];
    let status = unsafe {
        libc::getpwuid_r(
            uid,
            &mut record,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    ensure!(
        status == 0 && !result.is_null() && !record.pw_dir.is_null(),
        "actual OS home is unavailable"
    );
    let bytes = unsafe { CStr::from_ptr(record.pw_dir) }.to_bytes();
    ensure!(!bytes.is_empty(), "actual OS home is empty");
    let home = PathBuf::from(OsString::from_vec(bytes.to_vec()));
    ensure!(
        home.is_absolute(),
        "HOME must be absolute for isolated tests"
    );
    match std::fs::canonicalize(&home) {
        Ok(canonical) => Ok(canonical),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(home),
        Err(error) => Err(error.into()),
    }
}

#[cfg(windows)]
fn owned_test_home() -> anyhow::Result<PathBuf> {
    // On Windows dirs resolves the profile via the native known-folder API.
    let path = kcoder_config::expand_home_path(Path::new("~"));
    ensure!(path.is_absolute(), "actual OS profile is unavailable");
    match std::fs::canonicalize(&path) {
        Ok(canonical) => Ok(canonical),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(path),
        Err(error) => Err(error.into()),
    }
}

fn ensure_outside_personal_profiles(path: &Path) -> anyhow::Result<()> {
    let home = owned_test_home()?;
    for personal in [
        home.join(".config/kcoder"),
        home.join(".config/kcoder-dev"),
        home.join(".kcoder"),
    ] {
        ensure!(
            !path.starts_with(personal),
            "refusing to use a personal KCoder profile"
        );
    }
    Ok(())
}

fn system_test_temp_parent() -> anyhow::Result<PathBuf> {
    let path = std::env::temp_dir();
    ensure!(path.is_absolute(), "test temporary root must be absolute");
    ensure_outside_personal_profiles(&path)?;
    for key in ["KCODER_CONFIG_DIR", "KCODER_HOME"] {
        if let Some(value) = std::env::var_os(key).filter(|value| !value.is_empty()) {
            let configured = PathBuf::from(value);
            ensure!(
                !path.starts_with(configured),
                "test temporary root is inside the caller's KCoder profile"
            );
        }
    }
    let directory = kcoder_config::PrivateDirectory::open_existing(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = directory.directory_metadata()?;
        let mode = metadata.permissions().mode();
        ensure!(metadata.is_dir(), "test temporary root is not a directory");
        ensure!(
            mode & 0o022 == 0 || mode & 0o1000 != 0,
            "writable test temporary root is not sticky"
        );
        ensure!(
            metadata.uid() == 0 || metadata.uid() == unsafe { libc::geteuid() },
            "test temporary root is not trusted"
        );
    }
    #[cfg(windows)]
    directory.verify_trusted_config_directory()?;
    let canonical = std::fs::canonicalize(path)?;
    ensure_outside_personal_profiles(&canonical)?;
    Ok(canonical)
}

struct OwnedTestProfile {
    directory: Option<tempfile::TempDir>,
    #[cfg(windows)]
    parent: Option<OwnedWindowsTestParent>,
}

impl OwnedTestProfile {
    fn path(&self) -> &Path {
        self.directory.as_ref().expect("profile is retained").path()
    }

    fn keep(mut self) -> PathBuf {
        #[cfg(windows)]
        if let Some(parent) = &mut self.parent {
            parent.retained = true;
        }
        self.directory.take().expect("profile is retained").keep()
    }
}

#[cfg(windows)]
struct OwnedWindowsTestParent {
    pin: Option<kcoder_config::ReadOnlyDirectoryPin>,
    home: kcoder_config::PrivateDirectory,
    directory: kcoder_config::PrivateDirectory,
    name: std::ffi::OsString,
    path: PathBuf,
    retained: bool,
}

#[cfg(windows)]
impl Drop for OwnedWindowsTestParent {
    fn drop(&mut self) {
        if self.retained {
            return;
        }
        self.pin.take();
        if let Err(error) = self
            .home
            .remove_owned_empty_child(&self.name, &self.directory)
        {
            eprintln!(
                "Owned isolated test parent retained at {}: {error}",
                self.path.display()
            );
        }
    }
}

#[cfg(unix)]
fn create_owned_test_profile(builder: &tempfile::Builder<'_, '_>) -> OwnedTestProfile {
    let parent = system_test_temp_parent().expect("cannot identify a safe system temporary root");
    let directory = builder
        .tempdir_in(parent)
        .expect("cannot create a private isolated test directory");
    OwnedTestProfile {
        directory: Some(directory),
    }
}

#[cfg(windows)]
fn create_owned_test_profile(builder: &tempfile::Builder<'_, '_>) -> OwnedTestProfile {
    let path = system_test_temp_parent().expect("cannot identify a safe system temporary root");
    let home =
        kcoder_config::PrivateDirectory::open_existing(&path).expect("open native user profile");
    home.verify_trusted_config_directory()
        .expect("native user profile must reject untrusted writes");
    let name = std::ffi::OsString::from(format!("kcoder-owned-test-{}", uuid::Uuid::new_v4()));
    let directory = home
        .create_private_child(&name)
        .expect("create owned private test parent");
    directory
        .verify_private_directory()
        .expect("verify owned test parent ACL");
    let identity = directory
        .directory_identity()
        .expect("owned test parent identity");
    let parent_path = path.join(&name);
    let pin = kcoder_config::ReadOnlyDirectoryPin::open_existing(&parent_path)
        .expect("pin the owned test parent and its ancestors");
    let current = home
        .open_child(&name, false)
        .and_then(|entry| entry.directory_identity())
        .expect("reopen pinned test parent");
    assert_eq!(current, identity, "test parent changed during pinning");
    let parent = OwnedWindowsTestParent {
        pin: Some(pin),
        home,
        directory,
        name,
        path: parent_path.clone(),
        retained: false,
    };
    let profile = builder
        .tempdir_in(parent_path)
        .expect("create isolated test profile");
    kcoder_config::PrivateDirectory::open_existing(profile.path())
        .and_then(|directory| directory.verify_private_directory())
        .expect("verify inherited private test profile ACL");
    OwnedTestProfile {
        directory: Some(profile),
        parent: Some(parent),
    }
}

pub(crate) fn require_isolated_profile() -> anyhow::Result<PathBuf> {
    let configured = PathBuf::from(
        std::env::var_os("KCODER_CONFIG_DIR")
            .context("KCODER_CONFIG_DIR must select a private test profile")?,
    );
    let declared = PathBuf::from(
        std::env::var_os("KCODER_TEST_ISOLATED_PROFILE")
            .context("KCODER_TEST_ISOLATED_PROFILE must identify the same private profile")?,
    );
    ensure!(
        configured == declared,
        "test profile and KCODER_CONFIG_DIR differ"
    );
    ensure!(configured.is_absolute(), "test profile must be absolute");
    ensure_outside_personal_profiles(&configured)?;
    let name = configured
        .file_name()
        .context("missing test profile name")?;
    ensure!(
        name.to_string_lossy().starts_with("kcoder-owned-test-"),
        "test profile is not owned by the fixture"
    );
    #[cfg(windows)]
    {
        let parent = configured
            .parent()
            .and_then(Path::file_name)
            .context("missing owned test parent")?;
        ensure!(
            parent.to_string_lossy().starts_with("kcoder-owned-test-"),
            "test profile is not inside an owned private parent"
        );
    }
    let private = kcoder_config::PrivateDirectory::open_existing(&configured)?;
    private.verify_private_directory()?;
    let marker = configured.join(".kcoder-isolated-test-profile");
    ensure!(
        std::fs::symlink_metadata(&marker)?.file_type().is_file(),
        "missing regular test profile marker"
    );
    let token = std::env::var("KCODER_TEST_PROFILE_CHILD")
        .context("internal test child marker is missing")?;
    ensure!(
        uuid::Uuid::parse_str(&token).is_ok(),
        "invalid internal test child marker"
    );
    ensure!(
        std::fs::read_to_string(marker)? == format!("{MARKER}{token}\n"),
        "invalid test profile marker"
    );
    Ok(configured)
}

/// Run one exact libtest case in a child with its own private profile. Returns
/// true in the parent after a verified pass and false in the isolated child.
pub(crate) fn run_or_reexec(qualified_test_name: &str) -> bool {
    if std::env::var_os("KCODER_TEST_PROFILE_CHILD").is_some() {
        require_isolated_profile().expect("an explicitly isolated test profile is required");
        return false;
    }
    let mut builder = tempfile::Builder::new();
    builder.prefix("kcoder-owned-test-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let profile = create_owned_test_profile(&builder);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(profile.path(), std::fs::Permissions::from_mode(0o700))
            .expect("secure the newly created private profile");
    }
    kcoder_config::PrivateDirectory::open_existing(profile.path())
        .and_then(|directory| directory.verify_private_directory())
        .expect("verify the newly created private profile");
    let temp = profile.path().join("tmp");
    std::fs::create_dir(&temp).expect("create private test temp directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o700))
            .expect("secure test temp directory");
    }
    let token = uuid::Uuid::new_v4().to_string();
    let marker = profile.path().join(".kcoder-isolated-test-profile");
    std::fs::write(&marker, format!("{MARKER}{token}\n")).expect("write private test marker");
    let stdout_path = profile.path().join("stdout.log");
    let stderr_path = profile.path().join("stderr.log");
    let stdout = std::fs::File::create(&stdout_path).expect("create child stdout");
    let stderr = std::fs::File::create(&stderr_path).expect("create child stderr");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&marker, mode.clone()).expect("secure private test marker");
        stdout
            .set_permissions(mode.clone())
            .expect("secure child stdout");
        stderr.set_permissions(mode).expect("secure child stderr");
    }
    let test_name = qualified_test_name
        .split_once("::")
        .map(|(_, rest)| rest)
        .unwrap_or(qualified_test_name);
    let mut command = Command::new(std::env::current_exe().expect("current test binary"));
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
        let shell = profile.path().join("kcoder-isolated-bash");
        let bash_env = profile.path().join("bash-env");
        std::fs::write(
            &shell,
            "#!/bin/sh\nexec /bin/bash --noprofile --norc \"$@\"\n",
        )
        .expect("write owned shell wrapper");
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700))
            .expect("secure owned shell wrapper");
        std::fs::write(&bash_env, "").expect("write owned bash environment");
        std::fs::set_permissions(&bash_env, std::fs::Permissions::from_mode(0o600))
            .expect("secure owned bash environment");
        command.env("PATH", "/usr/local/bin:/usr/bin:/bin");
        if let Some(home) = std::env::var_os("HOME") {
            command.env("HOME", home);
        }
        command.env("SHELL", shell);
        command.env("BASH_ENV", bash_env);
        // Limit fixture permissions in the child without changing the caller's process.
        unsafe {
            command.pre_exec(|| {
                libc::umask(0o077);
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SYSTEMROOT") {
        let root = PathBuf::from(root);
        let path = std::env::join_paths([root.join("System32"), root]).expect("system PATH");
        command.env("PATH", path);
    }
    command
        .current_dir(&temp)
        .env("KCODER_CONFIG_DIR", profile.path())
        .env("KCODER_HOME", profile.path())
        .env("KCODER_TEST_ISOLATED_PROFILE", profile.path())
        .env("KCODER_TEST_PROFILE_CHILD", token)
        .env("XDG_CONFIG_HOME", profile.path())
        .env("XDG_CACHE_HOME", profile.path())
        .env("XDG_DATA_HOME", profile.path())
        .env("XDG_STATE_HOME", profile.path())
        .env("TMPDIR", &temp)
        .env("TEMP", &temp)
        .env("TMP", &temp)
        .arg("--exact")
        .arg(test_name)
        .arg("--nocapture")
        .arg("--test-threads=1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    let mut child = command.spawn().expect("start owned isolated test");
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        match child.try_wait().expect("check owned isolated test") {
            Some(status) => break status,
            None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            None => {
                let hooks = capture_owned_test_hooks(&temp);
                release_owned_test_hooks(&temp);
                let grace = Instant::now() + Duration::from_secs(2);
                while Instant::now() < grace {
                    if child.try_wait().ok().flatten().is_some() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                if child.try_wait().ok().flatten().is_none() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                let hook_cleanup = confirm_owned_hooks_exited(hooks);
                let group_cleanup =
                    confirm_fixture_hook_groups(profile.path(), Duration::from_secs(3));
                let retained = profile.keep();
                panic!(
                    "isolated test {test_name} exceeded its deadline; {hook_cleanup}; fixture groups: {group_cleanup:?}; owned evidence retained at {}",
                    retained.display()
                );
            }
        }
    };
    let output = std::fs::read_to_string(&stdout_path).unwrap_or_default();
    let errors = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    let groups = confirm_fixture_hook_groups(profile.path(), Duration::from_secs(3));
    let passed = status.success()
        && output.contains("running 1 test")
        && output.contains("1 passed; 0 failed");
    if !passed || groups.is_err() {
        let retained = profile.keep();
        panic!(
            "isolated test {test_name} failed or owned Hook groups were not settled (status {status}; groups {groups:?}); evidence retained at {}:\n{output}\n{errors}",
            retained.display()
        );
    }
    true
}

fn fixture_hook_records(profile: &Path) -> anyhow::Result<Vec<i32>> {
    let mut groups = Vec::new();
    let mut ledgers = 0usize;
    for entry in std::fs::read_dir(profile)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(token) = name
            .strip_prefix("owned-hook-")
            .and_then(|s| s.strip_suffix(".log"))
        else {
            continue;
        };
        uuid::Uuid::parse_str(token).context("invalid owned Hook ledger identity")?;
        ledgers += 1;
        ensure!(ledgers <= 128, "too many owned Hook ledgers");
        let metadata = std::fs::symlink_metadata(entry.path())?;
        ensure!(
            metadata.file_type().is_file() && metadata.len() <= 32 * 1024,
            "unsafe owned Hook ledger"
        );
        let text = std::fs::read_to_string(entry.path())?;
        ensure!(!text.is_empty(), "owned Hook start was not confirmed");
        let before = groups.len();
        for line in text.lines() {
            let mut parts = line.split_whitespace();
            let pid: i32 = parts.next().context("missing owned Hook PID")?.parse()?;
            let group: i32 = parts.next().context("missing owned Hook group")?.parse()?;
            ensure!(
                parts.next().is_none() && pid > 1 && pid == group,
                "owned Hook group identity is invalid"
            );
            groups.push(group);
            ensure!(groups.len() <= 1024, "too many owned Hook records");
        }
        ensure!(groups.len() > before, "owned Hook start was not confirmed");
    }
    Ok(groups)
}

#[cfg(unix)]
fn confirm_fixture_hook_groups(profile: &Path, budget: Duration) -> anyhow::Result<()> {
    let groups = fixture_hook_records(profile)?;
    let deadline = Instant::now() + budget;
    for group in groups {
        loop {
            // Signal zero observes only; the fixture recorded its own native process group.
            if unsafe { libc::kill(-group, 0) } != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    break;
                }
                if error.raw_os_error() != Some(libc::EPERM) {
                    return Err(error.into());
                }
            }
            ensure!(
                Instant::now() < deadline,
                "owned Hook group {group} did not settle"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn confirm_fixture_hook_groups(profile: &Path, _budget: Duration) -> anyhow::Result<()> {
    ensure!(
        fixture_hook_records(profile)?.is_empty(),
        "owned Hook group observation unavailable"
    );
    Ok(())
}

fn release_owned_test_hooks(temp: &Path) {
    let Ok(entries) = std::fs::read_dir(temp) else {
        return;
    };
    for entry in entries.flatten() {
        let root = entry.path();
        if root.join("hook.pid").is_file() && root.join(".kcoder/settings.json").is_file() {
            let _ = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(root.join("allow-submit"));
        }
    }
}

#[cfg(target_os = "linux")]
struct OwnedHook {
    pidfd: Option<std::os::fd::OwnedFd>,
    verified: bool,
}

#[cfg(target_os = "linux")]
fn capture_owned_test_hooks(temp: &Path) -> Vec<OwnedHook> {
    use std::os::fd::FromRawFd;
    let mut hooks = Vec::new();
    let Ok(entries) = std::fs::read_dir(temp) else {
        return hooks;
    };
    for entry in entries.flatten() {
        let root = entry.path();
        if !root.join(".kcoder/settings.json").is_file() {
            continue;
        }
        let Ok(value) = std::fs::read_to_string(root.join("hook.pid")) else {
            continue;
        };
        let Ok(pid) = value.trim().parse::<i32>() else {
            hooks.push(OwnedHook {
                pidfd: None,
                verified: false,
            });
            continue;
        };
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) as i32 };
        if fd < 0 {
            let already_gone = std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
            hooks.push(OwnedHook {
                pidfd: None,
                verified: already_gone,
            });
            continue;
        }
        let pidfd = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) };
        let cwd_matches = std::fs::read_link(format!("/proc/{pid}/cwd"))
            .ok()
            .zip(std::fs::canonicalize(&root).ok())
            .is_some_and(|(cwd, root)| cwd == root);
        let command_matches = std::fs::read(format!("/proc/{pid}/cmdline"))
            .ok()
            .is_some_and(|command| {
                (command
                    .windows(b"hook.pid".len())
                    .any(|part| part == b"hook.pid")
                    && command
                        .windows(b"allow-submit".len())
                        .any(|part| part == b"allow-submit"))
                    || command
                        .windows(b"owned-hook.sh".len())
                        .any(|part| part == b"owned-hook.sh")
            });
        hooks.push(OwnedHook {
            pidfd: Some(pidfd),
            verified: cwd_matches && command_matches,
        });
    }
    hooks
}

#[cfg(target_os = "linux")]
fn confirm_owned_hooks_exited(hooks: Vec<OwnedHook>) -> String {
    use std::os::fd::AsRawFd;
    if hooks.is_empty() {
        return "no Hook identity was captured; Hook cleanup is unconfirmed".to_string();
    }
    let mut unknown = 0usize;
    for hook in &hooks {
        if !hook.verified {
            unknown += 1;
            continue;
        }
        if let Some(pidfd) = &hook.pidfd {
            let mut item = libc::pollfd {
                fd: pidfd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let result = unsafe { libc::poll(&mut item, 1, 0) };
            if result <= 0 || item.revents & libc::POLLIN == 0 {
                unknown += 1;
            }
        }
    }
    if unknown == 0 {
        format!("{} owned hook(s) confirmed exited", hooks.len())
    } else {
        format!("{unknown} hook(s) could not be confirmed exited")
    }
}

#[cfg(not(target_os = "linux"))]
fn capture_owned_test_hooks(_temp: &Path) {}

#[cfg(not(target_os = "linux"))]
fn confirm_owned_hooks_exited(_: ()) -> String {
    "hook termination is unverified on this platform".to_string()
}

#[cfg(all(test, target_os = "linux"))]
mod timeout_cleanup_tests {
    use super::*;
    use std::os::unix::process::CommandExt;

    struct OwnedChild(std::process::Child);

    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }

    fn wait_for_file(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !path.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(path.exists(), "owned Hook did not publish its identity");
    }

    #[test]
    fn normal_exit_requires_each_started_hook_group_to_settle() {
        let profile = tempfile::tempdir().unwrap();
        let ledger = profile
            .path()
            .join(format!("owned-hook-{}.log", uuid::Uuid::new_v4()));
        std::fs::write(&ledger, "").unwrap();
        assert!(confirm_fixture_hook_groups(profile.path(), Duration::from_millis(30)).is_err());
        let mut child = OwnedChild(
            Command::new("/bin/sleep")
                .arg("30")
                .process_group(0)
                .spawn()
                .unwrap(),
        );
        let pid = child.0.id();
        std::fs::write(&ledger, format!("{pid} {pid}\n")).unwrap();
        assert!(confirm_fixture_hook_groups(profile.path(), Duration::from_millis(30)).is_err());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        confirm_fixture_hook_groups(profile.path(), Duration::from_secs(1)).unwrap();
    }

    #[test]
    fn timeout_cleanup_recognizes_and_settles_the_owned_hook_script() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("owned-workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir(workspace.join(".kcoder")).unwrap();
        std::fs::write(workspace.join(".kcoder/settings.json"), "{}").unwrap();
        std::fs::write(
            workspace.join("owned-hook.sh"),
            "printf '%s' \"$$\" > hook.pid; while [ ! -f allow-submit ]; do /bin/sleep 0.02; done",
        )
        .unwrap();
        let mut child = OwnedChild(
            Command::new("/bin/sh")
                .arg("./owned-hook.sh")
                .current_dir(&workspace)
                .env_clear()
                .process_group(0)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        wait_for_file(&workspace.join("hook.pid"));
        let hooks = capture_owned_test_hooks(temp.path());
        release_owned_test_hooks(temp.path());
        child.0.wait().unwrap();
        assert_eq!(
            confirm_owned_hooks_exited(hooks),
            "1 owned hook(s) confirmed exited"
        );
    }

    #[test]
    fn timeout_cleanup_confirms_the_original_owned_hook_with_pidfd() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("owned-workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir(workspace.join(".kcoder")).unwrap();
        std::fs::write(workspace.join(".kcoder/settings.json"), "{}").unwrap();
        let mut child = OwnedChild(Command::new("/bin/sh")
            .arg("-c")
            .arg("printf '%s' \"$$\" > hook.pid; while [ ! -f allow-submit ]; do /bin/sleep 0.02; done")
            .env_clear()
            .current_dir(&workspace)
            .process_group(0)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().unwrap());
        wait_for_file(&workspace.join("hook.pid"));
        let hooks = capture_owned_test_hooks(temp.path());
        assert_eq!(hooks.len(), 1);
        assert!(
            hooks[0].verified,
            "the owned Hook identity must be bound before cleanup"
        );
        release_owned_test_hooks(temp.path());
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if child.0.try_wait().unwrap().is_some() {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.0.kill();
                let _ = child.0.wait();
                panic!("owned Hook failed to exit after cooperative release");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            confirm_owned_hooks_exited(hooks),
            "1 owned hook(s) confirmed exited"
        );
    }

    #[test]
    fn timeout_cleanup_does_not_touch_an_unrelated_owned_process() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("fixture");
        let other = temp.path().join("other");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir(workspace.join(".kcoder")).unwrap();
        std::fs::create_dir(&other).unwrap();
        std::fs::write(workspace.join(".kcoder/settings.json"), "{}").unwrap();
        let mut child = OwnedChild(
            Command::new("/bin/sh")
                .arg("-c")
                .arg("exec /bin/sleep 10")
                .env_clear()
                .current_dir(&other)
                .process_group(0)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        std::fs::write(workspace.join("hook.pid"), child.0.id().to_string()).unwrap();
        let hooks = capture_owned_test_hooks(temp.path());
        assert_eq!(hooks.len(), 1);
        assert!(
            !hooks[0].verified,
            "a different process must not match the Hook identity"
        );
        release_owned_test_hooks(temp.path());
        assert_eq!(
            confirm_owned_hooks_exited(hooks),
            "1 hook(s) could not be confirmed exited"
        );
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "unrelated process must not be stopped"
        );
        child.0.kill().unwrap();
        let _ = child.0.wait().unwrap();
    }

    #[test]
    fn missing_hook_identity_never_counts_as_confirmed_cleanup() {
        assert_eq!(
            confirm_owned_hooks_exited(Vec::new()),
            "no Hook identity was captured; Hook cleanup is unconfirmed"
        );
    }
}
