//! Received data enters ordinary preview batches only through its original target authority.
use super::super::MigrationHost;
use super::*;
use kcoder_app_protocol::{
    MigrationSourceAdoptionCancelV1, MigrationSourceAdoptionPrepareV1,
    MigrationSourceAdoptionReadV1, MigrationSourceAdoptionResumeV1, MigrationSourceReceivedReadV1,
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

pub(in super::super) struct AdoptionWorkers {
    cancellation: CancellationToken,
    tasks: Mutex<JoinSet<()>>,
    running: Arc<AtomicUsize>,
}
struct Count(Arc<AtomicUsize>);
impl Drop for Count {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
impl AdoptionWorkers {
    pub(in super::super) fn new(cancellation: CancellationToken) -> Self {
        Self {
            cancellation,
            tasks: Mutex::new(JoinSet::new()),
            running: Arc::new(AtomicUsize::new(0)),
        }
    }
    pub(in super::super) fn activity(&self) -> usize {
        self.running.load(Ordering::Acquire)
    }
    fn start(
        &self,
        peer: AuthorizedMigrationPeer,
        owner: ReceivedAdoptionLease,
        factory: Arc<dyn MigrationHost>,
        project: Option<ReceivedProjectTarget>,
    ) -> Result<()> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "source_transfer_adoption_interrupted"
        );
        peer.validate()?;
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("source_transfer_busy"))?;
        while tasks.try_join_next().is_some() {}
        ensure!(
            self.activity() < 2,
            "source_transfer_adoption_worker_capacity"
        );
        self.running.fetch_add(1, Ordering::AcqRel);
        let count = Count(self.running.clone());
        let cancellation = self.cancellation.clone();
        tasks.spawn_blocking(move || {
            let _count = count;
            if let Ok(target) = target(&peer) {
                let _ = target.execute_adoption(owner, |_| {
                    !cancellation.is_cancelled()
                        && peer.validate().is_ok()
                        && project_matches(factory.as_ref(), peer.profile(), project.as_ref())
                            .is_ok()
                });
            }
        });
        Ok(())
    }
    pub(in super::super) async fn shutdown(&self) {
        self.cancellation.cancel();
        let mut tasks = {
            let mut guard = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut *guard)
        };
        while !tasks.is_empty() {
            let _ = tokio::time::timeout(std::time::Duration::from_millis(100), tasks.join_next())
                .await;
        }
    }
}
fn project_matches(
    factory: &dyn MigrationHost,
    profile: &std::path::Path,
    expected: Option<&ReceivedProjectTarget>,
) -> Result<()> {
    if let Some(expected) = expected {
        let actual = factory
            .migration_source_roots()?
            .project
            .context("source_transfer_project_mapping_required")?;
        ensure!(
            ReceivedProjectTarget::capture(profile, &actual)? == *expected,
            "source_transfer_project_mapping_changed"
        );
    }
    Ok(())
}

