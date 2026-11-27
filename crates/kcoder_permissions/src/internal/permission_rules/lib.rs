//! Permission rules and audit storage shared by the tool permission facade.

#[path = "../../audit.rs"]
mod audit;
#[path = "../../bash_split.rs"]
mod bash_split;
#[path = "../../rules.rs"]
mod rules;

pub use audit::{AuditRecord, PermissionAudit};
pub use bash_split::{bash_command_matches, glob_match, split_bash_command};
pub use rules::*;
