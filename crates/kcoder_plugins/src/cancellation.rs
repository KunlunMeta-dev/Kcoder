use anyhow::{Result, bail};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

/// Lightweight cancellation signal shared across synchronous installation stages.
#[derive(Debug, Clone, Default)]
pub struct PluginCancellationToken {
    cancelled: Arc<AtomicBool>,
    parent: Option<Arc<Self>>,
}

impl PluginCancellationToken {
    /// Cancelling this child never cancels siblings; connection shutdown still propagates.
    pub fn child(&self) -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            parent: Some(Arc::new(self.clone())),
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
            || self
                .parent
                .as_ref()
                .is_some_and(|parent| parent.is_cancelled())
    }

    pub(crate) fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            bail!("plugin operation cancelled");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloned_cancellation_token_observes_one_shared_signal() {
        let token = PluginCancellationToken::default();
        let clone = token.clone();

        clone.cancel();

        assert!(token.is_cancelled());
        assert!(token.check().is_err());
    }
}