pub(in super::super) fn execute(
    processor: &MigrationProcessor,
    peer: &AuthorizedMigrationPeer,
    factory: Arc<dyn MigrationHost>,
    operation: &str,
    value: Value,
) -> Result<Value> {
    peer.validate()?;
    ensure!(
        peer.role() == "target" && peer.permits(operation),
        "source_transfer_role_mismatch"
    );
    let target = target(peer)?;
    let result = match operation {
        "target/received/read" => {
            let value: MigrationSourceReceivedReadV1 = params(peer, value)?;
            let page = target.received_sources(
                peer.request_id(),
                &value.manifest_sha256,
                value.page_index,
            )?;
            ensure!(
                value.include_projects
                    || page
                        .items
                        .iter()
                        .all(|item| item.class != ReceivedSourceClass::Project),
                "source_transfer_projects_update_required"
            );
            ensure!(
                value.include_plugins
                    || page
                        .items
                        .iter()
                        .all(|item| item.class != ReceivedSourceClass::Plugin),
                "source_transfer_plugins_update_required"
            );
            ensure!(
                value.include_instructions
                    || page
                        .items
                        .iter()
                        .all(|item| item.class != ReceivedSourceClass::Instructions),
                "source_transfer_scoped_instructions_update_required"
            );
            let items = page.items.into_iter().map(|item| {
                let class=match item.class { ReceivedSourceClass::Project => "project", ReceivedSourceClass::Configuration => "configuration", ReceivedSourceClass::WorkAsset => "work_asset", ReceivedSourceClass::History => "history", ReceivedSourceClass::Plugin => "plugin", ReceivedSourceClass::Instructions => "instructions" };
                let mut value=json!({
                "entryId":item.entry_id, "source":item.source,
                "class":class,
                "category":item.category, "projectScoped":item.project_scoped, "files":item.files, "bytes":item.bytes,
            });
                if let Some(project)=item.project { value["project"]=serde_json::to_value(project)?; }
                Ok(value)}).collect::<Result<Vec<_>>>()?;
            json!({"receipt":page.receipt,"items":items,"totalSources":page.total_sources,"nextPage":page.next_page})
        }
        "target/adoption/prepare" => {
            let value: MigrationSourceAdoptionPrepareV1 = params(peer, value)?;
            let needs_project = value
                .selections
                .iter()
                .any(|selection| selection.project_mapping.is_some())
                || !value.instruction_mappings.is_empty();
            let project = if needs_project {
                Some(ReceivedProjectTarget::capture(
                    peer.profile(),
                    &factory
                        .migration_source_roots()?
                        .project
                        .context("source_transfer_project_mapping_required")?,
                )?)
            } else {
                None
            };
            let selections = serde_json::from_value(serde_json::to_value(value.selections)?)?;
            ensure!(
                value.instruction_mappings.len() <= 64
                    && value
                        .instruction_mappings
                        .iter()
                        .map(|mapping| mapping.items.len())
                        .sum::<usize>()
                        <= 128,
                "source_transfer_instruction_mapping_invalid"
            );
            let mappings = value
                .instruction_mappings
                .iter()
                .map(|mapping| {
                    let items = mapping
                        .items
                        .iter()
                        .map(|item| (item.item_id.clone(), item.target_relative_scope.clone()))
                        .collect::<Vec<_>>();
                    ReceivedInstructionAdoptionMapping::capture(
                        peer.profile(),
                        project
                            .as_ref()
                            .context("source_transfer_project_mapping_required")?,
                        &mapping.entry_id,
                        &items,
                        mapping.archive_incomplete_chain,
                    )
                })
                .collect::<Result<Vec<_>>>()?;
            let (state, lease) = target.prepare_adoption_with_instructions(
                peer.request_id(),
                &value.adoption_id,
                &value.manifest_sha256,
                selections,
                project.clone(),
                mappings,
            )?;
            if let Some(lease) = lease {
                processor
                    .source_adoption_workers
                    .start(peer.clone(), lease, factory, project)?;
            }
            json!({"state":state})
        }
        "target/adoption/read" => {
            let value: MigrationSourceAdoptionReadV1 = params(peer, value)?;
            json!({"state":target.read_adoption(peer.request_id(), &value.adoption_id)?})
        }
        "target/adoption/cancel" => {
            let value: MigrationSourceAdoptionCancelV1 = params(peer, value)?;
            json!({"state":target.cancel_adoption(peer.request_id(), &value.adoption_id, &value.command_id)?})
        }
        "target/adoption/resume" => {
            let value: MigrationSourceAdoptionResumeV1 = params(peer, value)?;
            let project = target.adoption_project(peer.request_id(), &value.adoption_id)?;
            project_matches(factory.as_ref(), peer.profile(), project.as_ref())?;
            let expected = ReceivedAdoptionControl {
                sequence: value.expected_control.sequence,
                cancel_watermark: value.expected_control.cancel_watermark,
            };
            let (state, lease) =
                target.resume_adoption(peer.request_id(), &value.adoption_id, expected)?;
            processor
                .source_adoption_workers
                .start(peer.clone(), lease, factory, project)?;
            json!({"state":state})
        }
        _ => anyhow::bail!("source_transfer_method_unavailable"),
    };
    peer.validate()?;
    Ok(result)
}
