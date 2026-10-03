#![cfg(windows)]

use kcoder_process_supervisor::client::{SpawnSpec, SupervisedChild};
use kcoder_process_supervisor::protocol::{PROTOCOL_VERSION, SpawnRequest};
use serde_json::json;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};

const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;

fn supervisor() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kcoder-process-supervisor"))
}

fn powershell() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot must be set"))
        .join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
}

fn explicit_environment() -> BTreeMap<OsString, OsString> {
    std::env::vars_os().collect()
}

fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if condition() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(condition(), "condition did not become true before timeout");
}

fn process_has_exited(pid: u32) -> bool {
    let handle = unsafe { OpenProcess(SYNCHRONIZE_ACCESS, 0, pid) };
    if handle.is_null() {
        return true;
    }
    let exited = unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0;
    unsafe { CloseHandle(handle) };
    exited
}

fn wait_ready(status_file: &Path, nonce: &str) -> u32 {
    let mut pid = None;
    wait_until(Duration::from_secs(10), || {
        let Ok(file) = std::fs::File::open(status_file) else {
            return false;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if value["event"] == "READY" && value["nonce"] == nonce {
                pid = value["pid"]
                    .as_u64()
                    .and_then(|value| u32::try_from(value).ok());
                return pid.is_some();
            }
        }
        false
    });
    pid.expect("READY must contain a target pid")
}

fn status_events(path: &Path) -> Vec<serde_json::Value> {
    let file = std::fs::File::open(path).expect("status file");
    BufReader::new(file)
        .lines()
        .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
        .collect()
}

fn launch_without_start(
    script: &str,
    status_file: &Path,
    nonce: &str,
    extra_env: &[(&str, &str)],
) -> (Child, std::process::ChildStdin) {
    let mut env = std::env::vars().collect::<BTreeMap<_, _>>();
    env.extend(
        extra_env
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned())),
    );
    let request = SpawnRequest {
        version: PROTOCOL_VERSION,
        nonce: nonce.to_owned(),
        executable: powershell().to_string_lossy().into_owned(),
        cwd: std::env::current_dir()
            .expect("current directory")
            .to_string_lossy()
            .into_owned(),
        status_file: status_file.to_string_lossy().into_owned(),
        args: vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            script.into(),
        ],
        env,
    };
    let mut child = Command::new(supervisor())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("launch supervisor");
    let mut stdin = child.stdin.take().expect("supervisor stdin");
    serde_json::to_writer(&mut stdin, &request).expect("serialize spawn request");
    stdin.write_all(b"\n").expect("write spawn request");
    stdin.flush().expect("flush spawn request");
    (child, stdin)
}

fn send_start(stdin: &mut std::process::ChildStdin, nonce: &str) {
    serde_json::to_writer(
        &mut *stdin,
        &json!({"command":"START","version":PROTOCOL_VERSION,"nonce":nonce}),
    )
    .unwrap();
    stdin.write_all(b"\n").unwrap();
    stdin.flush().unwrap();
}

#[test]
fn ready_precedes_execution_and_streams_are_target_owned() {
    let root = tempfile::Builder::new()
        .prefix("kcoder-supervisor-")
        .tempdir()
        .expect("temporary directory");
    let unicode_root = root.path().join("昆仑 workspace");
    std::fs::create_dir(&unicode_root).expect("unicode directory");
    let marker = unicode_root.join("started.txt");
    let status = unicode_root.join("status.jsonl");
    let marker_text = marker.to_string_lossy().into_owned();
    let nonce = "ready-before-start";
    let (child, mut stdin) = launch_without_start(
        "Set-Content -LiteralPath $env:KCODER_MARKER -Value started; [Console]::Out.Write('TARGET_STDOUT'); [Console]::Error.Write('TARGET_STDERR'); exit 37",
        &status,
        nonce,
        &[("KCODER_MARKER", &marker_text)],
    );
    wait_ready(&status, nonce);
    assert!(!marker.exists(), "target executed before START");
    serde_json::to_writer(
        &mut stdin,
        &json!({"command":"START","version":PROTOCOL_VERSION,"nonce":nonce}),
    )
    .expect("serialize START");
    stdin.write_all(b"\n").expect("write START");
    let output = child.wait_with_output().expect("wait for supervisor");
    assert_eq!(output.status.code(), Some(37));
    assert_eq!(String::from_utf8(output.stdout).unwrap(), "TARGET_STDOUT");
    assert_eq!(String::from_utf8(output.stderr).unwrap(), "TARGET_STDERR");
    assert!(marker.exists());
    drop(stdin);
    let events = status_events(&status);
    assert_eq!(events.last().unwrap()["event"], "EXIT");
    assert_eq!(events.last().unwrap()["code"], 37);
}

