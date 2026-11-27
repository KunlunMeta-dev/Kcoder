//! Recover an absent derived pointer from original validated attempt records.
use super::*;

pub(super) fn identity(store: &TurnAttemptStore) -> Result<Option<TurnAttemptIdentity>> {
    let records = store.list()?;
    let Some(latest) = records.iter().max_by_key(|record| record.accepted_at_ms) else {
        return Ok(None);
    };
    ensure!(
        records
            .iter()
            .filter(|record| record.accepted_at_ms == latest.accepted_at_ms)
            .count()
            == 1,
        "ambiguous latest attempt ordering"
    );
    // Do not sort by turn number: a history rewind can start a new branch.
    // An accepted/uncommitted latest record remains unknown in the normal reader;
    // never skip it in favor of an earlier successful turn.
    Ok(Some(latest.identity.clone()))
}
