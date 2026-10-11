//! Model-independent durability, ownership and billing boundaries; no vision-quality claim.
use anyhow::Result;
use kcoder_knowledge::{
    ImageImportInput, KnowledgeCatalog, KnowledgeScope, SourceChunk, WikiTokenUsage,
};

#[test]
fn complete_vision_response_survives_reopen_and_failed_validation_without_second_call() -> Result<()>
{
    let root = tempfile::tempdir()?;
    let path = root.path().join("state.sqlite");
    let scope = KnowledgeScope::from_authenticated_host("alice", "target")?;
    let mut store = KnowledgeCatalog::open(&path)?;
    let library = store.create(&scope, "library", "Images", "")?;
    let input = ImageImportInput {
        key: "image",
        title: "one.png",
        original: b"original",
        mime: "image/png",
        source: None,
        expected_revision: None,
    };
    let accepted = store.accept_image_import(&scope, &library.id, &input)?;
    assert!(
        store
            .list_sources(&scope, &library.id, None, 20)?
            .is_empty()
    );
    let lease = store.claim_image_import(
        &scope,
        &library.id,
        &accepted.id,
        false,
        0,
        "vision",
        "recipe",
    )?;
    store.receive_image_response(
        &scope,
        &library.id,
        &lease,
        "complete private interpretation",
        Some(WikiTokenUsage {
            input_tokens: 12,
            output_tokens: 7,
        }),
    )?;
    store.fail_image_import(&scope, &library.id, &lease, "validation_failed", None)?;
    drop(store);
    let mut store = KnowledgeCatalog::open(&path)?;
    assert_eq!(
        store.accept_image_import(&scope, &library.id, &input)?.id,
        accepted.id
    );
    assert!(
        store
            .claim_image_import(
                &scope,
                &library.id,
                &accepted.id,
                false,
                0,
                "vision",
                "recipe"
            )
            .is_err()
    );
    let lease = store.claim_image_import(
        &scope,
        &library.id,
        &accepted.id,
        true,
        0,
        "vision",
        "recipe",
    )?;
    assert_eq!(
        store
            .image_response(&scope, &library.id, &lease)?
            .as_deref(),
        Some("complete private interpretation")
    );
    let public = store.read_image_import(&scope, &library.id, &accepted.id)?;
    assert_eq!(public.reserved_calls, 1);
    assert_eq!(public.input_tokens, Some(12));
    assert_eq!(public.output_tokens, Some(7));
    assert!(!serde_json::to_string(&public)?.contains("complete private interpretation"));
    let chunks = vec![SourceChunk {
        ordinal: 1,
        chunk_id: "chunk-1".into(),
        first_line: 1,
        last_line: 1,
        text: "verified source interpretation".into(),
        page: None,
    }];
    let report = serde_json::json!({"format":"image","textBytes":30,"chunkCount":1,"warnings":[]});
    let source = store.commit_image_import(&scope, &library.id, &lease, chunks, &report)?;
    assert_eq!(
        store
            .read_image_import(&scope, &library.id, &accepted.id)?
            .status,
        "completed"
    );
    assert_eq!(
        store
            .original_source(&scope, &library.id, &source.source_id, &source.revision_id)?
            .2,
        b"original"
    );
    Ok(())
}

#[test]
fn cancel_and_budget_reject_stale_owner_and_changed_semantics() -> Result<()> {
    let root = tempfile::tempdir()?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "target")?;
    let mut store = KnowledgeCatalog::open(&root.path().join("state.sqlite"))?;
    let library = store.create(&scope, "library", "Images", "")?;
    let mut input = ImageImportInput {
        key: "image",
        title: "one.png",
        original: b"original",
        mime: "image/png",
        source: None,
        expected_revision: None,
    };
    let accepted = store.accept_image_import(&scope, &library.id, &input)?;
    input.expected_revision = Some("changed");
    assert!(
        store
            .accept_image_import(&scope, &library.id, &input)
            .is_err()
    );
    let lease = store.claim_image_import(
        &scope,
        &library.id,
        &accepted.id,
        false,
        0,
        "vision",
        "recipe",
    )?;
    store.fail_image_import(&scope, &library.id, &lease, "transport_failed", None)?;
    assert!(
        store
            .claim_image_import(
                &scope,
                &library.id,
                &accepted.id,
                true,
                0,
                "vision",
                "recipe"
            )
            .is_err()
    );
    let lease = store.claim_image_import(
        &scope,
        &library.id,
        &accepted.id,
        true,
        1,
        "vision",
        "recipe",
    )?;
    assert_eq!(
        store
            .read_image_import(&scope, &library.id, &accepted.id)?
            .unknown_usage_calls,
        2
    );
    store.cancel_image_import(&scope, &library.id, &accepted.id)?;
    assert!(
        store
            .receive_image_response(&scope, &library.id, &lease, "late paid response", None)
            .is_err()
    );
    assert!(
        store
            .claim_image_import(
                &scope,
                &library.id,
                &accepted.id,
                true,
                1,
                "vision",
                "recipe"
            )
            .is_err()
    );
    let other = KnowledgeScope::from_authenticated_host("bob", "target")?;
    assert!(
        store
            .read_image_import(&other, &library.id, &accepted.id)
            .is_err()
    );
    assert!(
        store
            .list_sources(&scope, &library.id, None, 20)?
            .is_empty()
    );
    Ok(())
}

