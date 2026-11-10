use super::*;
use kcoder_migration::history_tool_attachments::{HistoryToolAttachments, MAX_TOOL_ATTACHMENTS};
use kcoder_types::imported_transcript::{
    HistoricalBlock, HistoricalRecordData, HistoricalToolOutcome,
};
fn collection(
    f: &Fixture,
    record: u64,
    block: u32,
    replacement: Option<u32>,
) -> HistoryToolAttachments {
    HistoryToolAttachments::open(
        HistoryJobStore::open(f.profile.path())
            .unwrap()
            .archive_reader(&f.job)
            .unwrap(),
        record,
        block,
        replacement,
    )
    .unwrap()
}
fn result(content: Value) -> Value {
    claude(json!([{"type":"tool_result","tool_use_id":"old-call","content":content}]))
}
fn output(content: Value) -> Value {
    json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"old-call","output":content}})
}
fn read_item(catalog: &HistoryToolAttachments, index: u32, bytes: u64) -> Vec<u8> {
    let mut out = Vec::new();
    while (out.len() as u64) < bytes {
        let part = catalog
            .read_item_chunk(index, out.len() as u64, 31_111, |stage, _| {
                assert_eq!(stage, HistoricalAttachmentStage::Extracting);
                true
            })
            .unwrap();
        assert!(!part.is_empty());
        out.extend(part);
    }
    out
}
#[test]
fn claude_tool_images_and_documents_page_and_extract_without_changing_the_result() {
    let mut content = vec![json!({"type":"text","text":"Original historical output"})];
    for i in 0..23 {
        content.push(json!({"type":"document","title":format!("报告-{i}.txt"),"source":{"type":"text","media_type":"text/plain","data":format!("内容-{i}😀")}}));
    }
    content.push(json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAECA/8="}}));
    let f = Fixture::new(
        MigrationSourceKind::ClaudeCode,
        vec![result(json!(content))],
        true,
    );
    let catalog = collection(&f, 0, 0, None);
    assert!(catalog.summary().unwrap().is_none());
    let summary = catalog.build(|_, _| true).unwrap();
    assert!(summary.structured);
    assert_eq!(summary.attachments, 24);
    assert_eq!(summary.source_items, 25);
    let first = catalog.page(0).unwrap();
    assert_eq!(first.items.len(), 10);
    assert_eq!(first.items[0].source_array_index, 1);
    assert_eq!(first.next_cursor, Some(10));
    assert_eq!(catalog.page(10).unwrap().items.len(), 10);
    assert_eq!(catalog.page(20).unwrap().items.len(), 4);
    assert!(catalog.page(24).unwrap().items.is_empty());
    assert!(catalog.page(25).is_err());
    let info = catalog.extract_item(0, 100, |_, _| true).unwrap();
    assert_eq!(info.display_name.as_deref(), Some("报告-0.txt"));
    let receipt = info.receipt.unwrap();
    assert_eq!(read_item(&catalog, 0, receipt.bytes), "内容-0😀".as_bytes());
    catalog.extract_item(23, 100, |_, _| true).unwrap();
    assert_eq!(read_item(&catalog, 23, 5), [0, 1, 2, 3, 255]);
    assert_eq!(f.original(), f.source);
    drop(catalog);
    let reopened = collection(&f, 0, 0, None);
    assert_eq!(reopened.summary().unwrap().unwrap(), summary);
    assert_eq!(reopened.item_receipt(0).unwrap(), Some(receipt));
}
#[test]
fn codex_preserves_array_positions_and_keeps_encrypted_and_unknown_items_separate() {
    let f = Fixture::new(
        MigrationSourceKind::Codex,
        vec![output(json!([
        {"type":"input_text","text":"output"},
        {"type":"input_image","image_url":"data:image/png;base64,AQID"},
        {"type":"encrypted_content","encrypted_content":"OPAQUE_CANARY"},
        {"type":"future_kind","content":[{"type":"input_image","image_url":"data:image/png;base64,BAUG"}]},
        {"type":"input_audio","audio_url":"data:audio/wav;base64,BAUG"},
        {"type":"input_image","file_id":"REMOTE_CANARY"}
        ]))],
        false,
    );
    let catalog = collection(&f, 0, 0, None);
    let summary = catalog.build(|_, _| true).unwrap();
    assert_eq!(summary.attachments, 3);
    assert_eq!(summary.source_items, 6);
    assert_eq!(summary.opaque_items, 1);
    assert_eq!(summary.unknown_items, 1);
    let page = catalog.page(0).unwrap();
    assert_eq!(
        page.items
            .iter()
            .map(|v| v.source_array_index)
            .collect::<Vec<_>>(),
        [1, 4, 5]
    );
    let wire = serde_json::to_string(&page).unwrap();
    assert!(!wire.contains("CANARY"));
    assert!(!wire.contains("data:"));
    let image = catalog
        .extract_item(0, 100, |_, _| true)
        .unwrap()
        .receipt
        .unwrap();
    assert_eq!(read_item(&catalog, 0, image.bytes), [1, 2, 3]);
    let audio = catalog.extract_item(1, 100, |_, _| true).unwrap();
    assert_eq!(audio.media_type.as_deref(), Some("audio/wav"));
    assert_eq!(
        read_item(&catalog, 1, audio.receipt.unwrap().bytes),
        [4, 5, 6]
    );
    let remote = catalog.extract_item(2, 100, |_, _| true).unwrap();
    assert_eq!(remote.kind, HistoricalAttachmentKind::RemoteReference);
    assert!(remote.receipt.is_none());
}
#[test]
fn plain_text_is_not_reparsed_as_structured_content_and_objects_fail_explicitly() {
    let text =
        json!([{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAEC"}}])
            .to_string();
    let f = Fixture::new(
        MigrationSourceKind::ClaudeCode,
        vec![
            result(json!(text)),
            result(
                json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAEC"}}),
            ),
        ],
        false,
    );
    let c = collection(&f, 0, 0, None);
    let summary = c.build(|_, _| true).unwrap();
    assert!(!summary.structured);
    assert_eq!(summary.attachments, 0);
    assert!(c.page(0).unwrap().items.is_empty());
    assert!(collection(&f, 1, 0, None).build(|_, _| true).is_err());
    assert!(
        HistoryToolAttachments::open(
            HistoryJobStore::open(f.profile.path())
                .unwrap()
                .archive_reader(&f.job)
                .unwrap(),
            0,
            1,
            None
        )
        .is_err()
    );
}
#[test]
fn cancellation_and_decoded_budgets_keep_the_raw_archive_and_allow_explicit_rebuilding() {
    let payload = vec![255u8; 600_000];
    let f = Fixture::new(
        MigrationSourceKind::ClaudeCode,
        vec![result(
            json!([{"type":"image","source":{"type":"base64","media_type":"image/png","data":STANDARD.encode(&payload)}}]),
        )],
        true,
    );
    let catalog = collection(&f, 0, 0, None);
    assert!(catalog.build(|_, at| at < 70_000).is_err());
    assert!(catalog.summary().unwrap().is_none());
    let summary = catalog.build(|_, _| true).unwrap();
    assert_eq!(summary.attachments, 1);
    assert!(catalog.extract_item(0, 100, |_, _| true).is_err());
    assert!(catalog.item_receipt(0).unwrap().is_none());
    assert!(
        catalog
            .extract_item(0, HISTORICAL_ATTACHMENT_MAX_BYTES, |phase, at| phase
                == HistoricalAttachmentStage::Inspecting
                || at < 70_000)
            .is_err()
    );
    assert!(catalog.item_receipt(0).unwrap().is_none());
    catalog
        .extract_item(0, HISTORICAL_ATTACHMENT_MAX_BYTES, |_, _| true)
        .unwrap();
    assert_eq!(read_item(&catalog, 0, payload.len() as u64), payload);
    assert_eq!(f.original(), f.source);
}
#[test]
fn collection_budget_and_source_order_are_bounded_without_publishing_partial_indexes() {
    let rows = (0..MAX_TOOL_ATTACHMENTS + 1)
        .map(|_| json!({"type":"input_image","file_id":"not-fetched"}))
        .collect::<Vec<_>>();
    let f = Fixture::new(MigrationSourceKind::Codex, vec![output(json!(rows))], false);
    let catalog = collection(&f, 0, 0, None);
    assert!(catalog.build(|_, _| true).is_err());
    assert!(catalog.summary().unwrap().is_none());
}
#[test]
fn compacted_tool_outputs_keep_replacement_identities_and_payloads_distinct() {
    let f = Fixture::new(
        MigrationSourceKind::Codex,
        vec![
            json!({"type":"compacted","payload":{"message":"summary","replacement_history":[
 {"type":"function_call_output","call_id":"a","output":[{"type":"input_image","image_url":"data:image/png;base64,AAEC"}]},
 {"type":"function_call_output","call_id":"a","output":[{"type":"input_image","image_url":"data:image/png;base64,AwQF"}]}
 ],"replacement_history_metadata":[{},{}]}}),
        ],
        false,
    );
    let a = collection(&f, 0, 0, Some(0));
    let b = collection(&f, 0, 0, Some(1));
    a.build(|_, _| true).unwrap();
    b.build(|_, _| true).unwrap();
    assert_ne!(a.source_identity().unwrap(), b.source_identity().unwrap());
    assert_ne!(a.item_identity(0).unwrap(), b.item_identity(0).unwrap());
    a.extract_item(0, 100, |_, _| true).unwrap();
    b.extract_item(0, 100, |_, _| true).unwrap();
    assert_eq!(read_item(&a, 0, 3), [0, 1, 2]);
    assert_eq!(read_item(&b, 0, 3), [3, 4, 5]);
}

#[test]
fn cached_catalogues_do_not_rescan_large_payloads_and_corruption_is_not_republished() {
    let f = Fixture::new(
        MigrationSourceKind::Codex,
        vec![output(
            json!([{"type":"input_image","image_url":format!("data:image/png;base64,{}",STANDARD.encode(vec![1u8;700_000]))}]),
        )],
        false,
    );
    let catalog = collection(&f, 0, 0, None);
    let summary = catalog.build(|_, _| true).unwrap();
    assert_eq!(catalog.build(|_, at| at == 0).unwrap(), summary);
    let job = HistoryJobStore::open(f.profile.path())
        .unwrap()
        .read(&f.job)
        .unwrap();
    let directory = f
        .profile
        .path()
        .join("external-history")
        .join(job.archive_id.unwrap())
        .join("attachments-v1");
    let payload = fs::read_dir(&directory)
        .unwrap()
        .map(|v| v.unwrap().path().join("payload.bin"))
        .find(|p| p.is_file())
        .unwrap();
    let mut corrupt = fs::read(&payload).unwrap();
    corrupt[40] ^= 1;
    fs::write(&payload, &corrupt).unwrap();
    assert!(catalog.summary().is_err());
    assert!(catalog.page(0).is_err());
    assert!(catalog.build(|_, _| true).is_err());
    assert_eq!(fs::read(payload).unwrap(), corrupt);
}

#[test]
fn a_full_collection_pages_across_the_authenticated_index_chunk_boundary() {
    let mut items = Vec::new();
    for i in 0..MAX_TOOL_ATTACHMENTS {
        items.push(json!({"type":"input_image","file_id":format!("remote-{i}")}));
    }
    let f = Fixture::new(
        MigrationSourceKind::Codex,
        vec![output(json!(items))],
        false,
    );
    let catalog = collection(&f, 0, 0, None);
    let summary = catalog.build(|_, _| true).unwrap();
    assert_eq!(summary.attachments, MAX_TOOL_ATTACHMENTS as u32);
    assert_eq!(summary.source_items, MAX_TOOL_ATTACHMENTS as u32);
    let page = catalog.page(8189).unwrap();
    assert_eq!(page.items.len(), 10);
    for (at, item) in page.items.iter().enumerate() {
        assert_eq!(item.index, 8189 + at as u32);
        assert_eq!(item.source_array_index, item.index);
    }
    assert_eq!(catalog.page(9999).unwrap().items.len(), 1);
    assert!(catalog.page(9999).unwrap().next_cursor.is_none());
}

#[test]
fn a_lost_collection_receipt_is_rederived_and_never_changes_historical_tool_outcomes() {
    let f = Fixture::new(
        MigrationSourceKind::Codex,
        vec![output(
            json!([{"type":"input_image","image_url":"data:image/png;base64,AAEC"}]),
        )],
        false,
    );
    let store = HistoryJobStore::open(f.profile.path()).unwrap();
    let reader = store.archive_reader(&f.job).unwrap();
    let projection = reader
        .projection(
            kcoder_migration::history_normalization::HISTORY_NORMALIZATION_REVISION,
            false,
        )
        .unwrap()
        .unwrap();
    let before = serde_json::to_vec(&projection.record(0).unwrap()).unwrap();
    let catalog = collection(&f, 0, 0, None);
    let summary = catalog.build(|_, _| true).unwrap();
    let directory = f
        .profile
        .path()
        .join("external-history")
        .join(store.read(&f.job).unwrap().archive_id.unwrap())
        .join("attachments-v1");
    let receipt = fs::read_dir(&directory)
        .unwrap()
        .map(|v| v.unwrap().path().join("receipt.json"))
        .find(|v| v.is_file())
        .unwrap();
    fs::remove_file(receipt).unwrap();
    assert!(catalog.summary().unwrap().is_none());
    assert_eq!(catalog.build(|_, _| true).unwrap(), summary);
    catalog.extract_item(0, 100, |_, _| true).unwrap();
    assert_eq!(read_item(&catalog, 0, 3), [0, 1, 2]);
    assert_eq!(
        serde_json::to_vec(&projection.record(0).unwrap()).unwrap(),
        before
    );
    let HistoricalRecordData::Message { blocks, .. } = projection.record(0).unwrap().data else {
        panic!("tool message expected")
    };
    assert!(matches!(
        &blocks[0],
        HistoricalBlock::ToolResult {
            outcome: HistoricalToolOutcome::RecordedResult,
            ..
        }
    ));
}
