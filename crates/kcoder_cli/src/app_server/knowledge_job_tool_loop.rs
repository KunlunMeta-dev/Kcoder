//! File-contract (pipeline v2) host hooks: one durable call reservation per
//! tool-loop turn, step persistence under the job lease and public turn/call
//! counters. Tool definitions come only from the Wiki worker itself.
use super::{BudgetedModel, knowledge_requests};
use anyhow::{Result, ensure};
use kcoder_knowledge::{WikiToolStep, WikiTurnRequest, WikiTurnResponse};

/// Public progress phases keep the released vocabulary: autonomous tool turns
/// report generation, verification format repair reports source support.
pub(super) fn progress_phase(stage: &str) -> &str {
    match stage {
        "tool_step" => "generation",
        "support_repair" => "source_support",
        other => other,
    }
}

impl BudgetedModel<'_> {
    /// Initial persisted call limit: the released default for legacy jobs and
    /// a bounded per-batch turn allowance for the file contract.
    pub(super) fn initial_call_limit(&self) -> Result<u32> {
        if self.pipeline_version < 2 {
            return Ok(64);
        }
        let (store, scope) = knowledge_requests::open_catalog(self.path)?;
        let (total, _, _) = store.job_evidence_range(&scope, self.library, self.lease)?;
        Ok(kcoder_knowledge::file_contract_call_limit(total))
    }

    pub(super) async fn complete_turn_reserved(
        &self,
        input: WikiTurnRequest,
        limit: u32,
    ) -> Result<WikiTurnResponse> {
        // Local request-shape/output failures cannot consume a model call.
        self.inner.with_output_limit(
            &kcoder_knowledge::WikiModelRequest {
                stage: input.stage,
                system: String::new(),
                user: String::new(),
                max_output_tokens: input.max_output_tokens,
            },
            limit,
        )?;
        let estimate = kcoder_knowledge::WikiModel::estimate_turn_input_tokens(self, &input);
        let reservation = {
            let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
            ensure!(
                knowledge_requests::organization_enabled(self.path)?,
                "Wiki is disabled"
            );
            store
                .budget_reserve_for_stage(
                    &scope,
                    self.library,
                    self.lease,
                    self.initial_call_limit()?,
                    input.stage,
                    Some(estimate),
                )?
                .ok_or_else(|| anyhow::anyhow!("Wiki model call budget exceeded"))?
        };
        let phase = progress_phase(input.stage);
        self.progress(phase, 0, 0)?;
        {
            let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
            let mut progress = store
                .read_job(&scope, self.library, &self.lease.job.id)?
                .progress
                .unwrap();
            progress.requested_output_tokens = Some(
                kcoder_knowledge::WikiModel::output_token_budget(self, input.max_output_tokens)?
                    .min(limit),
            );
            progress.estimated_input_tokens = Some(estimate);
            store.update_job_progress(&scope, self.library, self.lease, &progress)?;
        }
        let progress = |text, reasoning| self.progress(phase, text, reasoning);
        let result = match (&self.authority, &self.organization_budget) {
            (Some(authority), Some(budget)) => {
                let admission = budget.admission(authority, &reservation)?;
                self.inner
                    .complete_turn_observed(input, limit, Some(&progress), Some(&admission))
                    .await
            }
            (None, None) => {
                self.inner
                    .complete_turn_observed(input, limit, Some(&progress), None)
                    .await
            }
            _ => anyhow::bail!("WIKI_ORGANIZATION_BUDGET_BINDING_CHANGED"),
        };
        let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
        let usage = match &result {
            Ok((_, usage)) => usage.clone(),
            Err(error) => error
                .downcast_ref::<super::super::knowledge_model::WikiReportedUsage>()
                .and_then(|context| context.0.clone()),
        };
        // Unknown usage stays unknown; it is never recorded as zero tokens.
        store.budget_record_usage(&scope, self.library, &reservation, usage)?;
        let current = store.read_job(&scope, self.library, &self.lease.job.id)?;
        if current.status == "running"
            && let Some(progress) = current.progress
        {
            self.progress(phase, progress.text_bytes, progress.reasoning_bytes)?;
        }
        result.map(|(response, _)| response)
    }

    pub(super) fn load_tool_steps(&self, loop_key: &str) -> Result<Vec<WikiToolStep>> {
        self.check_resource()?;
        let (store, scope) = knowledge_requests::open_catalog(self.path)?;
        store.tool_steps_load(&scope, self.library, self.lease, loop_key)
    }

    pub(super) fn save_tool_step(&self, step: &WikiToolStep) -> Result<()> {
        self.check_resource()?;
        let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
        store.tool_step_save(&scope, self.library, self.lease, step)
    }

    pub(super) fn discard_tool_steps(&self, loop_key: &str, from: usize) -> Result<()> {
        let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
        store.tool_steps_discard(&scope, self.library, self.lease, loop_key, from)
    }

    pub(super) fn record_tool_progress(&self, turns: u32, calls: u32) -> Result<()> {
        let (mut store, scope) = knowledge_requests::open_catalog(self.path)?;
        if let Some(mut progress) = store
            .read_job(&scope, self.library, &self.lease.job.id)?
            .progress
        {
            progress.tool_turns = Some(turns);
            progress.tool_calls = Some(calls);
            store.update_job_progress(&scope, self.library, self.lease, &progress)?;
        }
        store.stage_record_tool_counters(
            &scope,
            self.library,
            self.lease,
            "generation/aggregate",
            turns,
            calls,
        )
    }

    pub(super) fn window_limit(&self) -> Result<Option<usize>> {
        let (store, scope) = knowledge_requests::open_catalog(self.path)?;
        store.job_window_limit(&scope, self.library, &self.lease.job.id)
    }
}
