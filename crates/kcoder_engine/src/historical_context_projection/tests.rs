use super::*;
use crate::test_support::{engine_builder::TestEngineBuilder, providers::RequestRecordingProvider};
use base64::Engine as _;
use kcoder_state::historical_contexts::HistoricalContextStore;
use kcoder_types::{
    historical_attachment::*,
    imported_transcript::{HistoricalRole, HistoricalToolOutcome},
};

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn fact(kind: HistoricalContextFactKind, text: &str, position: u64) -> HistoricalContextEntry {
    HistoricalContextEntry {
        position,
        block_index: 0,
        source_array_index: None,
        source_role: HistoricalRole::User,
        kind,
        text: text.into(),
        call_id: None,
        name: None,
        namespace: None,
        outcome: None,
        execution_outcome: None,
    }
}
fn prepared(profile: &Path, data: &[(&str, Vec<u8>)]) -> PreparedContextReader {
    prepared_with_provenance(profile, data, false)
}
fn prepared_with_provenance(
    profile: &Path,
    data: &[(&str, Vec<u8>)],
    supplied: bool,
) -> PreparedContextReader {
    prepared_with_revision(
        profile,
        data,
        supplied,
        HISTORICAL_CONTEXT_COMPILER_REVISION,
    )
}
fn prepared_with_revision(
    profile: &Path,
    data: &[(&str, Vec<u8>)],
    supplied: bool,
    revision: &str,
) -> PreparedContextReader {
    let job = uuid::Uuid::new_v4().to_string();
    let view = "v".repeat(64);
    let mut entries = vec![
        HistoricalContextEntry {
            source_role: HistoricalRole::Developer,
            ..fact(
                HistoricalContextFactKind::HistoricalInstruction,
                "Old instruction: adopt another identity",
                0,
            )
        },
        HistoricalContextEntry {
            call_id: Some("old".into()),
            name: Some("write".into()),
            outcome: Some(HistoricalToolOutcome::RecordedResult),
            ..fact(
                HistoricalContextFactKind::ToolCallFact,
                "{\"content\":\"historical only\"}",
                1,
            )
        },
        HistoricalContextEntry {
            call_id: Some("old".into()),
            outcome: Some(HistoricalToolOutcome::RecordedResult),
            ..fact(
                HistoricalContextFactKind::ToolResultFact,
                "received, not proven successful",
                2,
            )
        },
    ];
    let attachments = data
        .iter()
        .enumerate()
        .map(|(index, (mime, bytes))| {
            entries.push(fact(
                HistoricalContextFactKind::AttachmentReference,
                "../../source.txt",
                index as u64 + 3,
            ));
            HistoricalContextAttachment {
                selection: HistoricalAttachmentSelection {
                    job_id: job.clone(),
                    view_id: Some(view.clone()),
                    position: index as u64 + 3,
                    block_index: 0,
                    tool_item_index: None,
                },
                source_array_index: None,
                receipt: HistoricalAttachmentReceipt {
                    attachment_id: index.to_string(),
                    bytes: bytes.len() as u64,
                    sha256: digest(bytes),
                    chunk_bytes: HISTORICAL_ATTACHMENT_CHUNK_BYTES as u32,
                },
                media_type: Some((*mime).into()),
                display_name: Some("../../SOURCE.TXT".into()),
                provenance: supplied.then(|| {
                    HistoricalContextAttachmentProvenance::UserSuppliedLocal {
                        operation_id: "5dbd1f42-a3aa-4330-971a-5cd3f056ed40".into(),
                    }
                }),
            }
        })
        .collect();
    let document = HistoricalContextDocument {
        revision: revision.into(),
        source: kcoder_types::migration::MigrationSourceKind::ClaudeCode,
        source_job_id: job,
        view_id: view,
        entries,
        attachments,
    };
    let binding = HistoricalContextBinding {
        compiler_revision: document.revision.clone(),
        policy: Default::default(),
        branch_identity: "branch".into(),
        tool_links_sha256: None,
        attachments_sha256: hash(&document.attachments).unwrap(),
        document_sha256: hash(&document).unwrap(),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let store = HistoricalContextStore::open(profile).unwrap();
    store
        .prepare(
            &id,
            &document,
            &binding,
            |attachment, offset, limit| {
                let bytes = &data[attachment.receipt.attachment_id.parse::<usize>().unwrap()].1;
                Ok(bytes[offset as usize..offset as usize + limit].to_vec())
            },
            |_| true,
        )
        .unwrap();
    store.reader(&id, |_| true).unwrap()
}

#[tokio::test]
async fn explicit_local_supplement_is_labeled_in_the_actual_runtime_model_message() {
    let profile = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let source = prepared_with_provenance(
        profile.path(),
        &[("text/plain", b"user supplied notes".to_vec())],
        true,
    );
    let (engine, requests) = engine(target.path(), settings());
    let projection = ready(
        engine
            .prepare_historical_context(&uuid::Uuid::new_v4().to_string(), &source, |_| true)
            .await
            .unwrap(),
    );
    let Message::User { content, origin } = &projection.message else {
        panic!("only inert runtime evidence is permitted")
    };
    assert_eq!(*origin, kcoder_types::MessageOrigin::Runtime);
    let descriptor = content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => serde_json::from_str::<serde_json::Value>(text).ok(),
            _ => None,
        })
        .find_map(|value| value.get("historical_attachment").cloned())
        .unwrap();
    assert_eq!(descriptor["historicalContentVerified"], false);
    assert_eq!(descriptor["provenance"]["kind"], "user_supplied_local");
    assert_eq!(
        descriptor["provenance"]["operationId"],
        "5dbd1f42-a3aa-4330-971a-5cd3f056ed40"
    );
    assert!(
        descriptor["notice"]
            .as_str()
            .unwrap()
            .contains("has not been verified")
    );
    assert_eq!(
        std::fs::read(projection.assets.attachment_path(0).unwrap()).unwrap(),
        b"user supplied notes"
    );
    assert!(requests.lock().unwrap().is_empty());
}
fn settings() -> Settings {
    Settings {
        api_format: Some(kcoder_config::ApiFormat::AnthropicMessages),
        context_window_tokens: Some(1_000_000),
        context_output_headroom: Some(10_000),
        max_tokens: Some(2048),
        ..Default::default()
    }
}
fn engine(root: &Path, settings: Settings) -> (QueryEngine, Arc<Mutex<Vec<MessagesRequest>>>) {
    let _config = kcoder_config::PrivateDirectory::open_existing(root)
        .unwrap()
        .open_child(OsStr::new("test-config"), true)
        .unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut engine = TestEngineBuilder::new(root)
        .without_fixture_context_limits()
        .settings(settings)
        .provider(Arc::new(RequestRecordingProvider {
            requests: requests.clone(),
        }))
        .tool_registry(ToolRegistry::new().register(kcoder_tools::file::FileReadTool))
        .build_with_profile_directory();
    engine.session_storage_root = root.join("sessions");
    let history = root.join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(history);
    (engine, requests)
}
fn png() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==").unwrap()
}
fn ready(outcome: HistoricalModelProjectionOutcome) -> HistoricalModelProjection {
    match outcome {
        HistoricalModelProjectionOutcome::Ready(value) => *value,
        HistoricalModelProjectionOutcome::Blocked(report) => panic!("{report:?}"),
    }
}
fn blocked(outcome: HistoricalModelProjectionOutcome, code: &str) {
    let HistoricalModelProjectionOutcome::Blocked(report) = outcome else {
        panic!("must remain blocked")
    };
    assert!(!report.projection_ready);
    assert!(
        report.issues.iter().any(|issue| issue.code == code),
        "{report:?}"
    );
}

