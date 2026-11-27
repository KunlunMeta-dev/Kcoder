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
    /// Needed capability in Chinese/English, or an exact registered tool name.
    pub query: String,
    /// Maximum definitions to append; default 5.
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
        "Find a deferred extension capability (plugin/MCP tool or native host feature) that no tool \
         attached to this request covers. Extensions are deferred behind this search unless the user \
         selected them directly. query is a concrete Chinese/English task description or an \
         exact tool name. Searches only this target's registered, model-visible and permitted catalog \
         and never returns attached tools. Matched tools' real schemas arrive in a NEW ordinary message \
         at the end of the conversation (top-level tool definitions stay unchanged); they run only \
         through tool_execute with the exact returned name and matching arguments, in a later batch than \
         this search. Search never executes tools, installs plugins, connects accounts, grants \
         credentials or bypasses permission/Hooks. Definitions over the 128 KiB ordinary-message budget \
         are counted as skipped_oversized, never truncated. Other zero matches mean no matching permitted \
         capability: refine the query or explain what is missing, never invent a tool name, and do not \
         conclude an MCP is unconfigured without checking attached tools and session MCP diagnostics. \
         Workflow-instruction skills come from skill discovery, not this search. already_returned counts \
         matches omitted because their definitions remain in context; search again after compaction, a \
         schema/source change or eviction from the bounded recent selection."
            .into()
    }

    fn ui_metadata(&self) -> kcoder_types::tool_ui::ToolUiMetadata {
        kcoder_types::tool_ui::ToolUiMetadata {
            display_text: crate::tool_display_text(&self.name()),
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
                "tool_search is unavailable outside an Engine request that defers extension tools"
                    .into(),
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

/// Description prefix the ranker indexes; longer catalog text is ignored for ranking.
pub const TOOL_SEARCH_RANK_DESCRIPTION_CHARS: usize = 2048;
/// Distinct query terms considered, bounding work for long CJK queries.
const MAX_TOOL_SEARCH_QUERY_TERMS: usize = 64;
/// BM25F weights: tool name, MCP server / plugin / native feature, then description.
const TOOL_SEARCH_FIELD_WEIGHTS: [f64; 3] = [3.0, 2.0, 1.0];

/// Query-only Chinese-to-English capability words. They expand the query rather
/// than folding document tokens in the shared lexicon, so DiscoverSkills scores
/// stay unchanged while Chinese requests reach English tool descriptions.
const QUERY_EXPANSIONS: &[(&str, &str)] = &[
    ("表格", "spreadsheet excel sheet table"),
    ("报表", "report spreadsheet sheet table"),
    ("邮件", "email mail message"),
    ("邮箱", "email mail"),
    ("文档", "document docx word"),
    ("幻灯", "presentation ppt slide"),
    ("演示", "presentation slide"),
    ("日历", "calendar event"),
    ("日程", "calendar event schedule"),
    ("会议", "meeting calendar event"),
    ("搜索", "search find"),
    ("查找", "search find"),
    ("查询", "search query list"),
    ("读取", "read get"),
    ("生成", "create generate"),
    ("创建", "create"),
    ("新建", "create new"),
    ("图片", "image picture"),
    ("图像", "image"),
    ("文件", "file document"),
    ("工作流", "workflow"),
    ("可视化", "widget chart diagram"),
    ("消息", "message chat"),
    ("发送", "send"),
    ("发个", "send"),
    ("发给", "send"),
    ("发邮件", "send email"),
    ("发消息", "send message"),
    ("建个", "create"),
    ("新增", "add create"),
    ("列出", "list"),
    ("代码", "code"),
    ("数据库", "database sql"),
    ("天气", "weather forecast"),
    ("问题", "issue"),
    ("群聊", "channel chat group"),
    ("频道", "channel"),
    ("网盘", "drive file storage"),
    ("云盘", "drive file storage"),
    ("上传", "upload"),
    ("下载", "download"),
    ("工单", "issue ticket"),
    ("缺陷", "issue bug"),
    ("任务", "task issue"),
    ("仓库", "repository repo"),
    ("网页", "web page browser"),
    ("浏览器", "browser"),
    ("截图", "screenshot"),
    ("翻译", "translate"),
    ("合并请求", "pull request merge"),
];
/// Request filler that every tool description could contain.
const QUERY_STOPWORDS: &[&str] = &["tool", "please", "want", "need", "help", "me", "my"];

/// One deferred catalog entry, read from bounded summaries only.
pub struct ToolSearchDocument<'a> {
    pub name: &'a str,
    pub source: &'a crate::ToolSource,
    pub description: &'a str,
}

/// Ranks `documents` for `query` and returns the indices of matching documents,
/// best first. A case-insensitive exact name match always ranks before keyword
/// matches; the rest use the BM25F ranker shared with DiscoverSkills, with IDF
/// over `documents` only. Equal scores fall back to ascending tool name. Schemas,
/// scripts and servers are never evaluated.
pub fn rank_tool_search(query: &str, documents: &[ToolSearchDocument<'_>]) -> Vec<usize> {
    let lowered = query.trim().to_lowercase();
    let mut exact = (0..documents.len())
        .filter(|&index| documents[index].name.to_lowercase() == lowered)
        .collect::<Vec<_>>();
    exact.sort_by_key(|&index| documents[index].name);
    let fields = documents.iter().map(tool_fields).collect::<Vec<_>>();
    let ranked = crate::search_rank::bm25f_rank(
        &fields,
        TOOL_SEARCH_FIELD_WEIGHTS,
        &tool_search_query_terms(query),
        |index| documents[index].name,
    );
    let keyword = ranked
        .into_iter()
        .map(|(index, _)| index)
        .filter(|index| !exact.contains(index))
        .collect::<Vec<_>>();
    exact.extend(keyword);
    exact
}

fn tool_search_query_terms(query: &str) -> Vec<String> {
    let lowered = query.to_lowercase();
    let mut terms = crate::search_rank::tokenize(&lowered);
    for (chinese, english) in QUERY_EXPANSIONS {
        if lowered.contains(chinese) {
            terms.extend(crate::search_rank::tokenize(english));
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    terms.retain(|term| !QUERY_STOPWORDS.contains(&term.as_str()) && seen.insert(term.clone()));
    terms.truncate(MAX_TOOL_SEARCH_QUERY_TERMS);
    terms
}

/// Name, provenance and description tokens in [`TOOL_SEARCH_FIELD_WEIGHTS`] order.
fn tool_fields(document: &ToolSearchDocument<'_>) -> [Vec<String>; 3] {
    let source = match document.source {
        crate::ToolSource::Builtin => Vec::new(),
        crate::ToolSource::NativeFeature { feature, .. } => identifier_tokens(feature),
        crate::ToolSource::Mcp { server, .. } => identifier_tokens(server),
        crate::ToolSource::Plugin { plugin, server, .. } => {
            let mut tokens = identifier_tokens(plugin);
            tokens.extend(identifier_tokens(server));
            tokens
        }
    };
    let description = document
        .description
        .chars()
        .take(TOOL_SEARCH_RANK_DESCRIPTION_CHARS)
        .collect::<String>();
    [
        identifier_tokens(document.name),
        source,
        crate::search_rank::tokenize(&description),
    ]
}

/// Tokens of an identifier split on `__`, `_`, `-`, `.` and camelCase boundaries.
/// A camelCase word also keeps its joined form, so `GitHub` matches both
/// "github" and "hub".
fn identifier_tokens(identifier: &str) -> Vec<String> {
    let mut tokens = crate::search_rank::tokenize(&split_camel_case(identifier));
    for word in identifier.split(|c: char| !c.is_alphanumeric()) {
        if word.chars().any(char::is_uppercase) && split_camel_case(word) != word {
            tokens.extend(crate::search_rank::tokenize(word));
        }
    }
    tokens
}

/// Inserts a space at lower/digit-to-upper and acronym-to-word boundaries:
/// `OfficeDocument` -> `Office Document`, `HTTPServer` -> `HTTP Server`.
fn split_camel_case(identifier: &str) -> String {
    let chars = identifier.chars().collect::<Vec<_>>();
    let mut split = String::with_capacity(identifier.len() + 4);
    for (index, &c) in chars.iter().enumerate() {
        if index > 0 && c.is_uppercase() {
            let previous = chars[index - 1];
            let next_lower = chars.get(index + 1).is_some_and(|next| next.is_lowercase());
            if previous.is_lowercase()
                || previous.is_ascii_digit()
                || (previous.is_uppercase() && next_lower)
            {
                split.push(' ');
            }
        }
        split.push(c);
    }
    split
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mcp(server: &str) -> crate::ToolSource {
        crate::ToolSource::Mcp {
            server: server.into(),
            tool: String::new(),
        }
    }

    fn matches(query: &str, name: &str, server: &str, description: &str) -> bool {
        let source = mcp(server);
        !rank_tool_search(
            query,
            &[ToolSearchDocument {
                name,
                source: &source,
                description,
            }],
        )
        .is_empty()
    }

    #[test]
    fn bilingual_search_prefers_specific_names_and_handles_unicode() {
        assert!(matches(
            "帮我分析表格",
            "mcp__sheet__read_table",
            "sheet",
            "Read an Excel spreadsheet"
        ));
        assert!(matches(
            "查找邮件",
            "mcp__mail__search",
            "mail",
            "Search email messages"
        ));
        assert!(matches("整理合同文档", "contracts", "", "检索合同文档"));
        assert!(!matches("unrelatedxyz", "mail", "mail", "Read email"));
        let (exact, longer) = (mcp("mail"), mcp("mail"));
        let documents = [
            ToolSearchDocument {
                name: "mail_search",
                source: &longer,
                description: "mail",
            },
            ToolSearchDocument {
                name: "Mail",
                source: &exact,
                description: "",
            },
        ];
        assert_eq!(rank_tool_search("mail", &documents), [1, 0]);
    }

    #[test]
    fn tool_search_splits_identifiers_and_indexes_provenance() {
        assert_eq!(
            identifier_tokens("mcp__feishu_sheet__readRange"),
            ["mcp", "lark", "sheet", "read", "range", "readrange"]
        );
        assert_eq!(split_camel_case("HTTPServer2Go"), "HTTP Server2 Go");
        assert!(matches("office document", "OfficeDocument", "", ""));
        assert!(matches("github", "GitHub", "", ""));
        assert!(matches("hub", "GitHub", "", ""));
        // The server field alone is enough for a provider-only query.
        assert!(matches(
            "jira",
            "mcp__tracker__create",
            "jira",
            "Create a record"
        ));
        let plugin = crate::ToolSource::Plugin {
            plugin: "acme-suite".into(),
            server: "billing".into(),
            tool: "x".into(),
        };
        let documents = [ToolSearchDocument {
            name: "plugin__x",
            source: &plugin,
            description: "",
        }];
        assert_eq!(rank_tool_search("acme billing", &documents), [0]);
    }

    #[test]
    fn tool_search_ranks_only_the_bounded_description_prefix() {
        let filler = "x".repeat(1100);
        let inside = format!("{filler} lighthouse");
        assert!(inside.chars().count() < TOOL_SEARCH_RANK_DESCRIPTION_CHARS);
        assert!(matches("lighthouse", "mcp__a__b", "a", &inside));
        let beyond = format!(
            "{} lighthouse",
            "统".repeat(TOOL_SEARCH_RANK_DESCRIPTION_CHARS)
        );
        assert!(!matches("lighthouse", "mcp__a__b", "a", &beyond));
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
                .contains("defers extension tools")
        );
        assert!(!ToolSearchTool.is_read_only());
        assert!(!ToolSearchTool.is_concurrency_safe(&serde_json::json!({})));
    }
}

#[cfg(test)]
#[path = "tool_search_eval_tests.rs"]
mod eval_tests;