#[test]
fn unicode_environment_and_large_output_round_trip() {
    let mut env = explicit_environment();
    env.insert("KCODER_UNICODE".into(), "你好 昆仑".into());
    let spec = SpawnSpec {
        executable: powershell(),
        cwd: std::env::current_dir().unwrap(),
        args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Out.Write($env:KCODER_UNICODE + \"`n\" + ('x' * 262144))",
        ]
        .into_iter()
        .map(OsString::from)
        .collect(),
        env,
    };
    let mut child = SupervisedChild::spawn(spec, &supervisor()).expect("spawn supervised process");
    let mut stdout = child.take_stdout().expect("stdout");
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).unwrap();
        bytes
    });
    assert!(child.wait().expect("wait").success());
    let stdout = String::from_utf8(reader.join().unwrap()).unwrap();
    assert!(stdout.starts_with("你好 昆仑\n"));
    assert_eq!(stdout.bytes().filter(|byte| *byte == b'x').count(), 262_144);
}

#[test]
fn kill_is_idempotent_and_terminates_descendants_only() {
    let root = tempfile::tempdir().unwrap();
    let pid_file = root.path().join("nested.pid");
    let pid_file_text = pid_file.to_string_lossy().into_owned();
    let mut env = explicit_environment();
    env.insert("KCODER_NESTED_PID".into(), pid_file_text.into());
    let spec = SpawnSpec {
        executable: powershell(),
        cwd: std::env::current_dir().unwrap(),
        args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$nested = Start-Process powershell.exe -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60' -PassThru; Set-Content -LiteralPath $env:KCODER_NESTED_PID -Value $nested.Id; Start-Sleep -Seconds 60",
        ]
        .into_iter()
        .map(OsString::from)
        .collect(),
        env,
    };
    let mut unrelated = Command::new(powershell())
        .args([
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "Start-Sleep -Seconds 60",
        ])
        .spawn()
        .unwrap();
    let unrelated_pid = unrelated.id();
    let mut child = SupervisedChild::spawn(spec, &supervisor()).expect("spawn process tree");
    let leader_pid = child.target_pid();
    wait_until(Duration::from_secs(10), || pid_file.exists());
    let nested_pid = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    child.kill().expect("first KILL");
    child.kill().expect("repeated KILL");
    let _ = child.wait();
    wait_until(Duration::from_secs(10), || {
        process_has_exited(leader_pid) && process_has_exited(nested_pid)
    });
    assert!(!process_has_exited(unrelated_pid));
    unrelated.kill().unwrap();
    unrelated.wait().unwrap();
}

#[test]
fn invalid_start_nonce_never_resumes_target() {
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("must-not-exist.txt");
    let status = root.path().join("status.jsonl");
    let marker_text = marker.to_string_lossy().into_owned();
    let nonce = "expected-nonce";
    let (mut child, mut stdin) = launch_without_start(
        "Set-Content -LiteralPath $env:KCODER_MARKER -Value unexpected",
        &status,
        nonce,
        &[("KCODER_MARKER", &marker_text)],
    );
    let target_pid = wait_ready(&status, nonce);
    serde_json::to_writer(
        &mut stdin,
        &json!({"command":"START","version":PROTOCOL_VERSION,"nonce":"wrong-nonce"}),
    )
    .unwrap();
    stdin.write_all(b"\n").unwrap();
    drop(stdin);
    assert!(!child.wait().unwrap().success());
    wait_until(Duration::from_secs(10), || process_has_exited(target_pid));
    assert!(!marker.exists());
    wait_until(Duration::from_secs(5), || {
        status_events(&status)
            .iter()
            .any(|event| event["event"] == "ERROR")
    });
}

#[test]
fn exact_environment_honors_env_clear_and_inherited_override_is_case_insensitive() {
    const SECRET: &str = "KCODER_SUPERVISOR_UNRELATED_SECRET_7A21";
    unsafe { std::env::set_var(SECRET, "must-not-leak") };
    let mut command = Command::new(powershell());
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "if ($env:KCODER_SUPERVISOR_UNRELATED_SECRET_7A21) { exit 91 }; [Console]::Out.Write($env:ONLY_VALUE)",
        ])
        .current_dir(std::env::current_dir().unwrap())
        .env_clear()
        .env("ONLY_VALUE", "exact");
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", system_root);
    }
    let spec = SpawnSpec::from_command_exact_environment(&command).unwrap();
    assert!(!spec.env.keys().any(|name| name == SECRET));
    let mut child = SupervisedChild::spawn(spec, &supervisor()).unwrap();
    let mut stdout = child.take_stdout().unwrap();
    let reader = std::thread::spawn(move || {
        let mut output = String::new();
        stdout.read_to_string(&mut output).unwrap();
        output
    });
    assert!(child.wait().unwrap().success());
    assert_eq!(reader.join().unwrap(), "exact");

    let mut inherited = Command::new(powershell());
    inherited.env("Path", "case-insensitive-override");
    let spec = SpawnSpec::from_command_inherit_environment(&inherited).unwrap();
    let path_entries = spec
        .env
        .iter()
        .filter(|(name, _)| name.to_string_lossy().eq_ignore_ascii_case("PATH"))
        .collect::<Vec<_>>();
    assert_eq!(path_entries.len(), 1);
    assert_eq!(path_entries[0].1, "case-insensitive-override");
    unsafe { std::env::remove_var(SECRET) };
}

