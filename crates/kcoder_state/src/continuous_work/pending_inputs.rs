//! Bounded read-only projection of original pending input receipts.
//!
//! The persistence layer must supply a validated snapshot. This projection
//! never reads input payloads, but it does not itself guarantee the cost of
//! loading an underlying storage index.
use super::{AppliedInputReference, WorkInputSource};
use anyhow::Result;
use kcoder_types::continuous_work::{WorkIdentity, WorkInputReceipt, WorkInputState};
use std::collections::BTreeMap;

pub const PENDING_INPUT_PAGE_SIZE: usize = 10;

/// The source is an opaque host-resolved identity, not an authorization grant.
/// Unknown input states are exposed for reconciliation, never auto-dispatched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingInputEntry {
    pub source: WorkInputSource,
    pub receipt: WorkInputReceipt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingInputPage {
    pub inputs: Vec<PendingInputEntry>,
    /// Continue strictly after this sequence; None means no later pending input
    /// was present in the same snapshot.
    pub next_after_sequence: Option<u64>,
}

/// An applied reference is a locator to the original native history, not a
/// substitute for the host's actual history/attempt verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkInputEntry {
    pub source: WorkInputSource,
    pub receipt: WorkInputReceipt,
    pub applied: Option<AppliedInputReference>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkInputPage {
    pub inputs: Vec<WorkInputEntry>,
    pub next_after_sequence: Option<u64>,
}

/// Unlike the pending projection, this includes applied and rejected inputs;
/// callers may reconstruct original requirements after verifying references.
pub(super) fn project_all_inputs(
    identity: &WorkIdentity,
    after_sequence: u64,
    entries: impl IntoIterator<Item = Result<WorkInputEntry>>,
) -> Result<WorkInputPage> {
    let mut first = BTreeMap::new();
    for entry in entries {
        let entry = entry?;
        if entry.receipt.work != *identity || entry.receipt.sequence <= after_sequence {
            continue;
        }
        first.insert(entry.receipt.sequence, entry);
        if first.len() > PENDING_INPUT_PAGE_SIZE + 1 {
            first.pop_last();
        }
    }
    let has_more = first.len() > PENDING_INPUT_PAGE_SIZE;
    let inputs: Vec<_> = first.into_values().take(PENDING_INPUT_PAGE_SIZE).collect();
    let next_after_sequence = if has_more {
        inputs.last().map(|entry| entry.receipt.sequence)
    } else {
        None
    };
    Ok(WorkInputPage {
        inputs,
        next_after_sequence,
    })
}

/// Keep at most one page and its look-ahead item in memory. `entries` must
/// come from a snapshot whose unique sequence and owner were already checked.
pub(super) fn project_pending_inputs(
    identity: &WorkIdentity,
    after_sequence: u64,
    entries: impl IntoIterator<Item = Result<PendingInputEntry>>,
) -> Result<PendingInputPage> {
    let mut first = BTreeMap::new();
    for entry in entries {
        let entry = entry?;
        if entry.receipt.work != *identity || entry.receipt.sequence <= after_sequence {
            continue;
        }
        if matches!(
            &entry.receipt.state,
            WorkInputState::Applied | WorkInputState::Rejected
        ) {
            continue;
        }
        first.insert(entry.receipt.sequence, entry);
        if first.len() > PENDING_INPUT_PAGE_SIZE + 1 {
            first.pop_last();
        }
    }
    let has_more = first.len() > PENDING_INPUT_PAGE_SIZE;
    let inputs: Vec<_> = first.into_values().take(PENDING_INPUT_PAGE_SIZE).collect();
    let next_after_sequence = if has_more {
        inputs.last().map(|entry| entry.receipt.sequence)
    } else {
        None
    };
    Ok(PendingInputPage {
        inputs,
        next_after_sequence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::continuous_work::{WorkInputKind, WorkScope};

    fn identity(id: &str) -> WorkIdentity {
        WorkIdentity {
            scope: WorkScope {
                account_id: "a".into(),
                target_id: "t".into(),
                workspace_id: "w".into(),
            },
            work_id: id.into(),
        }
    }
    fn entry(id: &str, sequence: u64, state: WorkInputState) -> PendingInputEntry {
        PendingInputEntry {
            source: WorkInputSource {
                kind: "foreground".into(),
                instance_id: "target-thread".into(),
                conversation_id: "thread".into(),
            },
            receipt: WorkInputReceipt {
                work: identity(id),
                input_id: format!("input-{sequence}"),
                request_id: format!("request-{sequence}"),
                request_digest: "a".repeat(64),
                payload_ref: format!("payload-{sequence}"),
                sequence,
                kind: WorkInputKind::Requirement,
                state,
                requirements_revision: Some(sequence),
            },
        }
    }

    #[test]
    fn pages_are_ordered_bounded_and_keep_unknown_states_visible() {
        let mut entries: Vec<_> = (1..=24)
            .rev()
            .map(|sequence| {
                entry(
                    "work",
                    sequence,
                    match sequence {
                        2 => WorkInputState::Applied,
                        4 => WorkInputState::Rejected,
                        5 => WorkInputState::Unknown("future".into()),
                        _ => WorkInputState::Accepted,
                    },
                )
            })
            .collect();
        entries.push(entry("other", 7, WorkInputState::Accepted));
        let first =
            project_pending_inputs(&identity("work"), 0, entries.clone().into_iter().map(Ok))
                .unwrap();
        assert_eq!(
            first
                .inputs
                .iter()
                .map(|entry| entry.receipt.sequence)
                .collect::<Vec<_>>(),
            vec![1, 3, 5, 6, 7, 8, 9, 10, 11, 12]
        );
        assert_eq!(first.next_after_sequence, Some(12));
        assert!(!first.inputs[2].receipt.state.is_known());
        let second =
            project_pending_inputs(&identity("work"), 12, entries.clone().into_iter().map(Ok))
                .unwrap();
        assert_eq!(
            second
                .inputs
                .iter()
                .map(|entry| entry.receipt.sequence)
                .collect::<Vec<_>>(),
            (13..=22).collect::<Vec<_>>()
        );
        assert_eq!(second.next_after_sequence, Some(22));
        let last =
            project_pending_inputs(&identity("work"), 22, entries.into_iter().map(Ok)).unwrap();
        assert_eq!(
            last.inputs
                .iter()
                .map(|entry| entry.receipt.sequence)
                .collect::<Vec<_>>(),
            vec![23, 24]
        );
        assert_eq!(last.next_after_sequence, None);
    }
}
