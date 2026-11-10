//! Native request policy snapshots and revocation checks before query dispatch.

use super::{SearchFailure, routing::SearchPolicy};
use crate::{ToolContext, ToolError};
use kcoder_config::WebSettings;
use kcoder_types::web_search::{WebSearchErrorKind, WebSearchProvider};
use std::sync::Arc;

type Check = dyn Fn(WebSearchProvider) -> Result<(), SearchFailure> + Send + Sync;

/// Not serializable: only the owning runtime can supply this permission check.
#[derive(Clone)]
pub struct SearchDispatchGuard {
    check: Arc<Check>,
    network: kcoder_config::WebFetchSettings,
}

impl SearchDispatchGuard {
    pub fn new(
        check: impl Fn(WebSearchProvider) -> Result<(), SearchFailure> + Send + Sync + 'static,
    ) -> Self {
        Self {
            check: Arc::new(check),
            network: kcoder_config::WebFetchSettings::default(),
        }
    }

    pub fn check(&self, provider: WebSearchProvider) -> Result<(), SearchFailure> {
        (self.check)(provider)
    }
    pub fn with_network_settings(mut self, settings: kcoder_config::WebFetchSettings) -> Self {
        self.network = settings;
        self
    }
    pub fn network_settings(&self) -> &kcoder_config::WebFetchSettings {
        &self.network
    }
}

fn denied() -> SearchFailure {
    SearchFailure::new(
        WebSearchErrorKind::PolicyDenied,
        "Search dispatch is restricted by the current target policy",
        false,
    )
}

pub(super) struct ResolvedPolicy {
    pub policy: SearchPolicy,
    pub guard: SearchDispatchGuard,
    pub settings: WebSettings,
}

