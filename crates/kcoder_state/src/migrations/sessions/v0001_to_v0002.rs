use super::{PersistedSessionState, RELIABLE_DELIVERY_FORMAT};

pub(super) fn upgrade(state: &mut PersistedSessionState) {
    for task in state.tasks.values_mut() {
        task.migrate_legacy_pending_messages();
    }
    state.schema_version = 2;
    state.delivery_format = Some(RELIABLE_DELIVERY_FORMAT.to_owned());
}
