use super::*;

#[test]
fn bash_fallback_timeout_is_five_minutes() {
    assert_eq!(DEFAULT_TIMEOUT_MS, 300_000);
}

#[tokio::test]
async fn bash_description_reflects_bypass_and_headless_context() {
    let tool = BashTool;
    let ctx = crate::ToolDescriptionContext {
        permission_mode: crate::ToolPermissionMode::Bypass,
        is_non_interactive: true,
        active_skills: Vec::new(),
        available_tools: Default::default(),
    };

    let description = tool.description_for_model(None, &ctx).await;

    assert!(description.contains("bypasses normal approval prompts"));
    assert!(description.contains("non-interactive/headless"));
    assert!(description.contains("Each bash call starts from the session directory"));
    assert!(description.contains("cd` only affects that one command"));
    assert!(description.contains("large producers piped into `head`"));
}
