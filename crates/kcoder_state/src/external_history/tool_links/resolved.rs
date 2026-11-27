//! Branch inputs are resolved by the migration domain, never supplied as executable RPC data.
use super::*;

impl HistoricalToolLinks {
    pub fn run(&self) -> Result<Option<HistoricalToolLinkRun>> {
        Ok(self.header(&self.connection)?.run)
    }

    pub fn begin_run(&mut self, resume_sequence: Option<u64>) -> Result<HistoricalToolLinkRun> {
        ensure!(
            self.writable && self.projection.is_none(),
            "history_tool_links_branch_writer_required"
        );
        let expected = self.header(&self.connection)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut header = read_header(&transaction)?;
        ensure!(
            header.progress == expected.progress && header.run == expected.run,
            "history_tool_links_progress_changed"
        );
        let previous = header.run.take().unwrap_or(HistoricalToolLinkRun {
            sequence: 0,
            stage: HistoricalToolLinkStage::Planned,
            failure_code: None,
        });
        if previous.stage == HistoricalToolLinkStage::Ready {
            return Ok(previous);
        }
        if matches!(
            previous.stage,
            HistoricalToolLinkStage::Cancelled | HistoricalToolLinkStage::Failed
        ) {
            ensure!(
                resume_sequence == Some(previous.sequence),
                "history_tool_links_resume_required"
            );
        } else {
            ensure!(
                resume_sequence.is_none(),
                "history_tool_links_revision_conflict"
            );
        }
        let run = HistoricalToolLinkRun {
            sequence: previous
                .sequence
                .checked_add(1)
                .context("history_tool_links_sequence_exhausted")?,
            stage: HistoricalToolLinkStage::Correlating,
            failure_code: None,
        };
        header.run = Some(run.clone());
        write_header(&transaction, &header)?;
        transaction.commit()?;
        Ok(run)
    }

    /// The full selected record and physical origin participate in replay comparison.
    pub fn append_resolved(
        &mut self,
        sequence: u64,
        record: &HistoricalRecord,
        origin: &HistoricalToolOrigin,
    ) -> Result<HistoricalToolLinkProgress> {
        ensure!(
            self.writable && self.projection.is_none(),
            "history_tool_links_branch_writer_required"
        );
        ensure!(
            origin
                .omitted_blocks
                .windows(2)
                .all(|pair| pair[0] < pair[1]),
            "history_tool_links_invalid_origin"
        );
        let bytes = serde_json::to_vec(&(
            record,
            origin.source_index,
            origin.replacement_index,
            &origin.omitted_blocks,
        ))?;
        ensure!(
            bytes.len() <= 16 * 1024 * 1024,
            "history_tool_links_input_budget_exceeded"
        );
        let digest = Sha256::digest(&bytes);
        drop(bytes);
        let expected = self.header(&self.connection)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut header = read_header(&transaction)?;
        ensure!(
            header.progress == expected.progress && header.run == expected.run,
            "history_tool_links_progress_changed"
        );
        ensure!(
            header
                .run
                .as_ref()
                .is_some_and(|run| run.stage == HistoricalToolLinkStage::Correlating),
            "history_tool_links_not_running"
        );
        if sequence < header.progress.processed_records {
            let (ordinal, sha): (u64, Vec<u8>) = transaction.query_row(
                "SELECT ordinal,sha FROM link_records WHERE sequence=?1",
                [sequence],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            ensure!(
                ordinal == record.record && sha == digest.as_slice(),
                "history_tool_links_replay_conflict"
            );
        } else {
            ensure!(
                !header.progress.sealed
                    && sequence == header.progress.processed_records
                    && sequence < EXTERNAL_HISTORY_MAX_RECORDS,
                "history_tool_links_cursor_conflict"
            );
            correlation::append_scoped(
                &transaction,
                sequence,
                record,
                origin,
                &mut header.progress,
            )?;
            transaction.execute(
                "INSERT INTO link_records(sequence,ordinal,sha) VALUES(?1,?2,?3)",
                params![sequence, record.record, digest.as_slice()],
            )?;
            header.progress.processed_records += 1;
            ensure!(
                header.progress.recorded_links <= 4_000_000,
                "history_tool_links_budget_exceeded"
            );
            let run = header
                .run
                .as_mut()
                .context("history_tool_links_not_running")?;
            run.sequence = run
                .sequence
                .checked_add(1)
                .context("history_tool_links_sequence_exhausted")?;
            write_header(&transaction, &header)?;
        }
        transaction.commit()?;
        Ok(header.progress)
    }

    pub fn finish_run(&mut self, expected_records: u64) -> Result<HistoricalToolLinkProgress> {
        ensure!(
            self.projection.is_none(),
            "history_tool_links_branch_writer_required"
        );
        if self
            .run()?
            .is_some_and(|run| run.stage == HistoricalToolLinkStage::Ready)
        {
            let progress = self.progress()?;
            ensure!(
                progress.sealed && progress.processed_records == expected_records,
                "history_tool_links_incomplete_selection"
            );
            self._lease.finish_resource_usage()?;
            return Ok(progress);
        }
        let progress = self.seal(expected_records)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut header = read_header(&transaction)?;
        let run = header
            .run
            .as_mut()
            .context("history_tool_links_not_running")?;
        run.sequence = run
            .sequence
            .checked_add(1)
            .context("history_tool_links_sequence_exhausted")?;
        run.stage = HistoricalToolLinkStage::Ready;
        run.failure_code = None;
        write_header(&transaction, &header)?;
        transaction.commit()?;
        self._lease.finish_resource_usage()?;
        Ok(progress)
    }

    pub fn stop_run(
        &mut self,
        cancelled: bool,
        code: Option<&str>,
    ) -> Result<HistoricalToolLinkRun> {
        ensure!(
            self.writable && self.projection.is_none(),
            "history_tool_links_branch_writer_required"
        );
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut header = read_header(&transaction)?;
        let run = header
            .run
            .as_mut()
            .context("history_tool_links_not_running")?;
        ensure!(
            run.stage != HistoricalToolLinkStage::Ready,
            "history_tool_links_already_ready"
        );
        run.sequence = run
            .sequence
            .checked_add(1)
            .context("history_tool_links_sequence_exhausted")?;
        run.stage = if cancelled {
            HistoricalToolLinkStage::Cancelled
        } else {
            HistoricalToolLinkStage::Failed
        };
        let safe = code.filter(|code| {
            code.starts_with("history_")
                && code.len() <= 128
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        });
        run.failure_code = (!cancelled).then(|| safe.unwrap_or("history_tool_links_failed").into());
        let result = run.clone();
        write_header(&transaction, &header)?;
        transaction.commit()?;
        Ok(result)
    }
}
