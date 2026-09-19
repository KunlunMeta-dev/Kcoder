use crate::consent::Consent;
use crate::matrix::Suite;
use crate::report::SuiteOutcome;
use crate::summary::verify_summary;
use anyhow::{Context, Result};
use kcoder_test_harness::{OwnedProcess, RunContext};
use std::fs::{self, File};
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

mod environment;
mod log_capture;
mod prerequisite;

use environment::configure_environment;
use log_capture::LogCapture;
use prerequisite::prerequisites;

#[derive(Debug)]
pub struct SuiteRunError {
    pub source: anyhow::Error,
    pub started_at_ms: u64,
    pub duration_ms: u128,
    pub stage: &'static str,
    pub executed: bool,
    pub cleanup: Vec<String>,
}

impl std::fmt::Display for SuiteRunError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {:#}", self.stage, self.source)
    }
}

impl std::error::Error for SuiteRunError {}

struct SuiteRunProgress {
    stage: &'static str,
    executed: bool,
    cleanup: Vec<String>,
}

pub fn run_suite(
    root: &Path,
    context: &RunContext,
    suite: &Suite,
    consent: &Consent,
) -> std::result::Result<SuiteOutcome, SuiteRunError> {
    let started_at_ms = unix_millis();
    let started = Instant::now();
    let mut progress = SuiteRunProgress {
        stage: "prerequisite",
        executed: false,
        cleanup: Vec::new(),
    };
    run_suite_inner(root, context, suite, consent, &mut progress)
        .map_err(|source| suite_run_error(source, started_at_ms, started, &progress))
}

fn suite_run_error(
    source: anyhow::Error,
    started_at_ms: u64,
    started: Instant,
    progress: &SuiteRunProgress,
) -> SuiteRunError {
    SuiteRunError {
        source,
        started_at_ms,
        duration_ms: started.elapsed().as_millis(),
        stage: progress.stage,
        executed: progress.executed,
        cleanup: progress.cleanup.clone(),
    }
}

