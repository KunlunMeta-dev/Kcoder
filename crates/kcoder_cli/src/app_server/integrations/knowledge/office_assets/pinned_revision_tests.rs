//! Explicit adoption changes the next real task, never an existing fixed result.
use super::*;

fn next_accepted(fixture: &Fixture) -> Result<TurnAttemptIdentity> {
    fixture
        .engine
        .state
        .add_message(kcoder_types::Message::user_text(
            "Use the explicitly adopted second revision in a new task.",
        ));
    let identity = TurnAttemptIdentity {
        thread_id: fixture.engine.session_id(),
        turn_id: uuid::Uuid::new_v4().to_string(),
        attempt_id: uuid::Uuid::new_v4().to_string(),
    };
    crate::app_server::turn_attempts::begin(
        &fixture.engine,
        &identity,
        false,
        None,
        "c".repeat(64),
        "d".repeat(64),
    )?;
    Ok(identity)
}

async fn publish_fixed_result(
    fixture: &Fixture,
    identity: &TurnAttemptIdentity,
    source: &PublicationSource,
    publication: &KnowledgePublication,
) -> Result<(OfficeStore, OfficeArtifactManifest, Vec<u8>, Value)> {
    let references = vec![
        office_wiki_page_reference(source)?,
        OfficeResourceRef {
            kind: PUBLICATION.into(),
            id: publication.draft.publication_id.clone(),
            revision: publication.version.to_string(),
        },
    ];
    let inputs = fixture
        .engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            let provider = NativeKnowledgeOfficeAssets::capture(
                &fixture.native,
                &fixture.engine,
                identity,
                fixture.cache.clone(),
            )?;
            provider
                .validate_sources(
                    &fixture.native,
                    &fixture.request(identity, json!({})),
                    &references,
                    &CancellationToken::new(),
                )
                .await
        })
        .await?;
    let profile = fixture.native.profile()?;
    let store = if let Some(guard) =
        NativeDomainGuard::observe(profile, fixture.native.scope(), NativeDomain::Office)?
    {
        OfficeStore::open_in(
            &guard.directory(profile)?,
            OsStr::new("data"),
            IntegrationOwner::from(fixture.native.scope()),
        )?
        .context("original Office store")?
    } else {
        NativeDomainGuard::initialize(
            profile,
            fixture.native.scope(),
            NativeDomain::Office,
            "explicit-pinned-office",
            |directory| {
                OfficeStore::create_in(
                    directory,
                    OsStr::new("data"),
                    IntegrationOwner::from(fixture.native.scope()),
                )
            },
        )?
        .1
    };
    let source_ids = inputs
        .iter()
        .map(|input| format!("{}@{}", input.reference.id, input.reference.revision))
        .collect::<Vec<_>>();
    let specification = json!({"schemaVersion":1,"kind":"docx","title":"Fixed task result",
        "sourceRefs":source_ids,"paragraphs":[{"text":publication.pages[0].markdown}]});
    let operation = format!("actual-fixed-generation-{}", publication.version);
    store.prepare_canonical_generation(
        &operation,
        OfficeTaskRef {
            thread_id: identity.thread_id.clone(),
            turn_id: identity.turn_id.clone(),
            run_id: None,
        },
        &specification,
        inputs,
        1,
    )?;
    // State binding bytes do not claim native OOXML reader acceptance.
    let bytes = format!(
        "Complete original result for version {}",
        publication.version
    )
    .into_bytes();
    let manifest = OfficeArtifactManifest {
        schema_version: 1,
        id: format!("actual-fixed-result-{}", publication.version),
        revision: 1,
        owner: IntegrationOwner::from(fixture.native.scope()),
        task: OfficeTaskRef {
            thread_id: identity.thread_id.clone(),
            turn_id: identity.turn_id.clone(),
            run_id: None,
        },
        kind: OfficeArtifactKind::Document,
        title: "Fixed result".into(),
        format: OfficeFileFormat::Docx,
        bytes: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        source_refs: references,
        verification: OfficeVerification {
            status: OfficeVerificationStatus::Partial,
            completed_checks: vec!["content_identity".into()],
            pending_checks: vec!["business_acceptance".into()],
            reader_status: OfficeVerificationStatus::Unavailable,
            formula_calculation: "not_applicable".into(),
        },
        dataset: None,
        presentation: None,
        created_at_ms: 1,
    };
    let published = store.publish_generated_artifact(
        &format!("publish-{operation}"),
        &operation,
        manifest,
        &bytes,
        OfficeGeneratorIdentity {
            component: "controlled-state-binding-fixture".into(),
            version: "1.0.0".into(),
            schema_revision: "office-generation/v1".into(),
            implementation_sha256: "a".repeat(64),
            dependency_lock_sha256: "b".repeat(64),
        },
    )?;
    finish(fixture, identity)?;
    Ok((store, published, bytes, specification))
}

