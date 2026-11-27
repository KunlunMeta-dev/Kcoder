//! Per-batch virtual Wiki tree for the file-contract tool loop: tree storage,
//! deterministic workspace construction, draft syntax, the `read`/`edit`/
//! `write` tools and conversion of delivered drafts into a proposal.
pub(in crate::ingest) mod delivery;
pub(in crate::ingest) mod draft_format;
pub(in crate::ingest) mod tools;
pub(in crate::ingest) mod tree;
pub(in crate::ingest) mod workspace;

#[cfg(test)]
mod tests;
