use super::*;
use std::collections::{BTreeMap, BTreeSet};

impl Guide {
    pub(super) async fn private_receive(
        &mut self,
        client: &mut runtime::Client,
        job: &str,
    ) -> Result<()> {
        let state = self.batch_read(client, job).await?;
        ensure!(!state.worker_running, "private_credentials_busy");
        let plan = state
            .state
            .batch
            .as_ref()
            .and_then(|batch| batch.plan_id.clone())
            .ok_or_else(|| anyhow::anyhow!("private_credentials_saved_plan_required"))?;
        let mut page = 0u32;
        let row = loop {
            let result: MigrationSourceCredentialSourcesResult = self
                .rpc(
                    client,
                    method::MIGRATION_BATCH_CREDENTIAL_SOURCES,
                    &MigrationSourceCredentialSourcesParams {
                        job_id: job.into(),
                        page_index: page,
                    },
                )
                .await?;
            ensure!(
                result.job_id == job
                    && result.plan_id.as_deref() == Some(&plan)
                    && result.sequence == state.state.job.sequence
                    && result.total_items <= 64,
                "private_credentials_plan_changed"
            );
            page_shape(
                page,
                result.total_items,
                result.items.len(),
                result.next_page,
            )?;
            let rows=result.items.iter().enumerate().map(|(at,row)|json!({"number":at+1,"entryId":row.entry_id,"source":row.source,"projectScoped":row.project_scoped})).collect::<Vec<_>>();
            let answer=self.io.ask("transfer_private_sources","只读原作业的来源定位。选择本页编号；next/prev每页10项；back返回。后续另确认API key或MCP私有字段，不读取任意文件。",json!({"page":page,"items":rows,"total":result.total_items}),None)?;
            match answer.as_str() {
                "back" => return Ok(()),
                "next" if result.next_page.is_some() => page = result.next_page.unwrap(),
                "prev" if page > 0 => page -= 1,
                _ => {
                    if let Some(row) = answer
                        .parse::<usize>()
                        .ok()
                        .filter(|n| (1..=10).contains(n))
                        .and_then(|n| result.items.get(n - 1))
                    {
                        break row.clone();
                    } else {
                        self.io.notice(
                            "private_credentials_invalid_selection",
                            "请选择原作业当前页内的来源。",
                        )?;
                    }
                }
            }
        };
        ensure!(
            row.request_id == self.draft.request_id
                && self.draft.manifest_sha256.as_ref() == Some(&row.manifest_sha256)
                && row.source == self.draft.source_kind,
            "private_credentials_binding_changed"
        );
        let target = self
            .session(MigrationSourceSessionPurpose::TargetRecovery)
            .await?;
        let selections = self
            .private_choices(job, &plan, state.state.job.sequence, &row, target)
            .await?;
        let api_keys = selections
            .iter()
            .any(|choice| matches!(choice, MigrationSourceCredentialSelection::Provider { .. }));
        let mcp_private_fields = selections
            .iter()
            .any(|choice| matches!(choice, MigrationSourceCredentialSelection::Mcp { .. }));
        if api_keys {
            ensure!(self.io.yes("transfer_private_api_consent","明确同意将所选已声明API key通过原Native加密通道送至所选目标？不会显示、输入或保存明文到本记录。")?,"private_credentials_explicit_consent_required");
        }
        if mcp_private_fields {
            ensure!(self.io.yes("transfer_private_mcp_consent","明确同意只传输逐项勾选的MCP环境/请求头私值？不执行MCP、不填占位值、不复制完整凭据文件。")?,"private_credentials_explicit_consent_required");
        }
        let source = self.session(MigrationSourceSessionPurpose::Source).await?;
        let target = self.session(MigrationSourceSessionPurpose::Target).await?;
        let input = MigrationSourceCredentialRunParams {
            locator: MigrationSourceCredentialLocator {
                request_id: self.draft.request_id.clone(),
                offer_id: uuid::Uuid::new_v4().to_string(),
                target,
            },
            source,
            manifest_sha256: row.manifest_sha256,
            entry_id: row.entry_id,
            selections,
            consent: MigrationSourceCredentialConsent {
                api_keys,
                mcp_private_fields,
            },
        };
        let known = self
            .draft
            .private_credentials
            .as_ref()
            .and_then(|journal| {
                journal.offers.iter().find(|old| {
                    old.job_id == job
                        && old.original_plan_id == plan
                        && same_input(&old.input, &input)
                })
            })
            .cloned();
        let offer = if let Some(known) = known {
            ensure!(
                known.source_binding_revision == row.source_binding_revision,
                "private_credentials_binding_changed"
            );
            known
        } else {
            Offer {
                job_id: job.into(),
                original_plan_id: plan.clone(),
                source_binding_revision: row.source_binding_revision,
                input,
                dispatched: false,
                included: false,
            }
        };
        let journal = self
            .draft
            .private_credentials
            .get_or_insert_with(Default::default);
        journal.selected_offer = Some(offer.input.locator.offer_id.clone());
        if !journal
            .offers
            .iter()
            .any(|row| row.input.locator.offer_id == offer.input.locator.offer_id)
        {
            ensure!(
                journal.offers.len() < 64,
                "private_credentials_budget_exceeded"
            );
            journal.offers.push(offer.clone());
        }
        self.save()?;
        if offer.dispatched {
            self.private_read(job, false).await?;
            return Ok(());
        }
        let fresh = self.batch_read(client, job).await?;
        ensure!(
            !fresh.worker_running
                && fresh.state.job.sequence == state.state.job.sequence
                && fresh
                    .state
                    .batch
                    .as_ref()
                    .and_then(|batch| batch.plan_id.as_ref())
                    == Some(&plan),
            "private_credentials_plan_changed"
        );
        self.draft
            .private_credentials
            .as_mut()
            .unwrap()
            .offers
            .iter_mut()
            .find(|row| row.input.locator.offer_id == offer.input.locator.offer_id)
            .unwrap()
            .dispatched = true;
        self.save()?;
        self.scope(true).await?;
        let result: MigrationSourceCredentialResult =
            self.private_post("run", &offer.input).await?;
        self.scope(true).await?;
        validation::observation(&result, &offer.input.locator, false)?;
        self.io.state("private_transfer", &result)
    }
    async fn private_choices(
        &self,
        job: &str,
        plan: &str,
        sequence: u64,
        source: &MigrationSourceCredentialSource,
        target: MigrationSourceSessionParams,
    ) -> Result<Vec<MigrationSourceCredentialSelection>> {
        let mut page = 0;
        let mut selected = BTreeMap::new();
        let mut total = None;
        loop {
            let params = MigrationSourceCredentialCandidatesParams {
                request_id: source.request_id.clone(),
                target: target.clone(),
                manifest_sha256: source.manifest_sha256.clone(),
                entry_id: source.entry_id.clone(),
                page_index: page,
                job_id: Some(job.into()),
                expected_plan_id: Some(plan.into()),
            };
            let result: MigrationSourceCredentialCandidatesResult =
                self.private_post("candidates", &params).await?;
            ensure!(
                result.request_id == params.request_id
                    && result.manifest_sha256 == params.manifest_sha256
                    && result.entry_id == params.entry_id
                    && result.source_binding_revision == source.source_binding_revision
                    && result.source == source.source
                    && result.project_scoped == source.project_scoped
                    && matches!(&result.plan,Some(current) if current.job_id==job && current.plan_id==plan && current.sequence==sequence),
                "private_credentials_binding_changed"
            );
            ensure!(
                total.is_none_or(|old| old == result.total_items) && result.total_items <= 1024,
                "private_credentials_binding_changed"
            );
            total = Some(result.total_items);
            page_shape(
                page,
                result.total_items,
                result.items.len(),
                result.next_page,
            )?;
            let rows=result.items.iter().enumerate().map(|(at,row)|match row {
                MigrationSourceCredentialCandidate::Provider {item_id,source_name,issue_code,selectors,targets,..}=>json!({"number":at+1,"kind":"provider","sourceName":source_name,"eligible":issue_code.is_none() && targets.len()==1,"issueCode":issue_code,"selectorCount":selectors.len(),"selected":selected.contains_key(item_id)}),
                MigrationSourceCredentialCandidate::Mcp {item_id,source_name,issue_code,fields,targets,..}=>json!({"number":at+1,"kind":"mcp","sourceName":source_name,"eligible":issue_code.is_none() && targets.len()==1,"issueCode":issue_code,"fieldCount":fields.len(),"selected":selected.contains_key(item_id)}),
            }).collect::<Vec<_>>();
            let answer=self.io.ask("transfer_private_candidates","toggle N逐项选择私密来源（仅已保存计划内唯一映射）；next/prev每页10项；done固定；quit返回。这里没有明文值。",json!({"page":page,"items":rows,"selected":selected.len()}),None)?;
            let mut words = answer.split_whitespace();
            match words.next().unwrap_or("") {
                "quit" => anyhow::bail!("migration_transfer_guide_stopped"),
                "next" if result.next_page.is_some() => page = result.next_page.unwrap(),
                "prev" if page > 0 => page -= 1,
                "done" if !selected.is_empty() => return Ok(selected.into_values().collect()),
                "toggle" => {
                    let row = words
                        .next()
                        .and_then(|n| n.parse::<usize>().ok())
                        .filter(|n| (1..=10).contains(n))
                        .and_then(|n| result.items.get(n - 1))
                        .ok_or_else(|| anyhow::anyhow!("private_credentials_invalid_selection"))?;
                    let id = match row {
                        MigrationSourceCredentialCandidate::Provider { item_id, .. }
                        | MigrationSourceCredentialCandidate::Mcp { item_id, .. } => item_id,
                    };
                    if selected.remove(id).is_some() {
                        continue;
                    }
                    ensure!(selected.len() < 64, "private_credentials_budget_exceeded");
                    let choice = self.private_choice(row)?;
                    selected.insert(id.clone(), choice);
                }
                _ => self.io.notice(
                    "private_credentials_invalid_selection",
                    "请明确选择字段；未开始私密传输。",
                )?,
            }
        }
    }
    fn private_choice(
        &self,
        row: &MigrationSourceCredentialCandidate,
    ) -> Result<MigrationSourceCredentialSelection> {
        match row {
            MigrationSourceCredentialCandidate::Provider {
                source_name: Some(source),
                issue_code: None,
                source_verification_required: true,
                selectors,
                targets,
                ..
            } => {
                let [
                    MigrationSourceCredentialCandidateTarget::Provider {
                        target_name,
                        endpoint,
                        api_format,
                        ..
                    },
                ] = targets.as_slice()
                else {
                    anyhow::bail!("private_credentials_invalid_selection")
                };
                ensure!(
                    !selectors.is_empty() && selectors.len() <= 2,
                    "private_credentials_selector_unavailable"
                );
                let input=self.io.ask("transfer_private_selector","选择实际来源槽位编号；只可选择原生已声明的配置/环境引用，不输入密钥或任意变量名。",json!({"targetName":target_name,"selectors":selectors.iter().enumerate().map(|(at,value)|json!({"number":at+1,"selector":value})).collect::<Vec<_>>()}),None)?;
                let selector = input
                    .parse::<usize>()
                    .ok()
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|n| selectors.get(n))
                    .ok_or_else(|| anyhow::anyhow!("private_credentials_invalid_selection"))?;
                Ok(MigrationSourceCredentialSelection::Provider {
                    source_name: source.clone(),
                    selector: selector.clone(),
                    target_name: target_name.clone(),
                    endpoint: endpoint.clone(),
                    api_format: api_format.clone(),
                })
            }
            MigrationSourceCredentialCandidate::Mcp {
                source_name: Some(source),
                definition_sha256: Some(definition),
                issue_code: None,
                source_verification_required: true,
                fields,
                targets,
                ..
            } => {
                let [MigrationSourceCredentialCandidateTarget::Mcp { target_name, .. }] =
                    targets.as_slice()
                else {
                    anyhow::bail!("private_credentials_invalid_selection")
                };
                ensure!(
                    !fields.is_empty() && fields.len() <= 32,
                    "private_credentials_selector_unavailable"
                );
                let mut page = 0;
                let mut selected = BTreeSet::new();
                loop {
                    let rows=fields.iter().skip(page*10).take(10).enumerate().map(|(at,field)|json!({"number":at+1,"field":field,"selected":selected.contains(&(page*10+at))})).collect::<Vec<_>>();
                    let input=self.io.ask("transfer_private_fields","逐项选择MCP私有字段名：toggle N；next/prev每页10项；done固定。不会显示或执行字段值。",json!({"page":page,"items":rows,"selected":selected.len(),"targetName":target_name}),None)?;
                    let mut words = input.split_whitespace();
                    match words.next().unwrap_or("") {
                        "done" if !selected.is_empty() => break,
                        "next" if (page + 1) * 10 < fields.len() => page += 1,
                        "prev" if page > 0 => page -= 1,
                        "toggle" => {
                            let index = words
                                .next()
                                .and_then(|n| n.parse::<usize>().ok())
                                .filter(|n| (1..=10).contains(n))
                                .map(|n| page * 10 + n - 1)
                                .filter(|n| *n < fields.len())
                                .ok_or_else(|| {
                                    anyhow::anyhow!("private_credentials_invalid_selection")
                                })?;
                            if !selected.remove(&index) {
                                selected.insert(index);
                            }
                        }
                        _ => self.io.notice(
                            "private_credentials_invalid_selection",
                            "请明确选择当前页字段名。",
                        )?,
                    }
                }
                Ok(MigrationSourceCredentialSelection::Mcp {
                    source_name: source.clone(),
                    target_name: target_name.clone(),
                    definition_sha256: definition.clone(),
                    fields: selected
                        .into_iter()
                        .map(|index| fields[index].clone())
                        .collect(),
                })
            }
            _ => anyhow::bail!("private_credentials_invalid_selection"),
        }
    }
}
fn page_shape(page: u32, total: u32, count: usize, next: Option<u32>) -> Result<()> {
    let offset = u64::from(page) * 10;
    ensure!(
        (offset < u64::from(total) || offset == 0)
            && count == u64::from(total).saturating_sub(offset).min(10) as usize
            && next == (offset + 10 < u64::from(total)).then_some(page + 1),
        "private_credentials_invalid_response"
    );
    Ok(())
}
fn same_input(
    left: &MigrationSourceCredentialRunParams,
    right: &MigrationSourceCredentialRunParams,
) -> bool {
    let mut left = left.clone();
    let mut right = right.clone();
    for value in [&mut left, &mut right] {
        value.locator.offer_id.clear();
        value.locator.target.session_id.clear();
        value.source.session_id.clear();
    }
    left == right
}
