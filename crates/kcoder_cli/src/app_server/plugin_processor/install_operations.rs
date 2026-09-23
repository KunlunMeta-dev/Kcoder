use anyhow::{Context, Result, ensure};
use kcoder_plugins::PluginCancellationToken;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Clone, Default)]
pub(super) struct InstallOperations(Arc<Mutex<HashMap<String, PluginCancellationToken>>>);

pub(super) struct InstallOperation {
    pub token: PluginCancellationToken,
    id: Option<String>,
    registry: InstallOperations,
}

impl InstallOperations {
    pub fn start(
        &self,
        id: Option<&str>,
        parent: &PluginCancellationToken,
    ) -> Result<InstallOperation> {
        let token = parent.child();
        if let Some(id) = id {
            let mut operations = self
                .0
                .lock()
                .map_err(|_| anyhow::anyhow!("plugin operation registry lock failed"))?;
            ensure!(
                operations.len() < 16,
                "plugin installation busy: operation limit reached"
            );
            ensure!(
                !operations.contains_key(id),
                "plugin installation busy: attempt already active"
            );
            operations.insert(id.to_owned(), token.clone());
        }
        Ok(InstallOperation {
            token,
            id: id.map(str::to_owned),
            registry: self.clone(),
        })
    }

    pub fn cancel(&self, id: &str) -> Result<bool> {
        let operations = self
            .0
            .lock()
            .ok()
            .context("plugin operation registry lock failed")?;
        if let Some(token) = operations.get(id) {
            token.cancel();
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

impl Drop for InstallOperation {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            if let Ok(mut operations) = self.registry.0.lock() {
                operations.remove(id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_is_scoped_and_finished_attempts_are_not_cancellable() {
        let registry = InstallOperations::default();
        let parent = PluginCancellationToken::default();
        let first = registry.start(Some("first"), &parent).unwrap();
        let second = registry.start(Some("second"), &parent).unwrap();
        assert!(registry.start(Some("first"), &parent).is_err());
        assert!(!registry.cancel("unknown").unwrap());
        assert!(registry.cancel("first").unwrap());
        assert!(first.token.is_cancelled());
        assert!(!second.token.is_cancelled());
        assert!(!parent.is_cancelled());
        drop(first);
        assert!(!registry.cancel("first").unwrap());
        parent.cancel();
        assert!(second.token.is_cancelled());
    }
}
