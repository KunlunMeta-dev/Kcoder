//! Explicit caller bindings supply new bytes; archived references and original receipts stay inert.
use super::*;
use crate::local_attachment::HistoryLocalAttachments;
use kcoder_types::local_attachment::HistoricalLocalAttachmentStage;
mod media;

type Location = (u64, u32, Option<u32>);
pub(super) fn bindings(
    root: &str,
    view: &str,
    _policy: &HistoricalContextPolicy,
    values: &[HistoricalLocalAttachmentBinding],
) -> Result<BTreeMap<Location, HistoricalLocalAttachmentBinding>> {
    ensure!(
        values.len() <= 1024,
        "history_context_local_binding_budget_exceeded"
    );
    let mut result = BTreeMap::new();
    for value in values {
        ensure!(
            value.selection.job_id == root
                && value.selection.view_id.as_deref() == Some(view)
                && uuid::Uuid::parse_str(&value.operation_id)
                    .is_ok_and(|id| id.to_string() == value.operation_id)
                && value.receipt.bytes <= HISTORICAL_ATTACHMENT_MAX_BYTES
                && value.receipt.attachment_id.len() == 64
                && value
                    .receipt
                    .attachment_id
                    .bytes()
                    .all(|v| v.is_ascii_hexdigit())
                && value.receipt.chunk_bytes as usize == HISTORICAL_ATTACHMENT_CHUNK_BYTES
                && value.receipt.sha256.len() == 64
                && value.receipt.sha256.bytes().all(|v| v.is_ascii_hexdigit()),
            "history_context_local_binding_invalid"
        );
        ensure!(
            result
                .insert(
                    (
                        value.selection.position,
                        value.selection.block_index,
                        value.selection.tool_item_index
                    ),
                    value.clone()
                )
                .is_none(),
            "history_context_local_binding_duplicate"
        );
    }
    Ok(result)
}

impl HistoryContextCompiler {
    pub(super) fn local_attachment(
        &self,
        context: &BlockContext<'_>,
        source_array_index: Option<u32>,
        binding: &HistoricalLocalAttachmentBinding,
        builder: &mut Builder,
        check: &mut impl FnMut(HistoryContextProgress) -> bool,
    ) -> Result<()> {
        let selection = context.selection(binding.selection.tool_item_index);
        ensure!(
            selection == binding.selection,
            "history_context_local_binding_changed"
        );
        ensure!(
            builder.local_seen.insert((
                selection.position,
                selection.block_index,
                selection.tool_item_index
            )),
            "history_context_local_binding_duplicate"
        );
        let store = HistoryLocalAttachments::open_existing(&self.profile)?
            .context("history_context_local_attachment_missing")?;
        let local = store.read_with_cancel(&binding.operation_id, |bytes| {
            check(HistoryContextProgress {
                phase: HistoryContextPhase::VerifyingAttachment,
                position: context.position,
                bytes,
            })
        })?;
        ensure!(
            local.selection == selection
                && !local.historical_content_verified
                && local.info.kind == HistoricalAttachmentKind::LocalReference,
            "history_context_local_binding_changed"
        );
        if local.state.stage != HistoricalLocalAttachmentStage::Ready
            || local.state.cancel_requested
        {
            context.issue(builder, "history_context_local_attachment_not_ready");
            return Ok(());
        }
        ensure!(
            local.state.receipt.as_ref() == Some(&binding.receipt)
                && local.info.receipt.as_ref() == Some(&binding.receipt)
                && local.info.issue.is_none(),
            "history_context_local_receipt_changed"
        );
        if builder.document.attachments.len() >= builder.policy.max_attachments as usize
            || binding.receipt.bytes
                > builder
                    .policy
                    .max_attachment_bytes
                    .saturating_sub(builder.report.attachment_bytes)
        {
            context.issue(builder, "history_context_attachment_budget_exceeded");
            return Ok(());
        }
        let verified = media::verify(
            &binding.receipt,
            context.position,
            |offset, limit| {
                store.chunk(
                    &binding.operation_id,
                    &selection,
                    &binding.receipt,
                    offset,
                    limit,
                )
            },
            check,
        )?;
        let media_type = match verified {
            Ok(media_type) => media_type,
            Err(code) => {
                context.issue(builder, code);
                return Ok(());
            }
        };
        let extension = match media_type {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            _ => "txt",
        };
        let attachment = HistoricalContextAttachment {
            selection,
            source_array_index,
            receipt: binding.receipt.clone(),
            media_type: Some(media_type.into()),
            display_name: Some(format!("User-supplied attachment.{extension}")),
            provenance: Some(HistoricalContextAttachmentProvenance::UserSuppliedLocal {
                operation_id: binding.operation_id.clone(),
            }),
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
        let mut entry = builder.entry(
            context.position,
            context.index,
            context.role,
            HistoricalContextFactKind::AttachmentReference,
        );
        entry.source_array_index = source_array_index;
        entry.text = serde_json::to_string(&serde_json::json!({
            "kind":"user_supplied_local_attachment", "operationId":binding.operation_id,
            "historicalContentVerified":false, "mediaType":media_type
        }))?;
        if builder.push(entry)? {
            builder.encoded += cost;
            builder.report.attachment_bytes += binding.receipt.bytes;
            builder.document.attachments.push(attachment);
        }
        Ok(())
    }
}
