use super::*;

pub(super) fn verified_execution_event(
    record: &HistoricalRecord,
    reference: &HistoricalCodexItemRef,
    position: u64,
    evidence: &Evidence,
) -> bool {
    let HistoricalRecordData::Event {
        source_type,
        call_id: Some(call_id),
        outcome: Some(outcome),
        ..
    } = &record.data
    else {
        return false;
    };
    if !evidence.ready || !matches!(source_type.as_str(), "exec_command_end" | "patch_apply_end") {
        return false;
    }
    let origin = HistoricalToolOrigin {
        source_index: reference.source_index,
        replacement_index: reference.replacement_index,
        omitted_blocks: reference.omitted_blocks.clone(),
    };
    let Some(expected) = origin.location(position, record.record, None) else {
        return false;
    };
    evidence.links.values().any(|link| {
        link.status == HistoricalToolLinkStatus::Linked
            && link.call_id == *call_id
            && link.source_turn_id == record.turn_id
            && link.execution_event.as_ref() == Some(&expected)
            && link.execution_outcome == Some(*outcome)
    })
}

impl BlockContext<'_> {
    fn entry(&self, builder: &Builder, kind: HistoricalContextFactKind) -> HistoricalContextEntry {
        builder.entry(self.position, self.index, self.role, kind)
    }
    pub(super) fn issue(&self, builder: &mut Builder, code: &str) {
        builder.issue(code, Some(self.position), Some(self.index));
    }
    pub(super) fn selection(&self, item: Option<u32>) -> HistoricalAttachmentSelection {
        HistoricalAttachmentSelection {
            job_id: self.root.into(),
            view_id: Some(self.view.into()),
            position: self.position,
            block_index: self.index,
            tool_item_index: item,
        }
    }
    fn link<'a>(
        &self,
        block: &HistoricalBlock,
        evidence: &'a Evidence,
        builder: &mut Builder,
    ) -> Option<&'a HistoricalToolLink> {
        if !evidence.ready {
            self.issue(builder, "history_context_tool_correlation_required");
            return None;
        }
        let key = (self.position, self.index);
        let Some(link) = evidence.links.get(&key) else {
            self.issue(builder, "history_context_unresolved_tool");
            return None;
        };
        let origin = HistoricalToolOrigin {
            source_index: self.reference.source_index,
            replacement_index: self.reference.replacement_index,
            omitted_blocks: self.reference.omitted_blocks.clone(),
        };
        let expected = origin.location(self.position, self.record.record, Some(self.index));
        let valid = match block {
            HistoricalBlock::ToolCall {
                call_id,
                name,
                namespace,
                ..
            } => {
                link.call_id == *call_id
                    && link.name.as_ref() == Some(name)
                    && link.namespace == *namespace
                    && link.call == expected
            }
            HistoricalBlock::ToolResult {
                call_id, outcome, ..
            } => {
                link.call_id == *call_id
                    && link.result == expected
                    && (link.outcome == *outcome
                        || (self.execution_enrichment
                            && *outcome == HistoricalToolOutcome::RecordedResult
                            && link.execution_event.is_some()
                            && matches!(
                                link.execution_outcome,
                                Some(
                                    HistoricalToolOutcome::RecordedSuccess
                                        | HistoricalToolOutcome::RecordedError
                                )
                            )
                            && link.execution_outcome == Some(link.outcome)))
            }
            _ => false,
        };
        let known_missing = link.status == HistoricalToolLinkStatus::MissingResult
            && matches!(block, HistoricalBlock::ToolCall { .. })
            && link.result.is_none()
            && link.execution_event.is_none()
            && link.execution_outcome.is_none()
            && link.outcome == HistoricalToolOutcome::OutcomeUnknown;
        let known_orphan = link.status == HistoricalToolLinkStatus::OrphanResult
            && matches!(block, HistoricalBlock::ToolResult { .. })
            && link.call.is_none()
            && link.execution_event.is_none()
            && link.execution_outcome.is_none()
            && link.name.is_none()
            && link.namespace.is_none();
        if !valid
            || (link.status != HistoricalToolLinkStatus::Linked && !known_missing && !known_orphan)
            || !builder.seen.insert(key)
        {
            self.issue(builder, "history_context_tool_evidence_mismatch");
            return None;
        }
        Some(link)
    }
}

