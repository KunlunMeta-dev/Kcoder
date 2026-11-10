use anyhow::{Result, ensure};
use kcoder_config::{CredentialBackend, OsCredentialBackend};
use serde::Serialize;
use std::collections::BTreeSet;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Calls {
    pub available: u64,
    pub get: u64,
    pub set: u64,
    pub delete: u64,
}

/// Faults withhold a reply only after the real OS operation succeeds.
pub(super) struct AuditedBackend {
    inner: OsCredentialBackend,
    accounts: BTreeSet<String>,
    calls: Mutex<Calls>,
    lose_set: AtomicBool,
    lose_delete: AtomicBool,
}

impl AuditedBackend {
    pub fn new(accounts: impl IntoIterator<Item = String>) -> Self {
        Self {
            inner: OsCredentialBackend::new(),
            accounts: accounts.into_iter().collect(),
            calls: Mutex::new(Calls::default()),
            lose_set: AtomicBool::new(false),
            lose_delete: AtomicBool::new(false),
        }
    }
    fn check(&self, account: &str) -> Result<()> {
        ensure!(
            self.accounts.contains(account),
            "core_unowned_backend_account"
        );
        Ok(())
    }
    pub fn calls(&self) -> Calls {
        self.calls.lock().unwrap().clone()
    }
    pub fn lose_next_set_reply(&self) {
        self.lose_set.store(true, Ordering::SeqCst);
    }
    pub fn lose_next_delete_reply(&self) {
        self.lose_delete.store(true, Ordering::SeqCst);
    }
}

impl CredentialBackend for AuditedBackend {
    fn describe(&self) -> String {
        self.inner.describe()
    }
    fn available(&self) -> bool {
        self.calls.lock().unwrap().available += 1;
        // Explicitly reviewed exception: read-only __kcoder_probe__ in this new owned SID.
        self.inner.available()
    }
    fn unavailable_reason(&self) -> Option<String> {
        self.inner.unavailable_reason()
    }
    fn get(&self, account: &str) -> Result<Option<String>> {
        self.check(account)?;
        self.calls.lock().unwrap().get += 1;
        self.inner.get(account)
    }
    fn set(&self, account: &str, secret: &str) -> Result<()> {
        self.check(account)?;
        self.calls.lock().unwrap().set += 1;
        self.inner.set(account, secret)?;
        ensure!(
            !self.lose_set.swap(false, Ordering::SeqCst),
            "core_lost_real_set_reply"
        );
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<()> {
        self.check(account)?;
        self.calls.lock().unwrap().delete += 1;
        self.inner.delete(account)?;
        ensure!(
            !self.lose_delete.swap(false, Ordering::SeqCst),
            "core_lost_real_delete_reply"
        );
        Ok(())
    }
}
