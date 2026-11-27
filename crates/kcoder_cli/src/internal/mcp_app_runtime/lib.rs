//! Dedicated MCP Apps connections and Engine tool adapters.

#[path = "action_tool.rs"]
mod action_tool;
pub use action_tool::AppActionTool;
#[path = "../../app_server/mcp_apps_registry.rs"]
pub mod mcp_apps_registry;
#[path = "../../app_server/mcp_apps_runtime.rs"]
pub mod mcp_apps_runtime;
#[path = "../../app_server/mcp_apps_tool.rs"]
pub mod mcp_apps_tool;

#[path = "../../app_server/mcp_apps_actions.rs"]
pub mod mcp_apps_actions;
#[path = "mcp_apps_rpc.rs"]
pub mod mcp_apps_rpc;
#[path = "widgets_dispatch.rs"]
pub mod widgets_dispatch;

/// Resolve only a conversation already owned by the actual connection.
pub trait ResidentThreads: Sync {
    fn engine(&self, thread_id: &str) -> Option<kcoder_engine::QueryEngine>;
    fn approval_prompt(
        &self,
        thread_id: &str,
    ) -> Option<kcoder_app_interactions::AppServerPermissionPrompt>;
}
