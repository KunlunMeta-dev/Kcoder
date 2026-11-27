//! Bounded, already-redacted evidence snippets with a TTL (`evidence/`).
//!
//! Callers redact text (for example with the session secret redactor)
//! before storing it; this store only enforces size and count bounds and
//! expiry. Identical text maps to the same id, and storing it again extends
//! its expiry instead of duplicating it.

use crate::error::{EvolutionError, Result};
use crate::store::{EvolutionStore, open_child_if_exists, read_versioned_in, write_json_in};
use crate::time::DAY_MS;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;

/// Maximum UTF-8 bytes of one snippet.
pub const EVIDENCE_SNIPPET_MAX_BYTES: usize = 4 * 1024;
/// Maximum number of stored snippets per scope.
pub const EVIDENCE_STORE_MAX_SNIPPETS: usize = 20_000;
const EVIDENCE_DIR: &str = "evidence";
const EVIDENCE_VERSION: u32 = 1;

/// One stored snippet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceSnippet {
    pub version: u32,
    pub evidence_id: String,
    pub text: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
}

/// Cut `text` to at most `max_bytes` on a character boundary.
pub fn truncate_snippet(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn evidence_id(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let hex: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!("ev-{hex}")
}

fn file_name(id: &str) -> String {
    format!("{id}.json")
}

impl EvolutionStore {
    /// Store a redacted snippet and return its evidence id. Oversized text
    /// is rejected (use [`truncate_snippet`] first), never silently cut.
    pub fn put_evidence(&self, text: &str, now_ms: u64, ttl_days: u32) -> Result<String> {
        if text.len() > EVIDENCE_SNIPPET_MAX_BYTES {
            return Err(EvolutionError::EvidenceTooLarge {
                limit: EVIDENCE_SNIPPET_MAX_BYTES,
                actual: text.len(),
            });
        }
        if text.contains('\0') {
            return Err(EvolutionError::InvalidContent(
                "evidence must not contain NUL",
            ));
        }
        let id = evidence_id(text);
        let expires_at_ms = now_ms.saturating_add(u64::from(ttl_days.max(1)) * DAY_MS);
        let _lock = self.lock()?;
        let directory = self
            .directory()
            .open_child(OsStr::new(EVIDENCE_DIR), true)?;
        let name = file_name(&id);
        let existing: Option<EvidenceSnippet> =
            read_versioned_in(&directory, &name, EVIDENCE_VERSION)?;
        let snippet = match existing {
            Some(mut snippet) => {
                if snippet.expires_at_ms >= expires_at_ms {
                    return Ok(id);
                }
                snippet.expires_at_ms = expires_at_ms;
                snippet
            }
            None => {
                let count = directory
                    .entry_names_bounded(EVIDENCE_STORE_MAX_SNIPPETS + 1)?
                    .len();
                if count >= EVIDENCE_STORE_MAX_SNIPPETS {
                    return Err(EvolutionError::EvidenceFull(EVIDENCE_STORE_MAX_SNIPPETS));
                }
                EvidenceSnippet {
                    version: EVIDENCE_VERSION,
                    evidence_id: id.clone(),
                    text: text.to_string(),
                    created_at_ms: now_ms,
                    expires_at_ms,
                }
            }
        };
        write_json_in(&directory, &name, &snippet)?;
        Ok(id)
    }

    /// Read a snippet; expired snippets read as `None` even before purge.
    pub fn read_evidence(&self, id: &str, now_ms: u64) -> Result<Option<EvidenceSnippet>> {
        kcoder_types::evolution::validate_evolution_id("evidenceId", id)?;
        let Some(directory) = open_child_if_exists(self.directory(), EVIDENCE_DIR)? else {
            return Ok(None);
        };
        let snippet: Option<EvidenceSnippet> =
            read_versioned_in(&directory, &file_name(id), EVIDENCE_VERSION)?;
        Ok(snippet.filter(|snippet| snippet.expires_at_ms > now_ms))
    }

    /// Delete expired snippets and unreadable leftovers. Returns how many
    /// files were removed.
    pub fn purge_expired_evidence(&self, now_ms: u64) -> Result<usize> {
        let _lock = self.lock()?;
        let Some(directory) = open_child_if_exists(self.directory(), EVIDENCE_DIR)? else {
            return Ok(0);
        };
        let mut removed = 0;
        for name in directory.entry_names_bounded(EVIDENCE_STORE_MAX_SNIPPETS * 2)? {
            let Some(text) = name.to_str() else { continue };
            if !text.ends_with(".json") {
                // Leftover temporary files from an interrupted replace.
                if text.starts_with('.') && directory.remove_regular_file(&name).is_ok() {
                    removed += 1;
                }
                continue;
            }
            let expired =
                match read_versioned_in::<EvidenceSnippet>(&directory, text, EVIDENCE_VERSION) {
                    Ok(Some(snippet)) => snippet.expires_at_ms <= now_ms,
                    Ok(None) => false,
                    // A newer format is left for its owner.
                    Err(EvolutionError::FutureVersion { .. }) => false,
                    // Corrupt evidence has no value and no other owner.
                    Err(_) => true,
                };
            if expired {
                directory.remove_regular_file(&name)?;
                removed += 1;
            }
        }
        Ok(removed)
    }
}
