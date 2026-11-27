//! Explicit diagnostics share the native search runtime and never replay on reads.
use super::*;
use kcoder_app_protocol::{
    WEB_SEARCH_PROBE_CANCEL, WEB_SEARCH_PROBE_READ, WEB_SEARCH_PROBE_START, WEB_SEARCH_STATUS_READ,
    WebSearchProbeReadParams, WebSearchProbeResult, WebSearchProbeStartParams, WebSearchProbeState,
    WebSearchStatusReadParams,
};

const PROBE_LIMIT: usize = 32;
use super::engine_factory::web_search::probe_input_json;
#[derive(Debug)]
struct Probe {
    result: WebSearchProbeResult,
    mode: kcoder_types::StudioWorkMode,
    thread_id: Option<String>,
    cancel: CancellationToken,
}
struct CompletionGuard(Arc<StdMutex<Probe>>);
impl Drop for CompletionGuard {
    fn drop(&mut self) {
        let mut probe = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if probe.result.state == WebSearchProbeState::Running {
            probe.result.state = if probe.cancel.is_cancelled() {
                WebSearchProbeState::Cancelled
            } else {
                WebSearchProbeState::Unknown
            };
        }
    }
}
#[derive(Debug, Default)]
pub(super) struct SearchDiagnostics {
    entries: HashMap<String, Arc<StdMutex<Probe>>>,
}
impl Drop for SearchDiagnostics {
    fn drop(&mut self) {
        for probe in self.entries.values() {
            probe
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .cancel
                .cancel();
        }
    }
}
impl SearchDiagnostics {
    fn read(
        &self,
        target: &str,
        params: &WebSearchProbeReadParams,
        cancel: bool,
    ) -> Result<WebSearchProbeResult> {
        let Some(probe) = self.entries.get(&params.request_id) else {
            return Ok(WebSearchProbeResult {
                target_id: target.into(),
                request_id: params.request_id.clone(),
                revision: params.expected_revision.clone(),
                state: WebSearchProbeState::Unknown,
                response: None,
            });
        };
        let mut probe = probe.lock().unwrap_or_else(|p| p.into_inner());
        ensure!(
            probe.result.target_id == target && probe.result.revision == params.expected_revision,
            "SEARCH_PROBE_BINDING_CONFLICT"
        );
        if cancel && probe.result.state == WebSearchProbeState::Running {
            probe.cancel.cancel();
            probe.result.state = WebSearchProbeState::Cancelled;
        }
        Ok(probe.result.clone())
    }
    fn existing_start(
        &self,
        target: &str,
        params: &WebSearchProbeStartParams,
    ) -> Result<Option<WebSearchProbeResult>> {
        let Some(probe) = self.entries.get(&params.request_id) else {
            return Ok(None);
        };
        let probe = probe.lock().unwrap_or_else(|p| p.into_inner());
        ensure!(
            probe.result.target_id == target
                && probe.result.revision == params.expected_revision
                && probe.mode == params.mode
                && probe.thread_id == params.thread_id,
            "SEARCH_PROBE_BINDING_CONFLICT"
        );
        Ok(Some(probe.result.clone()))
    }
    fn start(
        &mut self,
        target: &str,
        params: WebSearchProbeStartParams,
        binding: engine_factory::web_search::SearchDiagnosticBinding,
        owner_cancel: CancellationToken,
    ) -> Result<WebSearchProbeResult> {
        ensure!(
            !params.request_id.is_empty()
                && params.request_id.len() <= 128
                && params
                    .request_id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_".contains(c)),
            "SEARCH_PROBE_INVALID_ID"
        );
        if let Some(result) = self.existing_start(target, &params)? {
            return Ok(result);
        }
        ensure!(
            self.entries.len() < PROBE_LIMIT,
            "SEARCH_PROBE_RECEIPT_LIMIT"
        );
        ensure!(
            binding.status.revision == params.expected_revision,
            "SEARCH_REVISION_CONFLICT"
        );
        ensure!(binding.permitted, "SEARCH_PROBE_POLICY_DENIED");
        let result = WebSearchProbeResult {
            target_id: target.into(),
            request_id: params.request_id.clone(),
            revision: params.expected_revision,
            state: WebSearchProbeState::Running,
            response: None,
        };
        let probe = Arc::new(StdMutex::new(Probe {
            result: result.clone(),
            mode: params.mode,
            thread_id: params.thread_id,
            cancel: owner_cancel.clone(),
        }));
        self.entries.insert(params.request_id, probe.clone());
        tokio::spawn(async move {
            let _completion = CompletionGuard(probe.clone());
            let input = serde_json::from_value(probe_input_json()).expect("fixed diagnostic input");
            let response = tokio::select! {
                biased;
                _ = owner_cancel.cancelled() => None,
                result = binding.runtime.probe(input, &binding.context) => result.ok(),
            };
            let mut probe = probe.lock().unwrap_or_else(|p| p.into_inner());
            if probe.result.state == WebSearchProbeState::Cancelled || owner_cancel.is_cancelled() {
                probe.result.state = WebSearchProbeState::Cancelled;
            } else {
                probe.result.state = if response.is_some() {
                    WebSearchProbeState::Completed
                } else {
                    WebSearchProbeState::Unknown
                };
                probe.result.response = response;
            }
        });
        Ok(result)
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "Explicit target and connection ownership at RPC boundary"
)]
pub(super) async fn dispatch(
    method: &str,
    id: &Value,
    params: &Value,
    host: &QueryEngine,
    factory: &AppServerEngineFactory,
    manager: &ThreadManager,
    target: &str,
    state: &mut ConnectionState,
    outbound: &mpsc::Sender<Value>,
) -> Result<bool> {
    if !matches!(
        method,
        WEB_SEARCH_STATUS_READ
            | WEB_SEARCH_PROBE_START
            | WEB_SEARCH_PROBE_READ
            | WEB_SEARCH_PROBE_CANCEL
    ) {
        return Ok(false);
    }
    let enabled = if method == WEB_SEARCH_STATUS_READ {
        state.web_search_status_v1
    } else {
        state.web_search_probe_v1
    };
    let result: Result<Value> = (|| {
        ensure!(enabled, "SEARCH_DIAGNOSTIC_UNSUPPORTED");
        if matches!(method, WEB_SEARCH_PROBE_READ | WEB_SEARCH_PROBE_CANCEL) {
            let params: WebSearchProbeReadParams = serde_json::from_value(params.clone())?;
            return Ok(serde_json::to_value(state.web_search_diagnostics.read(
                target,
                &params,
                method == WEB_SEARCH_PROBE_CANCEL,
            )?)?);
        }
        let (request, start) = if method == WEB_SEARCH_PROBE_START {
            let start: WebSearchProbeStartParams = serde_json::from_value(params.clone())?;
            if let Some(receipt) = state
                .web_search_diagnostics
                .existing_start(target, &start)?
            {
                return Ok(serde_json::to_value(receipt)?);
            }
            (
                WebSearchStatusReadParams {
                    mode: start.mode,
                    thread_id: start.thread_id.clone(),
                },
                Some(start),
            )
        } else {
            (
                kcoder_app_rpc_codec::decode::<WebSearchStatusReadParams>(params.clone())?,
                None,
            )
        };
        let resident = request
            .thread_id
            .as_deref()
            .map(|thread| manager.engine(thread).context("SEARCH_THREAD_NOT_RESIDENT"))
            .transpose()?;
        let cancel = state.input_ended.child_token();
        let binding = factory.web_search_diagnostic(
            host,
            resident.as_ref(),
            &request,
            target,
            cancel.clone(),
            start.is_some(),
        )?;
        Ok(match start {
            Some(start) => serde_json::to_value(
                state
                    .web_search_diagnostics
                    .start(target, start, binding, cancel)?,
            )?,
            None => serde_json::to_value(binding.status)?,
        })
    })();
    let response = match result {
        Ok(value) => success_response(id.clone(), value),
        Err(error) => error_response(id.clone(), -32602, &error.to_string()),
    };
    send(outbound, response).await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(state: WebSearchProbeState) -> Arc<StdMutex<Probe>> {
        Arc::new(StdMutex::new(Probe {
            result: WebSearchProbeResult {
                target_id: "target-a".into(),
                request_id: "probe-a".into(),
                revision: "r1".into(),
                state,
                response: None,
            },
            mode: kcoder_types::StudioWorkMode::Kcoder,
            thread_id: None,
            cancel: CancellationToken::new(),
        }))
    }
    fn read_params() -> WebSearchProbeReadParams {
        WebSearchProbeReadParams {
            request_id: "probe-a".into(),
            expected_revision: "r1".into(),
        }
    }
    #[test]
    fn repeated_read_never_dispatches_and_peer_owner_cannot_cancel() {
        let owner = SearchDiagnostics {
            entries: HashMap::from([("probe-a".into(), entry(WebSearchProbeState::Running))]),
        };
        for _ in 0..5 {
            assert_eq!(
                owner.read("target-a", &read_params(), false).unwrap().state,
                WebSearchProbeState::Running
            );
        }
        assert!(owner.read("target-b", &read_params(), true).is_err());
        let peer = SearchDiagnostics::default();
        assert_eq!(
            peer.read("target-a", &read_params(), true).unwrap().state,
            WebSearchProbeState::Unknown
        );
        assert!(
            !owner.entries["probe-a"]
                .lock()
                .unwrap()
                .cancel
                .is_cancelled()
        );
    }
    #[test]
    fn repeated_start_reconciles_unknown_without_rechecking_or_dispatching() {
        let owner = SearchDiagnostics {
            entries: HashMap::from([("probe-a".into(), entry(WebSearchProbeState::Unknown))]),
        };
        let mut params = WebSearchProbeStartParams {
            request_id: "probe-a".into(),
            expected_revision: "r1".into(),
            mode: kcoder_types::StudioWorkMode::Kcoder,
            thread_id: None,
        };
        assert_eq!(
            owner
                .existing_start("target-a", &params)
                .unwrap()
                .unwrap()
                .state,
            WebSearchProbeState::Unknown
        );
        params.mode = kcoder_types::StudioWorkMode::Kworker;
        assert!(owner.existing_start("target-a", &params).is_err());
    }
    #[test]
    fn cancel_is_terminal_and_wrong_revision_does_not_cancel() {
        let entry = entry(WebSearchProbeState::Running);
        let owner = SearchDiagnostics {
            entries: HashMap::from([("probe-a".into(), entry.clone())]),
        };
        let mut wrong = read_params();
        wrong.expected_revision = "r2".into();
        assert!(owner.read("target-a", &wrong, true).is_err());
        assert!(!entry.lock().unwrap().cancel.is_cancelled());
        assert_eq!(
            owner.read("target-a", &read_params(), true).unwrap().state,
            WebSearchProbeState::Cancelled
        );
        drop(CompletionGuard(entry.clone()));
        assert_eq!(
            entry.lock().unwrap().result.state,
            WebSearchProbeState::Cancelled
        );
    }
    #[test]
    fn owner_drop_cancels_only_owned_diagnostics_and_missing_completion_is_unknown() {
        let ours = entry(WebSearchProbeState::Running);
        let peer = entry(WebSearchProbeState::Running);
        let owner = SearchDiagnostics {
            entries: HashMap::from([("probe-a".into(), ours.clone())]),
        };
        drop(owner);
        assert!(ours.lock().unwrap().cancel.is_cancelled());
        assert!(!peer.lock().unwrap().cancel.is_cancelled());
        drop(CompletionGuard(peer.clone()));
        assert_eq!(
            peer.lock().unwrap().result.state,
            WebSearchProbeState::Unknown
        );
        assert_eq!(
            probe_input_json()["query"],
            "KCoder web search connectivity check"
        );
    }
}
