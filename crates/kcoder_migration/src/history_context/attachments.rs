use super::*;

impl HistoryContextCompiler {
    pub(super) fn collection(
        &self,
        context: &BlockContext<'_>,
        count: u64,
        builder: &mut Builder,
    ) -> Result<bool> {
        if builder
            .local_bindings
            .keys()
            .any(|(position, block, _)| *position == context.position && *block == context.index)
        {
            let catalog = self
                .branches
                .tool_attachments(context.root, context.view, context.position, context.index)?
                .summary()?;
            if catalog.is_some_and(|catalog| {
                catalog.structured && u64::from(catalog.attachments) == count
            }) {
                return Ok(true);
            }
        }
        let Some(jobs) = &self.attachments else {
            context.issue(builder, "history_context_attachment_collection_required");
            return Ok(false);
        };
        let ready = jobs.read(&context.selection(None))?.is_some_and(|job| {
            job.stage == HistoricalAttachmentJobStage::Catalogued
                && job
                    .catalog
                    .is_some_and(|catalog| u64::from(catalog.attachments) == count)
        });
        if !ready {
            context.issue(builder, "history_context_attachment_collection_required");
        }
        Ok(ready)
    }
    pub(super) fn attachment(
        &self,
        context: &BlockContext<'_>,
        item: Option<u32>,
        source_array_index: Option<u32>,
        builder: &mut Builder,
        check: &mut impl FnMut(HistoryContextProgress) -> bool,
    ) -> Result<()> {
        if let Some(binding) = builder
            .local_bindings
            .get(&(context.position, context.index, item))
            .cloned()
        {
            return self.local_attachment(context, source_array_index, &binding, builder, check);
        }
        let Some(jobs) = &self.attachments else {
            context.issue(builder, "history_context_attachment_required");
            return Ok(());
        };
        let selection = context.selection(item);
        let Some(job) = jobs.read(&selection)? else {
            context.issue(builder, "history_context_attachment_required");
            return Ok(());
        };
        if job.stage != HistoricalAttachmentJobStage::Ready {
            context.issue(builder, "history_context_attachment_not_ready");
            return Ok(());
        }
        let info = job
            .info
            .context("history_context_attachment_receipt_missing")?;
        ensure!(
            matches!(
                info.kind,
                HistoricalAttachmentKind::EmbeddedBase64 | HistoricalAttachmentKind::EmbeddedText
            ) && info.issue.is_none(),
            "history_context_attachment_receipt_changed"
        );
        let receipt = info
            .receipt
            .context("history_context_attachment_receipt_missing")?;
        if builder.document.attachments.len() >= builder.policy.max_attachments as usize
            || receipt.bytes
                > builder
                    .policy
                    .max_attachment_bytes
                    .saturating_sub(builder.report.attachment_bytes)
        {
            context.issue(builder, "history_context_attachment_budget_exceeded");
            return Ok(());
        }
        let attachment = HistoricalContextAttachment {
            selection: selection.clone(),
            source_array_index,
            receipt: receipt.clone(),
            media_type: info.media_type,
            display_name: info.display_name,
            provenance: None,
        };
        let cost = size(&attachment, builder.policy.max_context_bytes)
            .unwrap_or(builder.policy.max_context_bytes)
            + 1;
        if cost
            > builder
                .policy
                .max_context_bytes
                .saturating_sub(builder.encoded)
        {
            context.issue(builder, "history_context_byte_budget_exceeded");
            return Ok(());
        }
        let mut digest = Sha256::new();
        let mut offset = 0;
        loop {
            ensure!(
                check(HistoryContextProgress {
                    phase: HistoryContextPhase::VerifyingAttachment,
                    position: context.position,
                    bytes: offset
                }),
                "history_context_cancelled"
            );
            let (observed, bytes) =
                jobs.chunk(&selection, offset, HISTORICAL_ATTACHMENT_CHUNK_BYTES)?;
            ensure!(
                observed == receipt && bytes.len() as u64 <= receipt.bytes.saturating_sub(offset),
                "history_context_attachment_receipt_changed"
            );
            digest.update(&bytes);
            offset += bytes.len() as u64;
            if offset == receipt.bytes {
                break;
            }
            ensure!(!bytes.is_empty(), "history_context_attachment_truncated");
        }
        ensure!(
            format!("{:x}", digest.finalize()) == receipt.sha256,
            "history_context_attachment_digest_changed"
        );
        ensure!(
            check(HistoryContextProgress {
                phase: HistoryContextPhase::VerifyingAttachment,
                position: context.position,
                bytes: offset
            }),
            "history_context_cancelled"
        );
        let mut entry = builder.entry(
            context.position,
            context.index,
            context.role,
            HistoricalContextFactKind::AttachmentReference,
        );
        entry.source_array_index = source_array_index;
        entry.text = attachment
            .display_name
            .clone()
            .unwrap_or_else(|| "Historical attachment".into());
        if builder.push(entry)? {
            builder.encoded += cost;
            builder.report.attachment_bytes += receipt.bytes;
            builder.document.attachments.push(attachment);
        }
        Ok(())
    }
}
