//! Safe lease categories preserve the public error without exposing private resource identities.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseKind {
    JournalRead,
    JournalWrite,
    BatchRunner,
    CredentialOperation,
}
impl LeaseKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::JournalRead => "journal_read",
            Self::JournalWrite => "journal_write",
            Self::BatchRunner => "batch_runner",
            Self::CredentialOperation => "credential_operation",
        }
    }
}

#[derive(Debug)]
pub struct MigrationContention {
    pub lease: LeaseKind,
}
impl std::fmt::Display for MigrationContention {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("migration_busy")
    }
}
impl std::error::Error for MigrationContention {}

pub(crate) fn busy(lease: LeaseKind) -> anyhow::Error {
    MigrationContention { lease }.into()
}