fn read_complete_source(store: &OfficeStore, manifest: &OfficeArtifactManifest) -> Result<Value> {
    let reference = OfficeArtifactRef {
        id: manifest.id.clone(),
        revision: manifest.revision,
    };
    let metadata = store.read_canonical_source(&reference, None, 0, 64, true)?;
    let descriptor = metadata.source.context("original canonical source")?;
    let mut text = String::new();
    let mut offset = 0;
    loop {
        let page = store.read_canonical_source(
            &reference,
            Some(&descriptor.specification_sha256),
            offset,
            127,
            false,
        )?;
        text.push_str(page.chunk.as_deref().context("original source page")?);
        if page.complete {
            break;
        }
        offset = page.next_offset.context("next original page")?;
    }
    assert_eq!(
        format!("{:x}", Sha256::digest(text.as_bytes())),
        descriptor.specification_sha256
    );
    Ok(serde_json::from_str(&text)?)
}

#[tokio::test]
async fn explicit_r2_adoption_changes_only_the_new_accepted_task_and_keeps_original_export_pinned()
-> Result<()> {
    let fixture = Fixture::new()?;
    let (mut wiki, legacy, r1) = fixture.seed()?;
    let first = fixture.publish(&r1, 0).await?;
    fixture.adopt(&first).await?;
    let first_task = fixture.accepted()?;
    let (store, old, old_bytes, old_spec) =
        publish_fixed_result(&fixture, &first_task, &r1, &first).await?;
    let assets = NativeOfficeFileAssets::capture_management(
        &fixture.native,
        &fixture.engine,
        Arc::new(NativeOfficeTransfers::default()),
        Some(Arc::new(ManagementSources {
            engine: fixture.engine.clone(),
            cache: fixture.cache.clone(),
        })),
    )?;
    let cancel = CancellationToken::new();
    let mut old_request = fixture.request(&first_task, json!({}));
    old_request.operation_id = Some("original-r1-export".into());
    let old_receipt: OfficeExportReceipt = serde_json::from_value(
        assets
            .prepare_export(
                &fixture.native,
                &old_request,
                &old,
                old_bytes.clone(),
                &cancel,
            )
            .await?,
    )?;
    let edited = wiki.edit_page(
        &legacy,
        &r1.library_id,
        &r1.page_id,
        &r1.page_revision,
        "explicit-r2",
        "New material",
        "Real second revision for the explicitly adopted next task.",
    )?;
    let r2 = PublicationSource {
        page_revision: edited.revision_id,
        ..r1.clone()
    };
    let second = fixture.publish(&r2, 1).await?;
    assert_eq!(second.version, 2);
    let new_ref = OfficeResourceRef {
        kind: PUBLICATION.into(),
        id: second.draft.publication_id.clone(),
        revision: "2".into(),
    };
    assert!(
        validate_management_office_knowledge_sources(
            &fixture.native,
            &fixture.engine,
            &fixture.cache,
            &old_request,
            std::slice::from_ref(&new_ref),
            &cancel
        )
        .await
        .is_err()
    );
    assert_eq!(read_complete_source(&store, &old)?, old_spec);
    let mut adopt = fixture.request(
        &first_task,
        json!({"owner":second.owner,
        "publicationId":second.draft.publication_id,"version":2}),
    );
    adopt.payload.remove("task");
    adopt.operation_id = Some("explicitly-adopt-r2-for-next-task".into());
    adopt.expected_revision = Some("1".into());
    let reply = fixture.host().await?.knowledge(
        "adoptPublication",
        &adopt,
        true,
        u64::try_from(chrono::Utc::now().timestamp_millis())?,
        &cancel,
    );
    assert_eq!(reply.status, IntegrationStatus::Completed, "{reply:?}");
    let second_task = next_accepted(&fixture)?;
    assert_ne!(first_task.turn_id, second_task.turn_id);
    let (new_store, new, new_bytes, new_spec) =
        publish_fixed_result(&fixture, &second_task, &r2, &second).await?;
    assert_ne!(new_spec, old_spec);
    assert_eq!(read_complete_source(&store, &old)?, old_spec);
    assert_eq!(read_complete_source(&new_store, &new)?, new_spec);
    assert_eq!(
        store
            .read_artifact(&old_receipt.reference)?
            .context("old manifest")?,
        old
    );
    let mut new_request = fixture.request(&second_task, json!({}));
    new_request.operation_id = Some("explicit-r2-export".into());
    let new_receipt: OfficeExportReceipt = serde_json::from_value(
        assets
            .prepare_export(
                &fixture.native,
                &new_request,
                &new,
                new_bytes.clone(),
                &cancel,
            )
            .await?,
    )?;
    for (receipt, expected, task) in [
        (&old_receipt, &old_bytes, &first_task),
        (&new_receipt, &new_bytes, &second_task),
    ] {
        let chunk = assets
            .read_attachment_chunk(
                &fixture.native,
                &AttachmentReadChunkParams {
                    thread_id: task.thread_id.clone(),
                    path: NativeOfficeFileAssets::export_locator(receipt),
                    offset: 0,
                    length: 4096,
                },
                &cancel,
            )
            .await?;
        assert_eq!(STANDARD.decode(chunk.content_base64)?, *expected);
        assert!(chunk.eof);
    }
    Ok(())
}
