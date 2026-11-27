//! Target-agnostic self-evolution contracts.
//!
//! These types describe learnable targets, usage records, outcome
//! observations, proposals and status snapshots. Storage, statistics and
//! rollout behavior live in `kcoder_evolution`; this module only defines
//! the serializable shapes and their pure validation rules.
#[path = "evolution/proposal.rs"]
mod proposal;
#[path = "evolution/records.rs"]
mod records;
#[path = "evolution/status.rs"]
mod status;
#[path = "evolution/target_key.rs"]
mod target_key;

pub use proposal::*;
pub use records::*;
pub use status::*;
pub use target_key::*;

/// Schema version written by this build for usage and outcome records,
/// proposals and status snapshots. Readers skip records with a newer version
/// instead of guessing their meaning.
pub const EVOLUTION_RECORD_VERSION: u32 = 1;

/// Maximum length of usage, observation, evidence, proposal and pattern ids.
pub const EVOLUTION_ID_MAX_LEN: usize = 128;

/// Validate a stable record identifier: 1..=128 ASCII characters from
/// `[A-Za-z0-9_.:-]`. Identifiers are case-preserving.
pub fn validate_evolution_id(
    kind: &'static str,
    value: &str,
) -> Result<(), EvolutionContractError> {
    if value.is_empty() || value.len() > EVOLUTION_ID_MAX_LEN {
        return Err(EvolutionContractError::InvalidId {
            kind,
            reason: "length must be between 1 and 128 bytes",
        });
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
    {
        return Err(EvolutionContractError::InvalidId {
            kind,
            reason: "only ASCII letters, digits and `_ . : -` are allowed",
        });
    }
    Ok(())
}

/// Validation failure of an evolution contract value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvolutionContractError {
    InvalidTargetKey(&'static str),
    UnknownTargetType(String),
    InvalidId {
        kind: &'static str,
        reason: &'static str,
    },
    InvalidValue {
        field: &'static str,
        reason: &'static str,
    },
}

impl std::fmt::Display for EvolutionContractError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidTargetKey(reason) => write!(formatter, "invalid target key: {reason}"),
            Self::UnknownTargetType(value) => {
                write!(formatter, "unknown evolution target type `{value}`")
            }
            Self::InvalidId { kind, reason } => write!(formatter, "invalid {kind}: {reason}"),
            Self::InvalidValue { field, reason } => write!(formatter, "invalid {field}: {reason}"),
        }
    }
}

impl std::error::Error for EvolutionContractError {}

#[cfg(test)]
#[path = "evolution/tests.rs"]
mod tests;
