//! Unsupported platforms never construct a live lineage reservation.
use crate::{
    AppState, AppStateLifecycleIdentity, CurrentHistoryObservation, NativeHistoryRowReceipt,
};
use anyhow::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeHistoryLineageStatus {
    Armed,
    Tracking,
    Unknown,
}

/// Process-local native lineage is not supported on this platform.
pub struct NativeHistoryLineageReservation {
    _private: (),
}

impl NativeHistoryLineageReservation {
    pub fn status(&self) -> NativeHistoryLineageStatus {
        NativeHistoryLineageStatus::Unknown
    }

    pub fn verify_original(
        &self,
        _receipt: &NativeHistoryRowReceipt,
        _observation: &CurrentHistoryObservation,
        _entry_index: usize,
    ) -> Result<()> {
        anyhow::bail!("native history lineage unavailable on this platform")
    }
}

impl AppState {
    /// This platform cannot currently retain and verify the required native
    /// handles. No files, sessions, or writer behavior are changed.
    pub fn try_reserve_native_history_lineage(
        &self,
        _owner: &AppStateLifecycleIdentity,
    ) -> Result<Option<NativeHistoryLineageReservation>> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_reservation_is_unavailable_without_creating_files() -> Result<()> {
        let root = kcoder_config::create_private_temp_dir("lineage-unavailable")?;
        let state = AppState::new(root.path());
        let owner = state.inspection_lifecycle_identity();
        assert!(state.try_reserve_native_history_lineage(&owner)?.is_none());
        assert_eq!(std::fs::read_dir(root.path())?.count(), 0);
        Ok(())
    }
}
