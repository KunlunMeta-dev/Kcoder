//! Parsed original bytes, never an allow decision or a replacement ledger.
use super::Journal;

pub(super) struct VerifiedJournal {
    pub(super) head: Vec<u8>,
    pub(super) bytes: Vec<u8>,
    pub(super) state: Journal,
}
