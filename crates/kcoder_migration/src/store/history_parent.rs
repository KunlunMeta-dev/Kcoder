//! Only an original batch action can identify the parent of an untracked history child.
use super::*;
use crate::{
    batch::{BatchActionKind, BatchSource},
    history_discovery::HistoryPendingSelection,
};
use kcoder_config::PrivateLeaseMode;
use kcoder_types::migration_resource::MigrationResourceLimits;

pub(crate) struct HistoryResourceParent {
    pub owner: String,
    pub members: Vec<String>,
    pub initial_limits: Option<MigrationResourceLimits>,
}

fn not_found(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|cause| cause.kind() == std::io::ErrorKind::NotFound)
    })
}

impl MigrationStore {
    fn history_parent_job_ids(&self) -> Result<Vec<String>> {
        let mut ids = Vec::new();
        self.directory
            .visit_entry_names_bounded(16_384, |name| {
                if let Some(name) = name.to_str()
                    && name.starts_with("mig-")
                    && name.ends_with(".json")
                {
                    let id = name.strip_suffix(".json").unwrap();
                    job_file(id).map_err(|_| anyhow::anyhow!("history_resource_parent_unknown"))?;
                    ensure!(ids.len() < 4096, "history_resource_parent_unknown");
                    ids.push(id.to_owned());
                }
                Ok(())
            })
            .map_err(|_| anyhow::anyhow!("history_resource_parent_unknown"))?;
        Ok(ids)
    }

    /// The absence case needs a complete bounded namespace observation, never the derived index.
    /// A missing coordinator is accepted only for an empty, still-unborn migration-job namespace.
    pub(crate) fn history_resource_parent(
        profile: &Path,
        migration_identity: &str,
        child: &str,
        selection: Option<&HistoryPendingSelection>,
        revision: &str,
    ) -> Result<Option<HistoryResourceParent>> {
        let store = Self::open_existing(profile)
            .map_err(|_| anyhow::anyhow!("history_resource_parent_unknown"))?;
        ensure!(
            store.directory.directory_identity()? == migration_identity,
            "history_resource_parent_unknown"
        );
        let name = OsStr::new(".lock");
        let identity = match store.directory.portable_regular_identity(name) {
            Ok(identity) => identity,
            Err(error) if not_found(&error) => {
                ensure!(
                    store.history_parent_job_ids()?.is_empty(),
                    "history_resource_parent_unknown"
                );
                ensure!(
                    store
                        .directory
                        .portable_regular_identity(name)
                        .is_err_and(|error| not_found(&error)),
                    "history_resource_parent_unknown"
                );
                return Ok(None);
            }
            Err(_) => anyhow::bail!("history_resource_parent_unknown"),
        };
        // No history child lease is acquired while this parent coordinator is held.
        let _lease = store
            .directory
            .try_existing_portable_lock(name, &identity, PrivateLeaseMode::Shared)
            .map_err(|_| anyhow::anyhow!("history_resource_parent_unknown"))?
            .ok_or_else(|| anyhow::anyhow!("history_resource_parent_unknown"))?;
        let ids = store.history_parent_job_ids()?;
        let mut bytes = 0u64;
        let mut found = None;
        for id in ids {
            let file = store
                .directory
                .open_single_link_regular_file(OsStr::new(&job_file(&id)?))?;
            bytes = bytes
                .checked_add(file.metadata()?.len())
                .ok_or_else(|| anyhow::anyhow!("history_resource_parent_unknown"))?;
            ensure!(bytes <= 64 * 1024 * 1024, "history_resource_parent_unknown");
            let identity = store.directory.portable_regular_handle_identity(&file)?;
            let job = store
                .load(&id)
                .map_err(|_| anyhow::anyhow!("history_resource_parent_unknown"))?;
            ensure!(
                store
                    .directory
                    .portable_regular_identity(OsStr::new(&job_file(&id)?))?
                    == identity,
                "history_resource_parent_unknown"
            );
            let Some(batch) = job.batch.as_ref() else {
                continue;
            };
            for action in &batch.actions {
                let BatchActionKind::History { plan } = &action.action else {
                    continue;
                };
                if plan.history_job_id != child {
                    continue;
                }
                ensure!(
                    found.is_none() && action.item_ids.len() == 1,
                    "history_resource_parent_unknown"
                );
                let BatchSource::History(source) = batch.source_for(&action.item_ids[0])? else {
                    anyhow::bail!("history_resource_parent_unknown")
                };
                let original =
                    selection.ok_or_else(|| anyhow::anyhow!("history_resource_parent_unknown"))?;
                ensure!(
                    plan.normalization_revision == revision
                        && source.revision() == revision
                        && plan.source_fingerprint == source.identity()
                        && source.selection().selection_identity()?
                            == original.selection_identity()?,
                    "history_resource_parent_unknown"
                );
                found = Some(HistoryResourceParent {
                    owner: job.job_id.clone(),
                    members: batch
                        .actions
                        .iter()
                        .filter_map(|action| match &action.action {
                            BatchActionKind::History { plan } => Some(plan.history_job_id.clone()),
                            _ => None,
                        })
                        .collect(),
                    initial_limits: batch.resource_limits.clone(),
                });
            }
        }
        Ok(found)
    }
}
