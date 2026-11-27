use kcoder_config::PermissionMode;
use kcoder_permissions::{PermissionPrompt, PermissionResponse};

/// Permission policy shared by noninteractive CLI and app-server turns.
pub struct HeadlessPermissionPrompt {
    mode: PermissionMode,
}

impl HeadlessPermissionPrompt {
    pub fn new(mode: PermissionMode) -> Self {
        Self { mode }
    }
}

#[async_trait::async_trait]
impl PermissionPrompt for HeadlessPermissionPrompt {
    async fn ask(
        &self,
        tool_name: &str,
        _description: String,
        _input: &serde_json::Value,
    ) -> PermissionResponse {
        match self.mode {
            PermissionMode::Bypass
            | PermissionMode::Yolo
            | PermissionMode::Auto
            | PermissionMode::AcceptEdits => PermissionResponse::AllowOnce,
            PermissionMode::Ask | PermissionMode::DontAsk => {
                eprintln!(
                    "\n[Permission required in headless mode: {} — denied]",
                    tool_name
                );
                PermissionResponse::DenyOnce
            }
        }
    }
}
