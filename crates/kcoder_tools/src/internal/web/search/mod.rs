//! Provider-independent web search constraints and reviewed response contracts.

use kcoder_tool_error::ToolError;
use kcoder_types::web_search::WebSearchErrorKind;

#[path = "bing.rs"]
pub mod bing;
#[path = "request.rs"]
pub mod request;
#[path = "routing.rs"]
pub mod routing;

#[path = "../../../web_search/constraints.rs"]
pub mod constraints;
#[path = "../../../web_search/provider_results.rs"]
pub mod provider_results;

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct SearchFailure {
    pub kind: WebSearchErrorKind,
    /// Adapter-owned diagnostic, never a server body, request URL or query.
    pub message: String,
    pub request_sent: bool,
}

impl SearchFailure {
    pub fn new(kind: WebSearchErrorKind, message: impl Into<String>, request_sent: bool) -> Self {
        Self {
            kind,
            message: message.into(),
            request_sent,
        }
    }

    pub fn contract(error: ToolError) -> Self {
        let (kind, sent) = match error {
            ToolError::InvalidInput(_) => (WebSearchErrorKind::InvalidInput, false),
            _ => (WebSearchErrorKind::ContractInvalid, true),
        };
        Self::new(kind, "Search response could not be validated", sent)
    }
}
