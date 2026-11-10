//! Shared request scheduling, bounded owner cache, and passive source observations.
use super::{WebSearchInput, normalize_input, policy, routing};
use crate::{ToolContext, ToolError};
use kcoder_config::WebSettings;
use kcoder_state::AppStateLifecycleIdentity;
use kcoder_types::web_search::{
    WebSearchErrorKind, WebSearchProvider, WebSearchResponseV1, WebSearchStatus,
};
use kcoder_types::web_search_status::WebSearchProviderObservationV1;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

const CACHE_TTL: Duration = Duration::from_secs(300);
const CACHE_ENTRIES: usize = 128;
const CACHE_BYTES: usize = 16 * 1024 * 1024;
const MAX_QUEUED: usize = 32;

#[cfg(test)]
type NetworkGenerationReader =
    Arc<dyn Fn(&kcoder_config::WebFetchSettings) -> Result<u64, ToolError> + Send + Sync>;

pub struct WebSearchRuntimeSnapshot {
    pub revision: String,
    pub candidates: Vec<WebSearchProvider>,
    pub automatic: bool,
    pub observations: Vec<WebSearchProviderObservationV1>,
}

struct Cached {
    owner: AppStateLifecycleIdentity,
    key: String,
    inserted: Instant,
    bytes: usize,
    response: WebSearchResponseV1,
}
struct Observation {
    revision: String,
    network: u64,
    value: WebSearchProviderObservationV1,
    retry_at: Option<Instant>,
}
#[derive(Default)]
struct State {
    cache: VecDeque<Cached>,
    observations: VecDeque<Observation>,
}

