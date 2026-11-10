//! Bounded tool discovery; the owning Engine supplies and activates its catalog.
use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_TOOL_SEARCH_RESULTS: usize = 10;
pub const MAX_TOOL_SEARCH_QUERY_BYTES: usize = 1024;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolSearchInput {
    /// Describe the needed capability in Chinese/English, or use an exact registered tool name.
    pub query: String,
    /// Maximum definitions to append in the newest ordinary message: 1..10, default 5.
    #[serde(default = "default_limit")]
    #[schemars(range(min = 1, max = 10))]
    pub limit: usize,
}

fn default_limit() -> usize {
    5
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSearchAvailability {
    AlreadyAvailable,
    Discovered,
}

#[derive(Debug, Serialize)]
pub struct ToolSearchMatch {
    pub name: String,
    pub description: String,
    pub source: String,
    pub availability: ToolSearchAvailability,
    pub call_via: &'static str,
}

#[derive(Debug, Serialize)]
pub struct ToolSearchResult {
    pub catalog_kind: &'static str,
    pub directly_available_matches: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub empty_reason: Option<&'static str>,
    pub tools: Vec<ToolSearchMatch>,
    pub total_matches: usize,
    pub has_more: bool,
    pub skipped_oversized: usize,
    pub already_returned: usize,
    pub skipped_capacity: usize,
    pub guidance: &'static str,
    #[serde(skip)]
    pub model_context: Option<String>,
}

/// Discovery changes only model exposure, never tool authorization or registration.
pub trait ToolSearchBackend: Send + Sync {
    fn search(
        &self,
        query: &str,
        limit: usize,
        call_id: Option<&str>,
    ) -> Result<ToolSearchResult, ToolError>;
}

#[derive(Debug)]
pub struct ToolSearchTool;

#[async_trait]
impl Tool for ToolSearchTool {
    fn name(&self) -> String {
        "tool_search".into()
    }

    fn description(&self) -> String {
        "Find tools for a capability not covered by the currently attached tools. KWorker only. \
         Supply a concrete Chinese/English task description or exact tool name in query; limit \
         is 1..10 (default 5). Searches only this target's registered, model-visible and permitted \
         catalog, including deferred plugin/MCP tools and native host features. Returns bounded names, summaries, sources \
         and availability. Tools already attached to this request are never returned: a result \
         always names a capability this turn cannot already call, so it arrives as a deferred \
         discovery instead. Deferred tools' real schemas arrive in a NEW ordinary message at the \
         end of the conversation, leaving the top-level tool definitions unchanged, and they run \
         through the fixed tool_execute tool with the exact returned name and matching arguments. \
         Do not execute a newly found tool in the same parallel \
         batch as this search. Search does not execute matched tools, install plugins, connect accounts, grant \
         credentials or bypass permission/Hooks. Definitions exceeding the 128 KiB ordinary-message \
         budget are explicitly counted as skipped_oversized, never truncated into invalid JSON. \
         Other zero matches mean no matching permitted registered \
         capability; refine the query or explain the missing capability rather than inventing \
         a tool name. Zero matches, even with already_returned=0, do not prove that an MCP is \
         unconfigured or absent from this session: directly attached tools are excluded, and \
         registration, role/profile/permission filtering and query matching limit this catalog. \
         Check currently attached tools and authoritative session MCP diagnostics before drawing \
         configuration or connection conclusions. Skill discovery is separate: use DiscoverSkills for workflow instructions. \
         A bounded recent selection is retained by this thread; search again if a tool is no \
         longer available. Do not repeat returned tools while their complete definitions remain in \
         context; already_returned counts omitted matches. Definitions can be returned again after \
         compaction removes them or their schema/source changes. CLI/TUI do not expose this tool."
            .into()
    }

    fn ui_metadata(&self) -> kcoder_types::tool_ui::ToolUiMetadata {
        kcoder_types::tool_ui::ToolUiMetadata {
            display_name: self.name(),
            group: kcoder_types::tool_ui::ToolUiGroup::Search,
            icon: kcoder_types::tool_ui::ToolUiIcon::Search,
            description: "Search registered capabilities and load matching tool definitions".into(),
        }
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(ToolSearchInput))
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ToolSearchInput = parse_input(&input)?;
        let query = input.query.trim();
        if query.is_empty() || query.len() > MAX_TOOL_SEARCH_QUERY_BYTES {
            return Err(ToolError::InvalidInput(format!(
                "tool_search: /query must contain 1..{MAX_TOOL_SEARCH_QUERY_BYTES} UTF-8 bytes after trimming"
            )));
        }
        if !(1..=MAX_TOOL_SEARCH_RESULTS).contains(&input.limit) {
            return Err(ToolError::InvalidInput(
                "tool_search: /limit must be an integer from 1 to 10".into(),
            ));
        }
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let backend = ctx.tool_search_backend.as_ref().ok_or_else(|| {
            ToolError::Execution(
                "tool_search is unavailable outside an authorized KWorker request".into(),
            )
        })?;
        let mut result = backend.search(query, input.limit, ctx.tool_call_id.as_deref())?;
        let model_context = result.model_context.take();
        let text = serde_json::to_string(&result)
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        let summary = if model_context.is_some() {
            "New definitions are supplied as Markdown descriptions and JSON Schema in the following ordinary message."
        } else {
            "No new definitions were returned. already_returned counts definitions still present in context; use their existing descriptions and schemas."
        };
        Ok(ToolOutput::text(format!(
            "## Tool discovery receipt\n\n{summary}\n\n```json\n{text}\n```"
        ))
        .with_user_context(
            model_context
                .into_iter()
                .map(|text| kcoder_types::ContentBlock::Text { text })
                .collect(),
        ))
    }
}

