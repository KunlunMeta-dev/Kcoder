#[test]
fn spawn_error_leaves_only_empty_logs() {
    let temporary = tempfile::tempdir().unwrap();
    let context = RunContext::create(
        temporary.path().join("runs"),
        RunMetadata::new("spawn-error", TestTier::Unit, ModelPolicy::Forbidden),
    )
    .unwrap();
    let suite = test_suite(vec!["definitely-not-a-real-kcoder-test-command".to_string()]);
    assert!(run_suite(temporary.path(), &context, &suite, &Consent::default()).is_err());
    let logs = context.case_path(&suite.id, "logs").unwrap();
    assert_eq!(fs::read(logs.join("stdout.log")).unwrap(), b"");
    assert_eq!(fs::read(logs.join("stderr.log")).unwrap(), b"");
}

#[test]
fn successful_suite_artifact_contract_requires_nested_evidence_file() {
    let temporary = tempfile::tempdir().unwrap();
    let contract = vec![PathBuf::from("assertions.json")];

    assert!(verify_required_artifacts(Some(temporary.path()), &contract).is_err());

    let nested = temporary.path().join("2026-07-30").join("run-startup");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("assertions.json"), b"{\"ok\":true}").unwrap();
    verify_required_artifacts(Some(temporary.path()), &contract).unwrap();
}

#[cfg(unix)]
#[test]
fn log_worker_failure_stops_process_tree_before_joining_remaining_workers() {
    let temporary = tempfile::tempdir().unwrap();
    let context = RunContext::create(
        temporary.path(),
        RunMetadata::new("log-worker-failure", TestTier::Unit, ModelPolicy::Forbidden),
    )
    .unwrap();
    let stdout_path = temporary.path().join("worker-stdout.log");
    let stderr_path = temporary.path().join("worker-stderr.log");
    let mut command = Command::new("sh");
    command
        .args(["-c", "trap '' TERM; while :; do sleep 1; done"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let process = OwnedProcess::spawn_inherit_environment(&mut command).unwrap();
    let pid = process.pid();
    let logs = LogCapture::start(
        context.streaming_redactor(),
        FailingReader,
        &stdout_path,
        context.streaming_redactor(),
        std::io::Cursor::new(Vec::<u8>::new()),
        &stderr_path,
    )
    .unwrap();
    let mut execution = SuiteExecution::new(process, logs);
    let mut progress = SuiteRunProgress {
        stage: "wait",
        executed: true,
        cleanup: Vec::new(),
    };

    let deadline = Instant::now() + Duration::from_secs(2);
    let error = loop {
        match execution.poll_log_workers(&mut progress) {
            Ok(()) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(()) => panic!("日志 worker 失败没有被执行 owner 观察到"),
            Err(error) => break error,
        }
    };

    assert!(
        format!("{error:#}").contains("测试注入的日志读取失败"),
        "意外错误: {error:#}"
    );
    let failure = suite_run_error(error, 10, Instant::now(), &progress);
    assert!(failure.executed);
    assert_eq!(failure.stage, "poll-log-capture");
    assert_eq!(failure.started_at_ms, 10);
    assert!(failure
        .cleanup
        .iter()
        .any(|fact| fact == "process-tree-terminated"));
    assert!(failure
        .cleanup
        .iter()
        .any(|fact| fact == "process-ownership-released"));
    assert!(failure.cleanup.iter().any(|fact| {
        fact == "log-capture-finalized" || fact.starts_with("log-capture-finalization-failed:")
    }));
    let probe = Command::new("sh")
        .args(["-c", &format!("! kill -0 -- -{pid} 2>/dev/null")])
        .status()
        .unwrap();
    assert!(probe.success(), "日志失败后不应遗留 suite 进程组 {pid}");
}

#[cfg(unix)]
struct FailingReader;

#[cfg(unix)]
impl Read for FailingReader {
    fn read(&mut self, _output: &mut [u8]) -> std::io::Result<usize> {
        Err(std::io::Error::other("测试注入的日志读取失败"))
    }
}
