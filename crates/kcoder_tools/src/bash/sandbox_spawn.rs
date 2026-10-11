//! Construct the platform child with the existing sandbox and inherited-pipe policy.

use super::*;

#[derive(Default)]
pub(super) struct ShellSpawnPolicy<'a> {
    pub(super) snapshot_path: Option<&'a Path>,
    /// Trusted temporary directory used by a regular sandboxed shell when deny_read covers the original snapshot.
    pub(super) snapshot_copy_root: Option<&'a Path>,
    pub(super) isolation_root: Option<&'a Path>,
    pub(super) isolation_workspace_root: Option<&'a Path>,
    pub(super) os_sandbox: Option<crate::os_sandbox::OsSandboxSpec>,
}

impl RunningShell {
    pub(super) fn spawn(
        shell: String,
        command: &str,
        cwd: PathBuf,
        timeout_ms: u64,
        limits: OutputLimits,
        policy: ShellSpawnPolicy<'_>,
    ) -> Result<Self, ToolError> {
        let ShellSpawnPolicy {
            snapshot_path,
            snapshot_copy_root,
            isolation_root,
            isolation_workspace_root,
            os_sandbox,
        } = policy;
        let prepared_snapshot =
            shell_snapshot_for_spawn(snapshot_path, isolation_root.or(snapshot_copy_root))?;
        let snapshot_path = prepared_snapshot
            .as_ref()
            .map(|snapshot| snapshot.path.as_path());
        let invocation = shell_invocation(
            &shell,
            command,
            prepared_snapshot.is_some(),
            isolation_root.is_some(),
        );
        let isolation_environment = isolation_root
            .map(|root| verifier_isolation_environment(root, isolation_workspace_root))
            .transpose()?;
        let mut command_builder = Command::new(&invocation.program);
        command_builder
            .args(&invocation.args)
            .env("SHELL", &invocation.program)
            .env("PWD", &cwd)
            .env("TERM", "xterm-256color")
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        // Bash commands run in their own process group while KCoder remains
        // the controlling terminal's foreground group. If they inherit the
        // TTY, programs such as Vite that install stdin shortcuts receive
        // SIGTTIN as soon as they read, leaving a managed task present but
        // stopped. Tool calls are non-interactive, so EOF is the only safe
        // stdin contract, including commands later promoted to background.
        configure_isolated_process_environment(&mut command_builder, &cwd);
        if let Some(environment) = &isolation_environment {
            command_builder.envs(environment.iter().cloned());
        }
        command_builder.env("SHELL", &invocation.program);
        if let Some(path) = snapshot_path {
            command_builder.env("KCODER_SHELL_SNAPSHOT", path);
        }
        #[cfg(target_os = "linux")]
        let process_scope = {
            let scope = new_process_scope();
            command_builder.env(PROCESS_SCOPE_ENV, &scope);
            Some(scope)
        };
        #[cfg(not(target_os = "linux"))]
        let process_scope = None;
        #[cfg(unix)]
        {
            command_builder.process_group(0);
            if let Some(spec) = os_sandbox {
                // SAFETY: the hook only invokes Landlock syscalls (no locks,
                // no allocation-dependent library state) before exec.
                unsafe {
                    command_builder.pre_exec(move || {
                        crate::os_sandbox::apply(&spec).map_err(|reason| {
                            std::io::Error::new(std::io::ErrorKind::PermissionDenied, reason)
                        })
                    });
                }
            }
        }

        let live_output = LiveOutputCapture::new(limits.clone());

        #[cfg(windows)]
        if let Some(spec) = os_sandbox {
            let mut environment = isolated_process_environment(&cwd);
            if let Some(isolation_environment) = &isolation_environment {
                environment.extend(isolation_environment.iter().cloned());
            }
            environment.push(("SHELL".into(), invocation.program.clone().into()));
            environment.push(("PWD".into(), cwd.as_os_str().to_os_string()));
            environment.push(("TERM".into(), "xterm-256color".into()));
            if let Some(path) = snapshot_path {
                environment.push((
                    "KCODER_SHELL_SNAPSHOT".into(),
                    path.as_os_str().to_os_string(),
                ));
            }
            let mut child = crate::windows_sandbox::spawn(
                std::ffi::OsStr::new(&invocation.program),
                &invocation.args.iter().map(Into::into).collect::<Vec<_>>(),
                &cwd,
                &environment,
                &spec,
            )
            .map_err(|reason| ToolError::SandboxDenied {
                reason,
                output: None,
            })?;
            let pid = child.pid;
            let stdout = child.stdout.take().ok_or_else(|| {
                ToolError::Execution("failed to capture sandboxed shell stdout".to_string())
            })?;
            let stderr = child.stderr.take().ok_or_else(|| {
                ToolError::Execution("failed to capture sandboxed shell stderr".to_string())
            })?;
            let native_terminator = child.terminator();
            return Ok(Self {
                child: Some(ManagedChild::Windows(child)),
                stdout: Some(tokio::spawn(read_output_pipe(
                    stdout,
                    limits.clone(),
                    Some((live_output.clone(), OutputStream::Stdout)),
                ))),
                stderr: Some(tokio::spawn(read_output_pipe(
                    stderr,
                    limits.clone(),
                    Some((live_output.clone(), OutputStream::Stderr)),
                ))),
                terminator: Arc::new(ProcessGroupTerminator::new_windows(pid, native_terminator)),
                deadline: Instant::now() + Duration::from_millis(timeout_ms),
                timeout_ms,
                live_output,
                cwd,
                _shell_snapshot: prepared_snapshot.and_then(|snapshot| snapshot.temporary),
            });
        }

        let mut child = command_builder
            .spawn()
            .map_err(|e| ToolError::Execution(format!("failed to spawn shell: {e}")))?;
        let pid = child.id().ok_or_else(|| {
            ToolError::Execution("spawned shell did not expose a process id".to_string())
        })?;
        let terminator = Arc::new(ProcessGroupTerminator::new(pid, process_scope));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ToolError::Execution("failed to capture shell stdout".to_string()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ToolError::Execution("failed to capture shell stderr".to_string()))?;

        Ok(Self {
            child: Some(ManagedChild::Tokio(child)),
            stdout: Some(tokio::spawn(read_output_pipe(
                stdout,
                limits.clone(),
                Some((live_output.clone(), OutputStream::Stdout)),
            ))),
            stderr: Some(tokio::spawn(read_output_pipe(
                stderr,
                limits.clone(),
                Some((live_output.clone(), OutputStream::Stderr)),
            ))),
            terminator,
            deadline: Instant::now() + Duration::from_millis(timeout_ms),
            timeout_ms,
            live_output,
            cwd,
            _shell_snapshot: prepared_snapshot.and_then(|snapshot| snapshot.temporary),
        })
    }
}
