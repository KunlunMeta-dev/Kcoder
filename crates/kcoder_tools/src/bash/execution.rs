//! Foreground waits, cancellation, total lifetime, and output collection for the owned child.

use super::*;

#[cfg(test)]
pub(super) async fn run_shell_command(
    shell: String,
    command: String,
    cwd: PathBuf,
    timeout_ms: u64,
    limits: OutputLimits,
) -> Result<ToolOutput, ToolError> {
    RunningShell::spawn(
        shell,
        &command,
        cwd,
        timeout_ms,
        limits.clone(),
        ShellSpawnPolicy::default(),
    )?
    .wait_for_output(&command, limits)
    .await
}

pub(super) struct RunningShell {
    pub(super) child: Option<ManagedChild>,
    pub(super) stdout: Option<JoinHandle<std::io::Result<Vec<u8>>>>,
    pub(super) stderr: Option<JoinHandle<std::io::Result<Vec<u8>>>>,
    pub(super) terminator: Arc<ProcessGroupTerminator>,
    pub(super) deadline: Instant,
    pub(super) timeout_ms: u64,
    pub(super) live_output: LiveOutputCapture,
    pub(super) cwd: PathBuf,
    /// Keep a randomized temporary snapshot alive until the sandboxed child finishes sourcing it.
    pub(super) _shell_snapshot: Option<tempfile::NamedTempFile>,
}

pub(super) enum ShellWait {
    Exited(ExitStatus),
    TimedOut,
    StillRunning,
}
impl RunningShell {
    pub(super) fn live_output_capture(&self) -> LiveOutputCapture {
        self.live_output.clone()
    }

    pub(super) fn cancel_callback(&self) -> Arc<dyn Fn() + Send + Sync> {
        let terminator = Arc::clone(&self.terminator);
        Arc::new(move || terminator.terminate())
    }

    pub(super) async fn wait_for(
        &mut self,
        foreground_wait: Duration,
    ) -> Result<ShellWait, ToolError> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            self.terminate_and_reap().await?;
            return Ok(ShellWait::TimedOut);
        }

        let wait_duration = foreground_wait.min(remaining);
        match self.wait_for_child_or_stop(wait_duration).await? {
            ChildWaitOutcome::Exited(status) => {
                self.child = None;
                // A raw background child can keep inherited pipes open after
                // the shell exits. End the process group so output collection
                // cannot outlive the command's lifecycle.
                self.terminator.terminate();
                Ok(ShellWait::Exited(status))
            }
            ChildWaitOutcome::Elapsed if foreground_wait >= remaining => {
                self.terminate_and_reap().await?;
                Ok(ShellWait::TimedOut)
            }
            ChildWaitOutcome::Elapsed => Ok(ShellWait::StillRunning),
            ChildWaitOutcome::Stopped => {
                let pid = self.terminator.pid;
                self.terminate_and_reap().await?;
                Err(ToolError::Execution(format!(
                    "command process group stopped (pid {pid}, Linux state T/t); this commonly means a background program attempted to read the controlling terminal (SIGTTIN). Managed background commands must use detached stdin"
                )))
            }
        }
    }

    pub(super) async fn wait_for_child_or_stop(
        &mut self,
        wait_duration: Duration,
    ) -> Result<ChildWaitOutcome, ToolError> {
        let pid = self.terminator.pid;
        let observed = {
            let child = self.child_mut()?;
            tokio::select! {
                result = timeout(wait_duration, child.wait()) => Some(result),
                _ = wait_for_linux_process_stop(pid) => None,
            }
        };
        match observed {
            Some(Ok(Ok(status))) => Ok(ChildWaitOutcome::Exited(status)),
            Some(Ok(Err(error))) => Err(ToolError::Execution(format!(
                "failed to wait for command: {error}"
            ))),
            Some(Err(_)) => Ok(ChildWaitOutcome::Elapsed),
            None => Ok(ChildWaitOutcome::Stopped),
        }
    }

    pub(super) async fn wait_for_output(
        mut self,
        command: &str,
        limits: OutputLimits,
    ) -> Result<ToolOutput, ToolError> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        match self.wait_for(remaining).await? {
            ShellWait::Exited(status) => finish_shell_command(self, status, command, limits).await,
            ShellWait::TimedOut => Err(command_timeout_error(self.timeout_ms)),
            ShellWait::StillRunning => {
                unreachable!("waiting for the remaining lifetime cannot background")
            }
        }
    }

    pub(super) fn child_mut(&mut self) -> Result<&mut ManagedChild, ToolError> {
        self.child
            .as_mut()
            .ok_or_else(|| ToolError::Execution("shell process was already reaped".to_string()))
    }

    pub(super) async fn terminate_and_reap(&mut self) -> Result<(), ToolError> {
        self.terminator.terminate();
        if let Some(mut child) = self.child.take() {
            child.wait().await.map_err(|error| {
                ToolError::Execution(format!("failed to reap command: {error}"))
            })?;
        }
        if let Some(stdout) = self.stdout.take() {
            let _ = stdout.await;
        }
        if let Some(stderr) = self.stderr.take() {
            let _ = stderr.await;
        }
        Ok(())
    }
}
