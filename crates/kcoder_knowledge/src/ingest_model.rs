//! Host-injected model interface for Wiki preparation: single structured JSON
//! requests for analysis/verification and multi-turn tool requests for the
//! file contract. Implementations own transport, budgets and persistence.
use super::*;
use kcoder_types::{ContentBlock, Message, ToolDefinition};

#[derive(Debug, Clone)]
pub struct WikiModelRequest {
    pub stage: &'static str,
    pub system: String,
    pub user: String,
    pub max_output_tokens: u32,
}
impl WikiModelRequest {
    /// Exact 0.3.11 host contract spellings for lookup only; all current source,
    /// page, model, purpose and publication checks still apply to replayed bytes.
    pub fn recent_format_cache_requests(&self) -> Result<Vec<Self>> {
        recent_model_contract::requests(self)
    }
    /// Exact prior prompt spelling for private cache lookup only. Replaying it
    /// still uses the current parser, source ownership and publication checks.
    pub fn legacy_format_cache_request(&self) -> Result<Option<Self>> {
        legacy_model_contract::request(self)
    }
}

/// A typed provider length stop. Partial JSON is never treated as a proposal.
#[derive(Debug)]
pub struct WikiOutputTruncated {
    pub stage: &'static str,
    pub text_bytes: usize,
    pub reasoning_bytes: usize,
    pub requested_tokens: u32,
    pub reported_output_tokens: Option<u64>,
    pub stop_reason: String,
}
impl std::fmt::Display for WikiOutputTruncated {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Wiki model output was truncated (stage={}, requested_tokens={}, text_bytes={}, reasoning_bytes={}, stop_reason={})",
            self.stage,
            self.requested_tokens,
            self.text_bytes,
            self.reasoning_bytes,
            self.stop_reason
        )
    }
}
impl std::error::Error for WikiOutputTruncated {}

/// One immutable source chunk cannot fit the selected context with the minimum
/// output allowance. Chunks are never split or truncated, so a retry with the
/// same model cannot progress; this is reported before any paid request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiSourceChunkExceedsContext {
    pub chunk_id: String,
    pub chunk_bytes: usize,
    pub estimated_input_tokens: usize,
    pub context_tokens: usize,
}
impl std::fmt::Display for WikiSourceChunkExceedsContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "knowledge context budget exceeded: source {} ({} bytes, about {} input tokens with the analysis contract) cannot fit a {}-token model context; select a model with a larger context window (the chunk is never split or truncated)",
            self.chunk_id, self.chunk_bytes, self.estimated_input_tokens, self.context_tokens
        )
    }
}
impl std::error::Error for WikiSourceChunkExceedsContext {}
#[async_trait]
pub trait WikiModel: Send + Sync {
    async fn complete(&self, request: WikiModelRequest) -> Result<String>;
    /// The host holds the library merge lease through publication or attempt
    /// failure. Source analysis may run before this slot; mutable page reads may
    /// not. This no-op keeps pure domain fixtures and headless adapters compatible.
    async fn acquire_merge_slot(&self, _cancel: &CancellationToken) -> Result<()> {
        Ok(())
    }
    /// Persistent hosts opt into independently recoverable topic nodes.
    fn supports_staged_topics(&self) -> bool {
        false
    }
    fn stage_begin(&self, _request: &WikiModelRequest) -> Result<()> {
        Ok(())
    }
    fn stage_received_response(&self, _request: &WikiModelRequest) -> Result<Option<String>> {
        Ok(None)
    }
    /// Only a fully terminated, non-truncated provider response may be recorded.
    /// Syntax and factual validity are separate later states.
    fn stage_remember_received(&self, _request: &WikiModelRequest, _raw: &str) -> Result<()> {
        Ok(())
    }
    fn stage_validated_output(&self, _request: &WikiModelRequest) -> Result<Option<String>> {
        Ok(None)
    }
    fn stage_mark_validated(&self, _request: &WikiModelRequest, _canonical: &str) -> Result<()> {
        Ok(())
    }
    fn stage_mark_completed(&self, _request: &WikiModelRequest, _canonical: &str) -> Result<()> {
        Ok(())
    }
    fn stage_mark_failed(
        &self,
        _request: &WikiModelRequest,
        _code: &str,
        _field: &str,
    ) -> Result<()> {
        Ok(())
    }
    fn stage_mark_needs_review(
        &self,
        _request: &WikiModelRequest,
        _canonical: &str,
        _code: &str,
        _field: &str,
    ) -> Result<()> {
        Ok(())
    }
    /// Apply the final input-aware context ceiling to the actual wire request.
    async fn complete_with_output_limit(
        &self,
        mut request: WikiModelRequest,
        limit: u32,
    ) -> Result<String> {
        request.max_output_tokens = request.max_output_tokens.min(limit);
        self.complete(request).await
    }
    /// Hosts use the shared request estimator; the default is a conservative
    /// byte upper bound for implementations without an audited tokenizer.
    fn estimate_input_tokens(&self, request: &WikiModelRequest) -> usize {
        request
            .system
            .len()
            .saturating_add(request.user.len())
            .saturating_add(512)
    }
    /// The host may reserve more output for a configured reasoning model.
    fn output_token_budget(&self, suggested: u32) -> Result<u32> {
        Ok(suggested)
    }

    /// Host reports remaining persisted repairs in this original chunk window.
    /// The orchestrator also subtracts its local counter and never raises quota.
    fn remaining_shared_repairs(&self) -> Result<u32> {
        Ok(3)
    }

