//! Native/managed child ownership and owned process-group cleanup.

use super::*;

pub(super) enum LocalExecutorChild {
    Tauri(CommandChild),
    Process(ManagedProcessChild),
}

pub(super) struct ManagedProcessChild {
    pub(super) child: Child,
    #[cfg(unix)]
    pub(super) process_group_id: u32,
}

impl LocalExecutorChild {
    pub(super) fn is_running(&mut self) -> bool {
        match self {
            LocalExecutorChild::Tauri(_) => true,
            LocalExecutorChild::Process(child) => child.is_running(),
        }
    }

    pub(super) fn kill(self) {
        match self {
            LocalExecutorChild::Tauri(child) => {
                let child_pid = child.pid();
                audit_local_executor_signal(format!(
                    "event=child_kill_requested sender_pid={} target_pid={} child_kind=tauri signal=SIGKILL",
                    std::process::id(), child_pid
                ));
                if let Err(error) = child.kill() {
                    audit_local_executor_signal(format!(
                        "event=child_kill_failed sender_pid={} target_pid={} child_kind=tauri error={error}",
                        std::process::id(), child_pid
                    ));
                }
            }
            LocalExecutorChild::Process(child) => child.kill(),
        }
    }

    pub(super) fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        match self {
            LocalExecutorChild::Tauri(child) => child
                .write(bytes)
                .map_err(|error| format!("Failed to write local executor stdin: {error}")),
            LocalExecutorChild::Process(child) => child.write(bytes),
        }
    }
}

impl ManagedProcessChild {
    pub(super) fn new(child: Child) -> Self {
        #[cfg(unix)]
        {
            let process_group_id = child.id();
            Self {
                child,
                process_group_id,
            }
        }
        #[cfg(not(unix))]
        {
            Self { child }
        }
    }

    pub(super) fn is_running(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    pub(super) fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        let stdin = self
            .child
            .stdin
            .as_mut()
            .ok_or_else(|| "Local executor stdin is unavailable".to_string())?;
        stdin
            .write_all(bytes)
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("Failed to write local executor stdin: {error}"))
    }

    pub(super) fn kill(mut self) {
        #[cfg(unix)]
        {
            audit_local_executor_signal(format!(
                "event=process_group_kill_requested sender_pid={} target_pid={} target_pgid={}",
                std::process::id(),
                self.child.id(),
                self.process_group_id
            ));
            terminate_process_group(self.process_group_id);
            let _ = self.child.wait();
        }

        #[cfg(not(unix))]
        {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(unix)]
pub(super) fn configure_managed_process_group(command: &mut Command) {
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

#[cfg(not(unix))]
pub(super) fn configure_managed_process_group(_command: &mut Command) {}

#[cfg(unix)]
pub(super) fn terminate_process_group(process_group_id: u32) {
    audit_local_executor_signal(format!(
        "event=process_group_termination_started sender_pid={} target_pgid={process_group_id}",
        std::process::id()
    ));
    send_process_group_signal(process_group_id, libc::SIGTERM);
    wait_for_process_group_exit(
        process_group_id,
        Duration::from_millis(LOCAL_EXECUTOR_PROCESS_GROUP_GRACE_MS),
    );
    send_process_group_signal(process_group_id, libc::SIGKILL);
    audit_local_executor_signal(format!(
        "event=process_group_termination_finished sender_pid={} target_pgid={process_group_id}",
        std::process::id()
    ));
}

#[cfg(unix)]
pub(super) fn wait_for_process_group_exit(process_group_id: u32, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if !process_group_exists(process_group_id) {
            return;
        }
        thread::sleep(Duration::from_millis(LOCAL_EXECUTOR_PROCESS_GROUP_POLL_MS));
    }
}

#[cfg(unix)]
pub(super) fn process_group_exists(process_group_id: u32) -> bool {
    let result = unsafe { libc::kill(-(process_group_id as libc::pid_t), 0) };
    log::debug!(
        "Tauri process-group signal probe: sender_pid={}, target_pgid={process_group_id}, signal=0, result={result}",
        std::process::id()
    );
    result == 0
}

#[cfg(unix)]
pub(super) fn send_process_group_signal(process_group_id: u32, signal: libc::c_int) {
    let result = unsafe { libc::kill(-(process_group_id as libc::pid_t), signal) };
    let error = (result != 0).then(std::io::Error::last_os_error);
    audit_local_executor_signal(format!(
        "event=process_group_signal_sent sender_pid={} target_pgid={process_group_id} signal={signal} result={result} error={error:?}",
        std::process::id()
    ));
}