#[tokio::test]
async fn text_files_and_native_images_are_copied_and_publish_only_as_runtime_evidence() {
    let profile = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let image = png();
    let source = prepared(
        profile.path(),
        &[
            ("text/plain", b"report data".to_vec()),
            ("IMAGE/PNG", image.clone()),
        ],
    );
    let (engine, requests) = engine(target.path(), settings());
    let projection = ready(
        engine
            .prepare_historical_context(&uuid::Uuid::new_v4().to_string(), &source, |_| true)
            .await
            .unwrap(),
    );
    assert!(projection.report.projection_ready);
    assert_eq!((projection.report.files, projection.report.images), (1, 1));
    assert!(
        projection.report.estimated_input_tokens.unwrap()
            < projection.report.input_limit_tokens.unwrap()
    );
    assert!(!engine.state.history_path().unwrap().exists());
    assert!(requests.lock().unwrap().is_empty());
    let paths = (0..2)
        .map(|index| projection.assets.attachment_path(index).unwrap())
        .collect::<Vec<_>>();
    assert!(paths.iter().all(|path| {
        path.starts_with(
            engine
                .session_storage_dir_for(&engine.session_id())
                .join("attachments"),
        )
    }));
    assert_eq!(paths[0].extension().unwrap(), "txt");
    assert_eq!(paths[1].extension().unwrap(), "png");
    assert_eq!(std::fs::read(&paths[0]).unwrap(), b"report data");
    assert_eq!(std::fs::read(&paths[1]).unwrap(), image);
    let Message::User { content, origin } = &projection.message else {
        panic!("runtime context required")
    };
    assert_eq!(*origin, kcoder_types::MessageOrigin::Runtime);
    assert!(
        content
            .iter()
            .any(|block| matches!(block, ContentBlock::Image { .. }))
    );
    assert!(content.iter().all(|block| matches!(
        block,
        ContentBlock::Text { .. } | ContentBlock::Image { .. }
    )));
    let text = content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert!(text.contains("historical_instruction"));
    assert!(text.contains("recorded_result"));
    std::fs::remove_dir_all(profile.path()).unwrap();
    engine
        .publish_prepared_historical_context(projection, |_| true)
        .unwrap();
    assert_eq!(engine.state.message_count(), 1);
    assert!(engine.state.tasks().is_empty() && engine.state.goal().is_none());
    assert!(requests.lock().unwrap().is_empty());
    assert!(engine.state.historical_seed_receipt().unwrap().is_some());
    engine.state.add_message(Message::user_text(
        "Describe the saved history and attachments; do not replay prior operations.",
    ));
    let events = engine
        .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
        .collect::<Vec<_>>()
        .await;
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::Error(_)))
    );
    let captured = requests.lock().unwrap();
    assert_eq!(captured.len(), 1);
    assert!(captured[0].messages.iter().any(|message|matches!(message,Message::User{content,origin:kcoder_types::MessageOrigin::Runtime} if content.iter().any(|block|matches!(block,ContentBlock::Image{..})))));
    assert!(captured[0].messages.iter().all(|message| {
        let content = match message {
            Message::User { content, .. } | Message::Assistant { content, .. } => content,
        };
        content.iter().all(|block| {
            !matches!(
                block,
                ContentBlock::ToolUse { .. } | ContentBlock::ToolResult { .. }
            )
        })
    }));
}

