//! Explicit, read-only observations of an Ollama endpoint's loaded-model snapshot.

use kcoder_api::{ProviderFactory, ProviderKind};
use kcoder_config::{ApiFormat, Settings};
use reqwest::{Client, Url, redirect::Policy};
use serde_json::Value;
use std::time::Duration;

const MAX_RESPONSE_BYTES: usize = 64 * 1024;

/// Never loads a model, sends provider credentials, or changes configured limits.
/// Failure to obtain a unique runtime observation is unknown, not a connection failure.
pub async fn observe(settings: &Settings) -> Option<usize> {
    if settings.api_format != Some(ApiFormat::OpenaiChatCompletions) {
        return None;
    }
    let kind = ProviderKind::from_settings(settings).ok()??;
    let endpoint = ProviderFactory::new(settings).endpoint_override(kind)?;
    let url = runtime_url(&endpoint)?;
    let mut builder = Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(2));
    // Match the selected transport's proxy precedence without copying its headers.
    if let Some(proxy) = settings.provider_proxy_url.as_deref() {
        builder = builder.proxy(reqwest::Proxy::all(proxy).ok()?);
    } else if settings.provider_no_proxy {
        builder = builder.no_proxy();
    }
    let mut response = builder.build().ok()?.get(url).send().await.ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    observed_window(&serde_json::from_slice(&bytes).ok()?, &settings.model)
}

/// Derive only the documented sibling of a canonical OpenAI-compatible /v1 base.
fn runtime_url(endpoint: &str) -> Option<Url> {
    let endpoint = endpoint.trim();
    let mut url = Url::parse(endpoint).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || endpoint.contains('\\')
        || endpoint.chars().any(char::is_control)
    {
        return None;
    }
    // URL parsing normalizes dot segments; reject them in the original input first.
    let authority_and_path = endpoint.split_once("://")?.1;
    let raw_path = &authority_and_path[authority_and_path.find('/')?..];
    if raw_path.contains('%')
        || raw_path.contains("//")
        || raw_path.split('/').any(|part| matches!(part, "." | ".."))
        || url.path().contains('%')
    {
        return None;
    }
    let path = url.path().strip_suffix('/').unwrap_or(url.path());
    let prefix = path.strip_suffix("/v1")?;
    url.set_path(&format!("{prefix}/api/ps"));
    Some(url)
}

fn matches_model(observed: &str, requested: &str) -> bool {
    observed == requested
        || (!requested
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .contains(':')
            && observed.strip_suffix(":latest") == Some(requested))
}

fn observed_window(body: &Value, model: &str) -> Option<usize> {
    let mut rows = body.get("models")?.as_array()?.iter().filter(|row| {
        row.get("model")
            .and_then(Value::as_str)
            .is_some_and(|name| matches_model(name, model))
    });
    let row = rows.next()?;
    if rows.next().is_some() {
        return None;
    }
    if row
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(|name| !matches_model(name, model))
        || row.get("digest")?.as_str()?.is_empty()
    {
        return None;
    }
    let tokens = u32::try_from(row.get("context_length")?.as_u64()?).ok()?;
    (tokens > 0).then_some(tokens as usize)
}

#[cfg(test)]
mod tests;
