//! Bounded, connection-owned cancellation for read-only storage scans.
use anyhow::{Result, ensure};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(super) struct StorageScans {
    entries: Arc<Mutex<HashMap<String, Entry>>>,
    parent: CancellationToken,
}

struct Entry {
    token: CancellationToken,
    active: bool,
    created: Instant,
}

pub(super) struct StorageScan {
    pub token: CancellationToken,
    id: String,
    entries: Arc<Mutex<HashMap<String, Entry>>>,
}

fn validate(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_')),
        "invalid storage scan id"
    );
    Ok(())
}

impl StorageScans {
    pub fn start(&self, id: String) -> Result<StorageScan> {
        validate(&id)?;
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| anyhow::anyhow!("storage scan registry unavailable"))?;
        entries
            .retain(|_, entry| entry.active || entry.created.elapsed() < Duration::from_secs(30));
        ensure!(
            entries.values().filter(|entry| entry.active).count() < 4,
            "too many active storage scans"
        );
        ensure!(
            !entries.get(&id).is_some_and(|entry| entry.active),
            "storage scan id is already active"
        );
        let token = entries
            .get(&id)
            .map(|entry| entry.token.clone())
            .unwrap_or_else(|| self.parent.child_token());
        ensure!(
            entries.len() < 64 || entries.contains_key(&id),
            "storage scan registry is full"
        );
        entries.insert(
            id.clone(),
            Entry {
                token: token.clone(),
                active: true,
                created: Instant::now(),
            },
        );
        Ok(StorageScan {
            token,
            id,
            entries: self.entries.clone(),
        })
    }

    pub fn cancel(&self, id: &str) -> Result<bool> {
        validate(id)?;
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| anyhow::anyhow!("storage scan registry unavailable"))?;
        entries
            .retain(|_, entry| entry.active || entry.created.elapsed() < Duration::from_secs(30));
        if let Some(entry) = entries.get(id) {
            entry.token.cancel();
            return Ok(entry.active);
        }
        // The UI may cancel while command-client initialization is still pending.
        ensure!(entries.len() < 64, "storage scan registry is full");
        let token = self.parent.child_token();
        token.cancel();
        entries.insert(
            id.to_owned(),
            Entry {
                token,
                active: false,
                created: Instant::now(),
            },
        );
        Ok(false)
    }
}

impl Drop for StorageScans {
    fn drop(&mut self) {
        self.parent.cancel();
    }
}
impl Drop for StorageScan {
    fn drop(&mut self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_is_scoped_handles_early_cancel_and_follows_connection_drop() {
        let scans = StorageScans::default();
        let a = scans.start("a".into()).unwrap();
        let b = scans.start("b".into()).unwrap();
        assert!(scans.start("a".into()).is_err());
        assert!(scans.cancel("a").unwrap());
        assert!(a.token.is_cancelled());
        assert!(!b.token.is_cancelled());
        assert!(!scans.cancel("early").unwrap());
        assert!(scans.start("early".into()).unwrap().token.is_cancelled());
        drop(scans);
        assert!(b.token.is_cancelled());
    }
}