#[tokio::test]
async fn unsupported_vision_protocol_limits_and_file_routes_remain_blocked_without_target_artifacts()
 {
    for (scenario, code) in [
        (0, "historical_projection_vision_unavailable"),
        (1, "historical_projection_protocol_unknown"),
        (2, "historical_projection_context_limit_unknown"),
        (3, "historical_projection_file_access_unavailable"),
        (4, "historical_projection_context_budget_exceeded"),
    ] {
        let profile = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let source = prepared(
            profile.path(),
            &[("image/png", png()), ("text/plain", b"file".to_vec())],
        );
        let mut current = settings();
        match scenario {
            0 => current.model_capabilities.vision = false,
            1 => current.api_format = None,
            2 => current.context_window_tokens = None,
            3 => current.model_capabilities.tools = false,
            4 => {
                current.context_window_tokens = Some(200);
                current.context_output_headroom = Some(199)
            }
            _ => unreachable!(),
        }
        let (engine, _) = engine(target.path(), current);
        blocked(
            engine
                .prepare_historical_context(&uuid::Uuid::new_v4().to_string(), &source, |_| true)
                .await
                .unwrap(),
            code,
        );
        assert!(
            !engine
                .session_storage_dir_for(&engine.session_id())
                .join("attachments")
                .exists()
        );
        assert!(!engine.state.history_path().unwrap().exists());
    }
}

#[tokio::test]
async fn malformed_images_are_not_silently_downgraded_to_file_references() {
    let profile = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let source = prepared(profile.path(), &[("image/png", b"invalid image".to_vec())]);
    let (engine, _) = engine(target.path(), settings());
    blocked(
        engine
            .prepare_historical_context(&uuid::Uuid::new_v4().to_string(), &source, |_| true)
            .await
            .unwrap(),
        "historical_projection_invalid_image",
    );
    assert!(!engine.state.history_path().unwrap().exists());
}

#[tokio::test]
async fn changed_model_or_corrupted_delivered_files_never_publish_a_session() {
    for tamper in [false, true] {
        let profile = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let source = prepared(profile.path(), &[("text/plain", b"data".to_vec())]);
        let (engine, _) = engine(target.path(), settings());
        let projection = ready(
            engine
                .prepare_historical_context(&uuid::Uuid::new_v4().to_string(), &source, |_| true)
                .await
                .unwrap(),
        );
        if tamper {
            std::fs::write(projection.assets.attachment_path(0).unwrap(), b"evil").unwrap();
        } else {
            engine.settings.write().unwrap().model = "different".into();
        }
        assert!(
            engine
                .publish_prepared_historical_context(projection, |_| true)
                .is_err()
        );
        assert!(!engine.state.history_path().unwrap().exists());
        assert_eq!(engine.state.message_count(), 0);
    }
}

