//! Versioned search facts shared by native tools and client projections.

use serde::{Deserialize, Serialize};

pub const WEB_SEARCH_RESPONSE_VERSION: u8 = 1;
pub const WEB_SEARCH_RESULT_LIMIT: usize = 20;
pub const WEB_SEARCH_ATTEMPT_LIMIT: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum WebSearchProvider {
    #[serde(rename = "exa-public")]
    Exa,
    #[serde(rename = "searxng-bundled")]
    Searxng,
    #[serde(rename = "bing-html")]
    Bing,
}

impl WebSearchProvider {
    pub fn id(self) -> &'static str {
        match self {
            Self::Exa => "exa-public",
            Self::Searxng => "searxng-bundled",
            Self::Bing => "bing-html",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum WebSearchStatus {
    Success,
    Empty,
    Partial,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum WebSearchErrorKind {
    InvalidInput,
    PolicyDenied,
    Authentication,
    RateLimited,
    QuotaExhausted,
    Network,
    Tls,
    Timeout,
    Challenge,
    ContractInvalid,
    ComponentUnavailable,
    Unsupported,
    Cancelled,
}

impl WebSearchErrorKind {
    /// Only independent reads may move to another permitted source.
    pub fn allows_fallback(self) -> bool {
        !matches!(
            self,
            Self::InvalidInput | Self::PolicyDenied | Self::Cancelled
        )
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub struct WebSearchHitV1 {
    /// Assigned by the native router, never accepted as authority from a page.
    #[serde(default)]
    pub source_id: String,
    pub title: String,
    pub url: String,
    pub snippet: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

/// Bounded upstream diagnostics; messages must never contain request bodies or credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub struct WebSearchEngineFailureV1 {
    pub engine: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub struct WebSearchPageV1 {
    pub results: Vec<WebSearchHitV1>,
    #[serde(default)]
    pub incomplete: bool,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub engine_failures: Vec<WebSearchEngineFailureV1>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub constraint_notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub struct WebSearchAttemptV1 {
    pub provider: WebSearchProvider,
    pub elapsed_ms: u64,
    pub status: WebSearchStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<WebSearchErrorKind>,
    /// A sent request may have consumed an upstream quota even when its reply was lost.
    pub request_sent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub struct WebSearchResponseV1 {
    pub schema_version: u8,
    pub request_id: String,
    pub status: WebSearchStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<WebSearchErrorKind>,
    pub provider: Option<WebSearchProvider>,
    pub retrieved_at: String,
    pub elapsed_ms: u64,
    pub page: WebSearchPageV1,
    pub attempts: Vec<WebSearchAttemptV1>,
    #[serde(default)]
    pub cache_hit: bool,
    #[serde(default)]
    pub cache_age_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn terminal_outcomes_and_provider_identities_are_distinct() {
        for (status, wire) in [
            (WebSearchStatus::Success, "success"),
            (WebSearchStatus::Empty, "empty"),
            (WebSearchStatus::Partial, "partial"),
            (WebSearchStatus::Failed, "failed"),
            (WebSearchStatus::Cancelled, "cancelled"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), json!(wire));
            assert_eq!(
                serde_json::from_value::<WebSearchStatus>(json!(wire)).unwrap(),
                status
            );
        }
        assert_eq!(
            serde_json::to_value(WebSearchProvider::Exa).unwrap(),
            json!("exa-public")
        );
        assert!(serde_json::from_value::<WebSearchStatus>(json!("unknown-success")).is_err());
    }

    #[test]
    fn absent_dates_do_not_become_retrieval_dates_or_verified_reads() {
        let hit: WebSearchHitV1 = serde_json::from_value(json!({
            "title":"Source", "url":"https://example.com", "snippet":"Excerpt"
        }))
        .unwrap();
        assert!(hit.published_at.is_none());
        assert!(hit.author.is_none());
        assert!(hit.source_id.is_empty());
        let wire = serde_json::to_value(hit).unwrap();
        assert!(wire.get("publishedAt").is_none());
        assert!(wire.get("readStatus").is_none());
    }

    #[test]
    fn caller_errors_policy_and_cancellation_never_trigger_fallback() {
        for kind in [
            WebSearchErrorKind::InvalidInput,
            WebSearchErrorKind::PolicyDenied,
            WebSearchErrorKind::Cancelled,
        ] {
            assert!(!kind.allows_fallback());
        }
        assert!(WebSearchErrorKind::Network.allows_fallback());
        assert!(WebSearchErrorKind::ContractInvalid.allows_fallback());
    }
}
