//! Non-owning notifications after the original durable run terminal commit.
use crate::native_model_requests::NativeModelRequestObserver;
use std::sync::{Arc, Mutex, Weak};

#[derive(Clone, Default)]
pub(super) struct TerminalObservers(Arc<Mutex<Vec<Weak<dyn NativeModelRequestObserver>>>>);
impl TerminalObservers {
    fn register(&self, observer: &Arc<dyn NativeModelRequestObserver>) -> anyhow::Result<()> {
        let mut observers = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("native terminal observers unavailable"))?;
        observers.retain(|entry| entry.strong_count() > 0);
        let entry = Arc::downgrade(observer);
        if observers.iter().any(|current| current.ptr_eq(&entry)) {
            return Ok(());
        }
        anyhow::ensure!(
            observers.len() < 64,
            "native terminal observer capacity exceeded"
        );
        observers.push(entry);
        Ok(())
    }
    pub(super) fn notify(&self) {
        // Call outside the registry lock. A meter may inspect its original
        // State/ledger, but cannot roll back a committed task terminal.
        let observers: Vec<_> = self
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .filter_map(Weak::upgrade)
            .collect();
        for observer in observers {
            if observer.observe_execution_terminal().is_err() {
                tracing::warn!("native task budget terminal reconciliation remains pending");
            }
        }
    }
}
impl super::BackgroundJobManager {
    pub(crate) fn register_terminal_observer(
        &self,
        observer: &Arc<dyn NativeModelRequestObserver>,
    ) -> anyhow::Result<()> {
        self.terminal_observers.register(observer)
    }
}

#[cfg(test)]
#[path = "terminal_observers_tests.rs"]
mod tests;
