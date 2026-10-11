//! Durable host-enforced model call budgets. Usage is recorded only when supplied
//! by the Provider; unknown/failed/cancelled calls never receive estimated tokens.
use crate::{KnowledgeCatalog, KnowledgeScope, WikiJobLease};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiTokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Created only by a successful reservation; never deserialize model input into it.
#[derive(Debug)]
pub struct WikiBudgetReservation {
    library: String,
    job: String,
    call: String,
    lease: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiBudgetSummary {
    pub call_limit: Option<u32>,
    pub reserved_calls: u32,
    pub completed_calls: u32,
    pub usage_reported_calls: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl KnowledgeCatalog {
    /// Reserve immediately before an actual model request (including repair).
    /// Prepared-output replay must not call this method. None means the budget
    /// pause was committed and the caller must not send a model request.
    /// max_calls is the initial host default; only explicit budget_extend may
    /// change a persisted limit. Resumes and changed request parameters cannot.
    pub fn budget_reserve(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        max_calls: u32,
    ) -> Result<Option<WikiBudgetReservation>> {
        self.budget_reserve_for_stage(scope, library, lease, max_calls, "unspecified", None)
    }

    pub fn budget_reserve_for_stage(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        max_calls: u32,
        stage: &str,
        input_estimate: Option<usize>,
    ) -> Result<Option<WikiBudgetReservation>> {
        ensure!(
            matches!(
                stage,
                "unspecified"
                    | "analysis"
                    | "generation"
                    | "source_support"
                    | "format_repair"
                    | "citation_repair"
                    | "organization_repair"
                    | "truncation_retry"
            ),
            "invalid Wiki call stage"
        );
        self.read_job(scope, library, &lease.job.id)?;
        ensure!(
            (1..=4096).contains(&max_calls),
            "Wiki call limit must be 1..4096"
        );
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::pages::require_active(&tx, library)?;
        crate::jobs::require_lease(&tx, library, lease)?;
        crate::source_lifecycle::require_current_source(
            &tx,
            library,
            &lease.job.source_id,
            &lease.job.source_revision,
        )?;
        tx.execute("INSERT INTO knowledge_job_budgets(library_id,job_id,call_limit) VALUES(?1,?2,?3) ON CONFLICT(library_id,job_id) DO NOTHING",params![library,lease.job.id,max_calls])?;
        let limit: u32 = tx.query_row(
            "SELECT call_limit FROM knowledge_job_budgets WHERE library_id=?1 AND job_id=?2",
            params![library, lease.job.id],
            |row| row.get(0),
        )?;
        let count: u32 = tx.query_row(
            "SELECT COUNT(*) FROM knowledge_job_calls WHERE library_id=?1 AND job_id=?2",
            params![library, lease.job.id],
            |row| row.get(0),
        )?;
        if count >= limit {
            tx.execute("UPDATE knowledge_jobs SET status='paused',error_code='budget_exceeded',lease_token=NULL,lease_until_ms=0 WHERE library_id=?1 AND job_id=?2",params![library,lease.job.id])?;
            tx.commit()?;
            return Ok(None);
        }
        if matches!(
            stage,
            "format_repair" | "citation_repair" | "organization_repair" | "truncation_retry"
        ) {
            let repairs: u32 = tx.query_row("SELECT COUNT(*) FROM knowledge_job_calls WHERE library_id=?1 AND job_id=?2 AND after_chunk=?3 AND stage IN ('format_repair','citation_repair','organization_repair','truncation_retry')",params![library,lease.job.id,lease.job.after_chunk as i64],|row|row.get(0))?;
            ensure!(repairs < 3, "Wiki shared repair budget exceeded");
        }
        let reservation = WikiBudgetReservation {
            library: library.into(),
            job: lease.job.id.clone(),
            call: uuid::Uuid::new_v4().to_string(),
            lease: lease.token.clone(),
        };
        tx.execute("INSERT INTO knowledge_job_calls(library_id,job_id,call_id,lease_token,completed,stage,after_chunk,input_estimate) VALUES(?1,?2,?3,?4,0,?5,?6,?7)",params![library,reservation.job,reservation.call,reservation.lease,stage,lease.job.after_chunk as i64,input_estimate.map(i64::try_from).transpose()?])?;
        tx.commit()?;
        Ok(Some(reservation))
    }

    /// A request can complete after cancellation/lease revocation. Record that
    /// real outcome against its original reservation without reviving the job.
    /// None explicitly records an unavailable Provider usage report.
    pub fn budget_record_usage(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        reservation: &WikiBudgetReservation,
        usage: Option<WikiTokenUsage>,
    ) -> Result<()> {
        ensure!(
            reservation.library == library,
            "budget reservation library mismatch"
        );
        self.read_job(scope, library, &reservation.job)?;
        let input = usage
            .as_ref()
            .map(|usage| i64::try_from(usage.input_tokens))
            .transpose()?;
        let output = usage
            .as_ref()
            .map(|usage| i64::try_from(usage.output_tokens))
            .transpose()?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let previous:Option<(bool,Option<i64>,Option<i64>)>=tx.query_row("SELECT completed,input_tokens,output_tokens FROM knowledge_job_calls WHERE library_id=?1 AND job_id=?2 AND call_id=?3 AND lease_token=?4",params![library,reservation.job,reservation.call,reservation.lease],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
        let (complete, old_input, old_output) =
            previous.ok_or_else(|| anyhow::anyhow!("budget reservation missing"))?;
        if complete {
            ensure!(
                old_input == input && old_output == output,
                "budget usage already recorded differently"
            );
            return Ok(());
        }
        let (total_input,total_output):(i64,i64)=tx.query_row("SELECT COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0) FROM knowledge_job_calls WHERE library_id=?1 AND job_id=?2",params![library,reservation.job],|row|Ok((row.get(0)?,row.get(1)?)))?;
        ensure!(
            total_input.checked_add(input.unwrap_or(0)).is_some()
                && total_output.checked_add(output.unwrap_or(0)).is_some(),
            "Wiki token accounting overflow"
        );
        tx.execute("UPDATE knowledge_job_calls SET completed=1,input_tokens=?5,output_tokens=?6 WHERE library_id=?1 AND job_id=?2 AND call_id=?3 AND lease_token=?4",params![library,reservation.job,reservation.call,reservation.lease,input,output])?;
        tx.commit()?;
        Ok(())
    }

    /// Explicit host/UI operation only, never expose this as a model tool or
    /// infer it from a failed model request. Raising the cap does not resume work.
    pub fn budget_extend(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        job: &str,
        expected_limit: u32,
        new_limit: u32,
    ) -> Result<WikiBudgetSummary> {
        let current_job = self.read_job(scope, library, job)?;
        ensure!(
            new_limit > expected_limit && new_limit <= 4096,
            "invalid Wiki budget extension"
        );
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::pages::require_active(&tx, library)?;
        crate::source_lifecycle::require_current_source(
            &tx,
            library,
            &current_job.source_id,
            &current_job.source_revision,
        )?;
        let changed = tx.execute("UPDATE knowledge_job_budgets SET call_limit=?4 WHERE library_id=?1 AND job_id=?2 AND call_limit=?3", params![library,job,expected_limit,new_limit])?;
        ensure!(
            changed == 1,
            "Wiki budget limit changed; reload before extending"
        );
        tx.commit()?;
        self.budget_read(scope, library, job)
    }

    pub fn budget_read(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        job: &str,
    ) -> Result<WikiBudgetSummary> {
        self.read_job(scope, library, job)?;
        // One statement gives a consistent count/limit snapshot to observers.
        let result=self.connection.query_row("SELECT b.call_limit,COUNT(c.call_id),COALESCE(SUM(c.completed),0),COUNT(c.input_tokens),COALESCE(SUM(c.input_tokens),0),COALESCE(SUM(c.output_tokens),0) FROM knowledge_job_budgets b LEFT JOIN knowledge_job_calls c ON c.library_id=b.library_id AND c.job_id=b.job_id WHERE b.library_id=?1 AND b.job_id=?2 GROUP BY b.call_limit",params![library,job],|row|Ok(WikiBudgetSummary {call_limit:Some(row.get(0)?),reserved_calls:row.get(1)?,completed_calls:row.get(2)?,usage_reported_calls:row.get(3)?,input_tokens:row.get::<_,i64>(4)? as u64,output_tokens:row.get::<_,i64>(5)? as u64})).optional()?;
        Ok(result.unwrap_or(WikiBudgetSummary {
            call_limit: None,
            reserved_calls: 0,
            completed_calls: 0,
            usage_reported_calls: 0,
            input_tokens: 0,
            output_tokens: 0,
        }))
    }
}

impl KnowledgeCatalog {
    /// Remaining-repair decisions use the current leased batch, not lifetime
    /// job totals. This read cannot grant a stale owner another model call.
    pub fn job_batch_repair_calls(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
    ) -> Result<u32> {
        let current = self.read_job(scope, library, &lease.job.id)?;
        crate::pages::require_active(&self.connection, library)?;
        crate::jobs::require_lease(&self.connection, library, lease)?;
        crate::source_lifecycle::require_current_source(
            &self.connection,
            library,
            &lease.job.source_id,
            &lease.job.source_revision,
        )?;
        ensure!(
            current.after_chunk == lease.job.after_chunk,
            "Wiki repair query belongs to a stale batch"
        );
        Ok(self.connection.query_row(
            "SELECT COUNT(*) FROM knowledge_job_calls WHERE library_id=?1 AND job_id=?2 AND after_chunk=?3 AND stage IN ('format_repair','citation_repair','organization_repair','truncation_retry')",
            params![library, lease.job.id, lease.job.after_chunk as i64],
            |row| row.get(0),
        )?)
    }

    pub fn job_repair_calls(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        job: &str,
    ) -> Result<u32> {
        self.read_job(scope, library, job)?;
        Ok(self.connection.query_row("SELECT COUNT(*) FROM knowledge_job_calls WHERE library_id=?1 AND job_id=?2 AND stage IN ('format_repair','citation_repair','organization_repair','truncation_retry')",params![library,job],|row|row.get(0))?)
    }
    /// Calibrate conservatively upward from real reports; never claim this is
    /// measured usage or shrink a request below the shared estimator's fallback.
    pub fn calibrated_input_estimate(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        job: &str,
        estimate: usize,
    ) -> Result<usize> {
        self.read_job(scope, library, job)?;
        let ratio: Option<f64> = self.connection.query_row("SELECT MAX(CAST(input_tokens AS REAL)/input_estimate) FROM knowledge_job_calls WHERE library_id=?1 AND job_id=?2 AND completed=1 AND input_estimate>0 AND input_tokens IS NOT NULL",params![library,job],|row|row.get(0))?;
        Ok((estimate as f64 * ratio.unwrap_or(1.0).clamp(1.0, 4.0)).ceil() as usize)
    }
}
