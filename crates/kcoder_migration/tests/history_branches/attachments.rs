use super::*;

#[test]
fn inherited_attachment_is_bound_to_the_selected_source_and_survives_reopening() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (parent, path, ends) = archive(
        profile.path(),
        root.path(),
        MigrationSourceKind::Codex,
        A,
        A,
        vec![
            json!({"type":"session_meta","ordinal":0,"payload":{"id":A,"cli_version":"0.163.0","history_mode":"paginated"}}),
            json!({"type":"response_item","ordinal":1,"payload":{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,AAECAw=="}]}}),
        ],
    );
    let (job, _, _) = archive(
        profile.path(),
        root.path(),
        MigrationSourceKind::Codex,
        B,
        B,
        vec![
            json!({"type":"session_meta","ordinal":2,"payload":{"id":B,"cli_version":"0.163.0","history_mode":"paginated","history_base":{"thread_id":A,"end_ordinal_exclusive":2,"end_byte_offset":ends[1]}}}),
            json!({"type":"response_item","ordinal":3,"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"current"}]}}),
        ],
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    let view = store.prepare(&job, &[parent]).unwrap().view_id;
    store.build(&job, &view, || true).unwrap();
    let selected = store.attachment(&job, &view, 0, 0).unwrap();
    let receipt = selected.extract(100, |_, _| true).unwrap().receipt.unwrap();
    assert_eq!(
        selected.read_chunk(0, 100, |_, _| true).unwrap(),
        [0, 1, 2, 3]
    );
    assert!(store.attachment(&job, &view, 1, 0).is_err());
    fs::remove_file(path).unwrap();
    drop(selected);
    drop(store);
    let reopened = HistoryBranchStore::open(profile.path())
        .unwrap()
        .attachment(&job, &view, 0, 0)
        .unwrap();
    assert_eq!(
        reopened.inspect(|_, _| true).unwrap().receipt.unwrap(),
        receipt
    );
    assert_eq!(
        reopened.read_chunk(0, 100, |_, _| true).unwrap(),
        [0, 1, 2, 3]
    );
}

#[test]
fn selected_attachment_blocks_map_past_omitted_context_without_exposing_removed_blocks() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (job, _, _) = archive(
        profile.path(),
        root.path(),
        MigrationSourceKind::Codex,
        A,
        A,
        vec![
            json!({"type":"session_meta","payload":{"id":A,"cli_version":"0.163.0"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"developer","internal_chat_message_metadata_passthrough":{"turn_id":"t1"},"content":[
                {"type":"input_text","text":"persistent"},
                {"type":"input_text","text":"<MODEL_SWITCH>removed model</MODEL_SWITCH>"},
                {"type":"input_image","image_url":"data:image/png;base64,BAUG"}
            ]}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","internal_chat_message_metadata_passthrough":{"turn_id":"t1"},"content":[{"type":"input_text","text":"removed input"}]}}),
            json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}),
        ],
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    let view = store.prepare(&job, &[]).unwrap().view_id;
    store.build(&job, &view, || true).unwrap();
    let page = store.page(&job, &view, 0, |_| true).unwrap();
    assert_eq!(page.items[0].omitted_blocks, 1);
    assert_eq!(page.items[0].record.blocks.len(), 2);
    assert!(store.attachment(&job, &view, 0, 0).is_err());
    assert!(store.attachment(&job, &view, 0, 2).is_err());
    let selected = store.attachment(&job, &view, 0, 1).unwrap();
    selected.extract(100, |_, _| true).unwrap();
    assert_eq!(selected.read_chunk(0, 100, |_, _| true).unwrap(), [4, 5, 6]);
}

#[test]
fn tool_result_attachments_follow_the_selected_parent_prefix_without_source_execution() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (parent, _, ends) = archive(
        profile.path(),
        root.path(),
        MigrationSourceKind::Codex,
        A,
        A,
        vec![
            json!({"type":"session_meta","ordinal":0,"payload":{"id":A,"cli_version":"0.163.0","history_mode":"paginated"}}),
            json!({"type":"response_item","ordinal":1,"payload":{"type":"function_call_output","call_id":"old","output":[{"type":"input_text","text":"historical output"},{"type":"input_image","image_url":"data:image/png;base64,AAEC"}]}}),
        ],
    );
    let (job, _, _) = archive(
        profile.path(),
        root.path(),
        MigrationSourceKind::Codex,
        B,
        B,
        vec![
            json!({"type":"session_meta","ordinal":2,"payload":{"id":B,"cli_version":"0.163.0","history_mode":"paginated","history_base":{"thread_id":A,"end_ordinal_exclusive":2,"end_byte_offset":ends[1]}}}),
            json!({"type":"response_item","ordinal":3,"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"current"}]}}),
        ],
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    let view = store.prepare(&job, &[parent]).unwrap().view_id;
    store.build(&job, &view, || true).unwrap();
    let catalog = store.tool_attachments(&job, &view, 0, 0).unwrap();
    assert_eq!(catalog.build(|_, _| true).unwrap().attachments, 1);
    assert_eq!(catalog.page(0).unwrap().items[0].source_array_index, 1);
    catalog.extract_item(0, 100, |_, _| true).unwrap();
    assert_eq!(
        catalog.read_item_chunk(0, 0, 100, |_, _| true).unwrap(),
        [0, 1, 2]
    );
    assert!(store.tool_attachments(&job, &view, 1, 0).is_err());
}
