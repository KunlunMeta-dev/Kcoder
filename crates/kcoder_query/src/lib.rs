//! Compatibility façade for code that still imports the historical
//! `kcoder_query` crate.
//!
//! Query orchestration now lives in `kcoder_engine`; this crate intentionally
//! re-exports the public query surface while downstream callers migrate to the
//! engine crate directly. Keeping this boundary explicit is preferable to an
//! empty placeholder crate because it documents the ownership and gives future
//! removals a single compatibility point.

pub use kcoder_engine::{EngineEvent, QueryEngine};
