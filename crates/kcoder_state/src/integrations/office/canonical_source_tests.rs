use super::*;
use kcoder_types::integrations::core::IntegrationNullable;
use serde_json::json;

fn owner() -> IntegrationOwner {
    IntegrationOwner {
        account_id: "canonical-owner".into(),
        target_id: "target".into(),
        workspace_id: IntegrationNullable::Null,
        organization_id: None,
    }
}
fn task() -> OfficeTaskRef {
    OfficeTaskRef {
        thread_id: "native-thread".into(),
        turn_id: "native-turn".into(),
        run_id: None,
    }
}
fn setup() -> (tempfile::TempDir, OfficeStore) {
    let temp = tempfile::tempdir().unwrap();
    let store = OfficeStore::create(&temp.path().join("office"), owner()).unwrap();
    (temp, store)
}
fn generator() -> OfficeGeneratorIdentity {
    OfficeGeneratorIdentity {
        component: "controlled-test-generator".into(),
        version: "1.0.0".into(),
        schema_revision: "office-generation/v1".into(),
        implementation_sha256: "a".repeat(64),
        dependency_lock_sha256: "b".repeat(64),
    }
}
fn manifest(id: &str, format: OfficeFileFormat, bytes: &[u8]) -> OfficeArtifactManifest {
    OfficeArtifactManifest {
        schema_version: 1,
        id: id.into(),
        revision: 1,
        owner: owner(),
        task: task(),
        kind: if format == OfficeFileFormat::Xlsx {
            OfficeArtifactKind::Table
        } else {
            OfficeArtifactKind::Document
        },
        title: "Canonical source fixture".into(),
        format,
        bytes: bytes.len() as u64,
        sha256: digest(bytes),
        source_refs: vec![],
        verification: OfficeVerification {
            status: OfficeVerificationStatus::Pending,
            completed_checks: vec![],
            pending_checks: vec!["native_reader".into()],
            reader_status: OfficeVerificationStatus::Pending,
            formula_calculation: "not_performed".into(),
        },
        dataset: None,
        created_at_ms: 1,
        presentation: None,
    }
}
fn read_all(
    store: &OfficeStore,
    reference: &OfficeArtifactRef,
) -> (OfficeCanonicalSourceDescriptor, Value) {
    let metadata = store
        .read_canonical_source(reference, None, 0, 64 * 1024, true)
        .unwrap();
    assert!(metadata.chunk.is_none());
    let source = metadata.source.unwrap();
    let mut text = String::new();
    let mut offset = 0;
    loop {
        let part = store
            .read_canonical_source(
                reference,
                Some(&source.specification_sha256),
                offset,
                127,
                false,
            )
            .unwrap();
        text.push_str(part.chunk.as_deref().unwrap());
        if part.complete {
            break;
        }
        offset = part.next_offset.unwrap();
    }
    assert_eq!(digest(text.as_bytes()), source.specification_sha256);
    assert_eq!(text.len() as u64, source.specification_bytes);
    (source, serde_json::from_str(&text).unwrap())
}

#[test]
fn all_sheets_and_formula_strings_survive_exact_private_read_and_reopen() {
    let (temp, store) = setup();
    let spec = json!({"schemaVersion":1,"kind":"xlsx","title":"完整多表","sourceRefs":[],"sheets":[{"name":"first","columns":[{"key":"amount","title":"金额","type":"number"}],"rows":[[1],[2]],"formulas":[{"cell":"A4","formula":"=SUM(A2:A3)"}]},{"name":"second","columns":[{"key":"literal","title":"原文","type":"string"}],"rows":[["第二工作表，不能从首表预览重建"]],"formulas":[]}]});
    let prepared = store
        .prepare_canonical_generation("original-op", task(), &spec, vec![], 1)
        .unwrap();
    assert_eq!(
        store
            .prepared_generation_specification("original-op")
            .unwrap(),
        spec
    );
    let bytes = b"State binding fixture; this test does not claim OOXML reader acceptance";
    let expected = manifest("generated", OfficeFileFormat::Xlsx, bytes);
    store
        .publish_generated_artifact(
            "publish",
            "original-op",
            expected.clone(),
            bytes,
            generator(),
        )
        .unwrap();
    drop(store);
    let store = OfficeStore::open_existing(&temp.path().join("office"), owner())
        .unwrap()
        .unwrap();
    let (source, actual) = read_all(
        &store,
        &OfficeArtifactRef {
            id: "generated".into(),
            revision: 1,
        },
    );
    assert_eq!(actual, spec);
    assert_eq!(source.operation_id, "original-op");
    assert_eq!(source.output_sha256, expected.sha256);
    assert_eq!(source.specification_sha256, prepared.specification_sha256);
}

