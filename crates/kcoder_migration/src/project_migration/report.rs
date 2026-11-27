//! Public reports project the frozen known metadata, not the registry document or arbitrary tables.
use super::ProjectBatchSource;
use anyhow::{Context, Result, ensure};
use kcoder_types::{
    imported_projects::ImportedProjectAssociation, migration::MigrationSourceKind,
    migration_projects::*,
};
pub fn report(
    job_id: &str,
    item_id: &str,
    source: &ProjectBatchSource,
    target: Option<&ImportedProjectAssociation>,
    page: u32,
) -> Result<MigrationProjectReportResult> {
    use MigrationProjectReportField as Field;
    let row = |field, value: Option<String>, ordinal| MigrationProjectReportRow {
        source_root_id: None,
        field,
        value,
        ordinal,
    };
    let record = source.record();
    let mut fields = vec![
        row(
            Field::SourceFormat,
            Some(source.format_revision().to_owned()),
            None,
        ),
        row(
            Field::OriginalProjectId,
            (source.source() == MigrationSourceKind::Codex).then(|| record.id.clone()),
            None,
        ),
        row(Field::SourceName, Some(record.name.clone()), None),
        row(Field::SourceOrder, Some(record.position.to_string()), None),
        row(
            Field::SourceCreatedAt,
            record.created_at_ms.map(|v| v.to_string()),
            None,
        ),
        row(
            Field::SourceUpdatedAt,
            record.updated_at_ms.map(|v| v.to_string()),
            None,
        ),
    ];
    fields.extend(
        record
            .roots
            .iter()
            .enumerate()
            .map(|(i, path)| row(Field::SourceRoot, Some(path.clone()), Some(i as u32))),
    );
    if let Some(target) = target {
        fields.push(row(
            Field::TargetWorkspace,
            Some(target.target.workspace.to_string_lossy().into_owned()),
            None,
        ));
        fields.extend(target.target.roots.iter().enumerate().map(|(i, root)| {
            row(
                Field::TargetRoot,
                Some(root.target_root.to_string_lossy().into_owned()),
                Some(i as u32),
            )
        }));
    }
    for field in &mut fields {
        if field.field == Field::SourceRoot {
            field.source_root_id = Some(
                source
                    .source_root_id(field.ordinal.context("migration_invalid_journal")? as usize)?,
            );
        }
    }
    fields.push(row(
        Field::MappingStatus,
        Some(
            if target.is_some() {
                "explicit_native_workspace"
            } else {
                "not_mapped"
            }
            .into(),
        ),
        None,
    ));
    let start = (page as usize)
        .checked_mul(10)
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_cursor"))?;
    ensure!(start <= fields.len(), "migration_invalid_cursor");
    Ok(MigrationProjectReportResult {
        job_id: job_id.to_owned(),
        item_id: item_id.to_owned(),
        page_index: page,
        total_fields: fields.len() as u32,
        next_page: (start + 10 < fields.len()).then_some(page + 1),
        fields: fields.into_iter().skip(start).take(10).collect(),
        unobserved: vec![
            MigrationProjectUnobserved::VendorMetadata,
            MigrationProjectUnobserved::SourceTrust,
            MigrationProjectUnobserved::WorktreeContents,
            MigrationProjectUnobserved::SessionRecency,
            MigrationProjectUnobserved::LegacyDesktopRegistry,
        ],
    })
}
