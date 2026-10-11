use anyhow::{Context, Result};
#[cfg(not(windows))]
use std::process::Child;
use std::process::{ChildStderr, ChildStdout, Command, ExitStatus};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use kcoder_process_supervisor::client::{SpawnSpec, SupervisedChild, locate_supervisor_or_sibling};

#[cfg(windows)]
type PlatformChild = SupervisedChild;
#[cfg(not(windows))]
type PlatformChild = Child;

pub struct OwnedProcess {
    child: Option<PlatformChild>,
    leader_status: Option<ExitStatus>,
    pid: u32,
}

impl std::fmt::Debug for OwnedProcess {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OwnedProcess")
            .field("pid", &self.pid)
            .field("leader_exited", &self.leader_status.is_some())
            .field("tree_alive", &self.tree_alive())
            .finish()
    }
}

impl OwnedProcess {
    pub fn spawn_inherit_environment(command: &mut Command) -> Result<Self> {
        Self::spawn_with_environment(command, true)
    }

    pub fn spawn_exact_environment(command: &mut Command) -> Result<Self> {
        Self::spawn_with_environment(command, false)
    }

    fn spawn_with_environment(command: &mut Command, _inherit: bool) -> Result<Self> {
        configure_process_group(command);
        #[cfg(windows)]
        let spec = if _inherit {
            SpawnSpec::from_command_inherit_environment(command)?
        } else {
            SpawnSpec::from_command_exact_environment(command)?
        };
        #[cfg(windows)]
        let child = SupervisedChild::spawn(
            spec,
            &locate_supervisor_or_sibling("KCODER_PROCESS_SUPERVISOR_BIN")?,
        )
        .context("通过 Windows supervisor 启动测试子进程失败")?;
        #[cfg(windows)]
        let pid = child.target_pid();
        #[cfg(not(windows))]
        let child = command.spawn().context("启动测试子进程失败")?;
        #[cfg(not(windows))]
        let pid = child.id();
        anyhow::ensure!(pid > 0, "测试子进程返回了无效 PID");
        Ok(Self {
            child: Some(child),
            leader_status: None,
            pid,
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        #[cfg(windows)]
        return self.child.as_mut()?.take_stdout();
        #[cfg(not(windows))]
        self.child.as_mut()?.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        #[cfg(windows)]
        return self.child.as_mut()?.take_stderr();
        #[cfg(not(windows))]
        self.child.as_mut()?.stderr.take()
    }

    /// Return leader status only after the entire process tree exits, preventing descendants from surviving an early leader exit.
    pub fn try_wait(&mut self) -> Result<Option<ExitStatus>> {
        self.reap_leader()?;
        if self.leader_status.is_some() && !self.tree_alive() {
            Ok(self.leader_status)
        } else {
            Ok(None)
        }
    }

    pub fn wait(mut self) -> Result<ExitStatus> {
        if self.leader_status.is_none() {
            let child = self.child.as_mut().context("测试子进程已经结束")?;
            self.leader_status = Some(child.wait().context("等待测试子进程失败")?);
            self.child = None;
        }
        while self.tree_alive() {
            thread::sleep(Duration::from_millis(10));
        }
        self.leader_status.context("测试子进程没有退出状态")
    }

    pub fn terminate(&mut self, grace: Duration) -> Result<Option<ExitStatus>> {
        self.reap_leader()?;
        if self.leader_status.is_some() && !self.tree_alive() {
            return Ok(self.leader_status);
        }

        terminate_process_tree(self)?;
        if self.wait_tree_until(grace)? {
            return Ok(self.leader_status);
        }

        kill_process_tree(self)?;
        anyhow::ensure!(
            self.wait_tree_until(Duration::from_secs(2))?,
            "强制终止后测试进程树仍然存活"
        );
        Ok(self.leader_status)
    }

    fn reap_leader(&mut self) -> Result<()> {
        if self.leader_status.is_some() {
            return Ok(());
        }
        let Some(child) = self.child.as_mut() else {
            return Ok(());
        };
        if let Some(status) = child.try_wait().context("查询测试子进程状态失败")? {
            self.leader_status = Some(status);
            self.child = None;
        }
        Ok(())
    }

    fn wait_tree_until(&mut self, timeout: Duration) -> Result<bool> {
        let deadline = Instant::now() + timeout;
        loop {
            self.reap_leader()?;
            if self.leader_status.is_some() && !self.tree_alive() {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    fn tree_alive(&self) -> bool {
        let Ok(pid) = i32::try_from(self.pid) else {
            return true;
        };
        let result = unsafe { libc::kill(-pid, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    #[cfg(windows)]
    fn tree_alive(&self) -> bool {
        self.leader_status.is_none()
    }

    #[cfg(not(any(unix, windows)))]
    fn tree_alive(&self) -> bool {
        self.leader_status.is_none()
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        let _ = self.terminate(Duration::from_secs(2));
    }
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn signal_group(pid: u32, signal: i32, label: &str) -> Result<()> {
    let pid = i32::try_from(pid).context("测试子进程 PID 超出平台范围")?;
    let result = unsafe { libc::kill(-pid, signal) };
    if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
            .with_context(|| format!("向测试进程组发送 {label} 失败"))
    }
}

#[cfg(unix)]
fn terminate_process_tree(process: &mut OwnedProcess) -> Result<()> {
    signal_group(process.pid, libc::SIGTERM, "SIGTERM")
}

#[cfg(unix)]
fn kill_process_tree(process: &mut OwnedProcess) -> Result<()> {
    signal_group(process.pid, libc::SIGKILL, "SIGKILL")
}

#[cfg(windows)]
fn terminate_process_tree(process: &mut OwnedProcess) -> Result<()> {
    if let Some(child) = process.child.as_mut() {
        child.kill()?;
    }
    Ok(())
}

#[cfg(windows)]
fn kill_process_tree(process: &mut OwnedProcess) -> Result<()> {
    terminate_process_tree(process)
}

#[cfg(not(any(unix, windows)))]
fn terminate_process_tree(process: &mut OwnedProcess) -> Result<()> {
    if let Some(child) = process.child.as_mut() {
        child.kill().context("终止测试子进程失败")?;
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn kill_process_tree(process: &mut OwnedProcess) -> Result<()> {
    terminate_process_tree(process)
}
