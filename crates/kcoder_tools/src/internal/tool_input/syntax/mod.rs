//! Shared syntax analysis for tool execution and permission checks.

#[path = "../../../bash/command_syntax.rs"]
mod command_syntax;
#[path = "../../../bash/read_only.rs"]
mod read_only;

#[path = "../../../bash/command_classification.rs"]
mod command_classification;
#[path = "../../../bash/verification_policy.rs"]
mod verification_policy;

pub mod verification {
    pub use super::command_classification::*;
    pub use super::verification_policy::*;
}

pub mod shell {
    pub use super::command_syntax::*;
    pub use super::read_only::shell_command_is_read_only;
}

#[path = "../../../apply_patch/parser.rs"]
pub mod patch;