pub(super) fn resolve(
    ctx: &ToolContext,
    legacy: Option<&str>,
) -> Result<ResolvedPolicy, ToolError> {
    // Preserve invalid environment errors instead of silently choosing a public source.
    SearchPolicy::from_override(legacy)?;
    let snapshot = ctx.effective_web_settings()?;
    let candidates = snapshot.search.candidates(legacy).map_err(|_| {
        ToolError::Execution("The startup search source is restricted by the target policy".into())
    })?;
    let policy = SearchPolicy::Configured(candidates);
    let runtime = ctx.runtime_settings.clone();
    let owner = ctx.state.inspection_lifecycle_identity();
    let state = ctx.state.clone();
    let cancel = ctx.abort_token.clone();
    let native_check = ctx.web_dispatch_check.clone();
    let reader = ctx.web_settings_reader.clone();
    let legacy = legacy.map(str::to_owned);
    let network = snapshot.fetch.clone();
    let request_settings = snapshot.clone();
    let guard = SearchDispatchGuard::new(move |provider| {
        if cancel.as_ref().is_some_and(|cancel| cancel.is_cancelled()) {
            return Err(SearchFailure::new(
                WebSearchErrorKind::Cancelled,
                "Search dispatch was cancelled",
                false,
            ));
        }
        if !owner.matches(&state) {
            return Err(denied());
        }
        if let Some(check) = &native_check
            && let Err(error) = check()
        {
            return Err(SearchFailure::new(
                if matches!(error, ToolError::Aborted) {
                    WebSearchErrorKind::Cancelled
                } else {
                    WebSearchErrorKind::PolicyDenied
                },
                "Search dispatch is restricted by the current host policy",
                false,
            ));
        }
        let current = crate::web_settings_reader::read(reader.as_ref(), runtime.as_ref())
            .map_err(|_| denied())?;
        if current.fetch != snapshot.fetch
            || !current
                .search
                .candidates(legacy.as_deref())
                .map_err(|_| denied())?
                .contains(&provider)
        {
            return Err(denied());
        }
        Ok(())
    })
    .with_network_settings(network);
    Ok(ResolvedPolicy {
        policy,
        guard,
        settings: request_settings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::RwLock;

    #[test]
    fn revocation_stops_a_later_dispatch_without_changing_the_original_candidate_snapshot() {
        let settings = Arc::new(RwLock::new(kcoder_config::Settings::default()));
        let context = ToolContext::new(kcoder_state::AppState::new("."))
            .with_runtime_settings(settings.clone());
        let resolved = resolve(&context, None).unwrap();
        assert!(resolved.guard.check(WebSearchProvider::Exa).is_ok());
        settings
            .write()
            .unwrap()
            .web
            .search
            .providers
            .retain(|p| p.id == WebSearchProvider::Bing);
        assert_eq!(
            resolved
                .guard
                .check(WebSearchProvider::Exa)
                .unwrap_err()
                .kind,
            WebSearchErrorKind::PolicyDenied
        );
        assert!(resolved.guard.check(WebSearchProvider::Bing).is_ok());
    }

    #[test]
    fn host_preference_changes_apply_to_the_next_resolve_without_reordering_inflight_candidates() {
        let current = Arc::new(RwLock::new(kcoder_config::WebSettings::default()));
        let source = current.clone();
        let context = ToolContext::new(kcoder_state::AppState::new("."))
            .with_web_settings_reader(Some(Arc::new(move || Ok(source.read().unwrap().clone()))));
        let first = resolve(&context, None).unwrap();
        let original = first.policy.clone().candidates();
        current.write().unwrap().search.preferred_provider = Some(WebSearchProvider::Bing);
        let next = resolve(&context, None).unwrap();
        assert_eq!(next.policy.candidates()[0], WebSearchProvider::Bing);
        assert_eq!(first.policy.candidates(), original);
        assert!(first.guard.check(WebSearchProvider::Exa).is_ok());
        current
            .write()
            .unwrap()
            .search
            .providers
            .retain(|p| p.id == WebSearchProvider::Bing);
        assert_eq!(
            first.guard.check(WebSearchProvider::Exa).unwrap_err().kind,
            WebSearchErrorKind::PolicyDenied
        );
    }

    #[test]
    fn changing_network_policy_blocks_an_old_client_snapshot() {
        let settings = Arc::new(RwLock::new(kcoder_config::Settings::default()));
        let context = ToolContext::new(kcoder_state::AppState::new("."))
            .with_runtime_settings(settings.clone());
        let resolved = resolve(&context, None).unwrap();
        settings.write().unwrap().web.fetch.proxy_mode = kcoder_config::WebProxyMode::Direct;
        assert_eq!(
            resolved
                .guard
                .check(WebSearchProvider::Exa)
                .unwrap_err()
                .kind,
            WebSearchErrorKind::PolicyDenied
        );
    }

    #[test]
    fn host_revocation_and_state_replacement_also_revoke_bundled_dispatch() {
        let allowed = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let active = allowed.clone();
        let context = ToolContext::new(kcoder_state::AppState::new(".")).with_web_dispatch_check(
            Arc::new(move || {
                if active.load(std::sync::atomic::Ordering::Acquire) {
                    Ok(())
                } else {
                    Err(ToolError::Execution("revoked".into()))
                }
            }),
        );
        let resolved = resolve(&context, None).unwrap();
        assert!(resolved.guard.check(WebSearchProvider::Searxng).is_ok());
        allowed.store(false, std::sync::atomic::Ordering::Release);
        assert_eq!(
            resolved
                .guard
                .check(WebSearchProvider::Searxng)
                .unwrap_err()
                .kind,
            WebSearchErrorKind::PolicyDenied
        );
        allowed.store(true, std::sync::atomic::Ordering::Release);
        context.state.start_new_session().unwrap();
        assert_eq!(
            resolved
                .guard
                .check(WebSearchProvider::Searxng)
                .unwrap_err()
                .kind,
            WebSearchErrorKind::PolicyDenied
        );
    }
}
