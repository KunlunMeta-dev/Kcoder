//! `preferences.json`: user-editable preference entries (plan section 10).
//!
//! Keys are `pref.<scope>.<category>`; values are short redacted text. The
//! document carries one revision for compare-and-swap edits by clients.
//! The preference target integration reads and extends the same document.

use crate::error::{EvolutionError, Result};
use crate::store::{EvolutionStore, read_versioned_in, write_json_in};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const PREFERENCES_FILE: &str = "preferences.json";
const PREFERENCES_VERSION: u32 = 1;
/// Maximum characters of one preference value.
pub const PREFERENCE_VALUE_MAX_CHARS: usize = 1000;
/// Maximum number of stored preferences.
pub const PREFERENCES_MAX_ITEMS: usize = 500;

/// One stored preference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferenceEntry {
    pub value: String,
    /// Evidence ids supporting the preference; empty for user edits.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence_ids: Vec<String>,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferenceDocument {
    pub version: u32,
    /// Increments on every write; `0` means the document does not exist.
    pub revision: u64,
    #[serde(default)]
    pub items: BTreeMap<String, PreferenceEntry>,
}

impl Default for PreferenceDocument {
    fn default() -> Self {
        Self {
            version: PREFERENCES_VERSION,
            revision: 0,
            items: BTreeMap::new(),
        }
    }
}

/// Split `pref.<scope>.<category>` into `(scope, category)`.
///
/// Both segments use `[A-Za-z0-9_-]` and are 1..=64 bytes; scope is
/// `global` or a target domain.
pub fn parse_preference_key(key: &str) -> Result<(&str, &str)> {
    let invalid =
        || EvolutionError::InvalidContent("preference keys are `pref.<scope>.<category>`");
    let rest = key.strip_prefix("pref.").ok_or_else(invalid)?;
    let (scope, category) = rest.split_once('.').ok_or_else(invalid)?;
    let segment = |value: &str| {
        !value.is_empty()
            && value.len() <= 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    };
    if !segment(scope) || !segment(category) {
        return Err(invalid());
    }
    Ok((scope, category))
}

impl EvolutionStore {
    pub fn read_preferences(&self) -> Result<PreferenceDocument> {
        Ok(
            read_versioned_in(self.directory(), PREFERENCES_FILE, PREFERENCES_VERSION)?
                .unwrap_or_default(),
        )
    }

    /// Set (`Some`) or delete (`None`) one preference when the document is
    /// still at `expected_revision`. Values must already be redacted.
    pub fn update_preference(
        &self,
        key: &str,
        value: Option<&str>,
        expected_revision: u64,
        now_ms: u64,
    ) -> Result<PreferenceDocument> {
        parse_preference_key(key)?;
        if let Some(value) = value {
            let chars = value.chars().count();
            if chars > PREFERENCE_VALUE_MAX_CHARS {
                return Err(EvolutionError::ContentTooLarge {
                    limit: PREFERENCE_VALUE_MAX_CHARS,
                    actual: chars,
                });
            }
            if value.trim().is_empty() || value.chars().any(|ch| ch.is_control() && ch != '\n') {
                return Err(EvolutionError::InvalidContent(
                    "preference values must be non-empty text",
                ));
            }
        }
        let _lock = self.lock()?;
        let mut document = self.read_preferences()?;
        if document.revision != expected_revision {
            return Err(EvolutionError::RevisionConflict {
                expected: Some(expected_revision),
                actual: Some(document.revision),
            });
        }
        match value {
            Some(value) => {
                if !document.items.contains_key(key)
                    && document.items.len() >= PREFERENCES_MAX_ITEMS
                {
                    return Err(EvolutionError::ContentTooLarge {
                        limit: PREFERENCES_MAX_ITEMS,
                        actual: document.items.len() + 1,
                    });
                }
                let entry =
                    document
                        .items
                        .entry(key.to_string())
                        .or_insert_with(|| PreferenceEntry {
                            value: String::new(),
                            evidence_ids: Vec::new(),
                            updated_at_ms: now_ms,
                        });
                entry.value = value.to_string();
                entry.updated_at_ms = now_ms;
            }
            None => {
                document.items.remove(key);
            }
        }
        document.version = PREFERENCES_VERSION;
        document.revision += 1;
        write_json_in(self.directory(), PREFERENCES_FILE, &document)?;
        Ok(document)
    }

    /// Set a learned preference with its supporting evidence ids (an
    /// accepted preference proposal). Same checks as
    /// [`Self::update_preference`]; at most 64 evidence ids are kept.
    pub fn set_learned_preference(
        &self,
        key: &str,
        value: &str,
        evidence_ids: &[String],
        expected_revision: u64,
        now_ms: u64,
    ) -> Result<PreferenceDocument> {
        for id in evidence_ids {
            kcoder_types::evolution::validate_evolution_id("evidenceId", id)?;
        }
        self.update_preference(key, Some(value), expected_revision, now_ms)?;
        let _lock = self.lock()?;
        let mut document = self.read_preferences()?;
        let Some(entry) = document.items.get_mut(key) else {
            return Ok(document);
        };
        entry.evidence_ids = evidence_ids.iter().take(64).cloned().collect();
        document.revision += 1;
        write_json_in(self.directory(), PREFERENCES_FILE, &document)?;
        Ok(document)
    }
}