impl HistoryContextCompiler {
    pub(super) fn block(
        &self,
        context: &BlockContext<'_>,
        block: &HistoricalBlock,
        evidence: &Evidence,
        builder: &mut Builder,
        check: &mut impl FnMut(HistoryContextProgress) -> bool,
    ) -> Result<()> {
        match block {
            HistoricalBlock::Thinking { .. } => builder.report.excluded_provider_blocks += 1,
            HistoricalBlock::Opaque { source_type, .. } => {
                if matches!(
                    source_type.as_str(),
                    "thinking_signature" | "encrypted_reasoning" | "encrypted_content"
                ) {
                    builder.report.excluded_provider_blocks += 1;
                } else {
                    context.issue(builder, "history_context_unsupported_block");
                }
            }
            HistoricalBlock::Text { value } => {
                if let Some(text) = builder.text(context.archive, value, context.position, check)? {
                    let kind = if matches!(
                        context.role,
                        HistoricalRole::System | HistoricalRole::Developer
                    ) {
                        HistoricalContextFactKind::HistoricalInstruction
                    } else {
                        HistoricalContextFactKind::Text
                    };
                    let mut entry = context.entry(builder, kind);
                    entry.text = text;
                    builder.push(entry)?;
                }
            }
            HistoricalBlock::ToolCall { input, .. } => {
                if let Some(link) = context.link(block, evidence, builder)
                    && let Some(text) =
                        builder.text(context.archive, input, context.position, check)?
                {
                    let mut entry = context.entry(builder, HistoricalContextFactKind::ToolCallFact);
                    entry.text = if link.status == HistoricalToolLinkStatus::MissingResult {
                        format!(
                            "[Historical tool call outcome is unknown; check before repeating any side effects.]\n{text}"
                        )
                    } else {
                        text
                    };
                    entry.call_id = Some(link.call_id.clone());
                    entry.name = link.name.clone();
                    entry.namespace = link.namespace.clone();
                    entry.outcome = Some(link.outcome);
                    entry.execution_outcome = link.execution_outcome;
                    builder.push(entry)?;
                }
            }
            HistoricalBlock::ToolResult { output, .. } => {
                if let Some(link) = context.link(block, evidence, builder) {
                    self.result(context, output, link, builder, check)?;
                }
            }
            HistoricalBlock::Attachment { .. } => {
                if historical_context_revision_reconstructed(&builder.document.revision) {
                    let mut entry = context.entry(builder, HistoricalContextFactKind::Text);
                    entry.text = format!(
                        "[Historical attachment omitted from reconstructed model context; its contents are not available to the model. The original remains at history position {}, block {}.]",
                        context.position, context.index
                    );
                    builder.push(entry)?;
                } else {
                    self.attachment(context, None, None, builder, check)?
                }
            }
        }
        Ok(())
    }
    fn result(
        &self,
        context: &BlockContext<'_>,
        output: &HistoricalValueRef,
        link: &HistoricalToolLink,
        builder: &mut Builder,
        check: &mut impl FnMut(HistoryContextProgress) -> bool,
    ) -> Result<()> {
        let parts = match tool_parts::collect(
            context.archive,
            context.record.source,
            output,
            builder.policy.max_entries as usize,
            check,
            context.position,
        ) {
            Ok(parts) => parts,
            Err(error)
                if matches!(
                    error.to_string().as_str(),
                    "history_context_part_budget_exceeded"
                        | "history_context_unsupported_tool_envelope"
                ) =>
            {
                context.issue(builder, &error.to_string());
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        builder.report.excluded_provider_blocks += parts.opaque;
        if parts.unknown > 0 {
            context.issue(builder, "history_context_unsupported_tool_item");
        }
        let count = parts
            .items
            .iter()
            .filter(|part| matches!(part, tool_parts::ToolPart::Attachment { .. }))
            .count();
        let reconstructed = historical_context_revision_reconstructed(&builder.document.revision);
        if count > 0 && !reconstructed && !self.collection(context, count as u64, builder)? {
            return Ok(());
        }
        // Keep an outcome fact even when the result contains only opaque content or attachments.
        let mut entry = context.entry(builder, HistoricalContextFactKind::ToolResultFact);
        if link.status == HistoricalToolLinkStatus::OrphanResult {
            entry.text = "[Historical tool result has no matching recorded call; do not infer an association or execution beyond this result.]".into();
        }
        entry.call_id = Some(link.call_id.clone());
        entry.name = link.name.clone();
        entry.namespace = link.namespace.clone();
        entry.outcome = Some(link.outcome);
        entry.execution_outcome = link.execution_outcome;
        builder.push(entry.clone())?;
        for part in parts.items {
            match part {
                tool_parts::ToolPart::Text {
                    source_index,
                    value,
                } => {
                    if let Some(text) = builder.reconstructed_tool_text(
                        context.archive,
                        &value,
                        context.position,
                        context.index,
                        check,
                    )? {
                        let mut part = entry.clone();
                        part.source_array_index = source_index;
                        part.text = text;
                        builder.push(part)?;
                    }
                }
                tool_parts::ToolPart::Attachment {
                    source_index,
                    index,
                } => {
                    if reconstructed {
                        let mut part = entry.clone();
                        part.source_array_index = Some(source_index);
                        part.text = format!(
                            "[Historical tool-result attachment omitted from reconstructed model context; its contents are not available to the model. The original remains at history position {}, block {}, attachment {}.]",
                            context.position, context.index, index
                        );
                        builder.push(part)?;
                    } else {
                        self.attachment(context, Some(index), Some(source_index), builder, check)?;
                    }
                }
            }
        }
        Ok(())
    }
}
