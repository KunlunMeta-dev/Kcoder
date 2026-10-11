//! Target-side Wiki catalog RPC. No client-supplied path, identity or model key.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{knowledge_method as km, *};
use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope};
use serde_json::{Value, json};
use std::path::Path;

pub(super) fn supports(method: &str) -> bool {
    matches!(
        method,
        km::IMAGE_IMPORT_LIST
            | km::IMAGE_IMPORT_CANCEL
            | km::FILE_CAPABILITIES
            | km::PAGE_LINKS
            | km::JOB_CANCEL
            | km::DEFAULT_READ
            | km::DEFAULT_SET
            | km::JOB_BUDGET
            | km::JOB_BUDGET_EXTEND
            | km::JOB_OVERVIEW
            | km::SOURCE_REMOVE
            | km::SOURCE_REMOVED
            | km::ARCHIVE
            | km::REINDEX
            | km::INSPECT
            | km::UPDATE
            | km::PAGE_EDIT
            | km::PAGE_HISTORY
            | km::PAGE_RESTORE
            | km::REVIEW_READ
            | km::REVIEW_PAGE
            | km::REVIEW_DECIDE
            | km::CITATION_RESOLVE
            | km::JOB_LIST
            | km::JOB_GET
            | km::JOB_PAUSE
            | km::JOB_PAUSE_ALL
            | km::STATUS
            | km::CONFIGURE
            | km::LIST
            | km::CREATE
            | km::READ
            | km::SEARCH
            | km::IMPORT_TEXT
            | km::SOURCE_LIST
            | km::SOURCE_READ
            | km::PAGE_LIST
            | km::PAGE_READ
    )
}

pub(super) fn settings(path: &Path) -> Result<kcoder_config::KnowledgeSettings> {
    let document = kcoder_config::read_settings_file(path)?;
    Ok(serde_json::from_value(
        document
            .get("knowledge")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )?)
}
pub(super) fn enabled(path: &Path) -> Result<bool> {
    Ok(settings(path)?.is_available())
}
pub(super) fn organization_enabled(path: &Path) -> Result<bool> {
    Ok(settings(path)?.can_organize())
}
fn status(path: &Path) -> Result<Value> {
    let settings = settings(path)?;
    Ok(json!(KnowledgeStatusResult {
        enabled: settings.is_available(),
        retrieval_enabled: settings.can_retrieve(),
        organization_enabled: settings.can_organize()
    }))
}

