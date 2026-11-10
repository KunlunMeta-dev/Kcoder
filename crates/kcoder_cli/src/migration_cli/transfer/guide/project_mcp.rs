//! Remote project inheritance chooses names from one frozen target catalog, never private values.
use super::*;
use std::collections::{BTreeMap, BTreeSet};
impl Guide {
    pub(super) async fn project_mcp_selection<'a>(
        &self,
        client: &mut runtime::Client,
        job: &str,
        choices: impl Iterator<Item = &'a MigrationBatchChoice>,
    ) -> Result<Option<MigrationProjectMcpInheritanceSelection>> {
        if !choices
            .into_iter()
            .any(|choice| matches!(choice, MigrationBatchChoice::Mcp { .. }))
        {
            return Ok(None);
        }
        client.require(CAPABILITY_MIGRATION_PROJECT_MCP_INHERITANCE_V1)?;
        let mut page = 0usize;
        let mut revision = None;
        let mut total = None;
        let mut known = BTreeMap::<usize, Vec<String>>::new();
        let mut selected = BTreeSet::new();
        loop {
            let params = MigrationProjectMcpCatalogParams {
                job_id: job.into(),
                page_index: page,
                expected_revision: revision.clone(),
            };
            let result: MigrationProjectMcpCatalogResult = self
                .rpc(client, method::MIGRATION_PROJECT_MCP_CATALOG, &params)
                .await?;
            ensure!(
                result.job_id == job && result.total_names <= 1024 && result.names.len() <= 10,
                "migration_remote_invalid_response"
            );
            if result.status != MigrationProjectMcpCatalogStatus::SelectionRequired {
                ensure!(
                    revision.is_none()
                        && page == 0
                        && result.names.is_empty()
                        && result.total_names == 0
                        && result.next_page_index.is_none(),
                    "migration_remote_invalid_response"
                );
                return Ok(None);
            }
            let seen = result
                .revision
                .clone()
                .filter(|v| {
                    v.len() == 64
                        && v.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
                .ok_or_else(|| anyhow::anyhow!("migration_remote_invalid_response"))?;
            ensure!(
                revision.as_ref().is_none_or(|value| value == &seen)
                    && total.is_none_or(|value| value == result.total_names),
                "migration_project_mcp_catalog_changed"
            );
            revision = Some(seen);
            total = Some(result.total_names);
            let start = page
                .checked_mul(10)
                .ok_or_else(|| anyhow::anyhow!("migration_remote_invalid_response"))?;
            ensure!(
                (start < result.total_names || start == 0)
                    && result.names.len() == result.total_names.saturating_sub(start).min(10)
                    && result.next_page_index
                        == (start + 10 < result.total_names).then_some(page + 1),
                "migration_remote_invalid_response"
            );
            ensure!(
                result.names.iter().all(|name| !name.is_empty()
                    && name.len() <= 256
                    && !name.chars().any(char::is_control))
                    && result.names.iter().collect::<BTreeSet<_>>().len() == result.names.len(),
                "migration_remote_invalid_response"
            );
            if let Some(previous) = known.get(&page) {
                ensure!(
                    previous == &result.names,
                    "migration_project_mcp_catalog_changed"
                );
            }
            ensure!(
                known
                    .iter()
                    .filter(|(index, _)| **index != page)
                    .all(|(_, names)| !names.iter().any(|name| result.names.contains(name))),
                "migration_remote_invalid_response"
            );
            known.insert(page, result.names.clone());
            let rows=result.names.iter().enumerate().map(|(at,name)|json!({"number":at+1,"name":name,"selected":selected.contains(name)})).collect::<Vec<_>>();
            let answer=self.io.ask("transfer_project_mcp_inheritance","首次声明项目MCP：toggle N明确保留继承名称；next/prev每页10项；confirm确认（空名单明确全部不保留）；quit取消。原凭据仍留在原层，不复制私值。",json!({"page":page,"total":result.total_names,"selected":selected.len(),"items":rows}),None)?;
            let mut words = answer.split_whitespace();
            match words.next().unwrap_or("") {
                "confirm" => {
                    return Ok(Some(MigrationProjectMcpInheritanceSelection {
                        names: selected.into_iter().collect(),
                        expected_revision: revision.unwrap(),
                    }));
                }
                "quit" => anyhow::bail!("migration_transfer_guide_stopped"),
                "next" if result.next_page_index.is_some() => {
                    page = result.next_page_index.unwrap()
                }
                "prev" if page > 0 => page -= 1,
                "toggle" => {
                    let name = words
                        .next()
                        .and_then(|n| n.parse::<usize>().ok())
                        .filter(|n| (1..=10).contains(n))
                        .and_then(|n| result.names.get(n - 1))
                        .ok_or_else(|| anyhow::anyhow!("migration_transfer_invalid_selection"))?;
                    if !selected.remove(name) {
                        selected.insert(name.clone());
                    }
                }
                _ => self.io.notice(
                    "migration_transfer_invalid_selection",
                    "请选择当前页名称或明确确认；尚未提交计划。",
                )?,
            }
        }
    }
}
