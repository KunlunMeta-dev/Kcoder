#[cfg(windows)]
use super::{TerminalRegistry, TerminalSession};
use std::ops::{Deref, DerefMut};

/// Own the child even when PTY setup fails before registry publication.
pub(super) struct ChildOwner(Box<dyn portable_pty::Child + Send + Sync>);

impl ChildOwner {
    pub(super) fn new(child: Box<dyn portable_pty::Child + Send + Sync>) -> Self {
        Self(child)
    }

    #[cfg(any(windows, test))]
    fn observe_exit_for(
        &mut self,
        timeout: std::time::Duration,
    ) -> anyhow::Result<Option<portable_pty::ExitStatus>> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let observed = self.0.try_wait()?;
            if observed.is_some() || std::time::Instant::now() >= deadline {
                return Ok(observed);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}

/// ConPTY output can reach EOF before the shell's process handle becomes signalled.
#[cfg(windows)]
pub(super) fn finish_output(session: &TerminalSession) -> anyhow::Result<u32> {
    let observed = session
        .child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .observe_exit_for(std::time::Duration::from_millis(500))?;
    if let Some(status) = observed {
        session
            .process_exited
            .store(true, std::sync::atomic::Ordering::Release);
        return Ok(status.exit_code());
    }
    // A live process that abandoned its output is still owned and must be stopped.
    super::terminate(session)
}

impl Deref for ChildOwner {
    type Target = dyn portable_pty::Child + Send + Sync;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

impl DerefMut for ChildOwner {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut *self.0
    }
}

impl Drop for ChildOwner {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_some() {
            return;
        }
        #[cfg(unix)]
        if let Some(pid) = self.0.process_id() {
            let _ = super::signal_process_group(pid, libc::SIGKILL);
        }
        if let Err(error) = self.0.kill() {
            tracing::warn!(%error, "failed to stop owned terminal child");
        }
        if let Err(error) = self.0.wait() {
            tracing::warn!(%error, "failed to reap owned terminal child");
        }
    }
}

/// Release the console outside the mutex: ClosePseudoConsole can wait for the reader.
#[cfg(windows)]
pub(super) fn close_console(session: &TerminalSession) {
    let master = session
        .master
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    drop(master);
    session
        .console_closed
        .store(true, std::sync::atomic::Ordering::Release);
}

#[cfg(windows)]
pub(super) fn wait_console_closed(session: &TerminalSession) -> anyhow::Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !session
        .console_closed
        .load(std::sync::atomic::Ordering::Acquire)
    {
        anyhow::ensure!(
            std::time::Instant::now() < deadline,
            "terminal console cleanup did not finish"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn wait_cleanup(session: &TerminalSession) -> anyhow::Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !super::cleanup_complete(session) {
        anyhow::ensure!(
            std::time::Instant::now() < deadline,
            "terminal cleanup remains owned and pending"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn watch_child(
    session: std::sync::Arc<TerminalSession>,
    number: u64,
    terminals: TerminalRegistry,
    session_id: String,
) -> std::io::Result<()> {
    use std::{sync::atomic::Ordering, time::Duration};
    std::thread::Builder::new()
        .name(format!("kcoder-terminal-child-{number}"))
        .spawn(move || {
            loop {
                let observed = session
                    .child
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .try_wait();
                match observed {
                    Ok(Some(_)) => break,
                    Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                    Err(error) => {
                        tracing::warn!(%error, "failed to observe owned terminal child");
                        if super::terminate(&session).is_ok() {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            }
            session.process_exited.store(true, Ordering::Release);
            super::mark_closed(&session);
            session
                .input_tx
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            close_console(&session);
            super::remove_if_complete(&terminals, &session_id, &session);
        })?;
    Ok(())
}

#[cfg(test)]
#[path = "lifecycle/tests.rs"]
pub(super) mod tests;
