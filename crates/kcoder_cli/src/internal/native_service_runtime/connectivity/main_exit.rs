//! Original application Main exit evidence rechecks its actual parent and OS exit.
use super::NativeConnectivityParent;
use anyhow::{Result, ensure};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

pub struct ExitState {
    pub exited: AtomicBool,
    pub notify: Notify,
    #[cfg(windows)]
    pub code: std::sync::atomic::AtomicI32,
}
/// Minted only after the actual Main tree and RPC reader have settled.
/// This value cannot be supplied by an RPC or launch DTO.
pub struct NativeConnectivityMainExitReceipt {
    parent: std::sync::Weak<NativeConnectivityParent>,
    exit: Arc<ExitState>,
}
impl NativeConnectivityMainExitReceipt {
    /// Called by the owning host after its original tree and RPC reader settled.
    pub fn from_owned_cleanup(
        parent: std::sync::Weak<NativeConnectivityParent>,
        exit: Arc<ExitState>,
    ) -> Self {
        Self { parent, exit }
    }

    pub fn verify(&self, parent: &std::sync::Weak<NativeConnectivityParent>) -> Result<()> {
        ensure!(
            self.parent.ptr_eq(parent) && self.exit.exited.load(Ordering::Acquire),
            "CONNECTIVITY_MAIN_EXIT_UNCONFIRMED"
        );
        if let Some(parent) = parent.upgrade() {
            ensure!(!parent.alive()?, "CONNECTIVITY_MAIN_EXIT_UNCONFIRMED");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Weak;

    #[test]
    fn held_exit_receipt_rechecks_original_process_exit() {
        let parent = Weak::new();
        let exit = Arc::new(ExitState {
            exited: AtomicBool::new(false),
            notify: Notify::new(),
            #[cfg(windows)]
            code: std::sync::atomic::AtomicI32::new(0),
        });
        let receipt =
            NativeConnectivityMainExitReceipt::from_owned_cleanup(parent.clone(), exit.clone());
        assert!(receipt.verify(&parent).is_err());
        exit.exited.store(true, Ordering::Release);
        receipt.verify(&parent).unwrap();
        exit.exited.store(false, Ordering::Release);
        assert!(receipt.verify(&parent).is_err());
    }
}