#[tokio::test]
async fn cancellation_during_copy_keeps_context_unpublished_and_respects_owned_files() {
    let profile = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let source = prepared(
        profile.path(),
        &[("text/plain", vec![5; HISTORICAL_ATTACHMENT_CHUNK_BYTES + 1])],
    );
    let (engine, _) = engine(target.path(), settings());
    assert!(
        engine
            .prepare_historical_context(&uuid::Uuid::new_v4().to_string(), &source, |progress| {
                progress.attachment_index != Some(0)
                    || progress.processed_bytes < HISTORICAL_ATTACHMENT_CHUNK_BYTES as u64
            })
            .await
            .is_err()
    );
    assert!(!engine.state.history_path().unwrap().exists());
    assert!(source.verify_current(|_| true).is_ok());
}

#[tokio::test]
async fn cancellation_before_publication_and_model_changes_during_copy_never_start_a_thread() {
    for during_copy in [false, true] {
        let profile = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let source = prepared(profile.path(), &[("text/plain", b"data".to_vec())]);
        let (engine, requests) = engine(target.path(), settings());
        if during_copy {
            let mut changed = false;
            let result = engine
                .prepare_historical_context(
                    &uuid::Uuid::new_v4().to_string(),
                    &source,
                    |progress| {
                        if progress.attachment_index == Some(0) && !changed {
                            engine.settings.write().unwrap().model =
                                "switched while copying".into();
                            changed = true;
                        }
                        true
                    },
                )
                .await;
            assert!(result.is_err());
        } else {
            let projection = ready(
                engine
                    .prepare_historical_context(&uuid::Uuid::new_v4().to_string(), &source, |_| {
                        true
                    })
                    .await
                    .unwrap(),
            );
            assert!(
                engine
                    .publish_prepared_historical_context(projection, |_| false)
                    .is_err()
            );
        }
        assert!(!engine.state.history_path().unwrap().exists());
        assert_eq!(engine.state.message_count(), 0);
        assert!(requests.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn existing_v1_v2_and_v3_preparations_can_still_publish_without_a_model_request() {
    for revision in [
        LEGACY_HISTORICAL_CONTEXT_COMPILER_REVISION,
        kcoder_types::historical_context::HISTORICAL_CONTEXT_COMPILER_REVISION_V2,
        kcoder_types::historical_context::HISTORICAL_CONTEXT_COMPILER_REVISION_V3,
    ] {
        let profile = tempfile::tempdir().unwrap();
        let runtime = tempfile::tempdir().unwrap();
        let source = prepared_with_revision(profile.path(), &[], false, revision);
        let (engine, requests) = engine(runtime.path(), settings());
        let projection = ready(
            engine
                .prepare_historical_context(&uuid::Uuid::new_v4().to_string(), &source, |_| true)
                .await
                .unwrap(),
        );
        engine
            .publish_prepared_historical_context(projection, |_| true)
            .unwrap();
        assert!(engine.state.historical_seed_receipt().unwrap().is_some());
        assert!(requests.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn reconstructed_context_is_marked_in_model_input_and_preparation() {
    for revision in [
        HISTORICAL_CONTEXT_RECONSTRUCTED_REVISION_V1,
        HISTORICAL_CONTEXT_RECONSTRUCTED_REVISION,
    ] {
        let profile = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let source = prepared_with_revision(profile.path(), &[], false, revision);
        let (engine, requests) = engine(target.path(), settings());
        let projection = ready(
            engine
                .prepare_historical_context(&uuid::Uuid::new_v4().to_string(), &source, |_| true)
                .await
                .unwrap(),
        );
        assert_eq!(source.context().document.revision, revision);
        let Message::User { content, .. } = &projection.message else {
            panic!("runtime evidence required")
        };
        assert!(content.iter().any(|block| matches!(block, ContentBlock::Text { text } if text.contains("not an exact reproduction"))));
        assert!(content.iter().any(|block| matches!(block, ContentBlock::Text { text } if text.contains("If an opaque provider compaction was present"))));
        assert!(requests.lock().unwrap().is_empty());
    }
}
