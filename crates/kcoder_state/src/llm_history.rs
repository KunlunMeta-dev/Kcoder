use super::*;

pub(super) const LLM_EXCHANGE_HISTORY_LIMIT: usize = 30;

#[derive(Debug, Clone)]
pub(super) struct LlmRequestHistoryLocation {
    pub(super) dir: PathBuf,
    pub(super) session_id: String,
}

impl AppState {
    /// Hosts explicitly select a profile; in-memory tests never infer a user home.
    pub fn set_usage_history_root(&self, root: Option<&Path>) {
        *self
            .usage_history_root
            .write()
            .unwrap_or_else(|error| error.into_inner()) = root.map(Path::to_path_buf);
    }

    pub fn usage_history_root(&self) -> Option<PathBuf> {
        self.usage_history_root
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn record_usage_history(&self, request: &MessagesRequest, events: &[StreamEvent]) {
        self.record_token_usage(&request.model, summarize_llm_usage(events).as_ref());
    }

    /// Record aggregate counters for model requests outside the main conversation stream.
    pub fn record_token_usage(&self, model: &str, usage: Option<&Usage>) {
        if let Some(root) = self.usage_history_root()
            && let Err(error) =
                crate::usage_history::record_usage(&root, model, usage, now_millis())
        {
            warn!("failed to persist token usage counters: {error}");
        }
    }

    /// Route raw LLM exchange artifacts to an explicit directory.
    ///
    /// Forked sub-agent engines do not own the parent's JSONL transcript, but
    /// their provider requests should still be persisted under the parent's
    /// session artifact tree.
    pub fn with_llm_request_history_dir(
        &self,
        dir: impl Into<PathBuf>,
        session_id: impl Into<String>,
    ) {
        self.write_inner().llm_request_history_override = Some(LlmRequestHistoryLocation {
            dir: dir.into(),
            session_id: session_id.into(),
        });
    }

    /// Directory where this session stores raw LLM request/response artifacts.
    pub fn llm_request_history_dir(&self) -> Option<PathBuf> {
        self.llm_request_history_location().map(|(dir, _)| dir)
    }

    /// Directory where session-memory maintenance stores raw LLM artifacts.
    pub fn session_memory_llm_request_history_dir(&self) -> Option<PathBuf> {
        self.llm_request_history_location()
            .map(|(dir, _)| dir.join("session-memory"))
    }

    /// Persist one model exchange next to the session artifacts.
    pub fn record_llm_exchange(
        &self,
        request: &MessagesRequest,
        response_events: &[StreamEvent],
        error: Option<&str>,
    ) {
        self.record_usage_history(request, response_events);
        let Some((dir, session_id)) = self.llm_request_history_location() else {
            return;
        };
        if let Err(err) =
            write_llm_exchange_record(&dir, &session_id, request, response_events, error)
        {
            warn!("failed to persist LLM request/response artifact: {err}");
        }
    }

    /// Persist one session-memory model exchange under `llm-requests/session-memory`.
    pub fn record_session_memory_llm_exchange(
        &self,
        request: &MessagesRequest,
        response_events: &[StreamEvent],
        error: Option<&str>,
    ) {
        self.record_usage_history(request, response_events);
        let Some((dir, session_id)) = self.llm_request_history_location() else {
            return;
        };
        let dir = dir.join("session-memory");
        if let Err(err) =
            write_llm_exchange_record(&dir, &session_id, request, response_events, error)
        {
            warn!("failed to persist session-memory LLM request/response artifact: {err}");
        }
    }

    fn llm_request_history_location(&self) -> Option<(PathBuf, String)> {
        let inner = self.read_inner();
        if let Some(location) = inner.llm_request_history_override.clone() {
            return Some((location.dir, location.session_id));
        }
        Self::session_artifact_project_dir_and_id(&inner).map(|(project_dir, session_id)| {
            (
                llm_request_history_dir_path(project_dir, &session_id),
                session_id,
            )
        })
    }
}

#[derive(Serialize)]
struct LlmExchangeRecord<'a> {
    schema: &'static str,
    session_id: &'a str,
    timestamp_ms: u64,
    request: &'a MessagesRequest,
    request_metadata: LlmRequestMetadata<'a>,
    response: LlmExchangeResponse<'a>,
}

#[derive(Serialize)]
struct LlmRequestMetadata<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<&'a str>,
    has_response_json_schema: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    debug_session_id: Option<&'a str>,
}

#[derive(Serialize)]
struct LlmExchangeResponse<'a> {
    events: DiagnosticEvents<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<Usage>,
    prompt_cache: PromptCacheSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a kcoder_types::ProviderErrorSummary>,
}

struct DiagnosticEvents<'a>(&'a [StreamEvent]);

impl Serialize for DiagnosticEvents<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for event in self.0 {
            match event {
                StreamEvent::Error { error } => {
                    sequence.serialize_element(&StreamEvent::Error {
                        error: error.diagnostic_projection(),
                    })?
                }
                _ => sequence.serialize_element(event)?,
            }
        }
        sequence.end()
    }
}

