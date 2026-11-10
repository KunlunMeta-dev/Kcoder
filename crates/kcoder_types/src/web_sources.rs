//! Native web observations for presentation; never inferred from model content.

use crate::TurnAttemptIdentity;
use crate::web_search::{
    WebSearchAttemptV1, WebSearchErrorKind, WebSearchProvider, WebSearchStatus,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum WebSourceReadStatus {
    SummaryOnly,
    Read,
    Partial,
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub struct WebSourcePageV1 {
    /// Native producer assigns this identifier; upstream source IDs are ignored.
    #[serde(default)]
    pub source_id: String,
    pub title: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Observation time, never substituted for the publication date.
    pub retrieved_at: String,
    pub read_status: WebSourceReadStatus,
    #[serde(default)]
    pub cache_hit: bool,
    #[serde(default)]
    pub cache_age_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum WebSourceOperation {
    Search,
    Fetch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub struct WebSourcesV1 {
    pub schema_version: u8,
    pub identity: TurnAttemptIdentity,
    pub tool_call_id: String,
    pub operation: WebSourceOperation,
    pub status: WebSearchStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<WebSearchProvider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<WebSearchErrorKind>,
    #[serde(default)]
    pub attempts: Vec<WebSearchAttemptV1>,
    #[serde(default)]
    pub sources: Vec<WebSourcePageV1>,
}

impl WebSourcesV1 {
    pub fn matches(&self, thread: &str, call: &str) -> bool {
        self.schema_version == 1
            && self.identity.validate().is_ok()
            && self.identity.thread_id == thread
            && !call.is_empty()
            && self.tool_call_id == call
            && self.sources.len() <= crate::web_search::WEB_SEARCH_RESULT_LIMIT
            && self.attempts.len() <= crate::web_search::WEB_SEARCH_ATTEMPT_LIMIT
            && self.sources.iter().all(|source| {
                !source.source_id.is_empty()
                    && source.source_id.len() <= 128
                    && source.title.len() <= 1024
                    && !source.title.chars().any(char::is_control)
                    && source.url.len() <= 8192
                    && safe_web_source_url(&source.url)
                    && source.retrieved_at.len() <= 128
                    && !source.retrieved_at.chars().any(char::is_control)
                    && source
                        .published_at
                        .as_ref()
                        .is_none_or(|date| date.len() <= 128 && !date.chars().any(char::is_control))
                    && source.author.as_ref().is_none_or(|author| {
                        author.len() <= 512 && !author.chars().any(char::is_control)
                    })
            })
            && self
                .sources
                .iter()
                .map(|source| &source.source_id)
                .collect::<std::collections::HashSet<_>>()
                .len()
                == self.sources.len()
    }
}

/// Conservative protocol check at presentation boundaries. Network access uses the native guard.
pub fn safe_web_source_url(value: &str) -> bool {
    let Some((scheme, rest)) = value.split_once("://") else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return false;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    !authority.is_empty()
        && !authority.contains('@')
        && !value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace() || ch == '\\')
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsafe_links_never_become_sources() {
        for url in [
            "javascript:alert(1)",
            "data:text/plain,x",
            "file:///tmp/x",
            "https://user:pass@host/x",
            "https://host/\nx",
            "https:///path",
        ] {
            assert!(!safe_web_source_url(url), "{url}");
        }
        assert!(safe_web_source_url("https://example.com/path?q=term#part"));
        assert!(safe_web_source_url("HTTPS://example.com/path"));
    }
}
