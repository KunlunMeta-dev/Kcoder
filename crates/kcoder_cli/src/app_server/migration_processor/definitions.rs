//! Explicit passive-definition discovery and bounded source reads never activate runtime assets.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::path::Path;
pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_DEFINITIONS_DISCOVER
            | method::MIGRATION_DEFINITION_REPORT
            | method::MIGRATION_DEFINITION_BODY
            | method::MIGRATION_AGENT_PREVIEW
    )
}
pub(super) fn execute(
    processor: &MigrationProcessor,
    factory: &dyn MigrationHost,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    if operation == method::MIGRATION_DEFINITIONS_DISCOVER {
        let params: MigrationDefinitionsDiscoverParams = decode(params)?;
        ensure!(
            params.sources.len() <= 2 && params.catalog_id.as_ref().is_none_or(|id| id.len() <= 80),
            "migration_invalid_parameters"
        );
        let mut registry = processor
            .registry
            .lock()
            .map_err(|_| anyhow::anyhow!("migration_busy"))?;
        processor.initialize_registry(&mut registry, factory)?;
        let registry = registry
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("migration_source_selection_expired"))?;
        if params.include_project {
            let roots = factory.migration_source_roots()?;
            registry.authorize_selected_project(profile, roots.project.as_deref())?;
            registry.authorize_definition_project(profile, roots.project.as_deref())?;
        }
        let page = registry.definition_page(
            &params.sources,
            params.include_project,
            params.catalog_id.as_deref(),
            params.page_index,
        )?;
        return Ok(serde_json::to_value(MigrationDefinitionsDiscoverResult {
            catalog_id: page.catalog_id,
            sources: page
                .sources
                .into_iter()
                .map(|source| MigrationSourceSummary {
                    source_id: source.source_id,
                    kind: source.kind,
                    display_name: source.display_name,
                    format_revision: source.format_revision,
                    available_categories: source.categories,
                    scope: source.scope.into(),
                })
                .collect(),
            problems: page
                .problems
                .into_iter()
                .map(|problem| MigrationDiscoveryProblem {
                    kind: problem.kind,
                    scope: problem.scope.into(),
                    code: problem.code.into(),
                })
                .collect(),
            total_sources: page.total_sources,
            next_page: page.next_page,
        })?);
    }
    let store = MigrationStore::open_existing(profile)?;
    if operation == method::MIGRATION_AGENT_PREVIEW {
        let params: MigrationAgentPreviewParams = decode(params)?;
        validate(&params.job_id, &params.item_id)?;
        return Ok(serde_json::to_value(MigrationAgentPreviewResult {
            compatibility: store.agent_compatibility(&params.job_id, &params.item_id)?,
            job_id: params.job_id,
            item_id: params.item_id,
        })?);
    }
    if operation == method::MIGRATION_DEFINITION_REPORT {
        let params: MigrationDefinitionReportParams = decode(params)?;
        validate(&params.job_id, &params.item_id)?;
        ensure!(params.page_index <= 102, "migration_invalid_page");
        let mut snapshot = store.definition_snapshot(&params.job_id, &params.item_id)?;
        let total = snapshot.report.fields.len();
        let start = params.page_index as usize * 10;
        ensure!(start < total || start == 0, "migration_invalid_page");
        snapshot.report.fields = snapshot
            .report
            .fields
            .into_iter()
            .skip(start)
            .take(10)
            .collect();
        return Ok(serde_json::to_value(MigrationDefinitionReportResult {
            job_id: params.job_id,
            item_id: params.item_id,
            page_index: params.page_index,
            report: snapshot.report,
            total_fields: total as u32,
            next_page: (start + 10 < total).then_some(params.page_index + 1),
            total_bytes: snapshot.bytes.len() as u64,
        })?);
    }
    let params: MigrationDefinitionBodyParams = decode(params)?;
    validate(&params.job_id, &params.item_id)?;
    let snapshot = store.definition_snapshot(&params.job_id, &params.item_id)?;
    let start =
        usize::try_from(params.offset).map_err(|_| anyhow::anyhow!("migration_invalid_page"))?;
    ensure!(start <= snapshot.bytes.len(), "migration_invalid_page");
    let mut end = (start + 16 * 1024).min(snapshot.bytes.len());
    let text = std::str::from_utf8(&snapshot.bytes).ok();
    if let Some(text) = text {
        ensure!(text.is_char_boundary(start), "migration_invalid_page");
        while !text.is_char_boundary(end) {
            end -= 1;
        }
    }
    Ok(serde_json::to_value(MigrationDefinitionBodyResult {
        job_id: params.job_id,
        item_id: params.item_id,
        offset: params.offset,
        encoding: if text.is_some() {
            MigrationDefinitionBodyEncoding::Utf8
        } else {
            MigrationDefinitionBodyEncoding::Binary
        },
        bytes_base64: STANDARD.encode(&snapshot.bytes[start..end]),
        text: text.map(|text| text[start..end].to_owned()),
        total_bytes: snapshot.bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&snapshot.bytes)),
        next_offset: (end < snapshot.bytes.len()).then_some(end as u64),
    })?)
}
fn validate(job: &str, item: &str) -> Result<()> {
    ensure!(
        !job.is_empty()
            && job.len() <= 128
            && !item.is_empty()
            && item.len() <= 256
            && !job.chars().chain(item.chars()).any(char::is_control),
        "migration_invalid_parameters"
    );
    Ok(())
}
