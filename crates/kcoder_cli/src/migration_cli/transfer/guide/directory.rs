//! A source-host directory is an explicit, connection-bound grant, never a client-side path.
use super::*;
use record::{DirectoryChoice, SourceViews};

impl Guide {
    pub(super) async fn source_query<P: serde::Serialize, R: serde::de::DeserializeOwned>(
        &self,
        session: &MigrationSourceSessionParams,
        kind: &str,
        params: &P,
    ) -> Result<R> {
        self.scope(true).await?;
        ensure!(
            session == &self.draft.source,
            "migration_transfer_record_scope_changed"
        );
        let wire: MigrationSourceSessionQueryParams = serde_json::from_value(
            json!({"session":session,"query":{"kind":kind,"params":params}}),
        )
        .map_err(|_| anyhow::anyhow!("migration_transfer_invalid_query"))?;
        let result = self.post("source-session", "query", &wire).await?;
        self.scope(true).await?;
        Ok(result)
    }
    pub(super) async fn prepare_directory(
        &mut self,
        session: &MigrationSourceSessionParams,
    ) -> Result<()> {
        if self.draft.source_views.is_none() {
            self.draft.source_views = Some(SourceViews {
                session_id: session.session_id.clone(),
                // Old records with selected grants retain their original default root.
                directory_decided: !self.draft.selections.is_empty(),
                discovery_started: !self.draft.selections.is_empty(),
                ..Default::default()
            });
            self.save()?;
        }
        let views = self.draft.source_views.as_ref().unwrap();
        ensure!(
            views.session_id == session.session_id,
            "migration_transfer_source_reselection_required"
        );
        if !views.directory_decided {
            let path = if let Some(path) = &views.requested_directory {
                Some(path.clone())
            } else {
                loop {
                    match self.io.ask("transfer_source_directory", "The source product root is on the source host. default uses that account's default product directory; directory explicitly enters a product directory; quit exits. Project files require separate --include-project authorization.", json!(["default","directory","quit"]), Some("default"))?.as_str() {
                        "default" => break None,
                        "directory" => break Some(self.io.ask("transfer_source_directory_path", "Enter an absolute product root on the source host. A same-named local path is not read; the path is saved only in the private record.", json!({"source":self.draft.source_kind}), None)?),
                        "quit" => anyhow::bail!("migration_transfer_guide_stopped"),
                        _ => self.io.notice("migration_transfer_invalid_selection", "Choose default or directory.")?,
                    }
                }
            };
            let params = path.map(|directory| serde_json::from_value::<MigrationSourceDirectorySelectParams>(json!({"selectionId":uuid::Uuid::new_v4().to_string(),"source":self.draft.source_kind,"directory":directory}))
                .map_err(|_| anyhow::anyhow!("migration_transfer_invalid_directory"))).transpose()?;
            if params.is_some() {
                ensure!(self.io.yes("transfer_source_directory_confirm", "Authorize only static product data in this source-host directory? Failures do not fall back to the default directory; use source-reset to change directories.")?, "migration_transfer_confirmation_required");
            }
            let views = self.draft.source_views.as_mut().unwrap();
            views.requested_directory = params.as_ref().map(|params| params.directory.clone());
            views.directory = params.map(|params| DirectoryChoice {
                params,
                confirmed: false,
            });
            views.directory_decided = true;
            self.save()?;
        }
        if let Some(choice) = self.draft.source_views.as_ref().unwrap().directory.clone()
            && !choice.confirmed
        {
            // The persisted same selectionId reconciles a lost reply. It never rebinds a root.
            let result: MigrationSourceDirectoryResult = self
                .source_query(session, "directory_select", &choice.params)
                .await?;
            ensure!(
                result.selection_id == choice.params.selection_id
                    && result.source == choice.params.source
                    && result.remaining_ms <= 600_000,
                "migration_transfer_invalid_response"
            );
            self.draft
                .source_views
                .as_mut()
                .unwrap()
                .directory
                .as_mut()
                .unwrap()
                .confirmed = true;
            self.save()?;
            self.io.state("source_directory", &json!({"selectionId":result.selection_id,"source":result.source,"remainingMs":result.remaining_ms}))?;
        }
        self.draft.source_views.as_mut().unwrap().discovery_started = true;
        self.save()
    }
    pub(super) async fn reset_source_views(&mut self) -> Result<()> {
        ensure!(
            !self.draft.copy_prepared,
            "migration_transfer_selection_frozen_read_original"
        );
        self.scope(true).await?;
        ensure!(self.io.yes("transfer_source_reset_confirm", "Release the original source connection and reselect untransferred directories and data? Only local unsubmitted selections are cleared; requestId/adoptionId remain unchanged and other connections are not taken over.")?, "migration_transfer_confirmation_required");
        let result: MigrationSourceSessionCloseResult = self
            .post("source-session", "close", &self.draft.source)
            .await?;
        self.scope(true).await?;
        ensure!(
            result.status == MigrationSourceSessionReleaseState::Released,
            "source_transfer_session_busy"
        );
        self.draft.source.session_id = uuid::Uuid::new_v4().to_string();
        self.draft.source_views = None;
        self.draft.instruction_capture = None;
        self.draft.selections.clear();
        self.save()?;
        self.io.notice(
            "migration_transfer_source_reset",
            "The original source connection was released. select will obtain explicit authorization again; the default directory is not scanned automatically.",
        )
    }
}
