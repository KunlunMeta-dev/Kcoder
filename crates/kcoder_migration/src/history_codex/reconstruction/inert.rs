//! Bounded, non-executable descriptions of source-side search records.
use super::*;

const MAX_EVENT_BYTES: u64 = 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Event {
    WebSearchCall {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        action: Option<WebAction>,
        #[serde(default)]
        internal_chat_message_metadata_passthrough:
            Option<serde_json::Map<String, serde_json::Value>>,
    },
    ToolSearchCall {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        call_id: Option<String>,
        #[serde(default)]
        status: Option<String>,
        execution: String,
        arguments: serde_json::Map<String, serde_json::Value>,
        #[serde(default)]
        internal_chat_message_metadata_passthrough:
            Option<serde_json::Map<String, serde_json::Value>>,
    },
    ToolSearchOutput {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        call_id: Option<String>,
        status: String,
        execution: String,
        tools: Vec<serde_json::Map<String, serde_json::Value>>,
        #[serde(default)]
        internal_chat_message_metadata_passthrough:
            Option<serde_json::Map<String, serde_json::Value>>,
    },
}

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum WebAction {
    Search {
        #[serde(default)]
        query: Option<String>,
        #[serde(default)]
        queries: Option<Vec<String>>,
    },
    OpenPage {
        #[serde(default)]
        url: Option<String>,
    },
    FindInPage {
        #[serde(default)]
        url: Option<String>,
        #[serde(default)]
        pattern: Option<String>,
    },
}

fn bounded(value: &Option<String>) -> bool {
    value.as_ref().is_none_or(|value| value.len() <= 8192)
}

fn status(value: Option<&str>) -> Result<&str> {
    let value = value.unwrap_or("unspecified");
    ensure!(
        matches!(
            value,
            "unspecified" | "completed" | "in_progress" | "failed" | "incomplete"
        ),
        "history_reconstruction_source_requires_review"
    );
    Ok(value)
}

pub(crate) fn reference(record: &HistoricalRecord) -> Option<(&str, &HistoricalValueRef)> {
    let kind = record.codex.as_ref()?.response_type.as_deref()?;
    if !matches!(
        kind,
        "web_search_call" | "tool_search_call" | "tool_search_output"
    ) {
        return None;
    }
    match &record.data {
        HistoricalRecordData::Message {
            role: HistoricalRole::Unknown,
            blocks,
            ..
        } => match blocks.as_slice() {
            [HistoricalBlock::Opaque { source_type, value }] if source_type == kind => {
                Some((kind, value))
            }
            _ => None,
        },
        _ => None,
    }
}

pub(crate) fn summary(
    archive: &ExternalHistoryReader,
    ordinal: u64,
    kind: &str,
    value: &HistoricalValueRef,
) -> Result<String> {
    ensure!(
        value.record == ordinal
            && value.encoding == HistoricalValueEncoding::Json
            && (1..=MAX_EVENT_BYTES).contains(&value.bytes),
        "history_reconstruction_source_requires_review"
    );
    let event: Event =
        serde_json::from_reader(archive.open_record_range(ordinal, value.offset, value.bytes)?)
            .map_err(|_| anyhow::anyhow!("history_reconstruction_source_requires_review"))?;
    let (label, action, source_status) = match event {
        Event::WebSearchCall {
            id,
            status: source_status,
            action,
            internal_chat_message_metadata_passthrough: _metadata,
        } => {
            ensure!(
                kind == "web_search_call" && bounded(&id),
                "history_reconstruction_source_requires_review"
            );
            let action = match action {
                Some(WebAction::Search { query, queries }) => {
                    ensure!(
                        bounded(&query)
                            && queries.as_ref().is_none_or(|items| items.len() <= 32
                                && items.iter().all(|item| item.len() <= 8192)),
                        "history_reconstruction_source_requires_review"
                    );
                    "search"
                }
                Some(WebAction::OpenPage { url }) => {
                    ensure!(
                        bounded(&url),
                        "history_reconstruction_source_requires_review"
                    );
                    "open page"
                }
                Some(WebAction::FindInPage { url, pattern }) => {
                    ensure!(
                        bounded(&url) && bounded(&pattern),
                        "history_reconstruction_source_requires_review"
                    );
                    "find in page"
                }
                None => "unspecified",
            };
            (
                "web search",
                action,
                status(source_status.as_deref())?.to_owned(),
            )
        }
        Event::ToolSearchCall {
            id,
            call_id,
            status: source_status,
            execution,
            arguments: _arguments,
            internal_chat_message_metadata_passthrough: _metadata,
        } => {
            ensure!(
                kind == "tool_search_call"
                    && bounded(&id)
                    && bounded(&call_id)
                    && matches!(execution.as_str(), "client" | "server"),
                "history_reconstruction_source_requires_review"
            );
            (
                "tool discovery request",
                "recorded",
                status(source_status.as_deref())?.to_owned(),
            )
        }
        Event::ToolSearchOutput {
            id,
            call_id,
            status: source_status,
            execution,
            tools,
            internal_chat_message_metadata_passthrough: _metadata,
        } => {
            ensure!(
                kind == "tool_search_output"
                    && bounded(&id)
                    && bounded(&call_id)
                    && matches!(execution.as_str(), "client" | "server")
                    && tools.len() <= 256,
                "history_reconstruction_source_requires_review"
            );
            (
                "tool discovery result",
                "recorded",
                status(Some(&source_status))?.to_owned(),
            )
        }
    };
    Ok(format!(
        "[Historical {label}: {action}; source status: {source_status}. Details remain in the original archive; no action was executed and no old tools were enabled.]"
    ))
}
