use super::*;

pub(super) fn metadata(
    fields: &Fields,
    source_type: &str,
    item_base: &[Segment],
    meta_base: &[Segment],
    record: &mut HistoricalRecord,
) -> HistoricalCodexMetadata {
    if fields
        .nodes
        .get(meta_base)
        .is_some_and(|node| !matches!(node.value, Value::Object | Value::Null))
    {
        diagnostic(record, "invalid_codex_harness_metadata", true);
    }
    let flag = |name: &str| fields.boolean(meta_base, name).unwrap_or(false);
    for name in [
        "client_authored",
        "inherited_user_message",
        "compaction_output",
    ] {
        if fields.nodes.contains_key(&child(meta_base, name))
            && fields.boolean(meta_base, name).is_none()
        {
            diagnostic(record, "invalid_codex_harness_metadata", true);
        }
    }
    if fields
        .nodes
        .get(&child(meta_base, "user_input_order"))
        .is_some_and(|node| !matches!(node.value, Value::Null))
        && fields.number(meta_base, "user_input_order").is_none()
    {
        diagnostic(record, "invalid_codex_input_order", true);
    }
    if source_type == "session_meta" {
        for key in ["id", "session_id", "forked_from_id", "parent_thread_id"] {
            optional_text(
                fields,
                item_base,
                key,
                record,
                "invalid_codex_session_identity",
            );
        }
        for key in [
            "forked_from_ordinal_exclusive",
            "subagent_history_start_ordinal",
        ] {
            if fields
                .nodes
                .get(&child(item_base, key))
                .is_some_and(|node| !matches!(node.value, Value::Null))
                && fields.number(item_base, key).is_none()
            {
                diagnostic(record, "invalid_codex_history_boundary", true);
            }
        }
    }
    let internal = child(item_base, "internal_chat_message_metadata_passthrough");
    if fields
        .nodes
        .get(&internal)
        .is_some_and(|node| !matches!(node.value, Value::Object | Value::Null))
    {
        diagnostic(record, "invalid_codex_turn_metadata", true);
    }
    optional_text(
        fields,
        &internal,
        "turn_id",
        record,
        "invalid_codex_turn_identity",
    );
    optional_text(
        fields,
        item_base,
        "turn_id",
        record,
        "invalid_codex_turn_identity",
    );
    let history_base = if source_type == "session_meta" {
        let base = child(item_base, "history_base");
        match fields.nodes.get(&base).map(|node| &node.value) {
            None | Some(Value::Null) => None,
            Some(Value::Object) => {
                match (
                    fields.text(&base, "thread_id"),
                    fields.number(&base, "end_ordinal_exclusive"),
                    fields.number(&base, "end_byte_offset"),
                ) {
                    (Some(rollout_id), Some(end_ordinal_exclusive), Some(end_byte_offset))
                        if !rollout_id.is_empty() =>
                    {
                        Some(HistoricalCodexBase {
                            rollout_id,
                            end_ordinal_exclusive,
                            end_byte_offset,
                        })
                    }
                    _ => {
                        diagnostic(record, "invalid_codex_history_base", true);
                        None
                    }
                }
            }
            _ => {
                diagnostic(record, "invalid_codex_history_base", true);
                None
            }
        }
    } else {
        None
    };
    let user_turn_boundary = (source_type == "response_item")
        .then(|| super::context::user_boundary(fields, item_base))
        .flatten();
    let contextual_message = (source_type == "response_item")
        .then(|| super::context::message_contextual(fields, item_base))
        .flatten();
    if source_type == "response_item"
        && (user_turn_boundary.is_none() || contextual_message.is_none())
    {
        diagnostic(record, "unresolved_codex_user_boundary", true);
    }
    HistoricalCodexMetadata {
        source_type: source_type.into(),
        response_type: (source_type == "response_item")
            .then(|| fields.text(item_base, "type"))
            .flatten(),
        client_authored: flag("client_authored"),
        inherited_user_message: flag("inherited_user_message"),
        compaction_output: flag("compaction_output"),
        user_input_order: fields.number(meta_base, "user_input_order"),
        user_turn_boundary,
        contextual_message,
        rollback_first_context_blocks: if source_type == "response_item" {
            super::context::rollback_blocks(fields, item_base)
        } else {
            Vec::new()
        },
        turn_id: fields
            .text(
                &child(item_base, "internal_chat_message_metadata_passthrough"),
                "turn_id",
            )
            .or_else(|| fields.text(item_base, "turn_id")),
        history_base,
        forked_from_id: (source_type == "session_meta")
            .then(|| fields.text(item_base, "forked_from_id"))
            .flatten(),
        forked_before_ordinal: (source_type == "session_meta")
            .then(|| fields.number(item_base, "forked_from_ordinal_exclusive"))
            .flatten(),
        thread_id: (source_type == "session_meta")
            .then(|| fields.text(item_base, "id"))
            .flatten(),
        root_session_id: (source_type == "session_meta")
            .then(|| fields.text(item_base, "session_id"))
            .flatten(),
    }
}

