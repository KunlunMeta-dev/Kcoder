//! Selection retains opaque grants and explicit replacement intent in the existing private draft.
use super::*;
use questions::SourceRow;
use std::collections::BTreeSet;

fn source_id(selection: &MigrationSourceSelectionV1) -> Option<&str> {
    match selection {
        MigrationSourceSelectionV1::Configuration { source_id }
        | MigrationSourceSelectionV1::Assets { source_id } => Some(source_id),
        _ => None,
    }
}
impl Guide {
    async fn source_rows(&self, session: &MigrationSourceSessionParams) -> Result<Vec<SourceRow>> {
        let discovered: MigrationDiscoverResult = self
            .source_query(
                session,
                "configuration",
                &MigrationDiscoverParams {
                    sources: vec![self.draft.source_kind],
                    include_project: self.draft.include_project,
                },
            )
            .await?;
        ensure!(
            discovered.sources.len() <= 1024,
            "migration_transfer_response_budget_exceeded"
        );
        let mut rows = Vec::new();
        for page in discovered.sources.chunks(10) {
            let ids = page
                .iter()
                .map(|row| row.source_id.clone())
                .collect::<Vec<_>>();
            let bindings: MigrationSourceBindingsResult = self
                .source_query(
                    session,
                    "source_bindings",
                    &MigrationSourceBindingsParams {
                        source_ids: ids.clone(),
                    },
                )
                .await?;
            ensure!(
                bindings.bindings.len() == ids.len()
                    && bindings
                        .bindings
                        .iter()
                        .zip(&ids)
                        .all(|(row, id)| &row.source_id == id),
                "migration_transfer_invalid_response"
            );
            for (row, binding) in page.iter().zip(bindings.bindings) {
                let selection = match binding.family {
                    kcoder_types::migration_source_bindings::MigrationSourceBindingFamily::Configuration => MigrationSourceSelectionV1::Configuration {source_id:binding.source_id},
                    kcoder_types::migration_source_bindings::MigrationSourceBindingFamily::Assets => MigrationSourceSelectionV1::Assets {source_id:binding.source_id},
                };
                rows.push(SourceRow {
                    title: row.display_name.clone(),
                    scope: row.scope.clone(),
                    selection,
                });
            }
        }
        if !discovered.problems.is_empty() {
            self.io.state("discovery_problems", &discovered.problems)?;
        }
        Ok(rows)
    }
    pub(super) async fn choose_source_views(
        &mut self,
        session: &MigrationSourceSessionParams,
    ) -> Result<Vec<MigrationSourceSelectionV1>> {
        let originals = self.source_rows(session).await?;
        let mut rows = originals.clone();
        let mut chosen = self
            .draft
            .selections
            .iter()
            .filter_map(source_id)
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        let instruction_selections = self
            .draft
            .selections
            .iter()
            .filter(|row| matches!(row, MigrationSourceSelectionV1::Instructions { .. }))
            .cloned()
            .collect::<Vec<_>>();
        let mut memory_selections = Vec::new();
        let mut project_selections = self
            .draft
            .selections
            .iter()
            .filter(|row| matches!(row, MigrationSourceSelectionV1::Projects { .. }))
            .cloned()
            .collect::<Vec<_>>();
        if let Some(layers) = self
            .draft
            .source_views
            .as_ref()
            .and_then(|v| v.codex_layers.as_ref())
            .and_then(|v| v.result.as_ref())
        {
            replace(&mut rows, &mut chosen, layers, false);
        }
        let mut page = 0;
        loop {
            self.scope(true).await?;
            let visible=rows.iter().skip(page*10).take(10).enumerate().map(|(i,row)|json!({"number":i+1,"title":row.title,"scope":row.scope,"selected":source_id(&row.selection).is_some_and(|id|chosen.contains(id))})).collect::<Vec<_>>();
            let answer=self.io.ask("transfer_sources","静态文件快照，不代表来源程序运行时最终配置。toggle N 选择；layers N 用该Codex用户/profile与受信任项目层替换单文件；report N 查看来源；originals 恢复单文件视图；projects 选择项目清单；memory 选择未验证记忆；next/prev；done 固定；quit 退出。",json!({"page":page,"pages":rows.len().div_ceil(10),"selected":chosen.len()+memory_selections.len()+project_selections.len(),"projectsSelected":project_selections.len(),"memorySelected":memory_selections.len(),"items":visible}),None)?;
            let mut words = answer.split_whitespace();
            let action = words.next().unwrap_or("");
            let index = words
                .next()
                .and_then(|v| v.parse::<usize>().ok())
                .filter(|n| (1..=10).contains(n))
                .map(|n| page * 10 + n - 1)
                .filter(|n| *n < rows.len());
            match action {
                "next" if (page + 1) * 10 < rows.len() => page += 1,
                "prev" if page > 0 => page -= 1,
                "originals" => {
                    self.draft.source_views.as_mut().unwrap().codex_layers = None;
                    self.draft.selections.clear();
                    self.save()?;
                    rows = originals.clone();
                    chosen.clear();
                    page = 0;
                }
                "layers" if index.is_some() => {
                    let row = &rows[index.unwrap()];
                    if self.draft.source_kind != kcoder_types::migration::MigrationSourceKind::Codex
                        || row.scope != "user"
                        || !matches!(
                            row.selection,
                            MigrationSourceSelectionV1::Configuration { .. }
                        )
                        || !self.draft.include_project
                    {
                        self.io.notice("migration_codex_project_authorization_required","layers 需要 --include-project、受信任来源项目和Codex用户/profile设置；未改变选择。")?;
                        continue;
                    }
                    let id = source_id(&row.selection).unwrap().to_owned();
                    self.draft.source_views.as_mut().unwrap().codex_layers =
                        Some(record::LayerChoice {
                            source_id: id.clone(),
                            result: None,
                        });
                    self.save()?;
                    match self.select_layers(session,&id).await {
                        Ok(selected)=>{
                            replace(&mut rows,&mut chosen,&selected,true);page=0;
                            self.show_source_layers(session,&selected.source.source_id,true).await?;
                        }
                        Err(error)=>self.io.notice(&safe_error(&error),"层次选择尚未确认，保留原选择。再次 layers 可核对原来源；originals 明确放弃待确认选择。")?,
                    }
                }
                "report" if index.is_some() => {
                    let row = &rows[index.unwrap()];
                    if let Some(id) = source_id(&row.selection) {
                        if !matches!(
                            row.selection,
                            MigrationSourceSelectionV1::Configuration { .. }
                        ) {
                            self.io.notice(
                                "migration_layers_report_unavailable",
                                "此项不是设置来源。",
                            )?;
                            continue;
                        }
                        if let Err(error) = self
                            .show_source_layers(session, id, row.scope == "codex-project-layers")
                            .await
                        {
                            self.io
                                .notice(&safe_error(&error), "报告不可用，未重新绑定来源。")?;
                        }
                    }
                }
                "projects" => {
                    project_selections = self
                        .choose_projects(
                            session,
                            chosen.len() + memory_selections.len() + instruction_selections.len(),
                        )
                        .await?;
                    self.scope(true).await?;
                }
                "memory" => {
                    memory_selections = questions::memory::choose(
                        &self.io,
                        &self.client,
                        session,
                        self.draft.source_kind,
                        chosen.len() + project_selections.len() + instruction_selections.len(),
                    )
                    .await?;
                    self.scope(true).await?;
                }
                "toggle" if index.is_some() => {
                    let row = &rows[index.unwrap()];
                    let id = source_id(&row.selection).unwrap().to_owned();
                    if !chosen.remove(&id) {
                        ensure!(
                            chosen.len()
                                + memory_selections.len()
                                + project_selections.len()
                                + instruction_selections.len()
                                < 64,
                            "migration_transfer_selection_budget_exceeded"
                        );
                        if row.scope == "project-effective" {
                            for old in &rows {
                                if matches!(
                                    old.scope.as_str(),
                                    "user" | "project" | "project-local"
                                ) && matches!(
                                    old.selection,
                                    MigrationSourceSelectionV1::Configuration { .. }
                                ) && let Some(id) = source_id(&old.selection)
                                {
                                    chosen.remove(id);
                                }
                            }
                        } else if matches!(row.scope.as_str(), "user" | "project" | "project-local")
                            && matches!(
                                row.selection,
                                MigrationSourceSelectionV1::Configuration { .. }
                            )
                        {
                            for old in &rows {
                                if old.scope == "project-effective"
                                    && let Some(id) = source_id(&old.selection)
                                {
                                    chosen.remove(id);
                                }
                            }
                        }
                        chosen.insert(id);
                    }
                }
                "done"
                    if !chosen.is_empty()
                        || !project_selections.is_empty()
                        || !memory_selections.is_empty()
                        || !instruction_selections.is_empty()
                        || self.draft.include_history =>
                {
                    ensure!(
                        self.draft
                            .source_views
                            .as_ref()
                            .and_then(|v| v.codex_layers.as_ref())
                            .is_none_or(|v| v.result.is_some()),
                        "migration_transfer_layer_choice_unconfirmed"
                    );
                    let mut selected = rows
                        .iter()
                        .filter(|row| {
                            source_id(&row.selection).is_some_and(|id| chosen.contains(id))
                        })
                        .map(|row| row.selection.clone())
                        .collect::<Vec<_>>();
                    selected.extend(memory_selections);
                    selected.extend(project_selections);
                    selected.extend(instruction_selections.clone());
                    if self.draft.include_history {
                        selected.extend(
                            questions::choose_history(
                                &self.io,
                                &self.client,
                                session,
                                self.draft.source_kind,
                                selected.len(),
                            )
                            .await?,
                        );
                    }
                    self.scope(true).await?;
                    ensure!(
                        !selected.is_empty() && selected.len() <= 64,
                        "migration_transfer_selection_budget_exceeded"
                    );
                    return Ok(selected);
                }
                "quit" => anyhow::bail!("migration_transfer_guide_stopped"),
                _ => self.io.notice(
                    "migration_transfer_invalid_selection",
                    "请选择当前页资料或有效操作。",
                )?,
            }
        }
    }
    async fn select_layers(
        &mut self,
        session: &MigrationSourceSessionParams,
        id: &str,
    ) -> Result<MigrationCodexLayersSelectResult> {
        let selected: MigrationCodexLayersSelectResult = self
            .source_query(
                session,
                "codex_layers_select",
                &MigrationCodexLayersSelectParams {
                    source_id: id.to_owned(),
                    include_project: true,
                },
            )
            .await?;
        ensure!(
            selected.source.kind == self.draft.source_kind
                && selected.source.scope == "codex-project-layers"
                && selected.replaces_source_ids.len() <= 1024
                && selected.replaces_source_ids.iter().any(|v| v == id),
            "migration_transfer_invalid_response"
        );
        self.draft
            .source_views
            .as_mut()
            .unwrap()
            .codex_layers
            .as_mut()
            .unwrap()
            .result = Some(selected.clone());
        self.save()?;
        Ok(selected)
    }
    async fn show_source_layers(
        &self,
        session: &MigrationSourceSessionParams,
        id: &str,
        codex: bool,
    ) -> Result<()> {
        let mut page = 0u32;
        loop {
            let (value, next, total) = if codex {
                let report: MigrationCodexLayersReadResult = self
                    .source_query(
                        session,
                        "codex_layers_read",
                        &MigrationSourceCodexLayersReadParams {
                            source_id: id.to_owned(),
                            page_index: page,
                        },
                    )
                    .await?;
                ensure!(
                    matches!(&report.target,MigrationConfigurationLayersTarget::Source{source_id}if source_id==id)
                        && report.page_index == page
                        && report.fields.len() <= 10,
                    "migration_transfer_invalid_response"
                );
                (
                    serde_json::to_value(&report)?,
                    report.next_page,
                    report.total_fields,
                )
            } else {
                let report: MigrationConfigurationLayersResult = self
                    .source_query(
                        session,
                        "configuration_layers_read",
                        &MigrationSourceConfigurationLayersReadParams {
                            source_id: id.to_owned(),
                            page_index: page,
                        },
                    )
                    .await?;
                ensure!(
                    matches!(&report.target,MigrationConfigurationLayersTarget::Source{source_id}if source_id==id)
                        && report.page_index == page
                        && report.fields.len() <= 10,
                    "migration_transfer_invalid_response"
                );
                (
                    serde_json::to_value(&report)?,
                    report.next_page,
                    report.total_fields,
                )
            };
            ensure!(
                total <= 1024 && next.is_none_or(|next| next == page + 1),
                "migration_transfer_invalid_response"
            );
            self.io.state("configuration_layers", &value)?;
            match self
                .io
                .ask(
                    "configuration_layers_page",
                    "只读静态来源与未观察边界，每页最多10项；next/prev 或 back。",
                    json!({"page":page,"hasNextPage":next.is_some()}),
                    Some("back"),
                )?
                .as_str()
            {
                "next" if next.is_some() => page = next.unwrap(),
                "prev" if page > 0 => page -= 1,
                "back" => return Ok(()),
                _ => self.io.notice(
                    "migration_transfer_invalid_selection",
                    "请选择有效页或 back。",
                )?,
            }
        }
    }
}
fn replace(
    rows: &mut Vec<SourceRow>,
    chosen: &mut BTreeSet<String>,
    selected: &MigrationCodexLayersSelectResult,
    select: bool,
) {
    for id in &selected.replaces_source_ids {
        chosen.remove(id);
    }
    rows.retain(|row| {
        source_id(&row.selection).is_none_or(|id| {
            id != selected.source.source_id
                && !selected.replaces_source_ids.iter().any(|old| old == id)
        })
    });
    if select {
        chosen.insert(selected.source.source_id.clone());
    }
    rows.insert(
        0,
        SourceRow {
            title: selected.source.display_name.clone(),
            scope: selected.source.scope.clone(),
            selection: MigrationSourceSelectionV1::Configuration {
                source_id: selected.source.source_id.clone(),
            },
        },
    );
}
