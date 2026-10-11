use kcoder_test_harness::OwnedProcess;
use std::process::Command;
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
#[test]
fn owned_process_waits_for_normal_exit() {
    let mut command = Command::new("sh");
    command.args(["-c", "exit 0"]);
    let process = OwnedProcess::spawn_inherit_environment(&mut command).unwrap();
    let status = process.wait().unwrap();
    assert!(status.success());
}

#[cfg(windows)]
#[test]
fn owned_process_waits_for_normal_exit() {
    let mut command = Command::new("cmd");
    command.args(["/C", "exit", "0"]);
    let process = OwnedProcess::spawn_inherit_environment(&mut command).unwrap();
    let status = process.wait().unwrap();
    assert!(status.success());
}

#[cfg(unix)]
#[test]
fn owned_process_terminates_its_dedicated_process_group() {
    let temporary = tempfile::tempdir().unwrap();
    let child_pid_path = temporary.path().join("child.pid");
    let script = format!(
        "sleep 60 & child=$!; printf '%s' \"$child\" > '{}'; wait",
        child_pid_path.display()
    );
    let mut command = Command::new("sh");
    command.args(["-c", &script]);
    let mut process = OwnedProcess::spawn_inherit_environment(&mut command).unwrap();
    for _ in 0..100 {
        if child_pid_path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let child_pid: i32 = std::fs::read_to_string(&child_pid_path)
        .unwrap()
        .parse()
        .unwrap();

    let status = process.terminate(Duration::from_millis(200)).unwrap();
    assert!(status.is_some());
    for _ in 0..100 {
        let result = unsafe { libc::kill(child_pid, 0) };
        if result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("进程组中的子进程仍然存活: {child_pid}");
}

#[cfg(unix)]
#[test]
fn owned_process_cleans_descendant_after_leader_exits_first() {
    let temporary = tempfile::tempdir().unwrap();
    let child_pid_path = temporary.path().join("child.pid");
    let script = format!(
        "sh -c 'trap \"\" TERM; while :; do sleep 1; done' & child=$!; printf '%s' \"$child\" > '{}'; exit 0",
        child_pid_path.display()
    );
    let mut command = Command::new("sh");
    command.args(["-c", &script]);
    let mut process = OwnedProcess::spawn_inherit_environment(&mut command).unwrap();
    for _ in 0..100 {
        if child_pid_path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let child_pid: i32 = std::fs::read_to_string(&child_pid_path)
        .unwrap()
        .parse()
        .unwrap();
    std::thread::sleep(Duration::from_millis(50));

    assert!(
        process.try_wait().unwrap().is_none(),
        "后代存活时不能报告进程树结束"
    );
    let status = process.terminate(Duration::from_millis(100)).unwrap();
    assert!(status.unwrap().success());
    assert_process_gone(child_pid);
}

#[cfg(unix)]
#[test]
fn owned_process_drop_is_a_bounded_fallback() {
    let pid = {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 60"]);
        let process = OwnedProcess::spawn_inherit_environment(&mut command).unwrap();
        let pid = process.pid();
        drop(process);
        pid
    };
    let pid = i32::try_from(pid).unwrap();
    let result = unsafe { libc::kill(pid, 0) };
    assert!(result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH));
}

#[cfg(unix)]
fn assert_process_gone(pid: i32) {
    for _ in 0..200 {
        let result = unsafe { libc::kill(pid, 0) };
        if result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("进程仍然存活: {pid}");
}
