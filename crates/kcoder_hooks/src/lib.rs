pub mod config;
pub mod effects;
pub mod execution;
pub mod matching;
mod redaction;
pub mod types;

pub use config::{HooksSettings, discover_hooks, discover_hooks_with_trust};
pub use effects::{AggregatedEffects, process_hook_output};
pub use execution::{HookRegistry, execute_hooks, first_blocking_error};
pub use matching::{matches_if_rule, matches_pattern};
pub use redaction::{hook_bytes_preview, hook_text_preview};
pub use types::{
    HookCommand, HookEffect, HookEvent, HookInput, HookJSONOutput, HookMatcher, HookOutcome,
    HookPermissionBehavior, HookResult, HookSource, HookSourceKind,
};
