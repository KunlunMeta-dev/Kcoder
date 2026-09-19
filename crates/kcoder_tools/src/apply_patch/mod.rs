//! Codex-style multi-file patch tool.
//!
//! `edit` stays the default surface; `tools.file_edit_tool = "apply_patch"`
//! swaps the model-visible edit tool (see the engine surface filter). This is
//! a JSON function tool carrying one `patch` string; lark-grammar freeform
//! exposure is a separate follow-up.

mod apply;
mod parser;
mod seek;
mod tool;

pub use parser::patch_affected_paths;
pub use tool::ApplyPatchTool;
