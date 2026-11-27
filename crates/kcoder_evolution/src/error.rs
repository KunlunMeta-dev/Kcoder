use kcoder_types::evolution::{EvolutionContractError, ProposalState};
use std::path::PathBuf;

/// Failure of an evolution storage or policy operation.
///
/// [`EvolutionError::code`] gives the stable RPC error code where one exists.
#[derive(Debug, thiserror::Error)]
pub enum EvolutionError {
    #[error("evolution storage is locked by another owner")]
    LockBusy,
    #[error("revision conflict: expected {expected:?}, found {actual:?}")]
    RevisionConflict {
        expected: Option<u64>,
        actual: Option<u64>,
    },
    #[error("unsupported evolution storage format version {0}")]
    UnsupportedFormat(u32),
    #[error("{file} has unsupported version {version}; it is left untouched")]
    FutureVersion { file: String, version: u32 },
    #[error("overlay slot has {actual} characters; the limit is {limit}")]
    ContentTooLarge { limit: usize, actual: usize },
    #[error("invalid overlay content: {0}")]
    InvalidContent(&'static str),
    #[error("evidence snippet has {actual} bytes; the limit is {limit}")]
    EvidenceTooLarge { limit: usize, actual: usize },
    #[error("evidence store holds the maximum of {0} snippets")]
    EvidenceFull(usize),
    #[error("record has {actual} bytes; the limit is {limit}")]
    RecordTooLarge { limit: usize, actual: usize },
    #[error("invalid proposal transition {from:?} -> {to:?}")]
    InvalidTransition {
        from: ProposalState,
        to: ProposalState,
    },
    #[error("proposal {0} was not found")]
    ProposalNotFound(String),
    #[error("proposal id {0} already holds different content")]
    ProposalIdCollision(String),
    #[error("overlay for {0} was not found")]
    OverlayNotFound(String),
    #[error("overlay operation is not valid now: {0}")]
    InvalidOverlayState(&'static str),
    #[error("evolution data root {0} is inside the project")]
    ScopeInsideProject(PathBuf),
    #[error(transparent)]
    Contract(#[from] EvolutionContractError),
    #[error(transparent)]
    Storage(#[from] anyhow::Error),
}

impl EvolutionError {
    /// Stable machine-readable code shared with the `evolution/*` RPC contract.
    pub fn code(&self) -> &'static str {
        match self {
            Self::RevisionConflict { .. } => "evolution_revision_conflict",
            Self::ProposalNotFound(_) => "evolution_proposal_not_found",
            Self::InvalidTransition { .. } => "evolution_invalid_transition",
            Self::ContentTooLarge { .. } => "evolution_content_too_large",
            Self::InvalidContent(_) => "evolution_content_rejected",
            Self::OverlayNotFound(_) => "evolution_target_not_found",
            Self::LockBusy => "evolution_busy",
            _ => "evolution_storage_error",
        }
    }
}

impl From<std::io::Error> for EvolutionError {
    fn from(error: std::io::Error) -> Self {
        Self::Storage(error.into())
    }
}

impl From<serde_json::Error> for EvolutionError {
    fn from(error: serde_json::Error) -> Self {
        Self::Storage(error.into())
    }
}

pub(crate) type Result<T> = std::result::Result<T, EvolutionError>;
