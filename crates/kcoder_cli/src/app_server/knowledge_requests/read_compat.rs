//! Account Wiki observation reuses original data scopes; no owner migration or source writes.
use crate::app_server::integrations::{
    core::ObservedReadScope, knowledge::authorize_observed_wiki_read,
};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{knowledge_method as km, *};
use kcoder_knowledge::integrations::knowledge::CatalogReadLimits;
use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope};
use kcoder_knowledge_rpc::knowledge_requests::{enabled, settings};
use serde_json::{Value, json};
use std::path::Path;
use tokio_util::sync::CancellationToken;

pub(super) fn supports(method: &str) -> bool {
    matches!(
        method,
        km::LIST
            | km::READ
            | km::SEARCH
            | km::SOURCE_LIST
            | km::SOURCE_READ
            | km::SOURCE_REMOVED
            | km::PAGE_LIST
            | km::PAGE_READ
            | km::PAGE_HISTORY
            | km::PAGE_LINKS
            | km::CITATION_RESOLVE
            | km::INSPECT
            | km::DEFAULT_READ
            | km::JOB_LIST
            | km::JOB_GET
            | km::JOB_OVERVIEW
            | km::REVIEW_READ
            | km::REVIEW_PAGE
    )
}

fn data_scope(
    catalog: &KnowledgeCatalog,
    current: &KnowledgeScope,
    original: &KnowledgeScope,
    library: &str,
) -> Result<KnowledgeScope> {
    match catalog.read(current, library) {
        Ok(_) => Ok(current.clone()),
        Err(error) if error.to_string() == "knowledge library not found" => {
            catalog.read(original, library)?;
            Ok(original.clone())
        }
        Err(error) => Err(error),
    }
}