pub struct WebSearchRuntime {
    pub(super) client: reqwest::Client,
    permits: Semaphore,
    queued: AtomicUsize,
    state: Mutex<State>,
    receipts: super::receipts::Receipts,
    #[cfg(test)]
    network_generation_reader: Option<NetworkGenerationReader>,
}
impl std::fmt::Debug for WebSearchRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebSearchRuntime")
            .field("available", &self.permits.available_permits())
            .finish_non_exhaustive()
    }
}
impl Default for WebSearchRuntime {
    fn default() -> Self {
        let mut builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none());
        if super::web_no_proxy_enabled() {
            builder = builder.no_proxy();
        }
        Self {
            client: builder.build().expect("valid built-in web client"),
            permits: Semaphore::new(4),
            queued: AtomicUsize::new(0),
            state: Mutex::default(),
            receipts: Default::default(),
            #[cfg(test)]
            network_generation_reader: None,
        }
    }
}
struct Queued<'a>(&'a AtomicUsize);
impl Drop for Queued<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn legacy() -> Result<Option<String>, ToolError> {
    match std::env::var("KCODER_WEB_SEARCH_PROVIDER") {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(_) => Err(ToolError::InvalidInput(
            "KCODER_WEB_SEARCH_PROVIDER must contain valid UTF-8".into(),
        )),
    }
}
fn revision(settings: &WebSettings, legacy: Option<&str>) -> Result<String, ToolError> {
    settings
        .validate()
        .map_err(|_| ToolError::Execution("Target web policy is invalid".into()))?;
    let bytes = serde_json::to_vec(&(settings, legacy))
        .map_err(|_| ToolError::Execution("Web policy cannot be projected".into()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn rejected(kind: WebSearchErrorKind) -> WebSearchResponseV1 {
    WebSearchResponseV1 {
        schema_version: kcoder_types::web_search::WEB_SEARCH_RESPONSE_VERSION,
        request_id: uuid::Uuid::new_v4().to_string(),
        status: if kind == WebSearchErrorKind::Cancelled {
            WebSearchStatus::Cancelled
        } else {
            WebSearchStatus::Failed
        },
        failure: Some(kind),
        provider: None,
        retrieved_at: chrono::Utc::now().to_rfc3339(),
        elapsed_ms: 0,
        page: Default::default(),
        attempts: Vec::new(),
        cache_hit: false,
        cache_age_ms: 0,
    }
}

fn host_rejection(ctx: &ToolContext) -> Option<WebSearchErrorKind> {
    ctx.web_dispatch_check
        .as_ref()
        .and_then(|check| match check() {
            Ok(()) => None,
            Err(ToolError::Aborted) => Some(WebSearchErrorKind::Cancelled),
            Err(_) => Some(WebSearchErrorKind::PolicyDenied),
        })
}

impl WebSearchRuntime {
    pub fn new() -> Self {
        Self::default()
    }
    fn network_generation(
        &self,
        settings: &kcoder_config::WebFetchSettings,
    ) -> Result<u64, ToolError> {
        #[cfg(test)]
        if let Some(reader) = &self.network_generation_reader {
            return reader(settings);
        }
        crate::web_network::environment_fingerprint(settings)
    }
    /// Configuration and recorded facts only: no query, component launch, or background probe.
    pub fn snapshot(
        &self,
        settings: &WebSettings,
        legacy: Option<&str>,
    ) -> Result<WebSearchRuntimeSnapshot, ToolError> {
        let revision = revision(settings, legacy)?;
        let candidates = settings.search.candidates(legacy).map_err(|_| {
            ToolError::Execution("Search source is restricted by target policy".into())
        })?;
        let network = if candidates.is_empty() {
            // An excluded ceiling has no network observations, just as execute cannot dispatch.
            0
        } else {
            self.network_generation(&settings.fetch)?
        };
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let observations = candidates
            .iter()
            .copied()
            .map(|provider| {
                state
                    .observations
                    .iter()
                    .find(|o| {
                        o.revision == revision
                            && o.network == network
                            && o.value.provider == provider
                    })
                    .map(|o| o.value.clone())
                    .unwrap_or(WebSearchProviderObservationV1 {
                        provider,
                        status: None,
                        observed_at: None,
                        error: None,
                    })
            })
            .collect();
        Ok(WebSearchRuntimeSnapshot {
            revision,
            candidates,
            automatic: !matches!(legacy, Some("exa" | "bing"))
                && settings.search.mode == kcoder_config::WebSearchMode::Auto,
            observations,
        })
    }
    pub async fn execute(
        &self,
        input: WebSearchInput,
        ctx: &ToolContext,
    ) -> Result<WebSearchResponseV1, ToolError> {
        let context = super::lifecycle::context(ctx)?;
        let ctx = &context;
        let normalized = normalize_input(
            serde_json::to_value(input)
                .map_err(|_| ToolError::InvalidInput("Invalid search input".into()))?,
        )?;
        let shape = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&normalized).unwrap())
        );
        match self.receipts.claim(ctx, shape)? {
            super::receipts::Claim::Untracked => self.execute_inner(normalized, ctx, false).await,
            super::receipts::Claim::Existing(slot) => {
                slot.read(ctx, &ctx.abort_token.clone().unwrap_or_default())
                    .await
            }
            super::receipts::Claim::Owner(owner) => {
                let result = self.execute_inner(normalized, ctx, false).await;
                owner.complete(&result);
                result
            }
        }
    }
    pub async fn probe(
        &self,
        input: WebSearchInput,
        ctx: &ToolContext,
    ) -> Result<WebSearchResponseV1, ToolError> {
        if ctx
            .abort_token
            .as_ref()
            .is_some_and(|token| token.is_cancelled())
        {
            return Ok(rejected(WebSearchErrorKind::Cancelled));
        }
        let context = match super::lifecycle::context(ctx) {
            Ok(context) => context,
            Err(_) => return Ok(rejected(WebSearchErrorKind::PolicyDenied)),
        };
        self.execute_inner(input, &context, true).await
    }
    async fn execute_inner(
        &self,
        input: WebSearchInput,
        ctx: &ToolContext,
        probe: bool,
    ) -> Result<WebSearchResponseV1, ToolError> {
        let value = serde_json::to_value(input)
            .map_err(|_| ToolError::InvalidInput("Invalid search input".into()))?;
        let input = normalize_input(value)?;
        let cancel = ctx.abort_token.clone().unwrap_or_default();
        if cancel.is_cancelled() {
            return Ok(rejected(WebSearchErrorKind::Cancelled));
        }
        let legacy = legacy()?;
        let resolved = match policy::resolve(ctx, legacy.as_deref()) {
            Ok(resolved) => resolved,
            Err(error @ ToolError::SandboxDenied { .. }) => return Err(error),
            Err(error) => {
                return Ok(rejected(match error {
                    ToolError::Aborted => WebSearchErrorKind::Cancelled,
                    ToolError::InvalidInput(_) => WebSearchErrorKind::InvalidInput,
                    _ => WebSearchErrorKind::PolicyDenied,
                }));
            }
        };
        let snapshot = resolved.settings.clone();
        let revision = revision(&snapshot, legacy.as_deref())?;
        if let Some(reason) = host_rejection(ctx) {
            return Ok(rejected(reason));
        }
        if resolved.policy.clone().candidates().is_empty() {
            return Ok(rejected(WebSearchErrorKind::PolicyDenied));
        }
        let network = match self.network_generation(&snapshot.fetch) {
            Ok(key) => key,
            Err(_) => return Ok(rejected(WebSearchErrorKind::PolicyDenied)),
        };
        let key = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&input, &revision, network)).unwrap())
        );
        if !probe && !input.constraints.bypass_cache() {
            let cached = {
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                state
                    .cache
                    .retain(|item| item.inserted.elapsed() < CACHE_TTL);
                state
                    .cache
                    .iter()
                    .position(|item| item.key == key && item.owner.matches(&ctx.state))
                    .and_then(|index| state.cache.remove(index))
            };
            if let Some(item) = cached
                && item
                    .response
                    .provider
                    .is_some_and(|provider| resolved.guard.check(provider).is_ok())
            {
                let mut response = item.response.clone();
                response.request_id = uuid::Uuid::new_v4().to_string();
                response.cache_hit = true;
                response.cache_age_ms =
                    item.inserted.elapsed().as_millis().min(u64::MAX as u128) as u64;
                response.elapsed_ms = 0;
                response.attempts.clear();
                let report = input
                    .constraints
                    .filter_page(&mut response.page, chrono::Utc::now())?;
                response.page.incomplete |= report.limited_by_date_evidence();
                response.status = if response.page.incomplete {
                    WebSearchStatus::Partial
                } else if response.page.results.is_empty() {
                    WebSearchStatus::Empty
                } else {
                    WebSearchStatus::Success
                };
                for (i, hit) in response.page.results.iter_mut().enumerate() {
                    hit.source_id = format!("{}:{}", response.request_id, i + 1);
                }
                self.state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .cache
                    .push_back(item);
                return Ok(response);
            }
        }
        let started = tokio::time::Instant::now();
        let total = if resolved
            .policy
            .clone()
            .candidates()
            .contains(&WebSearchProvider::Searxng)
            && ctx
                .bundled_search_backend
                .as_ref()
                .is_some_and(|backend| backend.startup_pending())
        {
            Duration::from_secs(60)
        } else {
            routing::SEARCH_DEADLINE
        };
        let deadline = started + total;
        let _account = match super::account_admission::acquire(ctx, &cancel, deadline).await {
            Ok(permit) => permit,
            Err(error) => return Ok(rejected(error.kind)),
        };
        let permit = match self.permits.try_acquire() {
            Ok(permit) => permit,
            Err(_) => {
                if self
                    .queued
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                        (n < MAX_QUEUED).then_some(n + 1)
                    })
                    .is_err()
                {
                    return Ok(rejected(WebSearchErrorKind::RateLimited));
                }
                let queued = Queued(&self.queued);
                let permit = tokio::select! {biased;
                    ()=cancel.cancelled()=>return Ok(rejected(WebSearchErrorKind::Cancelled)),
                    result=tokio::time::timeout_at(deadline,self.permits.acquire())=>match result {Ok(Ok(permit))=>permit,_=>return Ok(rejected(WebSearchErrorKind::Timeout))},
                };
                drop(queued);
                permit
            }
        };
        let mut candidates = resolved.policy.candidates();
        if !probe && !candidates.is_empty() {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let original = candidates.clone();
            candidates.retain(|provider| {
                !state.observations.iter().any(|o| {
                    o.revision == revision
                        && o.network == network
                        && o.value.provider == *provider
                        && o.retry_at.is_some_and(|at| Instant::now() < at)
                })
            });
            if candidates.is_empty() {
                let earliest = state
                    .observations
                    .iter()
                    .filter(|o| {
                        o.revision == revision
                            && o.network == network
                            && original.contains(&o.value.provider)
                    })
                    .filter_map(|o| o.retry_at.map(|at| (at, o.value.provider)))
                    .min_by_key(|(at, _)| *at);
                if earliest.is_some() {
                    return Ok(rejected(WebSearchErrorKind::RateLimited));
                }
            }
        }
        let backend = routing::BuiltinBackend {
            client: &self.client,
            bundled: ctx.bundled_search_backend.as_deref(),
            guard: &resolved.guard,
            ctx,
        };
        let mut response = routing::run_search_with_limits(
            &backend,
            &input,
            routing::SearchPolicy::Configured(candidates),
            &cancel,
            deadline.saturating_duration_since(tokio::time::Instant::now()),
            routing::ATTEMPT_DEADLINE,
        )
        .await;
        let denied = response.provider.and_then(|provider| {
            resolved
                .guard
                .check(provider)
                .err()
                .map(|error| error.kind)
                .or_else(|| host_rejection(ctx))
        });
        if let Some(reason) = denied {
            response.status = if reason == WebSearchErrorKind::Cancelled {
                WebSearchStatus::Cancelled
            } else {
                WebSearchStatus::Failed
            };
            response.failure = Some(reason);
            response.page = Default::default();
            if let Some(attempt) = response.attempts.last_mut() {
                attempt.status = response.status;
                attempt.error = Some(reason);
            }
        }
        drop(permit);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for attempt in &response.attempts {
            if matches!(
                attempt.error,
                Some(
                    WebSearchErrorKind::PolicyDenied
                        | WebSearchErrorKind::InvalidInput
                        | WebSearchErrorKind::Unsupported
                )
            ) || attempt.status == WebSearchStatus::Cancelled
            {
                continue;
            }
            state.observations.retain(|o| {
                o.revision != revision
                    || o.network != network
                    || o.value.provider != attempt.provider
            });
            state.observations.push_front(Observation {
                revision: revision.clone(),
                network,
                value: WebSearchProviderObservationV1 {
                    provider: attempt.provider,
                    status: Some(attempt.status),
                    observed_at: Some(chrono::Utc::now().to_rfc3339()),
                    error: attempt.error,
                },
                retry_at: attempt
                    .error
                    .map(|_| Instant::now() + Duration::from_secs(20)),
            });
        }
        state.observations.truncate(192);
        if !probe
            && !input.constraints.bypass_cache()
            && response.status == WebSearchStatus::Success
        {
            let bytes = serde_json::to_vec(&response).unwrap().len();
            if bytes <= CACHE_BYTES {
                while state.cache.len() >= CACHE_ENTRIES
                    || state.cache.iter().map(|v| v.bytes).sum::<usize>() + bytes > CACHE_BYTES
                {
                    state.cache.pop_front();
                }
                state.cache.push_back(Cached {
                    owner: ctx.web_resources.lifecycle_owner(&ctx.state)?,
                    key,
                    inserted: Instant::now(),
                    bytes,
                    response: response.clone(),
                });
            }
        }
        Ok(response)
    }
}

impl ToolContext {
    pub fn with_web_search_runtime(mut self, runtime: Arc<WebSearchRuntime>) -> Self {
        self.web_search_runtime = Some(runtime);
        self
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod lifecycle_tests;
