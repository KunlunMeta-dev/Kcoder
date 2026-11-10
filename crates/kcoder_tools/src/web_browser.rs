use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

/// Text-only page navigation; uses the same network and decoding as WebFetch.
#[derive(Debug, Default)]
pub struct WebBrowserTool;
#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BrowserAction {
    #[default]
    Navigate,
    #[serde(alias = "screenshot")]
    Snapshot,
}
#[derive(Debug, Deserialize, JsonSchema)]
pub struct WebBrowserInput {
    /// Fully formed HTTP(S) URL to inspect.
    pub url: String,
    /// navigate reads server-rendered content; snapshot is text only.
    #[serde(default)]
    pub action: BrowserAction,
}
#[async_trait]
impl Tool for WebBrowserTool {
    fn name(&self) -> String {
        "WebBrowser".into()
    }
    fn description(&self) -> String {
        "Inspect a page title and server-rendered content with navigate or snapshot. Returns text only, never a screenshot or visual evidence. Uses the target network policy and local-origin authorization. No JavaScript execution, browser login or interactive browser controls.".into()
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(WebBrowserInput))
    }
    fn is_read_only(&self) -> bool {
        true
    }
    fn is_concurrency_safe(&self, _: &Value) -> bool {
        true
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: WebBrowserInput = parse_input(&input)?;
        let result = match crate::web_fetch::read_page(&input.url, false, ctx).await {
            Ok(page) => page,
            Err(error) => {
                return Ok(ToolOutput::error(
                    ctx.truncate(&format!("Error ({})\n\n{error}", input.url)),
                ));
            }
        };
        let page = &result.page;
        let snapshot = if matches!(input.action, BrowserAction::Snapshot) {
            "[Text snapshot — no image was captured or visually inspected]\n\n"
        } else {
            ""
        };
        let text = format!(
            "{snapshot}{} ({})\nStatus: {}\nRetrieved: {}\nExtraction: {}\nCached: {}\n\n{}",
            if page.content.title.is_empty() {
                "(no title)"
            } else {
                &page.content.title
            },
            page.final_url,
            page.status,
            page.retrieved_at,
            page.content.state,
            result.cached,
            page.content.markdown
        );
        Ok(if matches!(page.content.state, "read" | "partial") {
            ToolOutput::text(ctx.truncate(&text))
        } else {
            ToolOutput::error(ctx.truncate(&text))
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn advertises_text_snapshot_and_accepts_legacy_spelling() {
        for action in ["snapshot", "screenshot"] {
            let input: WebBrowserInput = serde_json::from_value(
                serde_json::json!({"url":"https://example.test","action":action}),
            )
            .unwrap();
            assert!(matches!(input.action, BrowserAction::Snapshot));
        }
        let schema = WebBrowserTool.input_schema().to_string();
        assert!(schema.contains("snapshot"));
        assert!(!schema.contains("\"screenshot\""));
        assert!(WebBrowserTool.description().contains("text only"));
    }
    #[tokio::test]
    async fn failures_are_error_outputs() {
        let ctx = ToolContext::new(kcoder_state::AppState::new("."));
        let output = WebBrowserTool
            .call(serde_json::json!({"url":"not a url"}), &ctx)
            .await
            .unwrap();
        assert!(output.is_error);
    }
}