pub(super) fn request(path: &Path, method: &str, params: Value) -> Result<Value> {
    if matches!(method, km::IMAGE_IMPORT_LIST | km::IMAGE_IMPORT_CANCEL) {
        if !path
            .parent()
            .is_some_and(|root| root.join("knowledge/state.sqlite").is_file())
        {
            ensure!(method == km::IMAGE_IMPORT_LIST, "image import not found");
            let _: KnowledgeImageImportListParams = serde_json::from_value(params)?;
            return Ok(serde_json::to_value(KnowledgeImageImportListResult {
                supported: true,
                items: Vec::new(),
                next_after_id: None,
            })?);
        }
        let (mut store, scope) = open_catalog(path)?;
        return match method {
            km::IMAGE_IMPORT_LIST => {
                let p: KnowledgeImageImportListParams = serde_json::from_value(params)?;
                let items =
                    store.list_image_imports(&scope, &p.library_id, p.after_id.as_deref())?;
                let next_after_id =
                    (items.len() == 100).then(|| items.last().expect("full page").id.clone());
                Ok(serde_json::to_value(KnowledgeImageImportListResult {
                    supported: true,
                    items,
                    next_after_id,
                })?)
            }
            _ => {
                let p: KnowledgeImageImportParams = serde_json::from_value(params)?;
                ensure!(
                    p.additional_call_budget == 0,
                    "cancel cannot authorize model calls"
                );
                store.cancel_image_import(&scope, &p.library_id, &p.import_id)?;
                Ok(serde_json::to_value(store.read_image_import(
                    &scope,
                    &p.library_id,
                    &p.import_id,
                )?)?)
            }
        };
    }
    if method == km::FILE_CAPABILITIES {
        let _: KnowledgeStatusParams = serde_json::from_value(params)?;
        let items = serde_json::from_value(serde_json::to_value(
            kcoder_tools::wiki_document::runtime_file_capabilities(),
        )?)?;
        return Ok(serde_json::to_value(KnowledgeFileCapabilitiesResult {
            supported: true,
            items,
            batch_max_files: 10,
            batch_max_bytes: 128 * 1024 * 1024,
        })?);
    }
    if method == km::JOB_PAUSE_ALL {
        let _: KnowledgePauseAllParams = serde_json::from_value(params)?;
        let paused_jobs = if path
            .parent()
            .is_some_and(|root| root.join("knowledge/state.sqlite").is_file())
        {
            let (mut store, scope) = open_catalog(path)?;
            store.pause_all_jobs(&scope)?
        } else {
            0
        };
        return Ok(json!(KnowledgePauseAllResult { paused_jobs }));
    }
    if method == km::STATUS {
        let _: KnowledgeStatusParams = serde_json::from_value(params)?;
        return status(path);
    }
    if method == km::CONFIGURE {
        let input: KnowledgeConfigureParams = serde_json::from_value(params)?;
        ensure!(
            input.enabled.is_some()
                || input.retrieval_enabled.is_some()
                || input.organization_enabled.is_some(),
            "provide a Wiki switch"
        );
        ensure!(
            input.enabled.is_none()
                || (input.retrieval_enabled.is_none() && input.organization_enabled.is_none()),
            "set either legacy enabled or individual switches"
        );
        let mut pause = false;
        kcoder_config::update_settings_file(path, |document| {
            let mut settings: kcoder_config::KnowledgeSettings = serde_json::from_value(
                document
                    .get("knowledge")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            )?;
            if let Some(value) = input.enabled {
                settings.set_both(value);
            }
            if let Some(value) = input.retrieval_enabled {
                settings.retrieval_enabled = Some(value);
            }
            if let Some(value) = input.organization_enabled {
                settings.organization_enabled = Some(value);
            }
            let retrieval = settings.can_retrieve();
            let organization = settings.can_organize();
            settings.enabled = retrieval || organization;
            settings.retrieval_enabled = Some(retrieval);
            settings.organization_enabled = Some(organization);
            pause = !organization;
            document["knowledge"] = serde_json::to_value(settings)?;
            Ok(())
        })?;
        if pause
            && path
                .parent()
                .is_some_and(|root| root.join("knowledge/state.sqlite").is_file())
        {
            let (mut store, scope) = open_catalog(path)?;
            store.pause_all_jobs(&scope)?;
            store.pause_image_imports(&scope)?;
        }
        return status(path);
    }
    ensure!(supports(method), "unknown knowledge operation");
    // The switch is authoritative on the execution target. Disabled operations
    // must not even materialize the catalog or trigger model/index work.
    ensure!(enabled(path)?, "Wiki is disabled");
    if method == km::SEARCH {
        ensure!(settings(path)?.can_retrieve(), "Wiki retrieval is disabled");
    }
    if matches!(
        method,
        km::CREATE
            | km::UPDATE
            | km::ARCHIVE
            | km::PAGE_EDIT
            | km::PAGE_RESTORE
            | km::REVIEW_DECIDE
            | km::IMPORT_TEXT
            | km::SOURCE_REMOVE
            | km::REINDEX
            | km::JOB_BUDGET_EXTEND
    ) {
        ensure!(organization_enabled(path)?, "Wiki organization is disabled");
    }

    let (mut store, scope) = open_catalog(path)?;
    Ok(match method {
        km::PAGE_LINKS => {
            let p: KnowledgePageLinksParams = serde_json::from_value(params)?;
            json!(store.page_links(&scope, &p.library_id, &p.page_id, 20)?)
        }

        km::JOB_CANCEL => {
            let p: KnowledgeJobParams = serde_json::from_value(params)?;
            store.cancel_job(&scope, &p.library_id, &p.job_id)?;
            json!(store.read_job(&scope, &p.library_id, &p.job_id)?)
        }

        km::DEFAULT_READ => {
            let _: KnowledgeStatusParams = serde_json::from_value(params)?;
            match store.resolve_library(&scope, None, None)? {
                kcoder_knowledge::LibrarySelection::Selected(library) => {
                    json!({"libraryId":library.id})
                }
                _ => json!({"libraryId":null}),
            }
        }
        km::DEFAULT_SET => {
            let p: KnowledgeReadParams = serde_json::from_value(params)?;
            store.set_default_library(&scope, &p.library_id)?;
            json!({"libraryId":p.library_id})
        }

        km::JOB_BUDGET => {
            let p: KnowledgeJobParams = serde_json::from_value(params)?;
            json!(store.budget_read(&scope, &p.library_id, &p.job_id)?)
        }
        km::JOB_BUDGET_EXTEND => {
            let p: KnowledgeBudgetExtendParams = serde_json::from_value(params)?;
            json!(store.budget_extend(
                &scope,
                &p.library_id,
                &p.job_id,
                p.expected_limit,
                p.new_limit
            )?)
        }

        km::JOB_OVERVIEW => {
            let p: KnowledgeJobOverviewParams = serde_json::from_value(params)?;
            json!(store.job_overview_page(
                &scope,
                &p.library_id,
                p.cursor.as_deref(),
                p.limit.unwrap_or(16)
            )?)
        }

        km::SOURCE_REMOVE => {
            let p: KnowledgeSourceRemoveParams = serde_json::from_value(params)?;
            json!(store.set_source_removed(
                &scope,
                &p.library_id,
                &p.source_id,
                &p.expected_revision,
                p.removed
            )?)
        }
        km::SOURCE_REMOVED => {
            let p: KnowledgeContentsParams = serde_json::from_value(params)?;
            let items = store.list_removed_sources(
                &scope,
                &p.library_id,
                p.after_id.as_deref(),
                p.limit,
            )?;
            let next = (items.len() == p.limit)
                .then(|| items.last().map(|item| item.source_id.clone()))
                .flatten();
            let items = items
                .into_iter()
                .map(|source| -> Result<Value> {
                    let extraction = store.source_extraction(
                        &scope,
                        &p.library_id,
                        &source.source_id,
                        &source.revision_id,
                    )?;
                    let mut value = serde_json::to_value(source)?;
                    if let Some(extraction) = extraction {
                        value["extraction"] = extraction;
                    }
                    Ok(value)
                })
                .collect::<Result<Vec<_>>>()?;
            json!({"items":items,"nextAfterId":next})
        }

        km::ARCHIVE => {
            let p: KnowledgeArchiveParams = serde_json::from_value(params)?;
            json!(store.set_archived(&scope, &p.library_id, p.expected_revision, p.archived)?)
        }
        km::REINDEX => {
            let p: KnowledgeReadParams = serde_json::from_value(params)?;
            json!(store.rebuild_index(&scope, &p.library_id)?)
        }
        km::INSPECT => {
            let p: KnowledgeContentsParams = serde_json::from_value(params)?;
            json!(store.inspect_library(&scope, &p.library_id, p.after_id.as_deref(), p.limit)?)
        }
        km::UPDATE => {
            let p: KnowledgeLibraryUpdateParams = serde_json::from_value(params)?;
            json!(store.update_library(
                &scope,
                &p.library_id,
                p.expected_revision,
                &p.name,
                &p.purpose
            )?)
        }
        km::PAGE_EDIT => {
            let p: KnowledgePageEditParams = serde_json::from_value(params)?;
            json!(store.edit_page(
                &scope,
                &p.library_id,
                &p.page_id,
                &p.expected_revision,
                &p.idempotency_key,
                &p.title,
                &p.markdown
            )?)
        }
        km::PAGE_HISTORY => {
            let p: KnowledgePageHistoryParams = serde_json::from_value(params)?;
            let items = store.page_history(
                &scope,
                &p.library_id,
                &p.page_id,
                p.before_sequence,
                p.limit,
            )?;
            let next = (items.len() == p.limit)
                .then(|| items.last().map(|v| v.sequence))
                .flatten();
            json!({"items":items,"nextBeforeSequence":next})
        }
        km::PAGE_RESTORE => {
            let p: KnowledgePageRestoreParams = serde_json::from_value(params)?;
            json!(store.restore_page(
                &scope,
                &p.library_id,
                &p.page_id,
                &p.expected_revision,
                &p.revision_id,
                &p.idempotency_key
            )?)
        }
        km::REVIEW_READ => {
            let input: KnowledgeJobParams = serde_json::from_value(params)?;
            json!(store.pending_review(&scope, &input.library_id, &input.job_id)?)
        }
        km::REVIEW_PAGE => {
            let input: KnowledgeReviewPageParams = serde_json::from_value(params)?;
            json!(store.review_excerpt(
                &scope,
                &input.library_id,
                &input.job_id,
                &input.token,
                &input.page_id,
                input.offset
            )?)
        }
        km::REVIEW_DECIDE => {
            let input: KnowledgeReviewDecisionParams = serde_json::from_value(params)?;
            json!(store.decide_review(
                &scope,
                &input.library_id,
                &input.job_id,
                &input.token,
                input.decision == KnowledgeReviewDecision::Accept
            )?)
        }
        km::CITATION_RESOLVE => {
            let input: KnowledgeCitationParams = serde_json::from_value(params)?;
            let (source, chunk) = store.resolve_citation(
                &scope,
                &input.library_id,
                &input.source_id,
                &input.revision_id,
                &input.chunk_id,
            )?;
            json!({"source":source,"chunk":chunk})
        }
        km::JOB_LIST => {
            let input: KnowledgeContentsParams = serde_json::from_value(params)?;
            let items = store.list_jobs(
                &scope,
                &input.library_id,
                input.after_id.as_deref(),
                input.limit,
            )?;
            let next = (items.len() == input.limit)
                .then(|| items.last().map(|i| i.id.clone()))
                .flatten();
            json!({"items":items,"nextAfterId":next})
        }
        km::JOB_GET | km::JOB_PAUSE => {
            let input: KnowledgeJobParams = serde_json::from_value(params)?;
            if method == km::JOB_PAUSE {
                store.pause_job(&scope, &input.library_id, &input.job_id)?;
            }
            json!(store.read_job(&scope, &input.library_id, &input.job_id)?)
        }
        km::LIST => {
            let input: KnowledgeListParams = serde_json::from_value(params)?;
            let items = store.list(&scope, input.after_id.as_deref(), input.limit)?;
            let next_after_id = (items.len() == input.limit)
                .then(|| items.last().map(|i| i.id.clone()))
                .flatten();
            json!(KnowledgeListResult {
                items,
                next_after_id
            })
        }
        km::CREATE => {
            let input: KnowledgeCreateParams = serde_json::from_value(params)?;
            json!(store.create(&scope, &input.idempotency_key, &input.name, &input.purpose)?)
        }
        km::READ => {
            let input: KnowledgeReadParams = serde_json::from_value(params)?;
            json!(store.read(&scope, &input.library_id)?)
        }
        km::SEARCH => {
            let input: KnowledgeSearchParams = serde_json::from_value(params)?;
            json!({"items":store.search(&scope,&input.library_id,&input.query,input.limit)?})
        }
        km::IMPORT_TEXT => {
            let input: KnowledgeImportTextParams = serde_json::from_value(params)?;
            ensure!(
                input.text.len() <= 256 * 1024,
                "inline import is limited to 256 KiB; use attachment upload for larger sources"
            );
            json!(store.import_text(
                &scope,
                &input.library_id,
                &input.idempotency_key,
                &input.title,
                &input.text
            )?)
        }
        km::SOURCE_LIST => {
            let input: KnowledgeContentsParams = serde_json::from_value(params)?;
            let items = store.list_sources(
                &scope,
                &input.library_id,
                input.after_id.as_deref(),
                input.limit,
            )?;
            let next = (items.len() == input.limit)
                .then(|| items.last().map(|i| i.source_id.clone()))
                .flatten();
            let items = items
                .into_iter()
                .map(|source| -> Result<Value> {
                    let extraction = store.source_extraction(
                        &scope,
                        &input.library_id,
                        &source.source_id,
                        &source.revision_id,
                    )?;
                    let mut value = serde_json::to_value(source)?;
                    if let Some(extraction) = extraction {
                        value["extraction"] = extraction;
                    }
                    Ok(value)
                })
                .collect::<Result<Vec<_>>>()?;
            json!({"items":items,"nextAfterId":next})
        }
        km::SOURCE_READ => {
            let input: KnowledgeSourceReadParams = serde_json::from_value(params)?;
            ensure!(
                (1..=16).contains(&input.limit),
                "source read limit must be 1..16"
            );
            let items = store.source_chunks(
                &scope,
                &input.library_id,
                &input.source_id,
                &input.revision_id,
                input.after_chunk,
                input.limit,
            )?;
            let next = (items.len() == input.limit)
                .then(|| items.last().map(|i| i.ordinal))
                .flatten();
            json!({"items":items,"nextAfterChunk":next,"extraction":store.source_extraction(&scope,&input.library_id,&input.source_id,&input.revision_id)?})
        }
        km::PAGE_LIST => {
            let input: KnowledgeContentsParams = serde_json::from_value(params)?;
            let items = store.list_pages(
                &scope,
                &input.library_id,
                input.after_id.as_deref(),
                input.limit,
            )?;
            let next = (items.len() == input.limit)
                .then(|| items.last().map(|i| i.page_id.clone()))
                .flatten();
            json!({"items":items,"nextAfterId":next})
        }
        km::PAGE_READ => {
            let input: KnowledgePageReadParams = serde_json::from_value(params)?;
            json!(store.read_page(
                &scope,
                &input.library_id,
                &input.page_id,
                input.revision_id.as_deref()
            )?)
        }
        _ => unreachable!("supported method dispatched above"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn switch_is_target_authoritative_and_disabled_calls_have_no_catalog_side_effects() -> Result<()>
    {
        let dir = tempfile::tempdir()?;
        let settings = dir.path().join("settings.json");
        std::fs::write(&settings, "{}")?;
        assert_eq!(request(&settings, km::STATUS, json!({}))?["enabled"], false);
        assert_eq!(
            request(&settings, km::JOB_PAUSE_ALL, json!({}))?["pausedJobs"],
            0
        );
        assert!(request(&settings, km::JOB_PAUSE_ALL, json!({"principal":"other"})).is_err());
        assert!(request(&settings, km::LIST, json!({})).is_err());
        assert!(!dir.path().join("knowledge").exists());
        request(&settings, km::CONFIGURE, json!({"enabled":true}))?;
        let library = request(
            &settings,
            km::CREATE,
            json!({"idempotencyKey":"create","name":"Wiki"}),
        )?;
        let source = request(
            &settings,
            km::IMPORT_TEXT,
            json!({"libraryId":library["id"],"idempotencyKey":"source","title":"资料","text":"原始内容"}),
        )?;
        let content = request(
            &settings,
            km::SOURCE_READ,
            json!({"libraryId":library["id"],"sourceId":source["sourceId"],"revisionId":source["revisionId"]}),
        )?;
        assert_eq!(content["items"][0]["text"], "原始内容");
        let (mut store, scope) = open_catalog(&settings)?;
        let pending = store.enqueue_ingest(
            &scope,
            library["id"].as_str().unwrap(),
            "pause-fixture",
            source["sourceId"].as_str().unwrap(),
            source["revisionId"].as_str().unwrap(),
            "fixture",
            "zh",
        )?;
        assert_eq!(
            request(&settings, km::JOB_PAUSE_ALL, json!({}))?["pausedJobs"],
            1
        );
        assert_eq!(
            store
                .read_job(&scope, library["id"].as_str().unwrap(), &pending.id)?
                .status,
            "paused"
        );
        assert!(enabled(&settings)?);
        request(&settings, km::CONFIGURE, json!({"enabled":false}))?;
        assert!(request(&settings, km::READ, json!({"libraryId":library["id"]})).is_err());
        request(&settings, km::CONFIGURE, json!({"enabled":true}))?;
        assert_eq!(
            request(&settings, km::LIST, json!({}))?["items"][0]["id"],
            library["id"]
        );
        assert!(
            request(
                &settings,
                km::CREATE,
                json!({"idempotencyKey":"other","name":"Wiki","owner":"victim"})
            )
            .is_err()
        );
        Ok(())
    }
}

pub(super) fn open_catalog(path: &Path) -> Result<(KnowledgeCatalog, KnowledgeScope)> {
    let profile = path
        .parent()
        .context("knowledge profile storage unavailable")?
        .canonicalize()?;
    let principal = match std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID") {
        Ok(value) => uuid::Uuid::parse_str(&value)
            .context("invalid host account identity")?
            .to_string(),
        Err(std::env::VarError::NotPresent) => format!("profile:{}", profile.display()),
        Err(error) => return Err(error.into()),
    };
    // Plain SSH compatibility is single-user by profile. Account mode gets a
    // stable principal from the trusted launcher and its private worker home.
    let scope = KnowledgeScope::from_authenticated_host(&principal, "execution-host")?;
    let root = profile.join("knowledge");
    std::fs::create_dir_all(&root)?;
    kcoder_config::set_user_only_dir_permissions(&root)?;
    let store = KnowledgeCatalog::open(&root.join("state.sqlite"))?;
    Ok((store, scope))
}

#[cfg(test)]
mod independent_modes {
    use super::*;
    #[test]
    fn retrieval_and_organization_are_independent_and_only_organization_off_pauses() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{}")?;
        let status = request(&path, km::CONFIGURE, json!({"organizationEnabled":true}))?;
        assert_eq!(status["retrievalEnabled"], false);
        let library = request(
            &path,
            km::CREATE,
            json!({"name":"Wiki","idempotencyKey":"create"}),
        )?;
        let id = library["id"].as_str().unwrap();
        let source = request(
            &path,
            km::IMPORT_TEXT,
            json!({"libraryId":id,"idempotencyKey":"source","title":"Source","text":"Evidence"}),
        )?;
        let (mut store, scope) = open_catalog(&path)?;
        let job = store.enqueue_ingest(
            &scope,
            id,
            "job",
            source["sourceId"].as_str().unwrap(),
            source["revisionId"].as_str().unwrap(),
            "recipe",
            "en",
        )?;
        request(&path, km::CONFIGURE, json!({"retrievalEnabled":false}))?;
        assert_eq!(store.read_job(&scope, id, &job.id)?.status, "queued");
        assert!(
            request(
                &path,
                km::SEARCH,
                json!({"libraryId":id,"query":"Evidence"})
            )
            .is_err()
        );
        request(&path, km::CONFIGURE, json!({"retrievalEnabled":true}))?;
        request(&path, km::CONFIGURE, json!({"organizationEnabled":false}))?;
        assert_eq!(store.read_job(&scope, id, &job.id)?.status, "paused");
        assert!(
            !request(
                &path,
                km::SEARCH,
                json!({"libraryId":id,"query":"Evidence"})
            )?["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(
            request(
                &path,
                km::IMPORT_TEXT,
                json!({"libraryId":id,"idempotencyKey":"no","title":"No","text":"No"})
            )
            .is_err()
        );
        request(&path, km::CONFIGURE, json!({"organizationEnabled":true}))?;
        assert_eq!(store.read_job(&scope, id, &job.id)?.status, "paused");
        Ok(())
    }
}

#[cfg(test)]
mod extraction_assembly_tests {
    use super::*;
    #[test]
    fn source_read_and_removed_list_keep_exact_revision_report() -> Result<()> {
        let root = tempfile::tempdir()?;
        let profile = root.path().join("settings.json");
        std::fs::write(&profile, r#"{"knowledge":{"enabled":true}}"#)?;
        let (mut store, scope) = open_catalog(&profile)?;
        let library = store.create(&scope, "create", "Reports", "")?;
        let chunk = kcoder_knowledge::SourceChunk {
            chunk_id: "chunk-1".into(),
            ordinal: 1,
            text: "body".into(),
            first_line: 1,
            last_line: 1,
            page: None,
        };
        let report = json!({"format":"text","textBytes":4,"chunkCount":1,"warnings":[]});
        let source = store.import_extracted_with_report(
            &scope,
            &library.id,
            "source",
            "text.txt",
            b"body",
            "text",
            vec![chunk],
            &report,
        )?;
        drop(store);
        let read = request(
            &profile,
            km::SOURCE_READ,
            json!({"libraryId":library.id,"sourceId":source.source_id,"revisionId":source.revision_id}),
        )?;
        assert_eq!(read["extraction"], report);
        request(
            &profile,
            km::SOURCE_REMOVE,
            json!({"libraryId":library.id,"sourceId":source.source_id,"expectedRevision":source.revision_id,"removed":true}),
        )?;
        let removed = request(
            &profile,
            km::SOURCE_REMOVED,
            json!({"libraryId":library.id}),
        )?;
        assert_eq!(removed["items"][0]["extraction"], report);
        assert_eq!(removed["items"][0]["revisionId"], source.revision_id);
        Ok(())
    }
}

#[cfg(test)]
mod job_overview_paging_tests {
    use super::*;
    #[test]
    fn overview_rpc_defaults_to_sixteen_and_accepts_cursor_without_client_authority() -> Result<()>
    {
        let root = tempfile::tempdir()?;
        let path = root.path().join("settings.json");
        std::fs::write(&path, r#"{"knowledge":{"enabled":true}}"#)?;
        let (mut store, scope) = open_catalog(&path)?;
        let library = store.create(&scope, "create", "Wiki", "")?;
        let source = store.import_text(
            &scope,
            &library.id,
            "source",
            "Actual source title",
            "Evidence",
        )?;
        for index in 0..20 {
            store.enqueue_ingest(
                &scope,
                &library.id,
                &format!("job-{index}"),
                &source.source_id,
                &source.revision_id,
                "recipe",
                "en",
            )?;
        }
        let first = request(&path, km::JOB_OVERVIEW, json!({"libraryId":library.id}))?;
        assert_eq!(first["items"].as_array().unwrap().len(), 16);
        assert_eq!(first["items"][0]["sourceTitle"], "Actual source title");
        let second = request(
            &path,
            km::JOB_OVERVIEW,
            json!({"libraryId":library.id,"cursor":first["nextCursor"],"limit":16}),
        )?;
        assert_eq!(second["items"].as_array().unwrap().len(), 4);
        assert!(second["nextCursor"].is_null());
        assert!(
            request(
                &path,
                km::JOB_OVERVIEW,
                json!({"libraryId":library.id,"owner":"foreign"})
            )
            .is_err()
        );
        Ok(())
    }
}
