//! Original task, stored artifact and live export share fixed source authority.
use super::*;
use crate::app_server::integrations::office::native_assets::{
    NativeOfficeFileAssets, NativeOfficeTransfers,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_app_protocol::AttachmentReadChunkParams;

struct ManagementSources {
    engine: QueryEngine,
    cache: Arc<Mutex<NativeKnowledgeRpc>>,
}

#[async_trait::async_trait]
impl NativeOfficeAssets for ManagementSources {
    async fn validate_sources(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        sources: &[OfficeResourceRef],
        cancel: &CancellationToken,
    ) -> Result<Vec<OfficeCanonicalInputIdentity>> {
        validate_management_office_knowledge_sources(
            native,
            &self.engine,
            &self.cache,
            request,
            sources,
            cancel,
        )
        .await
    }
}

#[tokio::test]
async fn original_task_artifact_and_export_keep_removed_r1_but_deny_missing_or_revoked_sources()
-> Result<()> {
    for missing in [false, true] {
        let fixture = Fixture::new()?;
        let (mut wiki, legacy, source) = fixture.seed()?;
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
        let manifest = store
            .read_artifact(&reference)?
            .context("stored artifact")?;
        let bytes = b"Owned actual artifact bytes with fixed knowledge provenance.".to_vec();
        let cancel = CancellationToken::new();
        let mut request = fixture.request(&identity, json!({"reference":reference}));
        request.operation_id = Some("original-joint-holder-export".into());
        let baseline = validate_management_office_knowledge_sources(
            &fixture.native,
            &fixture.engine,
            &fixture.cache,
            &request,
            &manifest.source_refs,
            &cancel,
        )
        .await?;
        finish(&fixture, &identity)?;
        let assets = NativeOfficeFileAssets::capture_management(
            &fixture.native,
            &fixture.engine,
            Arc::new(NativeOfficeTransfers::default()),
            Some(Arc::new(ManagementSources {
                engine: fixture.engine.clone(),
                cache: fixture.cache.clone(),
            })),
        )?;
        let receipt: OfficeExportReceipt = serde_json::from_value(
            assets
                .prepare_export(&fixture.native, &request, &manifest, bytes.clone(), &cancel)
                .await?,
        )?;
        let chunk = AttachmentReadChunkParams {
            thread_id: identity.thread_id.clone(),
            path: NativeOfficeFileAssets::export_locator(&receipt),
            offset: 0,
            length: 4096,
        };
        let page = wiki.read_page(
            &legacy,
            &source.library_id,
            &source.page_id,
            Some(&source.page_revision),
        )?;
        let citation = &page.draft.citations[0];
        wiki.set_source_removed(
            &legacy,
            &source.library_id,
            &citation.source_id,
            &citation.revision_id,
            true,
        )?;
        let library = wiki.read(&legacy, &source.library_id)?;
        wiki.set_archived(&legacy, &library.id, library.revision, true)?;
        let historical = validate_management_office_knowledge_sources(
            &fixture.native,
            &fixture.engine,
            &fixture.cache,
            &request,
            &manifest.source_refs,
            &cancel,
        )
        .await?;
        assert_eq!(historical, baseline);
        let read = assets
            .read_attachment_chunk(&fixture.native, &chunk, &cancel)
            .await?;
        assert_eq!(STANDARD.decode(read.content_base64)?, bytes);
        assert!(read.eof);
        let mut inspect = fixture.request(
            &identity,
            json!({
                "owner": publication.owner, "publicationId": publication.draft.publication_id,
                "version": 1, "after": null,
            }),
        );
        // Knowledge management reads do not accept Office task metadata.
        inspect.payload.remove("task");
        let host = fixture.host().await?;
        let observation = host.knowledge("readPublicationSources", &inspect, false, 2000, &cancel);
        assert_eq!(
            observation.status,
            IntegrationStatus::Completed,
            "{observation:?}"
        );
        let observed = &observation.result.as_ref().unwrap()["page"]["items"][0];
        assert_eq!(observed["removed"], true);
        assert_eq!(observed["available"], true);
        if missing {
            let library = wiki.read(&legacy, &source.library_id)?;
            wiki.set_archived(&legacy, &library.id, library.revision, false)?;
            let latest = wiki.edit_page(
                &legacy,
                &source.library_id,
                &source.page_id,
                &source.page_revision,
                "joint-r2",
                "Current r2",
                "Never replace the held fixed r1.",
            )?;
            let object = fixture
                .profile
                .join("knowledge/state.objects")
                .join(&source.library_id)
                .join(format!(
                    "{:x}.md",
                    Sha256::digest(page.draft.markdown.as_bytes())
                ));
            std::fs::remove_file(object)?;
            assert_eq!(
                wiki.read_page(&legacy, &source.library_id, &source.page_id, None)?
                    .revision_id,
                latest.revision_id
            );
            let observation =
                host.knowledge("readPublicationSources", &inspect, false, 2001, &cancel);
            assert_eq!(
                observation.status,
                IntegrationStatus::Completed,
                "{observation:?}"
            );
            assert_eq!(
                observation.result.as_ref().unwrap()["page"]["items"][0]["available"],
                false
            );
        } else {
            let mut revoke = inspect.clone();
            revoke.operation_id = Some("actual-joint-holder-source-revoke".into());
            revoke.expected_revision = Some("1".into());
            // A mutation does not accept the read-only pagination cursor.
            revoke.payload.remove("after");
            let response = host.knowledge(
                "revokePublication",
                &revoke,
                true,
                u64::try_from(chrono::Utc::now().timestamp_millis())?,
                &cancel,
            );
            assert_eq!(
                response.status,
                IntegrationStatus::Completed,
                "{response:?}"
            );
        }
        // A held receipt and immutable bytes never replace current source authority.
        assert!(
            assets
                .read_attachment_chunk(&fixture.native, &chunk, &cancel)
                .await
                .is_err()
        );
        request.operation_id = Some("new-export-after-source-loss".into());
        assert!(
            assets
                .prepare_export(&fixture.native, &request, &manifest, bytes.clone(), &cancel)
                .await
                .is_err()
        );
        assert!(
            validate_management_office_knowledge_sources(
                &fixture.native,
                &fixture.engine,
                &fixture.cache,
                &request,
                &manifest.source_refs,
                &cancel,
            )
            .await
            .is_err()
        );
        assert_eq!(
            store
                .read_artifact(&reference)?
                .context("original artifact retained")?,
            manifest
        );
    }
    Ok(())
}

#[path = "pinned_revision_tests.rs"]
mod pinned_revision_tests;
