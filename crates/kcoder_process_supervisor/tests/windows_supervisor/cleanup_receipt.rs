use super::*;
use std::fs::{File, OpenOptions};
use std::os::windows::fs::OpenOptionsExt;
use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;

#[path = "cleanup_receipt/chromium.rs"]
mod chromium;

const CONFIRMED: &[u8] = b"kcoder-owned-cleanup/v1\nconfirmed\n";

fn private_receipt(path: &Path) -> File {
    std::fs::write(path, b"").unwrap();
    let literal = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$p='{literal}';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.FileSecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow));Set-Acl -LiteralPath $p -AclObject $acl"
    );
    assert!(
        Command::new(powershell())
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .status()
            .unwrap()
            .success()
    );
    OpenOptions::new()
        .access_mode(FILE_ALL_ACCESS)
        .open(path)
        .unwrap()
}

fn spec(root: &Path, script: &str) -> SpawnSpec {
    SpawnSpec {
        executable: powershell(),
        cwd: root.to_owned(),
        args: ["-NoProfile", "-NonInteractive", "-Command", script]
            .into_iter()
            .map(Into::into)
            .collect(),
        env: explicit_environment(),
    }
}

fn receipt_bytes(file: &mut File) -> Vec<u8> {
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0)).unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    bytes
}

#[test]
fn original_private_receipt_confirms_natural_target_terminal_only() {
    let root = tempfile::tempdir().unwrap();
    let mut file = private_receipt(&root.path().join("cleanup"));
    let mut child = SupervisedChild::spawn_with_cleanup_receipt(
        spec(root.path(), "Start-Sleep -Milliseconds 100; exit 7"),
        &file,
        &supervisor(),
    )
    .unwrap();
    let status = child
        .wait_with_timeout(Duration::from_secs(10))
        .unwrap()
        .expect("original helper terminal");
    assert_eq!(status.code(), Some(7));
    assert_eq!(receipt_bytes(&mut file), CONFIRMED);
}

#[test]
fn kill_keeps_receipt_owner_alive_until_owned_job_is_empty() {
    let root = tempfile::tempdir().unwrap();
    let mut file = private_receipt(&root.path().join("cleanup"));
    let pid_file = root.path().join("descendant.pid");
    let script = format!(
        "$p=Start-Process -FilePath '{}' -ArgumentList @('-NoProfile','-NonInteractive','-Command','while($true){{Start-Sleep -Milliseconds 50}}') -PassThru;$p.Id|Set-Content -LiteralPath '{}';while($true){{Start-Sleep -Milliseconds 50}}",
        powershell().to_string_lossy().replace('\'', "''"),
        pid_file.to_string_lossy().replace('\'', "''")
    );
    let mut peer = OwnedTestProcess(
        Command::new(powershell())
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "while($true){Start-Sleep -Milliseconds 50}",
            ])
            .spawn()
            .unwrap(),
    );
    let mut child = SupervisedChild::spawn_with_cleanup_receipt(
        spec(root.path(), &script),
        &file,
        &supervisor(),
    )
    .unwrap();
    wait_until(Duration::from_secs(10), || pid_file.exists());
    let pid = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    let handle = unsafe { OpenProcess(SYNCHRONIZE_ACCESS, 0, pid) };
    assert!(!handle.is_null(), "capture live descendant kernel identity");
    let descendant = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle) };
    assert_eq!(file.metadata().unwrap().len(), 0);
    assert!(
        child
            .kill_and_wait(Duration::from_secs(10))
            .unwrap()
            .is_some()
    );
    assert_eq!(receipt_bytes(&mut file), CONFIRMED);
    assert_eq!(
        unsafe {
            WaitForSingleObject(
                std::os::windows::io::AsRawHandle::as_raw_handle(&descendant),
                0,
            )
        },
        WAIT_OBJECT_0
    );
    assert!(
        peer.try_wait().unwrap().is_none(),
        "peer outside the original Job must survive"
    );
}

#[test]
fn readonly_and_nonempty_files_cannot_start_a_receipt_owner() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("cleanup");
    let mut file = private_receipt(&path);
    let readonly = File::open(&path).unwrap();
    assert!(
        SupervisedChild::spawn_with_cleanup_receipt(
            spec(root.path(), "exit 0"),
            &readonly,
            &supervisor()
        )
        .is_err()
    );
    file.write_all(b"not-empty").unwrap();
    file.sync_all().unwrap();
    assert!(
        SupervisedChild::spawn_with_cleanup_receipt(
            spec(root.path(), "exit 0"),
            &file,
            &supervisor()
        )
        .is_err()
    );
}

#[test]
#[ignore = "private child entry for the actual host-crash test"]
fn host_process_for_real_crash_probe() {
    let Some(root) = std::env::var_os("KCODER_TEST_RECEIPT_HOST_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let file = OpenOptions::new()
        .access_mode(FILE_ALL_ACCESS)
        .open(root.join("cleanup"))
        .unwrap();
    let mut child = SupervisedChild::spawn_with_cleanup_receipt(
        spec(&root, "while($true){Start-Sleep -Milliseconds 50}"),
        &file,
        &supervisor(),
    )
    .unwrap();
    std::fs::write(root.join("ready"), child.target_pid().to_string()).unwrap();
    loop {
        std::thread::sleep(Duration::from_millis(50));
        assert!(child.try_wait().unwrap().is_none());
    }
}

#[test]
fn actual_host_kill_leaves_original_owner_to_confirm_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let mut file = private_receipt(&root.path().join("cleanup"));
    let mut host = OwnedTestProcess(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "cleanup_receipt::host_process_for_real_crash_probe",
                "--nocapture",
            ])
            .env("KCODER_TEST_RECEIPT_HOST_ROOT", root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    wait_until(Duration::from_secs(10), || {
        root.path().join("ready").exists()
    });
    assert_eq!(file.metadata().unwrap().len(), 0);
    host.kill().unwrap();
    host.wait().unwrap();
    wait_until(Duration::from_secs(10), || {
        file.metadata().unwrap().len() == CONFIRMED.len() as u64
    });
    assert_eq!(receipt_bytes(&mut file), CONFIRMED);
}

#[test]
fn terminating_the_outer_job_never_fabricates_cleanup_confirmation() {
    use kcoder_process_supervisor::suspended_child::{SUSPENDED_CHILD_FLAGS, SuspendedChildJob};
    use std::os::windows::{io::AsHandle, process::CommandExt};

    let root = tempfile::tempdir().unwrap();
    let mut file = private_receipt(&root.path().join("cleanup"));
    let mut outer_job = SuspendedChildJob::new().unwrap();
    let mut host = OwnedTestProcess(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "cleanup_receipt::host_process_for_real_crash_probe",
                "--nocapture",
            ])
            .env("KCODER_TEST_RECEIPT_HOST_ROOT", root.path())
            .creation_flags(SUSPENDED_CHILD_FLAGS)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    outer_job.assign_and_resume(host.as_handle()).unwrap();
    wait_until(Duration::from_secs(10), || {
        root.path().join("ready").exists()
    });
    assert_eq!(file.metadata().unwrap().len(), 0);
    outer_job.terminate().unwrap();
    host.wait().unwrap();
    let exit = outer_job.exit_handle();
    wait_until(Duration::from_secs(10), || exit.is_empty().unwrap());
    assert!(
        receipt_bytes(&mut file).is_empty(),
        "an outer Job can kill the writer; target absence is not its receipt"
    );
}
