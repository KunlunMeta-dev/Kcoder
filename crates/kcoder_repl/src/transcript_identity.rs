//! Stable identities used only by the TUI, without changing history files or provider message protocols.

use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct EntryId(u64);

impl EntryId {
    pub(crate) fn new() -> Self {
        Self(NEXT_ID.fetch_add(1, Ordering::Relaxed))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct TranscriptAnchor {
    pub(crate) entry: EntryId,
    pub(crate) source_byte: usize,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct EntryMetadata {
    pub(crate) id: EntryId,
    pub(crate) revision: u64,
    pub(crate) prefix_revision: u64,
}

impl Default for EntryMetadata {
    fn default() -> Self {
        Self {
            id: EntryId::new(),
            revision: 0,
            prefix_revision: 0,
        }
    }
}
