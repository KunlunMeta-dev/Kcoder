use super::*;
use crate::app_server::integrations::core::{NativeDomain, NativeDomainGuard};
use kcoder_state::integrations::office::OfficeStore;

fn stored_manifest(
    fixture: &Fixture,
    identity: &TurnAttemptIdentity,
    sources: Vec<OfficeResourceRef>,
) -> Result<(OfficeStore, OfficeArtifactRef)> {
    let (_, store) = NativeDomainGuard::initialize(
        fixture.native.profile()?,
        fixture.native.scope(),
        NativeDomain::Office,
        "explicit-management-test-office",
        |directory| {
            OfficeStore::create_in(
                directory,
                OsStr::new("data"),
                IntegrationOwner::from(fixture.native.scope()),
            )
        },
    )?;
    let bytes = b"Owned actual artifact bytes with fixed knowledge provenance.";
    let manifest = OfficeArtifactManifest {
        schema_version: 1,
        id: "completed-turn-artifact".into(),
        revision: 1,
        owner: IntegrationOwner::from(fixture.native.scope()),
        task: OfficeTaskRef {
            thread_id: identity.thread_id.clone(),
            turn_id: identity.turn_id.clone(),
            run_id: None,
        },
        kind: OfficeArtifactKind::Document,
        title: "Completed task artifact".into(),
        format: OfficeFileFormat::Csv,
        bytes: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
        source_refs: sources,
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
    let stored = store.publish_artifact("explicit-actual-store-publish", manifest, bytes)?;
    Ok((
        store,
        OfficeArtifactRef {
            id: stored.id,
            revision: stored.revision,
        },
    ))
}
fn finish(fixture: &Fixture, identity: &TurnAttemptIdentity) -> Result<()> {
    crate::app_server::turn_attempts::finish(
        &fixture.engine,
        identity,
        "completed",
        None,
        None,
        &crate::app_server::turn_attempts::PartialOutput::default(),
    )
}

#[tokio::test]
async fn completed_turn_stored_manifest_sources_keep_current_management_access_but_not_model_turn_authority()
-> Result<()> {
    let fixture = Fixture::new()?;
    let (_wiki, _legacy, source) = fixture.seed()?;
    let publication = fixture.publish(&source, 0).await?;
    fixture.adopt(&publication).await?;
    let identity = fixture.accepted()?;
    let refs = vec![
        office_wiki_page_reference(&source)?,
        OfficeResourceRef {
            kind: PUBLICATION.into(),
            id: publication.draft.publication_id.clone(),
            revision: "1".into(),
        },
    ];
    let (store, reference) = stored_manifest(&fixture, &identity, refs)?;
    let actual = store
        .read_artifact(&reference)?
        .context("actual server stored artifact missing")?;
    let model = fixture
        .engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            let model = Arc::new(NativeKnowledgeOfficeAssets::capture(
                &fixture.native,
                &fixture.engine,
                &identity,
                fixture.cache.clone(),
            )?);
            model
                .validate_sources(
                    &fixture.native,
                    &fixture.request(&identity, json!({})),
                    &actual.source_refs,
                    &CancellationToken::new(),
                )
                .await?;
            Ok::<_, anyhow::Error>(model)
        })
        .await?;
    finish(&fixture, &identity)?;
    let mut request = fixture.request(
        &identity,
        json!({"reference":reference,"claimedAllow":true}),
    );
    request.payload.remove("task");
    let result = validate_management_office_knowledge_sources(
        &fixture.native,
        &fixture.engine,
        &fixture.cache,
        &request,
        &actual.source_refs,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(result.len(), 2);
    assert_eq!(
        result
            .iter()
            .map(|entry| &entry.reference)
            .collect::<Vec<_>>(),
        actual.source_refs.iter().collect::<Vec<_>>()
    );
    assert!(
        model
            .validate_sources(
                &fixture.native,
                &request,
                &actual.source_refs,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert!(
        NativeKnowledgeOfficeAssets::capture(
            &fixture.native,
            &fixture.engine,
            &identity,
            fixture.cache.clone()
        )
        .is_err()
    );
    assert_eq!(store.read_artifact(&reference)?.unwrap(), actual);
    Ok(())
}

#[tokio::test]
async fn completed_turn_export_source_rechecks_actual_revoke_and_never_reuses_prior_hash()
-> Result<()> {
    let fixture = Fixture::new()?;
    let (_, _, source) = fixture.seed()?;
    let publication = fixture.publish(&source, 0).await?;
    fixture.adopt(&publication).await?;
    let identity = fixture.accepted()?;
    let (store, reference) = stored_manifest(
        &fixture,
        &identity,
        vec![OfficeResourceRef {
            kind: PUBLICATION.into(),
            id: publication.draft.publication_id.clone(),
            revision: "1".into(),
        }],
    )?;
    finish(&fixture, &identity)?;
    let stored = store.read_artifact(&reference)?.unwrap();
    let request = fixture.request(&identity, json!({"reference":reference}));
    let before = validate_management_office_knowledge_sources(
        &fixture.native,
        &fixture.engine,
        &fixture.cache,
        &request,
        &stored.source_refs,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(before.len(), 1);
    let mut revoke = request.clone();
    revoke.operation_id = Some("actual-completed-task-source-revoke".into());
    revoke.expected_revision = Some("1".into());
    revoke.payload=json!({"owner":publication.owner,"publicationId":publication.draft.publication_id,"version":1}).as_object().unwrap().clone();
    let response = fixture.host().await?.knowledge(
        "revokePublication",
        &revoke,
        true,
        u64::try_from(chrono::Utc::now().timestamp_millis())?,
        &CancellationToken::new(),
    );
    assert_eq!(response.status, IntegrationStatus::Completed);
    assert!(
        validate_management_office_knowledge_sources(
            &fixture.native,
            &fixture.engine,
            &fixture.cache,
            &request,
            &stored.source_refs,
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert_eq!(store.read_artifact(&reference)?.unwrap(), stored);
    Ok(())
}

#[tokio::test]
async fn current_management_scope_policy_missing_wiki_and_unknown_kind_fail_without_creation_or_fallback()
-> Result<()> {
    let fixture = Fixture::new()?;
    let identity = fixture.accepted()?;
    finish(&fixture, &identity)?;
    let request = fixture.request(&identity, json!({"trusted":true}));
    let wiki = office_wiki_page_reference(&PublicationSource {
        library_id: "not-present".into(),
        page_id: "not-present".into(),
        page_revision: "fixed-r1".into(),
    })?;
    assert!(
        validate_management_office_knowledge_sources(
            &fixture.native,
            &fixture.engine,
            &fixture.cache,
            &request,
            std::slice::from_ref(&wiki),
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert!(!fixture.profile.join("knowledge").exists());
    let unknown = OfficeResourceRef {
        kind: "file".into(),
        ..wiki
    };
    assert_eq!(
        validate_management_office_knowledge_sources(
            &fixture.native,
            &fixture.engine,
            &fixture.cache,
            &request,
            &[unknown],
            &CancellationToken::new()
        )
        .await
        .unwrap_err()
        .to_string(),
        "OFFICE_INPUT_PROVIDER_UNAVAILABLE"
    );
    let mut foreign = request;
    foreign.scope.account_id = "not-the-actual-native-account".into();
    assert!(
        validate_management_office_knowledge_sources(
            &fixture.native,
            &fixture.engine,
            &fixture.cache,
            &foreign,
            &[],
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn completed_turn_management_reader_discards_a_current_cache_policy_replacement_mid_read()
-> Result<()> {
    let fixture = Fixture::new()?;
    let (_, _, source) = fixture.seed()?;
    let identity = fixture.accepted()?;
    finish(&fixture, &identity)?;
    let policy = Arc::new(ReplacePolicyDuringRead {
        cache: fixture.cache.clone(),
        reads: AtomicUsize::new(0),
    });
    fixture.cache.lock().await.set_policy(Some(policy.clone()));
    assert!(
        validate_management_office_knowledge_sources(
            &fixture.native,
            &fixture.engine,
            &fixture.cache,
            &fixture.request(&identity, json!({})),
            &[office_wiki_page_reference(&source)?],
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert!(policy.reads.load(Ordering::SeqCst) > 0);
    Ok(())
}

#[path = "joint_holder_tests.rs"]
mod joint_holder_tests;