#[test]
fn paragraphs_beyond_ui_preview_and_complete_slide_image_sources_are_not_truncated() {
    let (_temp, store) = setup();
    let paragraphs = (0..15)
        .map(|index| json!({"text":format!("段落-{index}:{}","完整原文".repeat(300))}))
        .collect::<Vec<_>>();
    let spec = json!({"schemaVersion":1,"kind":"docx","title":"正文","sourceRefs":[],"paragraphs":paragraphs});
    store
        .prepare_canonical_generation("doc-op", task(), &spec, vec![], 1)
        .unwrap();
    let bytes = b"docx fixture";
    store
        .publish_generated_artifact(
            "doc-publish",
            "doc-op",
            manifest("doc", OfficeFileFormat::Docx, bytes),
            bytes,
            generator(),
        )
        .unwrap();
    let (_, actual) = read_all(
        &store,
        &OfficeArtifactRef {
            id: "doc".into(),
            revision: 1,
        },
    );
    assert_eq!(actual, spec);
    assert_eq!(actual["paragraphs"].as_array().unwrap().len(), 15);
    let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=";
    let slides=(0..12).map(|index|json!({"title":format!("Slide-{index}"),"paragraphs":["Literal text"],"notes":format!("Complete speaker note {index}"),"images":[{"data":png,"alt":"Original immutable inline image"}]})).collect::<Vec<_>>();
    let ppt =
        json!({"schemaVersion":1,"kind":"pptx","title":"幻灯片","sourceRefs":[],"slides":slides});
    store
        .prepare_canonical_generation("ppt-op", task(), &ppt, vec![], 2)
        .unwrap();
    store
        .publish_generated_artifact(
            "ppt-publish",
            "ppt-op",
            manifest("ppt", OfficeFileFormat::Pptx, bytes),
            bytes,
            generator(),
        )
        .unwrap();
    let (_, actual) = read_all(
        &store,
        &OfficeArtifactRef {
            id: "ppt".into(),
            revision: 1,
        },
    );
    assert_eq!(actual, ppt);
    assert_eq!(actual["slides"][11]["images"][0]["data"], png);
}

#[test]
fn legacy_artifact_has_no_source_and_never_reconstructs_from_preview() {
    let (_temp, store) = setup();
    let bytes = b"old file";
    let mut old = manifest("legacy", OfficeFileFormat::Docx, bytes);
    old.presentation = Some(OfficeArtifactPresentation::Document {
        paragraphs: vec!["Only a truncated old preview".into()],
    });
    store
        .publish_artifact("legacy-publish", old, bytes)
        .unwrap();
    let read = store
        .read_canonical_source(
            &OfficeArtifactRef {
                id: "legacy".into(),
                revision: 1,
            },
            None,
            0,
            100,
            true,
        )
        .unwrap();
    assert_eq!(
        read.availability,
        OfficeCanonicalSourceAvailability::NotRecorded
    );
    assert!(read.source.is_none() && read.chunk.is_none() && !read.complete);
}