/// Rank bounded catalog summaries without evaluating schemas, scripts or servers.
pub fn tool_search_score(query: &str, name: &str, description: &str) -> usize {
    let query = query.to_lowercase();
    let name = name.to_lowercase();
    if query == name {
        return 100_000;
    }
    let description = description.to_lowercase();
    let mut terms = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|term| term.len() > 1)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    // CJK bigrams keep longer natural-language queries useful without a remote model.
    for word in terms.clone() {
        let chars = word.chars().collect::<Vec<_>>();
        for pair in chars.windows(2) {
            if pair.iter().all(|c| ('\u{3400}'..='\u{9fff}').contains(c)) {
                terms.push(pair.iter().collect());
            }
        }
    }
    for (chinese, english) in [
        ("表格", "spreadsheet excel sheet table"),
        ("邮件", "email mail message"),
        ("邮箱", "email mail"),
        ("文档", "document docx word"),
        ("幻灯", "presentation ppt slide"),
        ("演示", "presentation slide"),
        ("日历", "calendar event"),
        ("搜索", "search find"),
        ("查询", "search query list"),
        ("读取", "read get"),
        ("生成", "create generate"),
        ("图片", "image picture"),
        ("文件", "file document"),
        ("工作流", "workflow"),
        ("可视化", "widget chart diagram"),
    ] {
        if query.contains(chinese) {
            terms.extend(english.split_whitespace().map(str::to_owned));
        }
    }
    terms.sort_unstable();
    terms.dedup();
    terms.truncate(64);
    terms
        .iter()
        .filter(|term| {
            !matches!(
                term.as_str(),
                "the" | "for" | "and" | "with" | "tool" | "tools" | "please" | "want"
            )
        })
        .map(|term| {
            usize::from(name.contains(term)) * 12 + usize::from(description.contains(term)) * 3
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bilingual_search_prefers_specific_names_and_handles_unicode() {
        assert!(
            tool_search_score(
                "帮我分析表格",
                "mcp__sheet__read_table",
                "Read an Excel spreadsheet"
            ) > 0
        );
        assert!(tool_search_score("查找邮件", "mcp__mail__search", "Search email messages") > 0);
        assert!(tool_search_score("整理合同文档", "contracts", "检索合同文档") > 0);
        assert_eq!(tool_search_score("unrelatedxyz", "mail", "Read email"), 0);
        assert!(
            tool_search_score("mail", "mail", "")
                > tool_search_score("mail", "mail_search", "mail")
        );
    }

    #[tokio::test]
    async fn rejects_invalid_inputs_and_unowned_invocations_before_loading() {
        let root = tempfile::tempdir().unwrap();
        let state = kcoder_state::AppState::new(root.path());
        let ctx = ToolContext::new(state);
        for input in [
            serde_json::json!({"query":"  "}),
            serde_json::json!({"query":"mail","limit":0}),
            serde_json::json!({"query":"mail","limit":11}),
            serde_json::json!({"query":"mail","execute":true}),
            serde_json::json!({"query":"文".repeat(400)}),
        ] {
            assert!(ToolSearchTool.call(input, &ctx).await.is_err());
        }
        assert!(
            ToolSearchTool
                .call(serde_json::json!({"query":"mail"}), &ctx)
                .await
                .unwrap_err()
                .to_string()
                .contains("authorized KWorker")
        );
        assert!(!ToolSearchTool.is_read_only());
        assert!(!ToolSearchTool.is_concurrency_safe(&serde_json::json!({})));
    }
}
