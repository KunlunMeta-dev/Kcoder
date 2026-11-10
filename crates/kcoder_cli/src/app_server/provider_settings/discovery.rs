use super::*;
use kcoder_api::{ApiErrorKind, ProviderBuildOverrides, ProviderFactory, ProviderKind};
use kcoder_app_protocol::{ProviderDiscoverModelsParams, ProviderDiscoveredModels};
use kcoder_config::{ProviderConfig, Settings};
use std::collections::BTreeMap;
use std::time::Duration;

/// Discovery uses the chosen target's transport and never persists a draft or sends inference.
pub(in crate::app_server) async fn discover_models(
    engine: QueryEngine,
    params: Value,
) -> Result<Value> {
    let input: ProviderDiscoverModelsParams = serde_json::from_value(params)
        .map_err(|_| anyhow::anyhow!("[provider_discovery_configuration] Invalid fields"))?;
    validate_endpoint(input.endpoint.trim())
        .map_err(|_| anyhow::anyhow!("[provider_discovery_configuration] Invalid endpoint"))?;
    let baseline = engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("[provider_discovery_configuration] Settings unavailable"))?
        .clone();
    let id = input.id.as_deref().filter(|id| !id.is_empty());
    if let Some(id) = id {
        kcoder_config::validate_provider_id(id)?;
    }
    let path = engine.settings_persistence_path();
    let before = match (path.as_ref(), id) {
        (Some(path), Some(id)) => Some(SaveSnapshot::read(path, id)?),
        _ => None,
    };
    let mut saved = id.and_then(|id| baseline.providers.get(id).cloned());
    if let (Some(snapshot), Some(id)) = (&before, id)
        && let Some(value) = snapshot
            .user()
            .get("providers")
            .and_then(|profiles| profiles.get(id))
    {
        let mut merged = saved
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?
            .unwrap_or_else(|| json!({}));
        merge_profile_fields(&mut merged, value);
        saved = Some(serde_json::from_value(merged)?);
    }
    let key = input
        .api_key
        .as_ref()
        .filter(|key| !key.trim().is_empty())
        .cloned();
    anyhow::ensure!(
        key.as_ref()
            .is_none_or(|key| key.len() <= 16384 && !key.chars().any(char::is_control)),
        "[provider_discovery_configuration] Invalid key"
    );
    // A stored credential may only reach its original deployment, never an edited URL.
    let reusable = saved.as_ref().filter(|profile| {
        profile.endpoint.trim_end_matches('/') == input.endpoint.trim().trim_end_matches('/')
            && profile.api_format.as_str() == input.api_format
            && profile.authentication == input.authentication
    });
    let key = if input.authentication.is_api_key() {
        key.or_else(|| {
            reusable.and_then(|profile| {
                super::candidate_key(
                    &baseline,
                    id?,
                    profile,
                    None,
                    before
                        .as_ref()
                        .and_then(SaveSnapshot::credential)
                        .map(str::to_owned),
                )
            })
        })
    } else {
        None
    };
    anyhow::ensure!(
        !input.authentication.is_api_key() || key.is_some(),
        "[provider_discovery_authentication] An API key is required for this endpoint"
    );
    let profile: ProviderConfig = serde_json::from_value(json!({
        "api_format": input.api_format, "endpoint": input.endpoint.trim(),
        "authentication": input.authentication, "default_model": "model-discovery",
        // Construction-only limits; discovery never sends a generation request or saves this profile.
        "context_window_tokens":8192, "max_output_tokens":1024, "output_headroom_tokens":1024,
        "max_retries": 0, "request_timeout_secs": 15,
        "no_proxy": reusable.is_some_and(|profile| profile.no_proxy),
    }))
    .map_err(|_| anyhow::anyhow!("[provider_discovery_configuration] Unsupported API format"))?;
    let models = discover(&baseline, profile, key).await?;
    if let (Some(path), Some(id), Some(before)) = (path.as_ref(), id, before) {
        anyhow::ensure!(
            SaveSnapshot::read(path, id)? == before,
            "[provider_discovery_changed] Settings changed while listing models"
        );
    }
    Ok(kcoder_app_rpc_codec::encode(ProviderDiscoveredModels {
        models,
    })?)
}