#[test]
fn prepare_only_and_lost_action_reply_keep_original_identity_without_regeneration() {
    let (temp, store) = setup();
    let spec = json!({"schemaVersion":1,"kind":"docx","title":"recover","sourceRefs":[],"paragraphs":[{"text":"Original source"}]});
    store.begin_action("op", "office.generate", &spec).unwrap();
    let first = store
        .prepare_canonical_generation("op", task(), &spec, vec![], 10)
        .unwrap();
    store
        .dispatch_action_checkpoint("op", json!({"canonicalSourcePrepared":first}))
        .unwrap();
    assert!(store.generation_publication("op").unwrap().is_none());
    drop(store);
    let store = OfficeStore::open_existing(&temp.path().join("office"), owner())
        .unwrap()
        .unwrap();
    assert_eq!(store.read_action("op").unwrap().unwrap().phase, "executing");
    assert_eq!(
        store
            .prepare_canonical_generation("op", task(), &spec, vec![], 99)
            .unwrap()
            .created_at_ms,
        10
    );
    let bytes = b"actual persistent output bytes";
    let published = store
        .publish_generated_artifact(
            "publish",
            "op",
            manifest("recovered", OfficeFileFormat::Docx, bytes),
            bytes,
            generator(),
        )
        .unwrap();
    assert_eq!(
        store.generation_publication("op").unwrap().unwrap(),
        published
    );
    assert_eq!(
        store.generation_publication("op").unwrap().unwrap(),
        published
    );
    assert_eq!(
        store
            .publish_generated_artifact("publish", "op", published.clone(), bytes, generator())
            .unwrap(),
        published
    );
    assert_eq!(store.list_artifacts("native-thread").unwrap().len(), 1);
}

#[test]
fn missing_or_changed_source_fails_closed_without_overwriting_from_incoming_or_preview() {
    let (temp, store) = setup();
    let spec = json!({"schemaVersion":1,"kind":"docx","title":"source","sourceRefs":[],"paragraphs":[{"text":"Keep this exact value"}]});
    let prepared = store
        .prepare_canonical_generation("op", task(), &spec, vec![], 1)
        .unwrap();
    let path = temp
        .path()
        .join("office")
        .join(source_blob(&prepared.specification_sha256));
    std::fs::remove_file(&path).unwrap();
    assert!(store.read_canonical_preparation("op").is_err());
    assert!(
        store
            .prepare_canonical_generation("op", task(), &spec, vec![], 2)
            .is_err()
    );
    assert!(!path.exists());
    assert!(store.generation_publication("op").unwrap().is_none());
}

#[test]
fn source_revision_wrong_hash_and_foreign_owner_are_rejected() {
    let (temp, store) = setup();
    let spec = json!({"schemaVersion":1,"kind":"docx","title":"source","sourceRefs":[]});
    store
        .prepare_canonical_generation("op", task(), &spec, vec![], 1)
        .unwrap();
    let bytes = b"file";
    store
        .publish_generated_artifact(
            "publish",
            "op",
            manifest("result", OfficeFileFormat::Docx, bytes),
            bytes,
            generator(),
        )
        .unwrap();
    let reference = OfficeArtifactRef {
        id: "result".into(),
        revision: 1,
    };
    assert!(
        store
            .read_canonical_source(&reference, Some(&"0".repeat(64)), 0, 100, false)
            .is_err()
    );
    assert!(
        store
            .read_canonical_source(
                &OfficeArtifactRef {
                    revision: 2,
                    ..reference
                },
                None,
                0,
                100,
                true
            )
            .is_err()
    );
    let mut other = owner();
    other.account_id = "foreign".into();
    assert!(OfficeStore::open_existing(&temp.path().join("office"), other).is_err());
}