pub(super) fn request(
    path: &Path,
    method: &str,
    params: Value,
    observed: &ObservedReadScope,
) -> Result<Value> {
    ensure!(enabled(path)?, "Wiki is disabled");
    if method == km::SEARCH {
        ensure!(settings(path)?.can_retrieve(), "Wiki retrieval is disabled");
    }
    authorize_observed_wiki_read(observed)?;
    let profile = observed.canonical_profile_path();
    let current = KnowledgeScope::from_authenticated_host(observed.principal(), "execution-host")?;
    let original = KnowledgeScope::from_authenticated_host(
        &format!("profile:{}", profile.display()),
        "execution-host",
    )?;
    let directory = observed
        .profile()?
        .open_child(std::ffi::OsStr::new("knowledge"), false);
    let directory = match directory {
        Ok(directory) => Some(directory),
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|cause| cause.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            None
        }
        Err(error) => return Err(error),
    };
    let exists = match &directory {
        None => false,
        Some(directory) => match directory.entry_metadata(std::ffi::OsStr::new("state.sqlite")) {
            Ok(_) => true,
            Err(error)
                if error.chain().any(|cause| {
                    cause
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|cause| cause.kind() == std::io::ErrorKind::NotFound)
                }) =>
            {
                false
            }
            Err(error) => return Err(error),
        },
    };
    let directory_identity = directory
        .as_ref()
        .map(|directory| directory.directory_identity())
        .transpose()?;
    if !exists {
        let result = match method {
            km::LIST => {
                let _: KnowledgeListParams = serde_json::from_value(params)?;
                json!({"items":[],"nextAfterId":null})
            }
            km::DEFAULT_READ => {
                let _: KnowledgeStatusParams = serde_json::from_value(params)?;
                json!({"libraryId":null})
            }
            _ => anyhow::bail!("knowledge library not found"),
        };
        authorize_observed_wiki_read(observed)?;
        return Ok(result);
    }
    let reader = KnowledgeCatalog::open_existing_native_directory(
        directory.context("knowledge source directory missing")?,
        std::ffi::OsStr::new("state.sqlite"),
        std::ffi::OsStr::new("state.objects"),
        &CancellationToken::new(),
        CatalogReadLimits::default(),
    )?;
    let (result, _) = reader.with_catalog(|catalog| {
        if method == km::LIST {
            let input: KnowledgeListParams = serde_json::from_value(params)?;
            ensure!((1..=100).contains(&input.limit), "library page limit must be 1..100");
            let mut items = catalog.list(&current,input.after_id.as_deref(),input.limit)?;
            items.extend(catalog.list(&original,input.after_id.as_deref(),input.limit)?);
            items.sort_by(|left,right|left.id.cmp(&right.id));
            items.dedup_by(|left,right|left.id==right.id);
            items.truncate(input.limit);
            let next = (items.len()==input.limit).then(||items.last().unwrap().id.clone());
            return Ok(json!({"items":items,"nextAfterId":next}));
        }
        if method == km::DEFAULT_READ {
            let _: KnowledgeStatusParams = serde_json::from_value(params)?;
            let selected = catalog.resolve_library(&current,None,None)?;
            let selected = if catalog.list(&current,None,1)?.is_empty() {
                catalog.resolve_library(&original,None,None)?
            } else { selected };
            return Ok(match selected {
                kcoder_knowledge::LibrarySelection::Selected(library) => json!({"libraryId":library.id}),
                _ => json!({"libraryId":null}),
            });
        }
        let library = params.get("libraryId").and_then(Value::as_str).context("libraryId is required")?;
        let scope = data_scope(catalog,&current,&original,library)?;
        Ok(match method {
            km::READ => {
                let input:KnowledgeReadParams=serde_json::from_value(params)?;
                json!(catalog.read(&scope,&input.library_id)?)
            }
            km::SEARCH => {
                let input:KnowledgeSearchParams=serde_json::from_value(params)?;
                json!({"items":catalog.search(&scope,&input.library_id,&input.query,input.limit)?})
            }
            km::PAGE_READ => {
                let input:KnowledgePageReadParams=serde_json::from_value(params)?;
                json!(catalog.read_page(&scope,&input.library_id,&input.page_id,input.revision_id.as_deref())?)
            }
            km::PAGE_LIST | km::SOURCE_LIST | km::SOURCE_REMOVED | km::JOB_LIST | km::INSPECT => {
                let input:KnowledgeContentsParams=serde_json::from_value(params)?;
                if method==km::PAGE_LIST {
                    let items=catalog.list_pages(&scope,&input.library_id,input.after_id.as_deref(),input.limit)?;
                    let next=(items.len()==input.limit).then(||items.last().map(|item|item.page_id.clone())).flatten();
                    json!({"items":items,"nextAfterId":next})
                } else if method==km::JOB_LIST {
                    let items=catalog.list_jobs(&scope,&input.library_id,input.after_id.as_deref(),input.limit)?;
                    let next=(items.len()==input.limit).then(||items.last().map(|item|item.id.clone())).flatten();
                    json!({"items":items,"nextAfterId":next})
                } else if method==km::INSPECT {
                    json!(catalog.inspect_library(&scope,&input.library_id,input.after_id.as_deref(),input.limit)?)
                } else {
                    let items=if method==km::SOURCE_REMOVED {
                        catalog.list_removed_sources(&scope,&input.library_id,input.after_id.as_deref(),input.limit)?
                    } else { catalog.list_sources(&scope,&input.library_id,input.after_id.as_deref(),input.limit)? };
                    let next=(items.len()==input.limit).then(||items.last().map(|item|item.source_id.clone())).flatten();
                    let items=items.into_iter().map(|source|->Result<Value>{
                        let extraction=catalog.source_extraction(&scope,&input.library_id,&source.source_id,&source.revision_id)?;
                        let mut value=serde_json::to_value(source)?;
                        if let Some(extraction)=extraction {value["extraction"]=extraction;}
                        Ok(value)
                    }).collect::<Result<Vec<_>>>()?;
                    json!({"items":items,"nextAfterId":next})
                }
            }
            km::SOURCE_READ => {
                let input:KnowledgeSourceReadParams=serde_json::from_value(params)?;
                ensure!((1..=16).contains(&input.limit),"source read limit must be 1..16");
                let items=catalog.source_chunks(&scope,&input.library_id,&input.source_id,&input.revision_id,input.after_chunk,input.limit)?;
                let next=(items.len()==input.limit).then(||items.last().map(|item|item.ordinal)).flatten();
                json!({"items":items,"nextAfterChunk":next,"extraction":catalog.source_extraction(&scope,&input.library_id,&input.source_id,&input.revision_id)?})
            }
            km::PAGE_LINKS => {
                let input:KnowledgePageLinksParams=serde_json::from_value(params)?;
                json!(catalog.page_links(&scope,&input.library_id,&input.page_id,20)?)
            }
            km::PAGE_HISTORY => {
                let input:KnowledgePageHistoryParams=serde_json::from_value(params)?;
                let items=catalog.page_history(&scope,&input.library_id,&input.page_id,input.before_sequence,input.limit)?;
                let next=(items.len()==input.limit).then(||items.last().map(|item|item.sequence)).flatten();
                json!({"items":items,"nextBeforeSequence":next})
            }
            km::CITATION_RESOLVE => {
                let input:KnowledgeCitationParams=serde_json::from_value(params)?;
                let (source,chunk)=catalog.resolve_citation(&scope,&input.library_id,&input.source_id,&input.revision_id,&input.chunk_id)?;
                json!({"source":source,"chunk":chunk})
            }
            km::JOB_GET | km::REVIEW_READ => {
                let input:KnowledgeJobParams=serde_json::from_value(params)?;
                if method==km::JOB_GET {json!(catalog.read_job(&scope,&input.library_id,&input.job_id)?)}
                else {json!(catalog.pending_review(&scope,&input.library_id,&input.job_id)?)}
            }
            km::JOB_OVERVIEW => {
                let input:KnowledgeJobOverviewParams=serde_json::from_value(params)?;
                json!(catalog.job_overview_page(&scope,&input.library_id,input.cursor.as_deref(),input.limit.unwrap_or(16))?)
            }
            km::REVIEW_PAGE => {
                let input:KnowledgeReviewPageParams=serde_json::from_value(params)?;
                json!(catalog.review_excerpt(&scope,&input.library_id,&input.job_id,&input.token,&input.page_id,input.offset)?)
            }
            _ => anyhow::bail!("unsupported read-only Wiki request"),
        })
    })?;
    ensure!(
        observed
            .profile()?
            .open_child(std::ffi::OsStr::new("knowledge"), false)?
            .directory_identity()?
            == directory_identity.context("knowledge source directory missing")?,
        "knowledge_catalog_source_changed"
    );
    authorize_observed_wiki_read(observed)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_scope_wins_and_only_the_exact_original_profile_library_is_accepted() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut catalog = KnowledgeCatalog::open(&root.path().join("state.sqlite"))?;
        let current =
            KnowledgeScope::from_authenticated_host("actual-current-account", "execution-host")?;
        let original = KnowledgeScope::from_authenticated_host(
            "profile:/actual/original/profile",
            "execution-host",
        )?;
        let other =
            KnowledgeScope::from_authenticated_host("profile:/another/profile", "execution-host")?;
        let current_library = catalog.create(&current, "current", "Current Wiki", "")?;
        let old_library = catalog.create(&original, "original", "Original Wiki", "")?;
        let foreign_library = catalog.create(&other, "foreign", "Other profile Wiki", "")?;
        let selected = data_scope(&catalog, &current, &original, &current_library.id)?;
        assert_eq!(
            catalog.read(&selected, &current_library.id)?.id,
            current_library.id
        );
        let selected = data_scope(&catalog, &current, &original, &old_library.id)?;
        assert_eq!(catalog.read(&selected, &old_library.id)?.id, old_library.id);
        assert!(data_scope(&catalog, &current, &original, &foreign_library.id).is_err());
        assert_eq!(catalog.list(&current, None, 10)?.len(), 1);
        assert_eq!(catalog.list(&original, None, 10)?.len(), 1);
        Ok(())
    }

    #[test]
    fn schema_failure_never_falls_back_to_an_original_scope() -> Result<()> {
        let root = tempfile::tempdir()?;
        let path = root.path().join("state.sqlite");
        let catalog = KnowledgeCatalog::open(&path)?;
        let current =
            KnowledgeScope::from_authenticated_host("actual-current-account", "execution-host")?;
        let original = KnowledgeScope::from_authenticated_host(
            "profile:/actual/original/profile",
            "execution-host",
        )?;
        rusqlite::Connection::open(path)?.execute_batch("DROP TABLE libraries;")?;
        let error = data_scope(&catalog, &current, &original, "missing").unwrap_err();
        assert!(error.to_string().contains("no such table"), "{error}");
        Ok(())
    }
}
