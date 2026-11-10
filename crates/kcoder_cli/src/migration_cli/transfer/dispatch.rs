//! Each operation decodes the canonical public contract before any authenticated request.
use super::*;
use crate::cli_args::{AdoptionOperation as A, CopyOperation as C, SessionOperation as S};
use kcoder_app_protocol::*;

pub(super) async fn execute(
    client: &http::Client,
    action: &MigrationTransferAction,
    cwd: Option<&Path>,
) -> Result<()> {
    match action {
        MigrationTransferAction::Session { operation, request } => {
            let bytes = input(request, cwd, !matches!(operation, S::Read))?;
            match operation {
                S::Open => {
                    let params: MigrationSourceSessionOpenParams = decode(&bytes)?;
                    print(
                        &client
                            .post::<_, MigrationSourceSessionStateResult>(
                                "source-session",
                                "open",
                                &params,
                            )
                            .await?,
                    )
                }
                S::Read => {
                    let params: MigrationSourceSessionParams = decode(&bytes)?;
                    print(
                        &client
                            .post::<_, MigrationSourceSessionStateResult>(
                                "source-session",
                                "read",
                                &params,
                            )
                            .await?,
                    )
                }
                S::Close => {
                    let params: MigrationSourceSessionParams = decode(&bytes)?;
                    print(
                        &client
                            .post::<_, MigrationSourceSessionCloseResult>(
                                "source-session",
                                "close",
                                &params,
                            )
                            .await?,
                    )
                }
            }
        }
        MigrationTransferAction::Query { request, page } => {
            let params: MigrationSourceSessionQueryParams = decode(&input(request, cwd, false)?)?;
            ensure!(
                params.session.purpose == MigrationSourceSessionPurpose::Source,
                "source_transfer_invalid_session_scope"
            );
            match &params.query {
                MigrationSourceSessionQuery::InstructionsCapture(query) => {
                    ensure!(request.confirm, "source_transfer_confirmation_required");
                    ensure!(*page == 0, "source_transfer_invalid_request");
                    let result: MigrationInstructionCaptureResult =
                        client.post("source-session", "query", &params).await?;
                    instructions::capture(&result, query)?;
                    print(&result)
                }
                MigrationSourceSessionQuery::InstructionsPage(query) => {
                    ensure!(*page == 0, "source_transfer_invalid_request");
                    let result: MigrationInstructionPageResult =
                        client.post("source-session", "query", &params).await?;
                    instructions::page(&result, query)?;
                    print(&result)
                }
                MigrationSourceSessionQuery::InstructionsBody(query) => {
                    ensure!(*page == 0, "source_transfer_invalid_request");
                    let result: MigrationInstructionBodyResult =
                        client.post("source-session", "query", &params).await?;
                    instructions::body(&result, query)?;
                    print(&result)
                }
                MigrationSourceSessionQuery::Configuration(_) => {
                    let result = client
                        .post::<_, MigrationDiscoverResult>("source-session", "query", &params)
                        .await?;
                    let start = usize::from(*page) * 10;
                    print(
                        &serde_json::json!({"sources":result.sources.iter().skip(start).take(10).collect::<Vec<_>>(),"problems":result.problems,"pageIndex":page,"nextPage":(start+10<result.sources.len()).then_some(page+1)}),
                    )
                }
                MigrationSourceSessionQuery::Definitions(query) => {
                    ensure!(*page == 0, "source_transfer_use_definition_catalog");
                    let result: MigrationDefinitionsDiscoverResult =
                        client.post("source-session", "query", &params).await?;
                    ensure!(
                        result.sources.len() <= 10
                            && result
                                .next_page
                                .is_none_or(|next| next == query.page_index + 1),
                        "source_transfer_invalid_response"
                    );
                    print(&result)
                }
                MigrationSourceSessionQuery::Projects(query) => {
                    ensure!(*page == 0, "source_transfer_use_project_catalog");
                    let result: MigrationProjectSourcesResult =
                        client.post("source-session", "query", &params).await?;
                    ensure!(
                        result.source == query.source
                            && result.page_index == 0
                            && result.items.len() <= 10
                            && result.next_page.is_none_or(|next| next == 1),
                        "source_transfer_invalid_response"
                    );
                    print(&result)
                }
                MigrationSourceSessionQuery::ProjectsPage(query) => {
                    ensure!(*page == 0, "source_transfer_use_project_catalog");
                    let result: MigrationProjectSourcesResult =
                        client.post("source-session", "query", &params).await?;
                    ensure!(
                        result.catalog_id == query.catalog_id
                            && result.page_index == query.page_index
                            && result.items.len() <= 10
                            && result.next_page.is_none_or(|next| {
                                query.page_index.checked_add(1) == Some(next)
                            }),
                        "source_transfer_invalid_response"
                    );
                    print(&result)
                }
                MigrationSourceSessionQuery::ProjectRoots(query) => {
                    ensure!(*page == 0, "source_transfer_use_project_root_pages");
                    let result: MigrationProjectSourceRootsResult =
                        client.post("source-session", "query", &params).await?;
                    ensure!(
                        result.catalog_id == query.catalog_id
                            && result.source_handle == query.source_handle
                            && result.page_index == query.page_index
                            && result.roots.len() <= 10
                            && result.next_page.is_none_or(|next| {
                                query.page_index.checked_add(1) == Some(next)
                            }),
                        "source_transfer_invalid_response"
                    );
                    print(&result)
                }
                MigrationSourceSessionQuery::Plugins(query) => {
                    ensure!(*page == 0, "source_transfer_use_plugin_cursor");
                    let result: MigrationPluginDiscoverResult =
                        client.post("source-session", "query", &params).await?;
                    let mut ids = std::collections::BTreeSet::new();
                    ensure!(
                        result.candidates.len() <= 10
                            && result.candidates.iter().all(|item| {
                                !item.candidate_id.is_empty()
                                    && item.candidate_id.len() <= 128
                                    && !item.candidate_id.chars().any(char::is_control)
                                    && ids.insert(&item.candidate_id)
                                    && (query.sources.is_empty()
                                        || query.sources.contains(&item.source))
                            }),
                        "source_transfer_invalid_response"
                    );
                    print(&result)
                }
                MigrationSourceSessionQuery::Memory(_)
                | MigrationSourceSessionQuery::MemoryPage(_) => {
                    ensure!(*page == 0, "source_transfer_use_memory_cursor");
                    let result: MigrationMemorySourcesResult =
                        client.post("source-session", "query", &params).await?;
                    ensure!(result.items.len() <= 10, "source_transfer_invalid_response");
                    print(&result)
                }
                MigrationSourceSessionQuery::History(_)
                | MigrationSourceSessionQuery::HistoryFamilies(_)
                | MigrationSourceSessionQuery::HistoryPage(_) => {
                    ensure!(*page == 0, "source_transfer_use_history_cursor");
                    let result: MigrationHistorySourcesResult =
                        client.post("source-session", "query", &params).await?;
                    ensure!(result.items.len() <= 10, "source_transfer_invalid_response");
                    print(&result)
                }
                MigrationSourceSessionQuery::SourceBindings(query) => {
                    ensure!(*page == 0, "source_transfer_invalid_request");
                    let result: MigrationSourceBindingsResult =
                        client.post("source-session", "query", &params).await?;
                    ensure!(
                        result.bindings.len() == query.source_ids.len()
                            && result
                                .bindings
                                .iter()
                                .zip(&query.source_ids)
                                .all(|(found, id)| &found.source_id == id),
                        "source_transfer_invalid_response"
                    );
                    print(&result)
                }
                MigrationSourceSessionQuery::CodexLayersSelect(query) => {
                    ensure!(request.confirm, "source_transfer_confirmation_required");
                    ensure!(
                        *page == 0 && query.include_project,
                        "source_transfer_invalid_request"
                    );
                    let result: MigrationCodexLayersSelectResult =
                        client.post("source-session", "query", &params).await?;
                    ensure!(
                        result.source.kind == kcoder_types::migration::MigrationSourceKind::Codex
                            && result.source.scope == "codex-project-layers"
                            && !result.source.source_id.is_empty(),
                        "source_transfer_invalid_response"
                    );
                    print(&result)
                }
                MigrationSourceSessionQuery::CodexLayersRead(query) => {
                    ensure!(*page == 0, "source_transfer_invalid_request");
                    let result: MigrationCodexLayersReadResult =
                        client.post("source-session", "query", &params).await?;
                    ensure!(
                        result.target
                            == MigrationConfigurationLayersTarget::Source {
                                source_id: query.source_id.clone()
                            }
                            && result.page_index == query.page_index
                            && result.fields.len() <= 10,
                        "source_transfer_invalid_response"
                    );
                    print(&result)
                }
                MigrationSourceSessionQuery::ConfigurationLayersRead(query) => {
                    ensure!(*page == 0, "source_transfer_invalid_request");
                    let result: MigrationConfigurationLayersResult =
                        client.post("source-session", "query", &params).await?;
                    ensure!(
                        result.target
                            == MigrationConfigurationLayersTarget::Source {
                                source_id: query.source_id.clone()
                            }
                            && result.page_index == query.page_index
                            && result.fields.len() <= 10,
                        "source_transfer_invalid_response"
                    );
                    print(&result)
                }
                MigrationSourceSessionQuery::UploadedSelect(query) => {
                    ensure!(request.confirm, "source_transfer_confirmation_required");
                    ensure!(*page == 0, "source_transfer_invalid_request");
                    let result: MigrationSourceProductSelectResult =
                        client.post("source-session", "query", &params).await?;
                    ensure!(
                        result.operation_id == query.operation_id
                            && result.manifest_sha256 == query.manifest_sha256
                            && result.remaining_ms > 0
                            && result.remaining_ms <= 600_000,
                        "source_transfer_invalid_response"
                    );
                    print(&result)
                }
                MigrationSourceSessionQuery::DirectorySelect(query) => {
                    ensure!(request.confirm, "source_transfer_confirmation_required");
                    ensure!(*page == 0, "source_transfer_invalid_request");
                    let result: MigrationSourceDirectoryResult =
                        client.post("source-session", "query", &params).await?;
                    ensure!(
                        result.selection_id == query.selection_id
                            && result.source == query.source
                            && result.remaining_ms <= 600_000,
                        "source_transfer_invalid_response"
                    );
                    print(&result)
                }
            }
        }
        MigrationTransferAction::Copy { operation, request } => {
            let bytes = input(request, cwd, !matches!(operation, C::Read | C::TargetRead))?;
            macro_rules! copy {
                ($kind:ty,$operation:literal) => {{
                    let params: $kind = decode(&bytes)?;
                    let result: MigrationSourceTransferResult =
                        client.post("source-transfer", $operation, &params).await?;
                    validation::observation(&result, &params.request_id)?;
                    print(&result)
                }};
            }
            match operation {
                C::Run => copy!(MigrationSourceTransferRunParams, "run"),
                C::Read => copy!(MigrationSourceTransferReadParams, "read"),
                C::Cancel => copy!(MigrationSourceTransferCancelParams, "cancel"),
                C::TargetRead => copy!(MigrationSourceTransferTargetReadParams, "target-read"),
                C::TargetCancel => {
                    copy!(MigrationSourceTransferTargetCancelParams, "target-cancel")
                }
                C::TargetResume => {
                    copy!(MigrationSourceTransferTargetResumeParams, "target-resume")
                }
                C::TargetFinish => {
                    copy!(MigrationSourceTransferTargetFinishParams, "target-finish")
                }
            }
        }
        MigrationTransferAction::Adoption { operation, request } => {
            let bytes = input(request, cwd, !matches!(operation, A::Read | A::Received))?;
            macro_rules! adoption {
                ($kind:ty,$operation:literal,$locator:ident) => {{
                    let params: $kind = decode(&bytes)?;
                    let result: MigrationSourceAdoptionResult =
                        client.post("source-transfer", $operation, &params).await?;
                    validation::adoption(&result, &params.$locator)?;
                    print(&result)
                }};
            }
            match operation {
                A::Received => {
                    let params: MigrationSourceReceivedParams = decode(&bytes)?;
                    let result: MigrationSourceReceivedResult =
                        client.post("source-transfer", "received", &params).await?;
                    validation::received(&result, &params)?;
                    print(&result)
                }
                A::Read => {
                    let params: MigrationSourceAdoptionParams = decode(&bytes)?;
                    let result: MigrationSourceAdoptionResult = client
                        .post("source-transfer", "adoption-read", &params)
                        .await?;
                    validation::adoption(&result, &params)?;
                    print(&result)
                }
                A::Prepare => adoption!(
                    MigrationSourceAdoptionPrepareParams,
                    "adoption-prepare",
                    locator
                ),
                A::Resume => adoption!(
                    MigrationSourceAdoptionResumeParams,
                    "adoption-resume",
                    locator
                ),
                A::Cancel => adoption!(
                    MigrationSourceAdoptionCancelParams,
                    "adoption-cancel",
                    locator
                ),
            }
        }
        MigrationTransferAction::Targets { .. } => {
            unreachable!("targets handled before request dispatch")
        }
        MigrationTransferAction::Batch { .. } => unreachable!("batch handled before HTTP dispatch"),
        MigrationTransferAction::Guide { .. } => unreachable!("guide handled before HTTP dispatch"),
    }
}
