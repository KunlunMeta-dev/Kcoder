//! Receiving and adoption are explicit operations; only Native may authorize batch previews.
use super::*;
impl Guide {
    fn locator(&self) -> MigrationSourceAdoptionParams {
        MigrationSourceAdoptionParams {
            target: MigrationSourceAdoptionSession {
                session_id: self.draft.recovery.session_id.clone(),
                purpose: MigrationSourceAdoptionSessionPurpose::TargetRecovery,
                target_id: self.draft.recovery.target_id.clone(),
                workspace_path: self.draft.recovery.workspace_path.clone(),
            },
            request_id: self.draft.request_id.clone(),
            adoption_id: self.draft.adoption_id.clone(),
        }
    }
    pub(super) async fn adoption_read(
        &mut self,
        show: bool,
    ) -> Result<MigrationSourceAdoptionResult> {
        self.session(MigrationSourceSessionPurpose::TargetRecovery)
            .await?;
        let locator = self.locator();
        let result: MigrationSourceAdoptionResult = self
            .post("source-transfer", "adoption-read", &locator)
            .await?;
        validation::adoption(&result, &locator)?;
        self.scope(false).await?;
        if show {
            self.io.state("adoption_state", &result)?;
        }
        Ok(result)
    }
    pub(super) async fn adopt(&mut self) -> Result<()> {
        self.read_target(true).await?;
        ensure!(
            self.draft.manifest_sha256.is_some(),
            "migration_transfer_receipt_required"
        );
        if self.draft.adoption_prepared {
            self.adoption_read(true).await?;
            return self.io.notice("migration_transfer_adoption_already_prepared","Adoption identity is fixed. Check original state first; use adoption-retry for unknown outcomes or explicitly adoption-resume when stopped. Do not replace its creation identity.");
        }
        let digest = self.draft.manifest_sha256.clone().unwrap();
        let mut page = 0u32;
        let mut selected = std::collections::BTreeMap::new();
        let mut instruction_mappings = std::collections::BTreeMap::new();
        loop {
            self.scope(false).await?;
            let params = MigrationSourceReceivedParams {
                include_projects: self.draft.selections.iter().any(|selection| {
                    matches!(selection, MigrationSourceSelectionV1::Projects { .. })
                }),
                include_instructions: true,
                target: self.locator().target,
                request_id: self.draft.request_id.clone(),
                manifest_sha256: digest.clone(),
                page_index: page,
                include_plugins: self.draft.selections.iter().any(|selection| {
                    matches!(selection, MigrationSourceSelectionV1::Plugin { .. })
                }),
            };
            let result: MigrationSourceReceivedResult =
                self.post("source-transfer", "received", &params).await?;
            validation::received(&result, &params)?;
            let rows=result.items.iter().enumerate().map(|(i,row)|json!({"number":i+1,"entryId":row.entry_id,"kind":row.class,"category":row.category,"files":row.files,"bytes":row.bytes,"projectScoped":row.project_scoped,"selected":selected.contains_key(&row.entry_id)})).collect::<Vec<_>>();
            let answer=self.io.ask("transfer_received_selection","Select adoption sources: toggle N selects/deselects; next/prev changes pages; done fixes adoption and previews; quit returns. Target configuration is not published here.",json!({"page":page,"totalSources":result.total_sources,"selected":selected.len(),"items":rows}),None)?;
            let mut words = answer.split_whitespace();
            match words.next().unwrap_or("") {
                "quit" => return Ok(()),
                "next" => {
                    if let MigrationSourceNullable::Value(next) = result.next_page {
                        page = next
                    }
                }
                "prev" if page > 0 => page -= 1,
                "done" if !selected.is_empty() => break,
                "toggle" => {
                    if let Some(row) = words
                        .next()
                        .and_then(|n| n.parse::<usize>().ok())
                        .filter(|n| (1..=10).contains(n))
                        .and_then(|n| result.items.get(n - 1))
                    {
                        if selected.remove(&row.entry_id).is_some() {
                            instruction_mappings.remove(&row.entry_id);
                            continue;
                        }
                        ensure!(
                            selected.len() < 64,
                            "migration_transfer_selection_budget_exceeded"
                        );
                        let instruction = row.class == MigrationSourceReceivedClass::Instructions;
                        if instruction {
                            let mapping = self.map_instructions(&row.entry_id).await?;
                            instruction_mappings.insert(row.entry_id.clone(), mapping);
                        }
                        let project_mapping = if instruction
                            || row.project_scoped
                                && row.class != MigrationSourceReceivedClass::History
                        {
                            if !instruction {
                                ensure!(self.io.yes("transfer_project_mapping","This source includes project-scoped content. Explicitly map it to the selected target's current working directory? Native still validates actual directories, trust and supported fields; no fallback to user scope.")?,"migration_transfer_project_mapping_required");
                            }
                            Some(MigrationSourceProjectMapping::CurrentWorkspace)
                        } else {
                            None
                        };
                        selected.insert(
                            row.entry_id.clone(),
                            MigrationSourceAdoptionSelection {
                                entry_id: row.entry_id.clone(),
                                project_mapping,
                            },
                        );
                    } else {
                        self.io.notice(
                            "migration_transfer_invalid_selection",
                            "Select a data item number on this page.",
                        )?;
                    }
                }
                _ => self.io.notice(
                    "migration_transfer_invalid_selection",
                    "Select data or return; no new adoption job was prepared.",
                )?,
            }
        }
        ensure!(
            self.io.yes(
                "transfer_adoption_confirm",
                "Prepare these received sources as a target Native batch preview? This does not automatically submit, enable or execute source content."
            )?,
            "migration_transfer_confirmation_required"
        );
        self.draft.adoption_selections = Some(selected.into_values().collect());
        self.draft.instruction_mappings = instruction_mappings.into_values().collect();
        self.draft.adoption_prepared = true;
        self.save()?;
        self.prepare_adoption().await
    }
    pub(super) async fn adoption_retry(&mut self) -> Result<()> {
        ensure!(
            self.draft.adoption_prepared,
            "migration_transfer_adoption_not_prepared"
        );
        let previous = self.adoption_read(true).await?;
        if let MigrationSourceNullable::Value(state) = &previous.state
            && (state.phase == MigrationSourceAdoptionPhase::PreviewReady
                || state.worker_state == MigrationSourceAdoptionWorkerState::Running)
        {
            return Ok(());
        }
        ensure!(
            self.io.yes(
                "transfer_adoption_retry",
                "Idempotently check using the saved, identical adoption identity and selection? No replacement adoption job is generated."
            )?,
            "migration_transfer_confirmation_required"
        );
        self.prepare_adoption().await
    }
    async fn prepare_adoption(&mut self) -> Result<()> {
        self.scope(false).await?;
        let locator = self.locator();
        let params = MigrationSourceAdoptionPrepareParams {
            instruction_mappings: self.draft.instruction_mappings.clone(),
            locator: locator.clone(),
            manifest_sha256: self
                .draft
                .manifest_sha256
                .clone()
                .ok_or_else(|| anyhow::anyhow!("migration_transfer_receipt_required"))?,
            selections: self
                .draft
                .adoption_selections
                .clone()
                .ok_or_else(|| anyhow::anyhow!("migration_transfer_no_sources_selected"))?,
        };
        let result: MigrationSourceAdoptionResult = self
            .post("source-transfer", "adoption-prepare", &params)
            .await?;
        validation::adoption(&result, &locator)?;
        self.wait_adoption(result).await
    }
    async fn wait_adoption(&mut self, mut result: MigrationSourceAdoptionResult) -> Result<()> {
        let deadline = std::time::Instant::now() + Duration::from_secs(300);
        loop {
            self.io.state("adoption_state", &result)?;
            let running = matches!(&result.state,MigrationSourceNullable::Value(value) if value.worker_state==MigrationSourceAdoptionWorkerState::Running);
            if !running || std::time::Instant::now() >= deadline {
                return Ok(());
            }
            self.io.active()?;
            tokio::time::sleep(Duration::from_millis(500)).await;
            result = self.adoption_read(false).await?;
        }
    }
    pub(super) async fn adoption_resume(&mut self) -> Result<()> {
        let result = self.adoption_read(true).await?;
        let MigrationSourceNullable::Value(state) = result.state else {
            anyhow::bail!("source_transfer_outcome_unknown")
        };
        ensure!(
            state.worker_state == MigrationSourceAdoptionWorkerState::Stopped,
            "source_transfer_busy"
        );
        let MigrationSourceNullable::Value(control) = state.control else {
            anyhow::bail!("source_transfer_outcome_unknown")
        };
        ensure!(
            self.io.yes(
                "transfer_adoption_resume",
                "Resume the original adoption job using the Native progress just read? adoptionId is unchanged and target configuration is not published."
            )?,
            "migration_transfer_confirmation_required"
        );
        self.draft.adoption_resume = Some(control.clone());
        self.draft.adoption_cancel_id = None;
        self.save()?;
        self.scope(false).await?;
        let locator = self.locator();
        let result: MigrationSourceAdoptionResult = self
            .post(
                "source-transfer",
                "adoption-resume",
                &MigrationSourceAdoptionResumeParams {
                    locator: locator.clone(),
                    expected_control: control,
                },
            )
            .await?;
        validation::adoption(&result, &locator)?;
        self.wait_adoption(result).await
    }
    pub(super) async fn adoption_cancel(&mut self) -> Result<()> {
        self.adoption_read(true).await?;
        ensure!(
            self.io.yes(
                "transfer_adoption_cancel",
                "Cancel the original adoption preview job? Existing Native batches and confirmed results are retained; they are not undone automatically."
            )?,
            "migration_transfer_confirmation_required"
        );
        let command_id = self
            .draft
            .adoption_cancel_id
            .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone();
        self.save()?;
        self.scope(false).await?;
        let locator = self.locator();
        let result: MigrationSourceAdoptionResult = self
            .post(
                "source-transfer",
                "adoption-cancel",
                &MigrationSourceAdoptionCancelParams {
                    locator: locator.clone(),
                    command_id,
                },
            )
            .await?;
        validation::adoption(&result, &locator)?;
        self.io.state("adoption_state", &result)
    }
}