#[derive(Debug, Serialize)]
struct PromptCacheSummary {
    status: PromptCacheStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_creation_input_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_read_input_tokens: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum PromptCacheStatus {
    Hit,
    Miss,
    NotReported,
}

fn summarize_llm_usage(events: &[StreamEvent]) -> Option<Usage> {
    let mut summary: Option<Usage> = None;
    for usage in events.iter().filter_map(|event| match event {
        StreamEvent::MessageStart { message } => message.usage.as_ref(),
        StreamEvent::MessageDelta { delta } => delta.usage.as_ref(),
        _ => None,
    }) {
        merge_usage_max(&mut summary, usage);
    }
    summary
}

fn merge_usage_max(summary: &mut Option<Usage>, usage: &Usage) {
    let Some(current) = summary.as_mut() else {
        *summary = Some(usage.clone());
        return;
    };
    current.merge_stream_update(usage);
}

fn prompt_cache_summary(usage: Option<&Usage>) -> PromptCacheSummary {
    let cache_creation_input_tokens = usage.and_then(|usage| usage.cache_creation_input_tokens);
    let cache_read_input_tokens = usage.and_then(|usage| usage.cache_read_input_tokens);
    let status = match (cache_creation_input_tokens, cache_read_input_tokens) {
        (_, Some(tokens)) if tokens > 0 => PromptCacheStatus::Hit,
        (Some(_), _) | (_, Some(_)) => PromptCacheStatus::Miss,
        (None, None) => PromptCacheStatus::NotReported,
    };
    PromptCacheSummary {
        status,
        cache_creation_input_tokens,
        cache_read_input_tokens,
    }
}

pub(super) fn write_llm_exchange_record(
    dir: &Path,
    session_id: &str,
    request: &MessagesRequest,
    response_events: &[StreamEvent],
    error: Option<&str>,
) -> anyhow::Result<PathBuf> {
    fs::create_dir_all(dir)
        .with_context(|| format!("failed to create LLM request history dir {:?}", dir))?;
    set_private_dir_permissions(dir)?;

    let timestamp_ms = now_millis();
    let content = encode_llm_exchange(session_id, request, response_events, error, timestamp_ms)?;
    let path = dir.join(llm_exchange_file_name(timestamp_ms));
    fs::write(&path, content)
        .with_context(|| format!("failed to write LLM request/response artifact {:?}", path))?;
    if let Err(error) = set_private_file_permissions(&path) {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    prune_llm_exchange_history(dir)?;
    Ok(path)
}

pub(super) fn encode_llm_exchange(
    session_id: &str,
    request: &MessagesRequest,
    response_events: &[StreamEvent],
    error: Option<&str>,
    timestamp_ms: u64,
) -> anyhow::Result<Vec<u8>> {
    let safe_error = error.map(|_| kcoder_types::ProviderErrorSummary::new("unknown_error", None));
    encode_llm_exchange_with_summary(
        session_id,
        request,
        response_events,
        safe_error.as_ref(),
        timestamp_ms,
    )
}

pub(super) fn encode_llm_exchange_with_summary(
    session_id: &str,
    request: &MessagesRequest,
    response_events: &[StreamEvent],
    error: Option<&kcoder_types::ProviderErrorSummary>,
    timestamp_ms: u64,
) -> anyhow::Result<Vec<u8>> {
    let usage = summarize_llm_usage(response_events);
    let prompt_cache = prompt_cache_summary(usage.as_ref());
    info!(
        target: "kcoder_state::llm_cache",
        session_id,
        model = %request.model,
        status = ?prompt_cache.status,
        cache_creation_input_tokens = prompt_cache.cache_creation_input_tokens.unwrap_or(0),
        cache_read_input_tokens = prompt_cache.cache_read_input_tokens.unwrap_or(0),
        "upstream prompt cache usage"
    );
    let record = LlmExchangeRecord {
        schema: "kcoder.llm_exchange.v2",
        session_id,
        timestamp_ms,
        request,
        request_metadata: LlmRequestMetadata {
            reasoning_effort: request
                .reasoning_effort
                .as_ref()
                .map(|effort| effort.as_str()),
            has_response_json_schema: request.response_json_schema.is_some(),
            debug_session_id: request.debug_session_id.as_deref(),
        },
        response: LlmExchangeResponse {
            events: DiagnosticEvents(response_events),
            usage,
            prompt_cache,
            error,
        },
    };
    let mut output = BoundedEncoding(Vec::new());
    serde_json::to_writer(&mut output, &record)?;
    output.write_all(b"\n")?;
    Ok(output.0)
}

struct BoundedEncoding(Vec<u8>);

impl Write for BoundedEncoding {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > (64 * 1024 * 1024usize).saturating_sub(self.0.len()) {
            return Err(std::io::Error::other(
                "LLM diagnostic encoding exceeds 64 MiB",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(super) fn llm_exchange_file_name(timestamp_ms: u64) -> String {
    static LLM_EXCHANGE_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);
    let sequence = LLM_EXCHANGE_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "{timestamp_ms:013}-{sequence:016x}-{}.json",
        generate_transcript_uuid()
    )
}

fn prune_llm_exchange_history(dir: &Path) -> anyhow::Result<()> {
    let mut files = fs::read_dir(dir)
        .with_context(|| format!("failed to read LLM request history dir {:?}", dir))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_file() {
                return None;
            }
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
                Some(path)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    files.sort();
    let remove_count = files.len().saturating_sub(LLM_EXCHANGE_HISTORY_LIMIT);
    for path in files.into_iter().take(remove_count) {
        if let Err(err) = fs::remove_file(&path) {
            warn!(
                "failed to prune old LLM request/response artifact {:?}: {err}",
                path
            );
        }
    }
    Ok(())
}

fn set_private_dir_permissions(_path: &Path) -> anyhow::Result<()> {
    kcoder_config::set_user_only_dir_permissions(_path)
        .with_context(|| format!("failed to set private dir permissions for {:?}", _path))
}

fn set_private_file_permissions(_path: &Path) -> anyhow::Result<()> {
    kcoder_config::set_user_only_file_permissions(_path)
        .with_context(|| format!("failed to set private file permissions for {:?}", _path))
}

#[cfg(test)]
mod usage_tests {
    use super::*;

    #[test]
    fn bounded_encoding_stops_before_allocating_an_oversized_write() {
        let mut output = BoundedEncoding(Vec::new());
        let oversized = vec![b'x'; 64 * 1024 * 1024 + 1];
        assert!(output.write_all(&oversized).is_err());
        assert_eq!(output.0.capacity(), 0);
        output.write_all(b"{}").unwrap();
        assert_eq!(output.0, b"{}");
    }

    #[test]
    fn v2_encoder_is_compact_and_preserves_usage_metadata() {
        let request = MessagesRequest::new("model", vec![Message::user_text("hello")]);
        let bytes = encode_llm_exchange("session", &request, &[], None, 123).unwrap();
        assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 1);
        let record: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(record["timestamp_ms"], 123);
        assert_eq!(record["schema"], "kcoder.llm_exchange.v2");
        assert_eq!(record["response"]["prompt_cache"]["status"], "not_reported");
    }

    #[test]
    fn usage_survives_raw_history_pruning_and_historyless_memory_requests() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path());
        state.with_history_path(dir.path().join("session.jsonl"));
        let root = dir.path().join("usage");
        state.set_usage_history_root(Some(&root));
        let request =
            MessagesRequest::new("usage-model", vec![Message::user_text("private prompt")]);
        let event = StreamEvent::MessageDelta {
            delta: kcoder_types::MessageDeltaFields {
                stop_reason: None,
                stop_sequence: None,
                usage: Some(Usage {
                    input_tokens: 100,
                    output_tokens: 20,
                    total_tokens: Some(120),
                    cache_read_input_tokens: Some(80),
                    cache_creation_input_tokens: None,
                    iterations: None,
                }),
            },
        };
        for _ in 0..40 {
            state.record_llm_exchange(&request, std::slice::from_ref(&event), None);
        }
        let fork = AppState::new(dir.path());
        fork.set_usage_history_root(state.usage_history_root().as_deref());
        fork.record_session_memory_llm_exchange(&request, &[event], None);
        let history = crate::usage_history::read_usage(&root).unwrap().unwrap();
        let counters = &history.days.values().next().unwrap()["usage-model"];
        assert_eq!(counters.requests, 41);
        assert_eq!(counters.total_tokens, 41 * 120);
        assert!(
            !fs::read_to_string(root.join("usage.json"))
                .unwrap()
                .contains("private prompt")
        );
        assert_eq!(
            fs::read_dir(state.llm_request_history_dir().unwrap())
                .unwrap()
                .count(),
            LLM_EXCHANGE_HISTORY_LIMIT
        );
    }

    #[test]
    fn final_provider_total_is_preserved_when_start_only_had_input_usage() {
        let mut summary = Some(Usage {
            input_tokens: 100,
            output_tokens: 0,
            total_tokens: None,
            cache_read_input_tokens: Some(80),
            cache_creation_input_tokens: None,
            iterations: None,
        });
        merge_usage_max(
            &mut summary,
            &Usage {
                input_tokens: 0,
                output_tokens: 20,
                total_tokens: Some(120),
                cache_read_input_tokens: None,
                cache_creation_input_tokens: None,
                iterations: None,
            },
        );
        let result = summary.unwrap();
        assert_eq!(result.total_tokens, Some(120));
        assert_eq!(result.cache_read_input_tokens, Some(80));
    }
}
