//! Event projection and shared policy for CLI entry points.

#[path = "../../build_identity.rs"]
pub mod build_identity;
#[path = "../../startup/extension_preflight.rs"]
pub mod extension_preflight;
#[path = "failure_policy.rs"]
pub mod failure_policy;
#[path = "../../headless_events.rs"]
mod headless_events;
#[path = "../../startup/headless_questioner.rs"]
pub mod headless_questioner;
#[path = "permission_prompt.rs"]
mod permission_prompt;
#[path = "../../startup/session_history.rs"]
pub mod session_history;
#[path = "../../tui_dev_mock.rs"]
pub mod tui_dev_mock;

pub use headless_events::{engine_event_json, visible_system_notice};
pub use permission_prompt::HeadlessPermissionPrompt;