#[test]
fn adopted_r1_dataset_content_and_export_stay_pinned_after_real_r2_publication() {
    let (_temp, store) = setup();
    let mut data = OfficeDataset {
        schema_version: 1,
        id: "material".into(),
        revision: 1,
        owner: owner(),
        task: Some(task()),
        columns: vec![OfficeColumn {
            key: "literal".into(),
            title: "原文".into(),
            kind: OfficeColumnType::String,
            unit: None,
        }],
        rows: vec![vec![json!("r1 original material")]],
        source_refs: vec![],
    };
    let native_r1 = store
        .create_dataset("real-material-r1", data.clone())
        .unwrap();
    let r1hash =
        digest(&serde_json::to_vec(&store.read_dataset(&native_r1).unwrap().unwrap()).unwrap());
    let r1ref = OfficeResourceRef {
        kind: "dataset".into(),
        id: "material".into(),
        revision: "1".into(),
    };
    let spec = json!({"schemaVersion":1,"kind":"docx","title":"Pinned source","sourceRefs":["material@1"],"paragraphs":[{"text":"r1 original material"}]});
    store
        .prepare_canonical_generation(
            "r1-generation",
            task(),
            &spec,
            vec![OfficeCanonicalInputIdentity {
                reference: r1ref.clone(),
                sha256: r1hash.clone(),
            }],
            1,
        )
        .unwrap();
    let bytes = b"owned r1 deliverable";
    let mut result = manifest("r1-result", OfficeFileFormat::Docx, bytes);
    result.source_refs = vec![r1ref];
    store
        .publish_generated_artifact("r1-publish", "r1-generation", result, bytes, generator())
        .unwrap();
    data.revision = 2;
    data.rows = vec![vec![json!("r2 changed material")]];
    store.create_dataset("real-material-r2", data).unwrap();
    let reference = OfficeArtifactRef {
        id: "r1-result".into(),
        revision: 1,
    };
    let (source, read) = read_all(&store, &reference);
    assert_eq!(read, spec);
    assert_eq!(source.inputs[0].sha256, r1hash);
    assert_eq!(source.inputs[0].reference.revision, "1");
    assert_eq!(
        store.read_dataset(&native_r1).unwrap().unwrap().rows[0][0],
        "r1 original material"
    );
    assert_eq!(
        store.read_artifact_chunk(&reference, 0, 1000).unwrap().0,
        bytes
    );
}

#[test]
fn pending_native_tool_metadata_is_not_a_published_context_projection_receipt() {
    let (_temp, store) = setup();
    let receipt = OfficeCanonicalToolReceipt {
        session_id: "native-thread".into(),
        tool_call_id: "real-call".into(),
        tool_name: "OfficeDocument".into(),
        feature: "office".into(),
        source_revision: "native-revision".into(),
        original_input_sha256: "f".repeat(64),
        operation_id: "op".into(),
    };
    store
        .prepare_canonical_tool_receipt(receipt.clone())
        .unwrap();
    assert!(
        store
            .canonical_tool_source(
                "native-thread",
                "real-call",
                "OfficeDocument",
                &receipt.original_input_sha256
            )
            .unwrap()
            .is_none()
    );
    let spec = json!({"schemaVersion":1,"kind":"docx","title":"Source","sourceRefs":[]});
    store
        .prepare_canonical_generation("op", task(), &spec, vec![], 1)
        .unwrap();
    let bytes = b"owned output";
    store
        .publish_generated_artifact(
            "publish",
            "op",
            manifest("result", OfficeFileFormat::Docx, bytes),
            bytes,
            generator(),
        )
        .unwrap();
    let (native, source) = store
        .canonical_tool_source(
            "native-thread",
            "real-call",
            "OfficeDocument",
            &receipt.original_input_sha256,
        )
        .unwrap()
        .unwrap();
    assert_eq!(native, receipt);
    assert_eq!(source.operation_id, "op");
    assert!(
        store
            .canonical_tool_source(
                "another-session",
                "real-call",
                "OfficeDocument",
                &receipt.original_input_sha256
            )
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .canonical_tool_source(
                "native-thread",
                "real-call",
                "OfficeDocument",
                &"0".repeat(64)
            )
            .unwrap()
            .is_none()
    );
}

#[test]
fn native_namespace_fd_open_is_read_only_and_reports_actual_held_child_identity() {
    let temp = tempfile::tempdir().unwrap();
    let namespace = PrivateDirectory::open_existing(temp.path())
        .unwrap()
        .create_private_child(OsStr::new("namespace"))
        .unwrap();
    assert!(
        OfficeStore::open_in(&namespace, OsStr::new("absent"), owner())
            .unwrap()
            .is_none()
    );
    assert!(namespace.entry_metadata(OsStr::new("absent")).is_err());
    let store = OfficeStore::create_in(&namespace, OsStr::new("data"), owner()).unwrap();
    let native = namespace
        .open_entry_handle(OsStr::new("data"))
        .unwrap()
        .open_child_directory()
        .unwrap();
    assert_eq!(
        store.storage_directory_identity().unwrap(),
        native.directory_identity().unwrap()
    );
    let reopened = OfficeStore::open_in(&namespace, OsStr::new("data"), owner())
        .unwrap()
        .unwrap();
    assert_eq!(
        reopened.storage_directory_identity().unwrap(),
        native.directory_identity().unwrap()
    );
}