#[test]
fn abrupt_supervisor_death_closes_job_and_kills_target() {
    let root = tempfile::tempdir().unwrap();
    let nested_file = root.path().join("nested.pid");
    let nested_text = nested_file.to_string_lossy().into_owned();
    let status = root.path().join("status.jsonl");
    let nonce = "abrupt-helper-death";
    let (mut helper, mut stdin) = launch_without_start(
        "$nested = Start-Process powershell.exe -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60' -PassThru; Set-Content -LiteralPath $env:KCODER_NESTED_PID -Value $nested.Id; Start-Sleep -Seconds 60",
        &status,
        nonce,
        &[("KCODER_NESTED_PID", &nested_text)],
    );
    let target_pid = wait_ready(&status, nonce);
    send_start(&mut stdin, nonce);
    wait_until(Duration::from_secs(10), || nested_file.exists());
    let nested_pid = std::fs::read_to_string(&nested_file)
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    helper.kill().expect("abruptly terminate raw helper");
    helper.wait().unwrap();
    wait_until(Duration::from_secs(10), || {
        process_has_exited(target_pid) && process_has_exited(nested_pid)
    });
}

#[test]
fn closing_control_stdin_kills_the_entire_running_job() {
    let root = tempfile::tempdir().unwrap();
    let nested_file = root.path().join("nested.pid");
    let nested_text = nested_file.to_string_lossy().into_owned();
    let status = root.path().join("status.jsonl");
    let nonce = "control-eof";
    let (mut helper, mut stdin) = launch_without_start(
        "$nested = Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; Set-Content -LiteralPath $env:KCODER_NESTED_PID -Value $nested.Id; Start-Sleep -Seconds 60",
        &status,
        nonce,
        &[("KCODER_NESTED_PID", &nested_text)],
    );
    let target_pid = wait_ready(&status, nonce);
    send_start(&mut stdin, nonce);
    wait_until(Duration::from_secs(10), || nested_file.exists());
    let nested_pid = std::fs::read_to_string(&nested_file)
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    drop(stdin);
    helper.wait().unwrap();
    wait_until(Duration::from_secs(10), || {
        process_has_exited(target_pid) && process_has_exited(nested_pid)
    });
}

#[test]
fn leader_exit_does_not_finish_helper_while_a_descendant_survives() {
    let root = tempfile::tempdir().unwrap();
    let nested_file = root.path().join("nested.pid");
    let nested_text = nested_file.to_string_lossy().into_owned();
    let status = root.path().join("status.jsonl");
    let nonce = "leader-first";
    let (mut helper, mut stdin) = launch_without_start(
        "$nested = Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; Set-Content -LiteralPath $env:KCODER_NESTED_PID -Value $nested.Id",
        &status,
        nonce,
        &[("KCODER_NESTED_PID", &nested_text)],
    );
    let leader_pid = wait_ready(&status, nonce);
    send_start(&mut stdin, nonce);
    wait_until(Duration::from_secs(10), || nested_file.exists());
    let nested_pid = std::fs::read_to_string(&nested_file)
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    wait_until(Duration::from_secs(10), || process_has_exited(leader_pid));
    assert!(helper.try_wait().unwrap().is_none());
    assert!(!process_has_exited(nested_pid));
    serde_json::to_writer(
        &mut stdin,
        &json!({"command":"KILL","version":PROTOCOL_VERSION,"nonce":nonce}),
    )
    .unwrap();
    stdin.write_all(b"\n").unwrap();
    helper.wait().unwrap();
    wait_until(Duration::from_secs(10), || process_has_exited(nested_pid));
}

