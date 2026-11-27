use crate::session_persistence::PersistedSessionState;
use anyhow::{Result, bail, ensure};
use std::path::Path;

mod v0001_to_v0002;

pub(crate) const SESSION_STATE_SCHEMA_VERSION: u32 = 2;
pub(crate) const RELIABLE_DELIVERY_FORMAT: &str = "lease_ack_v1";

pub(crate) fn validate(state: &PersistedSessionState, path: &Path) -> Result<()> {
    if state.schema_version > SESSION_STATE_SCHEMA_VERSION {
        bail!(
            "session state at {path:?} uses unsupported future schema version {} (maximum {})",
            state.schema_version,
            SESSION_STATE_SCHEMA_VERSION
        );
    }
    ensure!(
        state.schema_version >= 1,
        "unsupported session state schema version 0 at {path:?}"
    );
    if state.schema_version >= 2 {
        ensure!(
            state.delivery_format.as_deref() == Some(RELIABLE_DELIVERY_FORMAT),
            "session state at {path:?} has unknown reliable delivery format {:?}",
            state.delivery_format
        );
    }
    Ok(())
}

pub(crate) fn upgrade_for_resume(state: &mut PersistedSessionState, path: &Path) -> Result<()> {
    validate(state, path)?;
    // Validate all queues before changing any of them. A failed migration may
    // not leave a partially converted in-memory snapshot for a later writer.
    for task in state.tasks.values() {
        ensure!(
            !task.has_delivery_queue_migration_conflict(),
            "sub-agent {} contains both legacy and reliable delivery queues; session resume refuses to guess FIFO order",
            task.id
        );
    }
    if state.schema_version == 1 {
        v0001_to_v0002::upgrade(state);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