async fn discover(
    baseline: &Settings,
    profile: ProviderConfig,
    key: Option<String>,
) -> Result<Vec<String>> {
    let endpoint = profile.endpoint.clone();
    let mut settings = baseline.clone();
    let id = "kcoder-model-discovery";
    settings.providers = BTreeMap::from([(id.to_owned(), profile)]);
    settings.credential_overrides.clear();
    settings.stored_provider_credentials.clear();
    if let Some(key) = &key {
        settings
            .stored_provider_credentials
            .insert(id.into(), key.trim().into());
    }
    settings.apply_provider(Some(id))?;
    let kind = ProviderKind::from_settings(&settings)?
        .context("[provider_discovery_configuration] Unsupported transport")?;
    let overrides = ProviderBuildOverrides {
        api_key: key.clone(),
        openai_api_key: key.clone(),
        local_api_key: key.clone(),
        gemini_api_key: key,
        base_url: Some(endpoint.clone()),
        openai_base_url: Some(endpoint.clone()),
        local_base_url: Some(endpoint),
        ..Default::default()
    };
    let provider = ProviderFactory::new(&settings)
        .with_overrides(overrides)
        .build(kind, "model-discovery")
        .map_err(|_| {
            anyhow::anyhow!("[provider_discovery_configuration] Cannot build transport")
        })?;
    tokio::time::timeout(
        Duration::from_secs(15),
        provider.discover_models(kcoder_api::providers::ModelDiscoveryOptions {
            timeout: Duration::from_secs(15),
            max_models: 2048,
        }),
    )
    .await
    .map_err(|_| anyhow::anyhow!("[provider_discovery_timeout] Model listing timed out"))?
    .map_err(safe_error)
}

fn safe_error(error: ApiErrorKind) -> anyhow::Error {
    let category = match &error {
        ApiErrorKind::Api { error_type, .. } if error_type == "model_discovery_http_401" => {
            "authentication"
        }
        ApiErrorKind::Api { error_type, .. } if error_type == "model_discovery_http_403" => {
            "permission"
        }
        ApiErrorKind::Api { error_type, .. }
            if matches!(
                error_type.as_str(),
                "model_discovery_http_404" | "model_discovery_http_405"
            ) =>
        {
            "unsupported"
        }
        ApiErrorKind::Api { error_type, .. } if error_type == "model_discovery_http_429" => {
            "rate_limit"
        }
        ApiErrorKind::Network(error) if error.is_timeout() => "timeout",
        ApiErrorKind::Network(_) => "network",
        _ => "response",
    };
    anyhow::anyhow!("[provider_discovery_{category}] Model listing failed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn catalog(status: u16, body: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/api/paas/v4", listener.local_addr().unwrap());
        let request = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 16384];
            let count = socket.read(&mut bytes).await.unwrap();
            let response = format!(
                "HTTP/1.1 {status} Catalog\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8(bytes[..count].to_vec()).unwrap()
        });
        (endpoint, request)
    }

    #[tokio::test]
    async fn lists_draft_endpoint_without_a_model_and_preserves_case_and_authentication() {
        let (endpoint, request) = catalog(
            200,
            r#"{"data":[{"id":"Model-B"},{"id":"Model-A"},{"id":"Model-B"}]}"#,
        )
        .await;
        let profile = serde_json::from_value(json!({ "api_format":"openai_chat_completions", "endpoint":endpoint,
            "default_model":"unused", "context_window_tokens":8192, "max_output_tokens":1024, "output_headroom_tokens":1024, "no_proxy":true })).unwrap();
        let baseline = Settings::default();
        let models = discover(&baseline, profile, Some("fixture-key".into()))
            .await
            .unwrap();
        assert_eq!(models, vec!["Model-A", "Model-B"]);
        let wire = request.await.unwrap();
        assert!(wire.starts_with("GET /api/paas/v4/models HTTP/1.1\r\n"));
        assert!(
            wire.to_ascii_lowercase()
                .contains("authorization: bearer fixture-key\r\n")
        );
        assert!(!wire.contains("model-discovery"));
        assert_eq!(
            baseline.active_provider,
            Settings::default().active_provider
        );
    }

    #[tokio::test]
    async fn authentication_failure_never_returns_upstream_body_or_key() {
        let (endpoint, request) =
            catalog(401, r#"{"error":{"message":"private-upstream-key"}}"#).await;
        let profile = serde_json::from_value(json!({ "api_format":"anthropic_messages", "endpoint":endpoint,
            "default_model":"unused", "context_window_tokens":8192, "max_output_tokens":1024, "output_headroom_tokens":1024, "no_proxy":true })).unwrap();
        let error = discover(&Settings::default(), profile, Some("fixture-key".into()))
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "[provider_discovery_authentication] Model listing failed"
        );
        let wire = request.await.unwrap();
        assert!(
            wire.to_ascii_lowercase()
                .contains("x-api-key: fixture-key\r\n")
        );
    }

    #[tokio::test]
    async fn explicit_local_no_auth_sends_no_authorization() {
        let (endpoint, request) = catalog(200, r#"{"data":[{"id":"local"}]}"#).await;
        let profile = serde_json::from_value(json!({ "api_format":"openai_chat_completions", "endpoint":endpoint,
            "default_model":"unused", "context_window_tokens":8192, "max_output_tokens":1024, "output_headroom_tokens":1024, "no_proxy":true, "authentication":{"mode":"none"} })).unwrap();
        assert_eq!(
            discover(&Settings::default(), profile, None).await.unwrap(),
            vec!["local"]
        );
        assert!(
            !request
                .await
                .unwrap()
                .to_ascii_lowercase()
                .contains("authorization:")
        );
    }
}