#[test]
fn kill_catches_descendants_spawned_in_a_bounded_burst() {
    let root = tempfile::tempdir().unwrap();
    let pids_file = root.path().join("nested-pids.txt");
    let pids_text = pids_file.to_string_lossy().into_owned();
    let status = root.path().join("status.jsonl");
    let nonce = "descendant-burst";
    let (mut helper, mut stdin) = launch_without_start(
        "$pids = 1..8 | ForEach-Object { (Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru).Id }; Set-Content -LiteralPath $env:KCODER_NESTED_PIDS -Value $pids; Start-Sleep -Seconds 60",
        &status,
        nonce,
        &[("KCODER_NESTED_PIDS", &pids_text)],
    );
    let leader_pid = wait_ready(&status, nonce);
    send_start(&mut stdin, nonce);
    wait_until(Duration::from_secs(15), || pids_file.exists());
    let nested_pids = std::fs::read_to_string(&pids_file)
        .unwrap()
        .lines()
        .map(|line| line.trim().parse::<u32>().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(nested_pids.len(), 8);
    drop(stdin);
    helper.wait().unwrap();
    wait_until(Duration::from_secs(10), || {
        process_has_exited(leader_pid) && nested_pids.iter().all(|pid| process_has_exited(*pid))
    });
}

#[test]
fn chromium_can_be_started_and_killed_without_a_post_spawn_race() {
    let chrome = [
        PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    ]
    .into_iter()
    .find(|path| path.is_file());
    let Some(chrome) = chrome else {
        eprintln!("Chrome is not installed; skipping local Chromium smoke");
        return;
    };
    let profile = tempfile::tempdir().unwrap();
    let spec = SpawnSpec {
        executable: chrome,
        cwd: std::env::current_dir().unwrap(),
        args: vec![
            "--headless=new".into(),
            "--disable-gpu".into(),
            "--no-first-run".into(),
            "--remote-debugging-port=0".into(),
            format!("--user-data-dir={}", profile.path().display()).into(),
            "about:blank".into(),
        ],
        env: explicit_environment(),
    };
    let mut child = SupervisedChild::spawn(spec, &supervisor()).unwrap();
    let target_pid = child.target_pid();
    assert!(!process_has_exited(target_pid));
    child.kill().unwrap();
    let _ = child.wait();
    wait_until(Duration::from_secs(10), || process_has_exited(target_pid));
}

#[test]
fn ready_timeout_and_repeated_spawn_kill_cycles_are_bounded() {
    let spec = SpawnSpec {
        executable: powershell(),
        cwd: std::env::current_dir().unwrap(),
        args: Vec::new(),
        env: explicit_environment(),
    };
    let error =
        SupervisedChild::spawn_with_timeout(spec, &powershell(), Duration::from_millis(100))
            .err()
            .expect("a non-supervisor executable must not produce READY");
    assert!(
        error
            .to_string()
            .contains("timed out waiting for supervisor READY")
    );

    for _ in 0..12 {
        let spec = SpawnSpec {
            executable: powershell(),
            cwd: std::env::current_dir().unwrap(),
            args: [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ]
            .into_iter()
            .map(OsString::from)
            .collect(),
            env: explicit_environment(),
        };
        let mut child = SupervisedChild::spawn(spec, &supervisor()).unwrap();
        let target_pid = child.target_pid();
        assert!(
            child
                .kill_and_wait(Duration::from_secs(5))
                .unwrap()
                .is_some()
        );
        wait_until(Duration::from_secs(5), || process_has_exited(target_pid));
    }
}

#[test]
fn embedded_run_joins_control_owner_before_input_closes() {
    let root = tempfile::tempdir().unwrap();
    let status = root.path().join("embedded-status.jsonl");
    let nonce = "embedded-control-owner";
    let mut read_handle = std::ptr::null_mut();
    let mut write_handle = std::ptr::null_mut();
    assert_ne!(
        unsafe { CreatePipe(&mut read_handle, &mut write_handle, std::ptr::null(), 0) },
        0
    );
    let reader = unsafe { std::fs::File::from_raw_handle(read_handle as RawHandle) };
    let mut writer = unsafe { std::fs::File::from_raw_handle(write_handle as RawHandle) };
    serde_json::to_writer(
        &mut writer,
        &json!({"command":"START","version":PROTOCOL_VERSION,"nonce":nonce}),
    )
    .unwrap();
    writer.write_all(b"\n").unwrap();
    writer.flush().unwrap();

    let request = SpawnRequest {
        version: PROTOCOL_VERSION,
        nonce: nonce.into(),
        executable: powershell().to_string_lossy().into_owned(),
        cwd: std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        status_file: status.to_string_lossy().into_owned(),
        args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "exit 23",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect(),
        env: std::env::vars().collect(),
    };
    let exit_code = kcoder_process_supervisor::windows::run(request, BufReader::new(reader))
        .expect("embedded supervisor run");
    assert_eq!(exit_code, 23);
    let events = status_events(&status);
    assert_eq!(events.last().unwrap()["event"], "EXIT");
    assert_eq!(events.last().unwrap()["code"], 23);

    // run stopped and joined the control thread that solely owned the duplicated Job
    // handle. Closing input afterward can only exit the handle-less reader and cannot touch the released Job again.
    let _ = writer.write_all(b"not-json\n");
    drop(writer);
    std::thread::sleep(Duration::from_millis(50));
}
