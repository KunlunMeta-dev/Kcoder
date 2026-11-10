use kcoder_process_supervisor::suspended_child::{SUSPENDED_CHILD_FLAGS, SuspendedChildJob};
use std::io::{Read, Write};
use std::os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};

const PROBE: &str = "KCODER_SUSPENDED_CHILD_PROBE";
const MARKER: &str = "KCODER_SUSPENDED_CHILD_MARKER";

struct OwnedChild {
    job: SuspendedChildJob,
    child: Child,
}

impl OwnedChild {
    fn spawn(mode: &str, marker: &Path) -> Self {
        let job = SuspendedChildJob::new().unwrap();
        let child = command(mode, marker)
            .creation_flags(SUSPENDED_CHILD_FLAGS)
            .spawn()
            .unwrap();
        Self { job, child }
    }

    fn start(&mut self) {
        self.job.assign_and_resume(self.child.as_handle()).unwrap();
    }

    fn wait(&mut self) {
        super::wait_until(Duration::from_secs(5), || {
            self.child.try_wait().unwrap().is_some()
        });
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.job.terminate();
        let _ = self.child.kill();
        let deadline = Instant::now() + Duration::from_secs(5);
        while matches!(self.child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

fn command(mode: &str, marker: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "suspended_child::child_probe", "--nocapture"])
        .env_clear()
        .env(PROBE, mode)
        .env(MARKER, marker)
        .env("KCODER_PRIVATE_PROBE_VALUE", "独立环境✓")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
    command
}

#[test]
fn child_probe() {
    let Ok(mode) = std::env::var(PROBE) else {
        return;
    };
    let marker = std::path::PathBuf::from(std::env::var_os(MARKER).unwrap());
    match mode.as_str() {
        "pipes" => {
            assert!(std::env::var_os("PATH").is_none());
            assert_eq!(
                std::env::var("KCODER_PRIVATE_PROBE_VALUE").unwrap(),
                "独立环境✓"
            );
            std::fs::write(&marker, b"started").unwrap();
            let mut input = String::new();
            std::io::stdin().read_to_string(&mut input).unwrap();
            print!("echo:{input}");
            std::io::stdout().flush().unwrap();
        }
        "tree" => {
            let mut descendant = command("wait", &marker).spawn().unwrap();
            std::fs::write(marker, descendant.id().to_string()).unwrap();
            let _ = descendant.wait();
        }
        "wait" => std::thread::sleep(Duration::from_secs(60)),
        "console" => {
            assert!(unsafe { windows_sys::Win32::System::Console::GetConsoleWindow() }.is_null());
            std::fs::write(marker, b"no-console").unwrap();
        }
        _ => panic!("unknown isolated process fixture"),
    }
}

#[test]
fn supervised_console_target_starts_without_allocating_a_console() {
    use kcoder_process_supervisor::client::{SpawnSpec, SupervisedChild};
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("console-state");
    let mut command = command("console", &marker);
    command.current_dir(root.path());
    let spec = SpawnSpec::from_command_exact_environment(&command).unwrap();
    let mut child = SupervisedChild::spawn(spec, &super::supervisor()).unwrap();
    let status = child
        .wait_with_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    assert!(status.success());
    assert_eq!(std::fs::read(marker).unwrap(), b"no-console");
}

#[test]
fn gui_carrier_starts_and_waits_for_a_windowless_child() {
    use kcoder_process_supervisor::protocol::{
        GUI_CARRIER_CAPABILITY_V1, INTERNAL_GUI_CARRIER_PROBE_V1, INTERNAL_GUI_CARRIER_V1,
    };
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("carrier-console-state");
    let probe = Command::new(super::supervisor())
        .arg(INTERNAL_GUI_CARRIER_PROBE_V1)
        .output()
        .unwrap();
    assert!(probe.status.success());
    assert_eq!(
        String::from_utf8(probe.stdout).unwrap().trim(),
        GUI_CARRIER_CAPABILITY_V1
    );
    let child = Command::new(super::supervisor())
        .arg(INTERNAL_GUI_CARRIER_V1)
        .arg(std::env::current_exe().unwrap())
        .args(["--exact", "suspended_child::child_probe", "--nocapture"])
        .env(PROBE, "console")
        .env(MARKER, &marker)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut child = super::OwnedTestProcess(child);
    super::wait_until(Duration::from_secs(5), || {
        child.try_wait().unwrap().is_some()
    });
    assert!(child.wait().unwrap().success());
    assert_eq!(std::fs::read(marker).unwrap(), b"no-console");
}

#[test]
fn suspended_job_assigns_before_execution_and_preserves_private_stdio() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("启动状态.txt");
    let mut owned = OwnedChild::spawn("pipes", &marker);
    std::thread::sleep(Duration::from_millis(100));
    assert!(!marker.exists(), "child ran before Job assignment");
    owned.start();
    let mut stdin = owned.child.stdin.take().unwrap();
    stdin.write_all("逐行✓\n".as_bytes()).unwrap();
    drop(stdin);
    owned.wait();
    let mut output = String::new();
    owned
        .child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    assert!(
        owned.child.try_wait().unwrap().unwrap().success(),
        "{output}"
    );
    assert!(output.contains("echo:逐行✓\n"), "{output}");
    assert_eq!(std::fs::read(marker).unwrap(), b"started");
}

