//! Native catalogs, never source path text, authorize target workspace mappings.
use super::*;
use kcoder_types::migration_projects::{
    MigrationProjectMappingChoice, MigrationProjectReportField, MigrationProjectRootMapping,
};
use serde_json::json;
use std::collections::BTreeSet;

async fn reports(
    client: &mut impl Client,
    job: &str,
    item: &str,
) -> Result<Vec<kcoder_types::migration_projects::MigrationProjectReportRow>> {
    let mut index = 0;
    let mut rows = Vec::new();
    loop {
        let value: MigrationProjectReportResult = read(
            client,
            method::MIGRATION_PROJECTS_REPORT,
            &MigrationProjectReportParams {
                job_id: job.into(),
                item_id: item.into(),
                page_index: index,
            },
        )
        .await?;
        page(
            index,
            value.next_page,
            value.fields.len(),
            value.total_fields,
        )?;
        ensure!(
            value.job_id == job
                && value.item_id == item
                && value.page_index == index
                && value.total_fields <= 128,
            "migration_project_invalid_response"
        );
        rows.extend(value.fields);
        match value.next_page {
            Some(next) => index = next,
            None => return Ok(rows),
        }
    }
}
pub(in crate::migration_cli) async fn report(
    io: &GuideIo,
    client: &mut impl Client,
    job: &str,
    item: &str,
) -> Result<()> {
    let mut index = 0;
    loop {
        let value: MigrationProjectReportResult = read(
            client,
            method::MIGRATION_PROJECTS_REPORT,
            &MigrationProjectReportParams {
                job_id: job.into(),
                item_id: item.into(),
                page_index: index,
            },
        )
        .await?;
        page(
            index,
            value.next_page,
            value.fields.len(),
            value.total_fields,
        )?;
        ensure!(
            value.job_id == job && value.item_id == item && value.page_index == index,
            "migration_project_invalid_response"
        );
        let answer = io.ask(
            "project_report",
            "Read-only original project provenance and saved mappings, up to 10 fields per page; next/prev/back. Original paths are not opened and migration is not repeated.",
            serde_json::to_value(&value)?,
            Some("back"),
        )?;
        match answer.as_str() {
            "next" if value.next_page.is_some() => index = value.next_page.unwrap(),
            "prev" if index > 0 => index -= 1,
            _ => return Ok(()),
        }
    }
}
pub(in crate::migration_cli) async fn mapping(
    io: &GuideIo,
    client: &mut impl Client,
    job: &str,
    item: &str,
    catalog: &mut Option<String>,
) -> Result<MigrationBatchChoice> {
    let fields = reports(client, job, item).await?;
    let roots = fields
        .iter()
        .filter(|row| row.field == MigrationProjectReportField::SourceRoot)
        .collect::<Vec<_>>();
    let ids = roots
        .iter()
        .filter_map(|row| row.source_root_id.as_deref())
        .collect::<BTreeSet<_>>();
    ensure!(
        !roots.is_empty()
            && roots.len() <= 16
            && ids.len() == roots.len()
            && ids.iter().all(|id| atom(id)),
        "migration_project_mapping_required"
    );
    let mut index = 0;
    let chosen = loop {
        let result: MigrationProjectTargetsResult = read(
            client,
            method::MIGRATION_PROJECTS_TARGETS,
            &MigrationProjectTargetsParams {
                target_catalog_id: catalog.clone(),
                page_index: index,
            },
        )
        .await?;
        page(
            index,
            result.next_page,
            result.items.len(),
            result.total_items,
        )?;
        ensure!(
            result.page_index == index
                && atom(&result.target_catalog_id)
                && catalog
                    .as_ref()
                    .is_none_or(|id| id == &result.target_catalog_id),
            "migration_project_invalid_response"
        );
        *catalog = Some(result.target_catalog_id.clone());
        let rows=result.items.iter().enumerate().map(|(i,row)|json!({"number":i+1,"title":row.display_name,"roots":row.roots,"currentWorkspace":row.current_workspace})).collect::<Vec<_>>();
        let answer=io.ask("project_target","Explicitly select an actual Native target workspace number; next/prev changes pages; register registers another actual directory; quit cancels this item. Source paths do not grant access and registration does not grant trust.",json!({"page":index,"items":rows,"registeredWorkspacesObserved":result.registered_workspaces_observed}),None)?;
        match answer.as_str() {
            "quit" => anyhow::bail!("migration_project_mapping_required"),
            "next" if result.next_page.is_some() => index = result.next_page.unwrap(),
            "prev" if index > 0 => index -= 1,
            "register" => {
                let name = io.text(
                    "project_register_name",
                    "Explicitly enter a Native target workspace name (original project name provenance is unchanged).",
                    None,
                )?;
                let path = io.text(
                    "project_register_path",
                    "Explicitly enter the actual absolute directory on the target device. Source paths are not defaults; worktrees are not created or copied.",
                    None,
                )?;
                ensure!(
                    !name.is_empty()
                        && name.len() <= 256
                        && !path.is_empty()
                        && path.len() <= 4096
                        && !path.chars().any(char::is_control),
                    "migration_project_mapping_required"
                );
                ensure!(io.yes("project_register_confirm","Add only a new Native workspace registration? The original writer rejects existing paths/project identities under the same lock. Trust is not granted, existing user registrations are not modified, and files are not copied. If the reply is unknown, refresh the original directory before retrying; no automatic resend.")?,"migration_project_mapping_required");
                let key = uuid::Uuid::new_v4().to_string();
                let response=client.call("runtime.projects.upsert_local",json!({"projectKey":key,"name":name,"roots":[path],"preserveExisting":true})).await;
                match response {
                    Ok(value) => ensure!(
                        value["accepted"] == true && value["projectKey"] == key,
                        "migration_project_invalid_response"
                    ),
                    Err(error) => {
                        io.notice(
                            "migration_project_registration_not_confirmed",
                            "Registration was not confirmed. Refresh the Native directory and select an actual existing item; no automatic duplicate write.",
                        )?;
                        *catalog = None;
                        index = 0;
                        let _ = error;
                        continue;
                    }
                }
                *catalog = None;
                index = 0;
            }
            _ => {
                if let Some(row) = answer
                    .parse::<usize>()
                    .ok()
                    .filter(|n| (1..=10).contains(n))
                    .and_then(|n| result.items.get(n - 1))
                {
                    ensure!(
                        atom(&row.target_handle),
                        "migration_project_invalid_response"
                    );
                    break row.target_handle.clone();
                }
                io.notice(
                    "migration_project_invalid_selection",
                    "Select an actual Native workspace number; it is not inferred from the source path.",
                )?;
            }
        }
    };
    let target_catalog_id = catalog
        .clone()
        .ok_or_else(|| anyhow::anyhow!("migration_project_mapping_required"))?;
    let mut mappings = Vec::new();
    for source in roots {
        let mut index = 0;
        loop {
            let value: MigrationProjectTargetRootsResult = read(
                client,
                method::MIGRATION_PROJECTS_TARGET_ROOTS,
                &MigrationProjectTargetRootsParams {
                    target_catalog_id: target_catalog_id.clone(),
                    target_handle: chosen.clone(),
                    page_index: index,
                },
            )
            .await?;
            page(index, value.next_page, value.roots.len(), value.total_roots)?;
            ensure!(
                value.target_catalog_id == target_catalog_id
                    && value.target_handle == chosen
                    && value.page_index == index,
                "migration_project_invalid_response"
            );
            let rows=value.roots.iter().enumerate().map(|(i,row)|json!({"number":i+1,"path":row.path,"trusted":row.trusted,"available":row.available})).collect::<Vec<_>>();
            let answer=io.ask("project_target_root","For this original root, explicitly select an available and trusted Native target root number; next/prev changes pages; quit cancels this item. Native still rechecks current state during planning and submission.",json!({"page":index,"sourceRoot":source.value,"items":rows}),None)?;
            match answer.as_str() {
                "quit" => anyhow::bail!("migration_project_mapping_required"),
                "next" if value.next_page.is_some() => index = value.next_page.unwrap(),
                "prev" if index > 0 => index -= 1,
                _ => {
                    if let Some(row) = answer
                        .parse::<usize>()
                        .ok()
                        .filter(|n| (1..=10).contains(n))
                        .and_then(|n| value.roots.get(n - 1))
                    {
                        ensure!(
                            row.trusted && row.available && atom(&row.target_root_handle),
                            "migration_project_target_untrusted"
                        );
                        mappings.push(MigrationProjectRootMapping {
                            source_root_id: source.source_root_id.clone().unwrap(),
                            target_root_handle: row.target_root_handle.clone(),
                        });
                        break;
                    }
                    io.notice(
                        "migration_project_invalid_selection",
                        "Select an available, trusted target root on this page; trust is not granted automatically.",
                    )?;
                }
            }
        }
    }
    Ok(MigrationBatchChoice::Project {
        item_id: item.into(),
        mapping: MigrationProjectMappingChoice {
            target_catalog_id,
            target_handle: chosen,
            mappings,
        },
    })
}