pub(super) fn parse(
    fields: &Fields,
    payload: &[Segment],
    record: &mut HistoricalRecord,
) -> Result<HistoricalRecordData> {
    let replacement_base = child(payload, "replacement_history");
    let metadata_base = child(payload, "replacement_history_metadata");
    let has_replacement = matches!(
        fields.nodes.get(&replacement_base).map(|node| &node.value),
        Some(Value::Array)
    );
    let has_metadata = matches!(
        fields.nodes.get(&metadata_base).map(|node| &node.value),
        Some(Value::Array)
    );
    if fields
        .nodes
        .get(&child(payload, "window_number"))
        .is_some_and(|node| !matches!(node.value, Value::Null))
        && fields.number(payload, "window_number").is_none()
    {
        diagnostic(record, "invalid_codex_window_number", true);
    }
    if fields.text(payload, "message").is_none()
        && !matches!(
            fields
                .nodes
                .get(&child(payload, "message"))
                .map(|node| &node.value),
            Some(Value::String(_))
        )
    {
        diagnostic(record, "invalid_compaction_summary", true);
    }
    if !has_replacement {
        diagnostic(record, "unresolved_compaction_history", true);
    }
    if fields
        .nodes
        .get(&replacement_base)
        .is_some_and(|node| !matches!(node.value, Value::Array | Value::Null))
    {
        diagnostic(record, "invalid_compaction_history", true);
    }
    if fields
        .nodes
        .get(&metadata_base)
        .is_some_and(|node| !matches!(node.value, Value::Array | Value::Null))
    {
        diagnostic(record, "invalid_compaction_item_metadata", true);
    }
    let item_indices = fields.indices(&replacement_base);
    let metadata_indices = fields.indices(&metadata_base);
    if has_metadata && (!has_replacement || item_indices.len() != metadata_indices.len()) {
        diagnostic(record, "compaction_metadata_length_mismatch", true);
    }
    let replacement = if has_replacement {
        let mut items = Vec::new();
        for index in item_indices {
            let mut base = replacement_base.clone();
            base.push(Segment::Index(index));
            let mut meta = metadata_base.clone();
            meta.push(Segment::Index(index));
            if has_metadata
                && !matches!(
                    fields.nodes.get(&meta).map(|node| &node.value),
                    Some(Value::Object)
                )
            {
                diagnostic(record, "invalid_compaction_item_metadata", true);
            }
            let metadata = metadata(fields, "response_item", &base, &meta, record);
            let data = item(fields, &base, record)?;
            items.push(HistoricalCompactionItem {
                index: u32::try_from(index)?,
                source_id: fields.text(&base, "id"),
                metadata,
                data,
            });
        }
        Some(items)
    } else {
        None
    };
    Ok(HistoricalRecordData::Compaction {
        checkpoint: Box::new(HistoricalCompaction {
            payload: required(fields, payload)?,
            message: fields.reference(&child(payload, "message"), true),
            replacement,
            window_number: fields
                .number(payload, "window_number")
                .or_else(|| fields.number(payload, "window_id")),
            resume_metadata: object_reference(fields, payload, "resume_metadata", record),
            resume_turn_id: fields
                .text(&child(payload, "resume_metadata"), "last_started_turn_id")
                .or_else(|| {
                    fields.text(
                        &child(&child(payload, "resume_metadata"), "turn_attribution"),
                        "turn_id",
                    )
                }),
            retained_context: object_reference(fields, payload, "retained_context", record),
            guardian_history: object_reference(fields, payload, "guardian_history", record),
        }),
    })
}

fn object_reference(
    fields: &Fields,
    base: &[Segment],
    key: &str,
    record: &mut HistoricalRecord,
) -> Option<HistoricalValueRef> {
    let path = child(base, key);
    match fields.nodes.get(&path).map(|node| &node.value) {
        None | Some(Value::Null) => None,
        Some(Value::Object) => {
            if key == "resume_metadata" {
                optional_text(
                    fields,
                    &path,
                    "last_started_turn_id",
                    record,
                    "invalid_compaction_checkpoint",
                );
                let attribution = child(&path, "turn_attribution");
                if let Some(node) = fields.nodes.get(&attribution)
                    && !matches!(node.value, Value::Null)
                    && (!matches!(node.value, Value::Object)
                        || fields.text(&attribution, "turn_id").is_none())
                {
                    diagnostic(record, "invalid_compaction_checkpoint", true);
                }
            }
            fields.reference(&path, false)
        }
        _ => {
            diagnostic(record, "invalid_compaction_checkpoint", true);
            // Retain the source value as evidence; the diagnostic prevents treating it
            // as a usable checkpoint merely because a reference exists.
            fields.reference(&path, false)
        }
    }
}

fn optional_text(
    fields: &Fields,
    base: &[Segment],
    key: &str,
    record: &mut HistoricalRecord,
    code: &str,
) {
    if fields
        .nodes
        .get(&child(base, key))
        .is_some_and(|node| !matches!(node.value, Value::Null))
        && fields.text(base, key).is_none()
    {
        diagnostic(record, code, true);
    }
}
