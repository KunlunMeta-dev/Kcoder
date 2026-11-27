//! Target-owned search policy. Tool availability stays in the existing tools configuration.

use anyhow::{Result, ensure};
use kcoder_types::web_search::WebSearchProvider;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchMode {
    #[default]
    Auto,
    Pinned,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebFallbackScope {
    None,
    #[default]
    Builtin,
    Enabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchProviderKind {
    ExaMcp,
    Searxng,
    BingHtml,
}

impl WebSearchProviderKind {
    fn provider(self) -> WebSearchProvider {
        match self {
            Self::ExaMcp => WebSearchProvider::Exa,
            Self::Searxng => WebSearchProvider::Searxng,
            Self::BingHtml => WebSearchProvider::Bing,
        }
    }
}

fn enabled() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebSearchProviderSettings {
    pub id: WebSearchProvider,
    pub kind: WebSearchProviderKind,
    #[serde(default = "enabled")]
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct WebSearchSettings {
    pub mode: WebSearchMode,
    pub preferred_provider: Option<WebSearchProvider>,
    pub fallback_scope: WebFallbackScope,
    /// An explicit empty list is a ceiling, not a request to restore defaults.
    pub providers: Vec<WebSearchProviderSettings>,
}

impl Default for WebSearchSettings {
    fn default() -> Self {
        Self {
            mode: WebSearchMode::Auto,
            preferred_provider: None,
            fallback_scope: WebFallbackScope::Builtin,
            providers: [
                (WebSearchProvider::Exa, WebSearchProviderKind::ExaMcp),
                (WebSearchProvider::Searxng, WebSearchProviderKind::Searxng),
                (WebSearchProvider::Bing, WebSearchProviderKind::BingHtml),
            ]
            .into_iter()
            .map(|(id, kind)| WebSearchProviderSettings {
                id,
                kind,
                enabled: true,
            })
            .collect(),
        }
    }
}

impl WebSearchSettings {
    pub fn validate_fields(&self) -> Result<()> {
        ensure!(
            self.providers.len() <= 3,
            "web.search.providers accepts at most three built-in sources"
        );
        let mut seen = HashSet::new();
        for provider in &self.providers {
            ensure!(
                seen.insert(provider.id),
                "web.search.providers contains a duplicate source"
            );
            ensure!(
                provider.id == provider.kind.provider(),
                "web.search.providers id and kind do not match"
            );
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        self.validate_fields()?;
        if let Some(preferred) = self.preferred_provider {
            ensure!(
                self.providers
                    .iter()
                    .any(|p| p.enabled && p.id == preferred),
                "web.search.preferredProvider must identify an enabled, explicitly listed source"
            );
        }
        ensure!(
            self.mode != WebSearchMode::Pinned || self.preferred_provider.is_some(),
            "web.search pinned mode requires preferredProvider"
        );
        Ok(())
    }

    /// Startup environment may pin only a source inside the target's explicit ceiling.
    pub fn candidates(&self, legacy_provider: Option<&str>) -> Result<Vec<WebSearchProvider>> {
        self.validate()?;
        let mut candidates: Vec<_> = self
            .providers
            .iter()
            .filter(|p| p.enabled)
            .map(|p| p.id)
            .collect();
        let pinned = match legacy_provider {
            Some("exa") => Some(WebSearchProvider::Exa),
            Some("bing") => Some(WebSearchProvider::Bing),
            None | Some("auto") => None,
            _ => anyhow::bail!("KCODER_WEB_SEARCH_PROVIDER must be exa, bing or auto"),
        };
        if let Some(provider) = pinned {
            ensure!(
                candidates.contains(&provider),
                "The startup search source is excluded by the target policy"
            );
            return Ok(vec![provider]);
        }
        if let Some(preferred) = self.preferred_provider {
            candidates.retain(|p| *p != preferred);
            candidates.insert(0, preferred);
        }
        if self.mode == WebSearchMode::Pinned || self.fallback_scope == WebFallbackScope::None {
            candidates.truncate(1);
        }
        Ok(candidates)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebNetworkPolicy {
    #[default]
    Public,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebProxyMode {
    #[default]
    Inherit,
    Direct,
    Configured,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct WebFetchSettings {
    pub network_policy: WebNetworkPolicy,
    pub proxy_mode: WebProxyMode,
    /// Reference to a host environment variable, never a proxy credential or URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_env: Option<String>,
}

impl WebFetchSettings {
    fn validate_fields(&self) -> Result<()> {
        if let Some(name) = &self.proxy_env {
            let mut chars = name.chars();
            ensure!(
                name.len() <= 128
                    && chars
                        .next()
                        .is_some_and(|c| c == '_' || c.is_ascii_alphabetic())
                    && chars.all(|c| c == '_' || c.is_ascii_alphanumeric()),
                "web.fetch.proxyEnv must be a host environment variable name"
            );
        }
        Ok(())
    }

    fn validate(&self) -> Result<()> {
        self.validate_fields()?;
        ensure!(
            (self.proxy_mode == WebProxyMode::Configured) == self.proxy_env.is_some(),
            "web.fetch configured proxy mode requires proxyEnv; other modes cannot declare it"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct WebSettings {
    pub search: WebSearchSettings,
    pub fetch: WebFetchSettings,
}

impl WebSettings {
    pub fn validate_fields(&self) -> Result<()> {
        self.search.validate_fields()?;
        self.fetch.validate_fields()
    }

    pub fn validate(&self) -> Result<()> {
        self.search.validate()?;
        self.fetch.validate()
    }
}

/// Project and local documents may narrow the effective host policy at their layer only.
pub(crate) fn validate_project_web_layer(
    base: &serde_json::Value,
    layer: &serde_json::Value,
) -> Result<()> {
    let Some(patch) = layer.get("web") else {
        return Ok(());
    };
    let inherited: WebSettings = serde_json::from_value(
        base.get("web")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
    )?;
    let mut merged = serde_json::to_value(&inherited)?;
    crate::merge_settings_documents(&mut merged, patch.clone());
    let requested: WebSettings = serde_json::from_value(merged)?;
    requested.validate()?;
    let permitted = inherited.search.candidates(None)?;
    ensure!(
        requested
            .search
            .candidates(None)?
            .iter()
            .all(|p| permitted.contains(p)),
        "project web policy cannot add or re-enable a host-excluded search source"
    );
    ensure!(
        requested.search.fallback_scope <= inherited.search.fallback_scope,
        "project web policy cannot widen the host fallback scope"
    );
    ensure!(
        requested.fetch == inherited.fetch,
        "project web policy cannot replace the host network or proxy policy"
    );
    Ok(())
}

#[cfg(test)]
#[path = "web_tests.rs"]
mod tests;