#[test]
fn changed_original_title_and_replacement_cas_fail_before_a_new_paid_call() -> Result<()> {
    let root = tempfile::tempdir()?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "target")?;
    let mut store = KnowledgeCatalog::open(&root.path().join("state.sqlite"))?;
    let library = store.create(&scope, "library", "Images", "")?;
    let source = store.import_text(&scope, &library.id, "source", "old", "old text")?;
    let mut input = ImageImportInput {
        key: "image",
        title: "one.png",
        original: b"original",
        mime: "image/png",
        source: Some(&source.source_id),
        expected_revision: Some(&source.revision_id),
    };
    let accepted = store.accept_image_import(&scope, &library.id, &input)?;
    input.original = b"changed";
    assert!(
        store
            .accept_image_import(&scope, &library.id, &input)
            .is_err()
    );
    input.original = b"original";
    input.title = "changed.png";
    assert!(
        store
            .accept_image_import(&scope, &library.id, &input)
            .is_err()
    );
    let lease = store.claim_image_import(
        &scope,
        &library.id,
        &accepted.id,
        false,
        0,
        "vision",
        "recipe",
    )?;
    assert!(
        store
            .claim_image_import(
                &scope,
                &library.id,
                &accepted.id,
                true,
                1,
                "vision",
                "recipe"
            )
            .is_err()
    );
    store.pause_image_imports(&scope)?;
    assert!(
        store
            .receive_image_response(
                &scope,
                &library.id,
                &lease,
                "late complete response",
                Some(WikiTokenUsage {
                    input_tokens: 1,
                    output_tokens: 1
                })
            )
            .is_err()
    );
    assert_eq!(
        store
            .read_image_import(&scope, &library.id, &accepted.id)?
            .status,
        "failed"
    );
    assert_eq!(
        store
            .read_image_import(&scope, &library.id, &accepted.id)?
            .reserved_calls,
        1
    );
    assert_eq!(
        store.read_source(&scope, &library.id, &source.source_id, &source.revision_id)?,
        "old text"
    );
    Ok(())
}

#[test]
fn image_replacement_commits_with_the_same_source_and_original_revision_cas() -> Result<()> {
    let root = tempfile::tempdir()?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "target")?;
    let mut store = KnowledgeCatalog::open(&root.path().join("state.sqlite"))?;
    let library = store.create(&scope, "library", "Images", "")?;
    let source = store.import_text(&scope, &library.id, "source", "old", "old text")?;
    let input = ImageImportInput {
        key: "replace",
        title: "new.png",
        original: b"original",
        mime: "image/png",
        source: Some(&source.source_id),
        expected_revision: Some(&source.revision_id),
    };
    let accepted = store.accept_image_import(&scope, &library.id, &input)?;
    let lease = store.claim_image_import(
        &scope,
        &library.id,
        &accepted.id,
        false,
        0,
        "vision",
        "recipe",
    )?;
    store.receive_image_response(
        &scope,
        &library.id,
        &lease,
        "private complete response",
        None,
    )?;
    let chunks = vec![SourceChunk {
        ordinal: 1,
        chunk_id: "chunk-1".into(),
        first_line: 1,
        last_line: 1,
        text: "verified".into(),
        page: None,
    }];
    let report = serde_json::json!({"format":"image","textBytes":8,"chunkCount":1,"warnings":[]});
    let updated = store.commit_image_import(&scope, &library.id, &lease, chunks, &report)?;
    assert_eq!(updated.source_id, source.source_id);
    assert_ne!(updated.revision_id, source.revision_id);
    assert_eq!(
        store
            .accept_image_import(&scope, &library.id, &input)?
            .revision_id
            .as_deref(),
        Some(updated.revision_id.as_str())
    );
    assert_eq!(
        store
            .original_source(
                &scope,
                &library.id,
                &updated.source_id,
                &updated.revision_id
            )?
            .2,
        b"original"
    );
    assert_eq!(
        store.read_source(&scope, &library.id, &source.source_id, &source.revision_id)?,
        "old text"
    );
    Ok(())
}