    fn batch_identity(&self) -> String {
        String::new()
    }
    fn restored_through_chunk(&self) -> Result<Option<usize>> {
        Ok(None)
    }
    fn source_range(
        &self,
        _through: usize,
        _first_page: Option<u32>,
        _last_page: Option<u32>,
    ) -> Result<()> {
        Ok(())
    }
    fn cached_proposal(&self, _request: &WikiModelRequest) -> Result<Option<WikiProposal>> {
        Ok(None)
    }
    /// Complete, schema-parsed responses are private recovery inputs, not
    /// validated candidates. Every downstream identity, proof and evidence
    /// check must still run when replaying one.
    fn cached_json_response(&self, _request: &WikiModelRequest) -> Result<Option<String>> {
        Ok(None)
    }
    fn remember_json_response(&self, _request: &WikiModelRequest, _raw: &str) -> Result<()> {
        Ok(())
    }
    fn forget_json_response(&self, _request: &WikiModelRequest) -> Result<()> {
        Ok(())
    }
    /// Parsed and structurally checked candidates are private staging data.
    /// Citation validation MUST run again after restoring one.
    fn remember_proposal(
        &self,
        _request: &WikiModelRequest,
        _proposal: &WikiProposal,
    ) -> Result<()> {
        Ok(())
    }

    fn remember_analysis(
        &self,
        _request: &WikiModelRequest,
        _analysis: &WikiAnalysis,
    ) -> Result<()> {
        Ok(())
    }

    /// The job uses the file contract (pipeline version 2).
    fn file_contract(&self) -> bool {
        false
    }
    /// One tool-loop turn under the same budget, admission and usage rules as
    /// `complete`. `limit` is the final context-aware output ceiling.
    async fn complete_turn(
        &self,
        _request: WikiTurnRequest,
        _limit: u32,
    ) -> Result<WikiTurnResponse> {
        anyhow::bail!("this Wiki model host does not support tool turns")
    }
    fn estimate_turn_input_tokens(&self, request: &WikiTurnRequest) -> usize {
        serde_json::to_vec(&request.messages)
            .map_or(usize::MAX / 4, |bytes| bytes.len())
            .saturating_add(request.system.len())
            .saturating_add(
                request
                    .tools
                    .iter()
                    .map(|tool| tool.description.len() + tool.input_schema.to_string().len())
                    .sum::<usize>(),
            )
            .saturating_add(512)
    }
    /// Persisted steps of one loop in step order. Hosts without persistence
    /// return none, so a restart simply asks the model again.
    fn tool_steps(&self, _loop_key: &str) -> Result<Vec<WikiToolStep>> {
        Ok(Vec::new())
    }
    /// Insert or replace one step (received, then applied).
    fn tool_step_save(&self, _step: &WikiToolStep) -> Result<()> {
        Ok(())
    }
    /// Drop steps at and after `from_step`; their responses no longer apply.
    fn tool_steps_discard(&self, _loop_key: &str, _from_step: usize) -> Result<()> {
        Ok(())
    }
    /// Public counters of persisted turns and executed tool calls.
    fn tool_progress(&self, _turns: u32, _calls: u32) -> Result<()> {
        Ok(())
    }
    /// Optional last chunk ordinal of an explicit pending-organize job.
    fn source_window_limit(&self) -> Result<Option<usize>> {
        Ok(None)
    }
}

/// One request of the file-contract tool loop. The full transcript is sent;
/// only the Wiki worker's own `read`/`edit`/`write` tools are offered.
#[derive(Debug, Clone)]
pub struct WikiTurnRequest {
    /// Budget stage: generation, tool_step, a shared repair stage or truncation_retry.
    pub stage: &'static str,
    pub system: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDefinition>,
    pub max_output_tokens: u32,
    /// Stable per-batch prompt-cache identity; never contains source text.
    pub cache_key: String,
    /// The first request of a loop. A provider rejection of it without any
    /// content is reported as [`WikiToolsRejected`].
    pub first_turn: bool,
}

/// A complete, non-truncated provider response with every assistant block,
/// including thinking text, signatures and redacted thinking, for exact replay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiTurnResponse {
    pub content: Vec<ContentBlock>,
    /// Tool-use ids whose argument JSON was invalid. They are never executed;
    /// the replayed block carries an empty object input.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub invalid_tool_inputs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
}

impl WikiTurnResponse {
    pub fn tool_uses(&self) -> impl Iterator<Item = (&str, &str, &serde_json::Value)> {
        self.content.iter().filter_map(|block| match block {
            ContentBlock::ToolUse { id, name, input } => Some((id.as_str(), name.as_str(), input)),
            _ => None,
        })
    }
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }
}

/// The provider rejected a tool-bearing request before producing content.
/// The worker never retries without tools; the user must pick another model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiToolsRejected;
impl std::fmt::Display for WikiToolsRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the organization model rejected tool definitions; select an organization model that supports tool calls")
    }
}
impl std::error::Error for WikiToolsRejected {}

/// One persisted step of a tool loop. `response_json` is a complete
/// [`WikiTurnResponse`]; `tool_results_json` is the host envelope of the next
/// user message once its tools were applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiToolStep {
    pub loop_key: String,
    pub step: usize,
    pub input_fingerprint: String,
    pub response_json: String,
    pub response_hash: String,
    #[serde(default)]
    pub tool_results_json: Option<String>,
    #[serde(default)]
    pub tree_hash: Option<String>,
    #[serde(default)]
    pub read_revisions_json: String,
    pub applied: bool,
}
