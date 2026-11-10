//! Search request shape and deterministic validation.
use crate::search::constraints;
use kcoder_tool_error::ToolError;
use kcoder_types::web_search::WebSearchHitV1 as SearchResult;
use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Debug, Clone, Default, serde::Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub struct WebSearchInput {
    /// Search query text. Be specific enough to retrieve relevant current
    /// results.
    pub query: String,
    /// Optional allowlist of domains such as `["example.com"]`. Must be a JSON
    /// array of strings. Use only when results must come from specific sites.
    pub allowed_domains: Option<Vec<String>>,
    /// Optional denylist of domains such as `["example.com"]`. Must be a JSON
    /// array of strings.
    pub blocked_domains: Option<Vec<String>>,
    /// Number of search results to return. Use a JSON integer. Accepts 1 through 20; defaults to 8.
    pub num_results: Option<usize>,
    /// Live crawl mode. Use `fallback` for cached-first behavior or
    /// `preferred` to prioritize live crawling. Defaults to `fallback`.
    pub livecrawl: Option<LivecrawlMode>,
    /// Search depth. Use `auto` by default, `fast` for quick lookups, or
    /// `deep` for comprehensive research.
    pub search_type: Option<SearchType>,
    /// Maximum characters of returned search context. Use a JSON integer.
    /// Defaults to 10000.
    pub context_max_characters: Option<usize>,
    /// Publication window, language/search-market constraints, and cache freshness.
    #[serde(flatten)]
    pub constraints: constraints::SearchConstraints,
}

#[derive(Debug, Clone, serde::Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LivecrawlMode {
    #[serde(alias = "Fallback")]
    Fallback,
    #[serde(alias = "Preferred")]
    Preferred,
}

#[derive(Debug, Clone, serde::Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SearchType {
    #[serde(alias = "Auto")]
    Auto,
    #[serde(alias = "Fast")]
    Fast,
    #[serde(alias = "Deep")]
    Deep,
}

pub(crate) fn host_matches(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

fn normalized_domains(domains: &Option<Vec<String>>) -> Vec<String> {
    domains
        .as_ref()
        .map(|domains| {
            domains
                .iter()
                .map(|domain| domain.trim())
                .filter(|domain| !domain.is_empty())
                .map(|domain| domain.trim_end_matches('.').to_ascii_lowercase())
                .collect()
        })
        .unwrap_or_default()
}

pub fn domains_conflict(input: &WebSearchInput) -> bool {
    !normalized_domains(&input.allowed_domains).is_empty()
        && !normalized_domains(&input.blocked_domains).is_empty()
}

pub fn filter_results(results: Vec<SearchResult>, input: &WebSearchInput) -> Vec<SearchResult> {
    let allowed = normalized_domains(&input.allowed_domains);
    let blocked = normalized_domains(&input.blocked_domains);
    results
        .into_iter()
        .filter(|r| {
            let Ok(url) = url::Url::parse(&r.url) else {
                return false;
            };
            let Some(host) = url.host_str() else {
                return false;
            };
            if !allowed.is_empty() && !allowed.iter().any(|domain| host_matches(host, domain)) {
                return false;
            }
            if blocked.iter().any(|domain| host_matches(host, domain)) {
                return false;
            }
            true
        })
        .collect()
}

pub fn normalize_input(mut input: WebSearchInput) -> Result<WebSearchInput, ToolError> {
    input.constraints = constraints::SearchConstraints::parse(
        &serde_json::to_value(&input.constraints)
            .map_err(|_| ToolError::InvalidInput("Invalid search constraints".into()))?,
    )?;
    input.query = input.query.trim().to_string();

    if input.query.chars().count() < 2 {
        return Err(ToolError::InvalidInput(
            "Error: Missing query. query must contain at least 2 non-whitespace characters."
                .to_string(),
        ));
    }

    if input
        .num_results
        .is_some_and(|count| !(1..=20).contains(&count))
    {
        return Err(ToolError::InvalidInput(
            "num_results must be between 1 and 20".into(),
        ));
    }

    if domains_conflict(&input) {
        return Err(ToolError::InvalidInput(
            "Cannot specify both allowed_domains and blocked_domains in the same request"
                .to_string(),
        ));
    }

    for values in [&mut input.allowed_domains, &mut input.blocked_domains]
        .into_iter()
        .flatten()
    {
        if values.len() > 128 {
            return Err(ToolError::InvalidInput(
                "domain filters accept at most 128 domains".into(),
            ));
        }
        let mut normalized = Vec::new();
        for value in values.iter() {
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            let value = value.trim_end_matches('.');
            if value.is_empty() {
                return Err(ToolError::InvalidInput(
                    "domain filter contains an invalid hostname".into(),
                ));
            }
            if value.len() > 253
                || value
                    .chars()
                    .any(|c| c.is_whitespace() || c.is_control() || "/:@?#*\\".contains(c))
            {
                return Err(ToolError::InvalidInput(
                    "domain filters require hostnames without schemes, paths, ports or wildcards"
                        .into(),
                ));
            }
            let host = url::Host::parse(value)
                .map_err(|_| {
                    ToolError::InvalidInput("domain filter contains an invalid hostname".into())
                })?
                .to_string();
            if !normalized.contains(&host) {
                normalized.push(host);
            }
        }
        *values = normalized;
    }

    if input.query.len() > 4096 || input.query.chars().any(char::is_control) {
        return Err(ToolError::InvalidInput(
            "query must be at most 4096 UTF-8 bytes without control characters".into(),
        ));
    }
    if input
        .context_max_characters
        .is_some_and(|limit| !(1000..=40_000).contains(&limit))
    {
        return Err(ToolError::InvalidInput(
            "context_max_characters must be between 1000 and 40000".into(),
        ));
    }
    Ok(input)
}