#[test]
fn job_close_reaps_descendants_after_root_exit_and_preserves_peer() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("descendant.pid");
    let mut peer = OwnedChild::spawn("wait", &directory.path().join("peer"));
    peer.start();
    let mut owned = OwnedChild::spawn("tree", &marker);
    owned.start();
    let exit = owned.job.exit_handle();
    let mut pid = None;
    super::wait_until(Duration::from_secs(5), || {
        pid = std::fs::read_to_string(&marker)
            .ok()
            .and_then(|text| text.parse::<u32>().ok());
        pid.is_some()
    });
    // Keep the kernel handle, so assertions never confuse a reused PID.
    let raw = unsafe { OpenProcess(0x0010_0000, 0, pid.unwrap()) };
    assert!(!raw.is_null());
    // SAFETY: OpenProcess returned a new owned handle.
    let descendant = unsafe { OwnedHandle::from_raw_handle(raw) };
    owned.child.kill().unwrap();
    owned.wait();
    assert_eq!(
        unsafe { WaitForSingleObject(descendant.as_raw_handle(), 0) },
        WAIT_TIMEOUT
    );
    // The observer retains the OS handle. Dropping the actual owner must still
    // terminate the Job, independently of OwnedChild's fallback cleanup.
    let original_job = std::mem::replace(&mut owned.job, SuspendedChildJob::new().unwrap());
    drop(original_job);
    assert_eq!(
        unsafe { WaitForSingleObject(descendant.as_raw_handle(), 5000) },
        WAIT_OBJECT_0
    );
    super::wait_until(Duration::from_secs(5), || exit.is_empty().unwrap());
    drop(owned);
    assert!(peer.child.try_wait().unwrap().is_none());
}

#[test]
fn original_named_job_query_distinguishes_owned_member_and_independent_peer() {
    use kcoder_process_supervisor::suspended_child::NamedJobQuery;
    let directory = tempfile::tempdir().unwrap();
    let name = format!(
        "Local\\KCoder-E2E-query-{}-{}",
        std::process::id(),
        directory.path().file_name().unwrap().to_string_lossy()
    );
    let mut owned = OwnedChild {
        job: SuspendedChildJob::new_named(&name, "D:P(A;;GA;;;OW)(A;;GA;;;SY)").unwrap(),
        child: command("wait", &directory.path().join("owned"))
            .creation_flags(SUSPENDED_CHILD_FLAGS)
            .spawn()
            .unwrap(),
    };
    let mut peer = OwnedChild::spawn("wait", &directory.path().join("peer"));
    owned.start();
    peer.start();
    let query = NamedJobQuery::open_for_process(&name, owned.child.as_handle()).unwrap();
    assert!(query.contains_process(owned.child.as_handle()).unwrap());
    assert!(!query.contains_process(peer.child.as_handle()).unwrap());
    drop(query);
    assert!(owned.child.try_wait().unwrap().is_none());
    assert!(peer.child.try_wait().unwrap().is_none());
}

#[test]
fn lost_original_job_owner_cannot_replace_or_terminate_held_orphan() {
    use kcoder_process_supervisor::suspended_child::NamedJobQuery;
    let directory = tempfile::tempdir().unwrap();
    let name = format!(
        "Local\\KCoder-E2E-orphan-{}-{}",
        std::process::id(),
        directory.path().file_name().unwrap().to_string_lossy()
    );
    let security = "D:P(A;;GA;;;OW)(A;;GA;;;SY)";
    let mut job = SuspendedChildJob::new_named(&name, security).unwrap();
    let mut child = super::OwnedTestProcess(
        command("wait", &directory.path().join("original"))
            .creation_flags(SUSPENDED_CHILD_FLAGS)
            .spawn()
            .unwrap(),
    );
    job.assign_and_resume(child.as_handle()).unwrap();
    let query = NamedJobQuery::open_for_process(&name, child.as_handle()).unwrap();
    drop(job);
    assert!(query.contains_process(child.as_handle()).unwrap());
    assert!(SuspendedChildJob::new_named(&name, security).is_err());
    assert!(child.try_wait().unwrap().is_none());
    assert!(query.contains_process(child.as_handle()).unwrap());
    drop(query);
    super::wait_until(Duration::from_secs(5), || {
        child.try_wait().unwrap().is_some()
    });
}
