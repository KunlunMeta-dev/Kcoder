//! Projects share the original source session and ordinary target runtime, never a path tunnel.
use super::*;
use crate::migration_cli::projects as review;
use serde_json::Value;

struct Source<'a> {
    guide: &'a Guide,
    session: &'a MigrationSourceSessionParams,
}
impl review::Client for Source<'_> {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let kind = match method {
            method::MIGRATION_PROJECTS_DISCOVER => "projects",
            method::MIGRATION_PROJECTS_SOURCES => "projects_page",
            method::MIGRATION_PROJECTS_SOURCE_ROOTS => "project_roots",
            _ => anyhow::bail!("migration_transfer_invalid_query"),
        };
        self.guide.source_query(self.session, kind, &params).await
    }
}
struct Target<'a> {
    guide: &'a Guide,
    client: &'a mut runtime::Client,
}
impl review::Client for Target<'_> {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        ensure!(
            matches!(
                method,
                method::MIGRATION_PROJECTS_TARGETS
                    | method::MIGRATION_PROJECTS_TARGET_ROOTS
                    | method::MIGRATION_PROJECTS_REPORT
                    | method::MIGRATION_ITEMS
                    | "runtime.projects.upsert_local"
            ),
            "migration_transfer_invalid_query"
        );
        self.guide.rpc(self.client, method, &params).await
    }
}
impl Guide {
    pub(super) async fn choose_projects(
        &self,
        session: &MigrationSourceSessionParams,
        other: usize,
    ) -> Result<Vec<MigrationSourceSelectionV1>> {
        let mut client = Source {
            guide: self,
            session,
        };
        let selected =
            review::sources(&self.io, &mut client, self.draft.source_kind, other).await?;
        self.scope(true).await?;
        Ok(selected
            .into_iter()
            .map(|row| MigrationSourceSelectionV1::Projects {
                catalog_id: row.catalog_id,
                source_handle: row.source_handle,
            })
            .collect())
    }
    pub(super) async fn project_choice(
        &self,
        client: &mut runtime::Client,
        job: &str,
        item: &str,
        catalog: &mut Option<String>,
    ) -> Result<MigrationBatchChoice> {
        client.require(CAPABILITY_MIGRATION_PROJECTS_V1)?;
        review::mapping(
            &self.io,
            &mut Target {
                guide: self,
                client,
            },
            job,
            item,
            catalog,
        )
        .await
    }
    pub(super) async fn saved_projects(
        &self,
        client: &mut runtime::Client,
        job: &str,
    ) -> Result<()> {
        client.require(CAPABILITY_MIGRATION_PROJECTS_V1)?;
        let mut index = 0;
        loop {
            let result: MigrationItemsResult = self
                .rpc(
                    client,
                    method::MIGRATION_ITEMS,
                    &MigrationItemsParams {
                        job_id: job.into(),
                        cursor: None,
                        page_index: Some(index),
                        include_templates: false,
                    },
                )
                .await?;
            ensure!(
                result.items.len() <= 10,
                "migration_project_invalid_response"
            );
            let rows=result.items.iter().enumerate().map(|(i,row)|json!({"number":i+1,"title":row.source_name,"category":row.category})).collect::<Vec<_>>();
            let answer = self.io.ask(
                "project_saved",
                "选择本页原项目编号查看出处/保存映射；next/prev/back。不重新连接来源或重试变更。",
                json!({"page":index,"items":rows}),
                Some("back"),
            )?;
            match answer.as_str() {
                "back" => return Ok(()),
                "next" if result.next_cursor.is_some() => index += 1,
                "prev" if index > 0 => index -= 1,
                _ => {
                    if let Some(item) = answer
                        .parse::<usize>()
                        .ok()
                        .filter(|n| (1..=10).contains(n))
                        .and_then(|n| result.items.get(n - 1))
                    {
                        ensure!(
                            item.category == kcoder_types::migration::MigrationCategory::Project,
                            "migration_project_invalid_selection"
                        );
                        review::report(
                            &self.io,
                            &mut Target {
                                guide: self,
                                client,
                            },
                            job,
                            &item.id,
                        )
                        .await?;
                    } else {
                        self.io.notice(
                            "migration_project_invalid_selection",
                            "请选择原记录中的项目编号。",
                        )?;
                    }
                }
            }
        }
    }
}
