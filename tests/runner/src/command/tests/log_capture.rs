#[test]
fn streaming_capture_redacts_a_secret_split_across_reads() {
    let temporary = tempfile::tempdir().unwrap();
    let mut context = RunContext::create(
        temporary.path(),
        RunMetadata::new("streaming-log", TestTier::Unit, ModelPolicy::Forbidden),
    )
    .unwrap();
    context.register_secret("secret-value").unwrap();
    let stdout = context.root().join("stdout.log");
    let stderr = context.root().join("stderr.log");
    let mut capture = LogCapture::start(
        context.streaming_redactor(),
        ChunkReader::new([b"token=secret-".as_slice(), b"value\n".as_slice()]),
        &stdout,
        context.streaming_redactor(),
        ChunkReader::new([b"safe".as_slice()]),
        &stderr,
    )
    .unwrap();
    capture.finalize().unwrap();

    assert_eq!(fs::read_to_string(stdout).unwrap(), "token=[REDACTED]\n");
    assert_eq!(fs::read_to_string(stderr).unwrap(), "safe");
}

#[test]
fn log_worker_initialization_rolls_back_before_starting_threads() {
    let temporary = tempfile::tempdir().unwrap();
    let mut context = RunContext::create(
        temporary.path(),
        RunMetadata::new("log-init-rollback", TestTier::Unit, ModelPolicy::Forbidden),
    )
    .unwrap();
    context.register_secret("worker-secret-value").unwrap();
    let stdout = temporary.path().join("stdout.log");
    let stderr = temporary.path().join("stderr.log");
    fs::create_dir(&stderr).unwrap();

    let error = LogCapture::start(
        context.streaming_redactor(),
        std::io::Cursor::new(b"worker-secret-value"),
        &stdout,
        context.streaming_redactor(),
        std::io::Cursor::new(b"safe"),
        &stderr,
    )
    .unwrap_err();

    assert!(error.to_string().contains("创建 suite 日志失败"));
    assert!(!stdout.exists());
}

#[cfg(unix)]
#[test]
fn forced_process_tree_termination_still_finalizes_redacted_logs() {
    let temporary = tempfile::tempdir().unwrap();
    let mut context = RunContext::create(
        temporary.path(),
        RunMetadata::new("forced-log", TestTier::Unit, ModelPolicy::Forbidden),
    )
    .unwrap();
    context.register_secret("forced-secret-value").unwrap();
    let stdout_path = context.root().join("forced-stdout.log");
    let stderr_path = context.root().join("forced-stderr.log");
    let mut command = Command::new("sh");
    command
        .args(["-c", "trap '' TERM; printf 'forced-secret-'; sleep 0.05; printf 'value'; while :; do sleep 1; done"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut process = OwnedProcess::spawn_inherit_environment(&mut command).unwrap();
    let stdout = process.take_stdout().unwrap();
    let stderr = process.take_stderr().unwrap();
    let mut capture = LogCapture::start(
        context.streaming_redactor(),
        stdout,
        &stdout_path,
        context.streaming_redactor(),
        stderr,
        &stderr_path,
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(100));
    process.terminate(Duration::from_millis(50)).unwrap();
    capture.finalize().unwrap();

    assert_eq!(fs::read_to_string(stdout_path).unwrap(), "[REDACTED]");
}

struct ChunkReader {
    chunks: std::collections::VecDeque<Vec<u8>>,
}

impl ChunkReader {
    fn new<'a>(chunks: impl IntoIterator<Item = &'a [u8]>) -> Self {
        Self {
            chunks: chunks.into_iter().map(<[u8]>::to_vec).collect(),
        }
    }
}

impl Read for ChunkReader {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let Some(chunk) = self.chunks.pop_front() else {
            return Ok(0);
        };
        output[..chunk.len()].copy_from_slice(&chunk);
        Ok(chunk.len())
    }
}
