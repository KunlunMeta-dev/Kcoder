use super::*;

impl HistoricalBranchView {
    fn write(
        &mut self,
        action: impl FnOnce(&Transaction<'_>, &mut Header) -> Result<()>,
    ) -> Result<HistoricalBranchProgress> {
        ensure!(self.writable, "history_branch_read_only");
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut value = header(&transaction, &self.binding_sha256)?;
        action(&transaction, &mut value)?;
        save(&transaction, &mut value)?;
        transaction.commit()?;
        Ok(value.progress)
    }
    pub fn begin(&mut self) -> Result<HistoricalBranchProgress> {
        ensure!(self.writable, "history_branch_read_only");
        let previous = self.progress()?;
        if previous.stage == HistoricalBranchStage::Ready {
            self._lease.finish_resource_usage()?;
            return Ok(previous);
        }
        let requested = self.cancel_requested()?;
        self.write(|_, value| {
            ensure!(
                !matches!(
                    value.progress.stage,
                    HistoricalBranchStage::Failed | HistoricalBranchStage::Cancelled
                ),
                "history_branch_resume_required"
            );
            if value.progress.stage != HistoricalBranchStage::Ready {
                value.progress.stage = if requested {
                    HistoricalBranchStage::Cancelled
                } else {
                    HistoricalBranchStage::Reconstructing
                };
                value.progress.checks = 0;
                value.progress.failure_code = None;
            }
            Ok(())
        })
    }
    pub fn resume(&mut self, expected_sequence: u64) -> Result<HistoricalBranchProgress> {
        let _control = self
            .directory
            .try_exclusive_lock(OsStr::new("control.lock"))?
            .context("history_branch_control_busy")?;
        let value = header(&self.connection, &self.binding_sha256)?;
        ensure!(
            self.writable && value.progress.sequence == expected_sequence,
            "history_branch_revision_conflict"
        );
        ensure!(
            matches!(
                value.progress.stage,
                HistoricalBranchStage::Cancelled | HistoricalBranchStage::Failed
            ),
            "history_branch_not_resumable"
        );
        self.directory
            .atomic_replace(OsStr::new("cancel.json"), b"false")?;
        self.write(|_, value| {
            value.progress.stage = HistoricalBranchStage::Planned;
            value.progress.failure_code = None;
            Ok(())
        })
    }
    pub fn checked(&mut self, steps: u64) -> Result<HistoricalBranchProgress> {
        self.write(|_, value| {
            ensure!(
                value.progress.stage == HistoricalBranchStage::Reconstructing
                    && steps >= value.progress.checks,
                "history_branch_progress_conflict"
            );
            value.progress.checks = steps;
            Ok(())
        })
    }
    pub fn set_plan(&mut self, plan: &HistoricalBranchPlan) -> Result<HistoricalBranchProgress> {
        ensure!(
            valid_hash(&plan.selection_sha256)
                && plan.total_items <= EXTERNAL_HISTORY_MAX_RECORDS
                && plan.issues.len() <= 128
                && plan.issues.iter().all(|code| !code.is_empty()
                    && code.len() <= 128
                    && code
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte == b'_')),
            "history_branch_invalid_plan"
        );
        self.write(|_, value| {
            ensure!(
                value.progress.stage == HistoricalBranchStage::Reconstructing,
                "history_branch_progress_conflict"
            );
            ensure!(
                value.plan.as_ref().is_none_or(|previous| previous == plan),
                "history_branch_plan_changed"
            );
            value.plan = Some(plan.clone());
            value.progress.total_items = Some(plan.total_items);
            value.progress.structural_complete = Some(plan.structural_complete);
            value.progress.source_records_with_diagnostics = plan.source_records_with_diagnostics;
            value.progress.issues = plan.issues.clone();
            value.progress.stage = HistoricalBranchStage::Saving;
            Ok(())
        })
    }
    /// Replayed positions are compared with their committed bytes, never silently overwritten.
    pub fn append(
        &mut self,
        start: u64,
        items: &[HistoricalCodexItemRef],
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalBranchProgress> {
        ensure!(
            !items.is_empty() && items.len() <= 1000,
            "history_branch_invalid_batch"
        );
        for item in items {
            self.valid_item(item)?;
        }
        let cancelled = self.cancel_requested()?;
        ensure!(!cancelled, "history_branch_cancelled");
        self.write(|transaction, value| {
            ensure!(
                matches!(
                    value.progress.stage,
                    HistoricalBranchStage::Saving | HistoricalBranchStage::Ready
                ),
                "history_branch_progress_conflict"
            );
            let total = value
                .plan
                .as_ref()
                .context("history_branch_plan_missing")?
                .total_items;
            ensure!(
                start <= value.progress.written_items
                    && start
                        .checked_add(items.len() as u64)
                        .is_some_and(|end| end <= total),
                "history_branch_cursor_conflict"
            );
            for (index, item) in items.iter().enumerate() {
                let position = start + index as u64;
                ensure!(check(position), "history_branch_cancelled");
                let body = encode(item, ROW_BYTES)?;
                let sha = Sha256::digest(&body);
                if position < value.progress.written_items {
                    let (previous, previous_sha): (Vec<u8>, Vec<u8>) = transaction.query_row(
                        "SELECT body,sha FROM branch_items WHERE position=?1",
                        [position],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?;
                    ensure!(
                        previous == body && previous_sha == sha.as_slice(),
                        "history_branch_replay_conflict"
                    );
                } else {
                    ensure!(
                        position == value.progress.written_items
                            && value.progress.stage == HistoricalBranchStage::Saving,
                        "history_branch_cursor_conflict"
                    );
                    value.index_bytes = value
                        .index_bytes
                        .checked_add(body.len() as u64)
                        .context("history_branch_index_budget_exceeded")?;
                    ensure!(
                        value.index_bytes <= INDEX_BYTES,
                        "history_branch_index_budget_exceeded"
                    );
                    transaction.execute(
                        "INSERT INTO branch_items(position,body,sha) VALUES(?1,?2,?3)",
                        params![position, &body, sha.as_slice()],
                    )?;
                    value.progress.written_items += 1;
                }
            }
            Ok(())
        })
    }
    pub fn finish(&mut self) -> Result<HistoricalBranchProgress> {
        ensure!(self.writable, "history_branch_read_only");
        let previous = self.progress()?;
        if previous.stage == HistoricalBranchStage::Ready {
            self._lease.finish_resource_usage()?;
            return Ok(previous);
        }
        let progress = self.write(|transaction,value| {
            let total=value.plan.as_ref().context("history_branch_plan_missing")?.total_items;
            let (count,first,last,bytes):(u64,Option<u64>,Option<u64>,u64)=transaction.query_row("SELECT count(*),min(position),max(position),coalesce(sum(length(body)),0) FROM branch_items",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?;
            ensure!(count==total && count==value.progress.written_items && bytes==value.index_bytes && (count==0 || first==Some(0) && last==Some(count-1)),"history_branch_incomplete_index");
            value.progress.stage=HistoricalBranchStage::Ready;value.progress.failure_code=None;Ok(())
        })?;
        self._lease.finish_resource_usage()?;
        Ok(progress)
    }
    pub fn stop(
        &mut self,
        cancelled: bool,
        code: Option<&str>,
    ) -> Result<HistoricalBranchProgress> {
        let safe = code.filter(|code| {
            code.len() <= 128
                && code.starts_with("history_")
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        });
        self.write(|_, value| {
            ensure!(
                value.progress.stage != HistoricalBranchStage::Ready,
                "history_branch_already_ready"
            );
            value.progress.stage = if cancelled {
                HistoricalBranchStage::Cancelled
            } else {
                HistoricalBranchStage::Failed
            };
            value.progress.failure_code =
                (!cancelled).then(|| safe.unwrap_or("history_branch_build_failed").into());
            Ok(())
        })
    }
}
