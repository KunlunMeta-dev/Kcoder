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
            "只读原项目出处和保存的映射，每页最多10字段；next/prev/back。不打开原路径或重做迁移。",
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
        let answer=io.ask("project_target","明确选择实际Native目标工作区编号；next/prev翻页；register 登记另一个实际目录；quit取消本项。来源路径不授予权限，登记也不授予信任。",json!({"page":index,"items":rows,"registeredWorkspacesObserved":result.registered_workspaces_observed}),None)?;
        match answer.as_str() {
            "quit" => anyhow::bail!("migration_project_mapping_required"),
            "next" if result.next_page.is_some() => index = result.next_page.unwrap(),
            "prev" if index > 0 => index -= 1,
            "register" => {
                let name = io.text(
                    "project_register_name",
                    "明确填写Native目标工作区名称（不改原项目名称出处）。",
                    None,
                )?;
                let path = io.text(
                    "project_register_path",
                    "明确填写目标设备上的实际绝对目录；不使用来源路径作默认值，不创建/复制工作树。",
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
                ensure!(io.yes("project_register_confirm","确认只新增Native工作区登记？原writer会在同锁内拒绝已有路径/项目身份；不会授予信任、修改用户原登记或复制文件。回包未知时先刷新原目录，不自动重发。")?,"migration_project_mapping_required");
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
                            "登记未确认成功。先刷新Native目录并选择实际已有项；不会自动重复写入。",
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
                    "请选择实际Native工作区编号；不从来源路径推断。",
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
            let answer=io.ask("project_target_root","为这一个原始根明确选择可用且可信的Native目标根编号；next/prev翻页；quit取消本项。Native在计划和提交时仍会fresh核验。",json!({"page":index,"sourceRoot":source.value,"items":rows}),None)?;
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
                        "请选择当前页可用且可信的目标根；不自动授予信任。",
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