#[test]
fn native_card_resource_observation_requires_private_receipt_and_completed_actual_action() {
    let (_temporary, store) = setup();
    let bytes = serde_json::to_vec(&OfficeArtifactPresentation::Document {
        paragraphs: vec!["owned declarative data".into()],
    })
    .unwrap();
    let mut published = manifest("native-card", OfficeFileFormat::Json, &bytes);
    published.presentation = Some(OfficeArtifactPresentation::Document {
        paragraphs: vec!["owned declarative data".into()],
    });
    let reference = OfficeArtifactRef {
        id: published.id.clone(),
        revision: published.revision,
    };
    let receipt = OfficeCanonicalToolReceipt {
        session_id: published.task.thread_id.clone(),
        tool_call_id: "original-native-card-call".into(),
        tool_name: "OfficeCard".into(),
        feature: "office".into(),
        source_revision: "original-native-revision".into(),
        original_input_sha256: "a".repeat(64),
        operation_id: "native-card-operation".into(),
    };
    store
        .begin_action(
            &receipt.operation_id,
            "artifact.createCard",
            &json!({"explicit":"owned input"}),
        )
        .unwrap();
    assert!(
        store
            .native_artifact_tool_receipt(&reference)
            .unwrap()
            .is_none()
    );
    store
        .publish_artifact("actual-card-publication", published.clone(), &bytes)
        .unwrap();
    store
        .complete_action(&receipt.operation_id, &json!({"manifest":published}))
        .unwrap();
    // A public publication/action result is not an original Native tool producer.
    assert!(
        store
            .native_artifact_tool_receipt(&reference)
            .unwrap()
            .is_none()
    );
    store
        .prepare_canonical_tool_receipt(receipt.clone())
        .unwrap();
    let (actual, output) = store
        .native_artifact_tool_receipt(&reference)
        .unwrap()
        .unwrap();
    assert_eq!(actual, receipt);
    assert_eq!(output, published);
    assert!(
        store
            .native_artifact_tool_receipt(&OfficeArtifactRef {
                id: reference.id,
                revision: 2
            })
            .unwrap()
            .is_none()
    );
}
#[test]
fn pending_or_mismatched_native_card_call_never_grants_an_artifact() {
    let (_temporary, store) = setup();
    let mut output = manifest("pending-card", OfficeFileFormat::Json, b"{}");
    output.presentation = Some(OfficeArtifactPresentation::Document {
        paragraphs: vec!["owned".into()],
    });
    let reference = OfficeArtifactRef {
        id: output.id.clone(),
        revision: output.revision,
    };
    let receipt = OfficeCanonicalToolReceipt {
        session_id: output.task.thread_id.clone(),
        tool_call_id: "actual-pending-call".into(),
        tool_name: "OfficeCard".into(),
        feature: "office".into(),
        source_revision: "native-revision".into(),
        original_input_sha256: "b".repeat(64),
        operation_id: "pending-card-operation".into(),
    };
    store
        .prepare_canonical_tool_receipt(receipt.clone())
        .unwrap();
    store
        .begin_action(
            &receipt.operation_id,
            "office.generate",
            &json!({"owned":true}),
        )
        .unwrap();
    assert!(
        store
            .native_artifact_tool_receipt(&reference)
            .unwrap()
            .is_none()
    );
    store
        .publish_artifact("actual-mismatched-publication", output.clone(), b"{}")
        .unwrap();
    store
        .complete_action(&receipt.operation_id, &json!({"manifest":output}))
        .unwrap();
    assert!(
        store.native_artifact_tool_receipt(&reference).is_err(),
        "A different actual method cannot mint a card observation"
    );
}