fn run_suite_inner(
    root: &Path,
    context: &RunContext,
    suite: &Suite,
    consent: &Consent,
    progress: &mut SuiteRunProgress,
) -> Result<SuiteOutcome> {
    let mut unmet = prerequisites(root, suite);
    if let Err(error) = consent.require(suite.consent.as_deref(), suite.consent_env.as_deref()) {
        unmet.push(error.to_string());
    }
    if !unmet.is_empty() {
        return Ok(SuiteOutcome::UnmetPrerequisite {
            id: suite.id.clone(),
            reasons: unmet,
        });
    }

    progress.stage = "prepare-evidence";
    let case_dir = context.case_path(&suite.id, "logs")?;
    fs::create_dir_all(&case_dir)?;
    let domain_artifacts = suite
        .command
        .iter()
        .any(|part| part == "{artifact_dir}")
        .then(|| context.case_path(&suite.id, "artifacts"))
        .transpose()?;
    if let Some(path) = &domain_artifacts {
        fs::create_dir_all(path)?;
    }
    let stdout_path = case_dir.join("stdout.log");
    let stderr_path = case_dir.join("stderr.log");
    File::create(&stdout_path)?;
    File::create(&stderr_path)?;
    let cwd = suite.cwd.as_ref().map_or_else(
        || Ok(root.to_path_buf()),
        |path| contained_directory(root, path),
    )?;
    let argv = suite
        .command
        .iter()
        .map(|part| {
            if part == "{artifact_dir}" {
                domain_artifacts
                    .as_ref()
                    .expect("artifact placeholder 必须分配领域目录")
                    .to_string_lossy()
                    .into_owned()
            } else {
                part.clone()
            }
        })
        .collect::<Vec<_>>();
    progress.stage = "prepare-command";
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .current_dir(cwd)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_environment(&mut command, context, suite)?;

    let started = Instant::now();
    progress.stage = "spawn";
    let mut process = OwnedProcess::spawn_exact_environment(&mut command)
        .with_context(|| format!("启动 suite {} 失败", suite.id))?;
    progress.executed = true;
    progress.stage = "take-stdout";
    let stdout = match process.take_stdout().context("suite stdout pipe 不可用") {
        Ok(stdout) => stdout,
        Err(error) => {
            cleanup_spawned_process(process, progress);
            return Err(error);
        }
    };
    progress.stage = "take-stderr";
    let stderr = match process.take_stderr().context("suite stderr pipe 不可用") {
        Ok(stderr) => stderr,
        Err(error) => {
            cleanup_spawned_process(process, progress);
            return Err(error);
        }
    };
    progress.stage = "start-log-capture";
    let logs = match LogCapture::start(
        context.streaming_redactor(),
        stdout,
        &stdout_path,
        context.streaming_redactor(),
        stderr,
        &stderr_path,
    ) {
        Ok(logs) => logs,
        Err(error) => {
            cleanup_spawned_process(process, progress);
            return Err(error);
        }
    };
    let mut execution = SuiteExecution::new(process, logs);
    progress.stage = "wait";
    let deadline = started + Duration::from_secs(suite.timeout_seconds);
    loop {
        execution.poll_log_workers(progress)?;
        if let Some(status) = execution.try_wait(progress)? {
            let duration_ms = started.elapsed().as_millis();
            execution.finalize_after_exit(progress)?;
            progress.stage = "collect-artifacts";
            return Ok(if status.success() {
                progress.stage = "verify-artifacts";
                verify_required_artifacts(domain_artifacts.as_deref(), &suite.required_artifacts)?;
                progress.stage = "verify-summary";
                let summary = verify_summary(
                    suite.summary.as_ref().context("suite 缺少 summary 合同")?,
                    &stdout_path,
                    &stderr_path,
                    domain_artifacts.as_deref(),
                )?;
                progress.stage = "collect-artifacts";
                SuiteOutcome::Passed {
                    id: suite.id.clone(),
                    duration_ms,
                    stdout: relative_log(context, &stdout_path),
                    stderr: relative_log(context, &stderr_path),
                    domain_artifacts: actual_artifact_reference(
                        context,
                        domain_artifacts.as_deref(),
                    )?,
                    summary,
                }
            } else {
                SuiteOutcome::Failed {
                    id: suite.id.clone(),
                    duration_ms,
                    exit_code: status.code(),
                    stdout: relative_log(context, &stdout_path),
                    stderr: relative_log(context, &stderr_path),
                    domain_artifacts: actual_artifact_reference(
                        context,
                        domain_artifacts.as_deref(),
                    )?,
                }
            });
        }
        if Instant::now() >= deadline {
            progress.stage = "timeout-cleanup";
            execution.stop_and_finalize(Duration::from_secs(15), progress)?;
            progress.stage = "collect-artifacts";
            return Ok(SuiteOutcome::TimedOut {
                id: suite.id.clone(),
                duration_ms: started.elapsed().as_millis(),
                stdout: relative_log(context, &stdout_path),
                stderr: relative_log(context, &stderr_path),
                domain_artifacts: actual_artifact_reference(context, domain_artifacts.as_deref())?,
            });
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn cleanup_spawned_process(mut process: OwnedProcess, progress: &mut SuiteRunProgress) {
    match process.terminate(Duration::from_secs(2)) {
        Ok(_) => progress.cleanup.push("process-tree-terminated".to_string()),
        Err(error) => progress
            .cleanup
            .push(format!("process-tree-termination-failed: {error:#}")),
    }
    drop(process);
    progress
        .cleanup
        .push("process-ownership-released".to_string());
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

struct SuiteExecution {
    process: Option<OwnedProcess>,
    logs: LogCapture,
    finalized: bool,
}

impl SuiteExecution {
    fn new(process: OwnedProcess, logs: LogCapture) -> Self {
        Self {
            process: Some(process),
            logs,
            finalized: false,
        }
    }

    fn try_wait(&mut self, progress: &mut SuiteRunProgress) -> Result<Option<ExitStatus>> {
        progress.stage = "wait-process";
        match self
            .process
            .as_mut()
            .context("suite 进程 ownership 已释放")?
            .try_wait()
        {
            Ok(status) => Ok(status),
            Err(error) => Err(self.abort_with(error, Duration::from_secs(2), progress)),
        }
    }

    fn poll_log_workers(&mut self, progress: &mut SuiteRunProgress) -> Result<()> {
        progress.stage = "poll-log-capture";
        if let Err(error) = self.logs.poll_finished() {
            return Err(self.abort_with(error, Duration::from_secs(2), progress));
        }
        Ok(())
    }

    fn finalize_after_exit(&mut self, progress: &mut SuiteRunProgress) -> Result<()> {
        progress.stage = "release-process-owner";
        drop(self.process.take());
        progress
            .cleanup
            .push("process-ownership-released".to_string());
        self.finalized = true;
        progress.stage = "finalize-log-capture";
        let result = self.logs.finalize();
        record_log_finalization(progress, &result);
        result
    }

    fn stop_and_finalize(
        &mut self,
        grace: Duration,
        progress: &mut SuiteRunProgress,
    ) -> Result<()> {
        progress.stage = "terminate-process-tree";
        let stop_error = self
            .process
            .as_mut()
            .and_then(|process| process.terminate(grace).err());
        match &stop_error {
            None => progress.cleanup.push("process-tree-terminated".to_string()),
            Some(error) => progress
                .cleanup
                .push(format!("process-tree-termination-failed: {error:#}")),
        }
        // Release process-tree ownership first so the log reader can reliably observe EOF afterward.
        progress.stage = "release-process-owner";
        drop(self.process.take());
        progress
            .cleanup
            .push("process-ownership-released".to_string());
        progress.stage = "finalize-log-capture";
        let log_result = self.logs.finalize();
        record_log_finalization(progress, &log_result);
        let log_error = log_result.err();
        self.finalized = true;
        progress.stage = match (&stop_error, &log_error) {
            (Some(_), Some(_)) => "terminate-process-tree-and-finalize-log-capture",
            (Some(_), None) => "terminate-process-tree",
            (None, Some(_)) => "finalize-log-capture",
            (None, None) => "cleanup-complete",
        };
        match (stop_error, log_error) {
            (None, None) => Ok(()),
            (Some(error), None) | (None, Some(error)) => Err(error),
            (Some(stop), Some(log)) => Err(anyhow::anyhow!(
                "终止 suite 进程树失败: {stop:#}; 收尾日志失败: {log:#}"
            )),
        }
    }

    fn abort_with(
        &mut self,
        primary: anyhow::Error,
        grace: Duration,
        progress: &mut SuiteRunProgress,
    ) -> anyhow::Error {
        let primary_stage = progress.stage;
        let cleanup = self.stop_and_finalize(grace, progress);
        progress.stage = primary_stage;
        match cleanup {
            Ok(()) => primary,
            Err(cleanup) => anyhow::anyhow!("{primary:#}; suite 执行收尾失败: {cleanup:#}"),
        }
    }
}

impl Drop for SuiteExecution {
    fn drop(&mut self) {
        if !self.finalized {
            let _ = self
                .process
                .as_mut()
                .and_then(|process| process.terminate(Duration::from_secs(2)).err());
            drop(self.process.take());
            let _ = self.logs.finalize();
            self.finalized = true;
        }
    }
}

fn record_log_finalization(progress: &mut SuiteRunProgress, result: &Result<()>) {
    match result {
        Ok(()) => progress.cleanup.push("log-capture-finalized".to_string()),
        Err(error) => progress
            .cleanup
            .push(format!("log-capture-finalization-failed: {error:#}")),
    }
}

fn contained_directory(root: &Path, relative: &Path) -> Result<std::path::PathBuf> {
    let root = root.canonicalize().context("解析工作区根目录失败")?;
    let directory = root.join(relative);
    let resolved = directory
        .canonicalize()
        .with_context(|| format!("解析 suite 工作目录失败: {}", directory.display()))?;
    anyhow::ensure!(
        resolved.starts_with(&root),
        "suite 工作目录通过符号链接逃逸工作区"
    );
    anyhow::ensure!(
        resolved.is_dir(),
        "suite 工作目录不是目录: {}",
        resolved.display()
    );
    Ok(resolved)
}

fn relative_log(context: &RunContext, path: &Path) -> String {
    path.strip_prefix(context.root())
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn actual_artifact_reference(context: &RunContext, path: Option<&Path>) -> Result<Option<String>> {
    let Some(path) = path else {
        return Ok(None);
    };
    let mut entries = fs::read_dir(path)
        .with_context(|| format!("读取领域 artifact 目录失败: {}", path.display()))?;
    if entries.next().transpose()?.is_none() {
        fs::remove_dir(path)
            .with_context(|| format!("删除空领域 artifact 目录失败: {}", path.display()))?;
        return Ok(None);
    }
    Ok(Some(relative_log(context, path)))
}

fn verify_required_artifacts(root: Option<&Path>, required: &[std::path::PathBuf]) -> Result<()> {
    if required.is_empty() {
        return Ok(());
    }
    let root = root.context("suite 声明了 artifact contract 但没有 artifact 目录")?;
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .with_context(|| format!("读取 suite artifact 目录失败: {}", directory.display()))?
        {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                files.push(entry.path());
            }
        }
    }
    for contract in required {
        anyhow::ensure!(
            files.iter().any(|path| {
                path.strip_prefix(root)
                    .is_ok_and(|relative| relative.ends_with(contract))
            }),
            "suite 成功退出但缺少必需 artifact: {}",
            contract.display()
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "command/tests/mod.rs"]
mod tests;
