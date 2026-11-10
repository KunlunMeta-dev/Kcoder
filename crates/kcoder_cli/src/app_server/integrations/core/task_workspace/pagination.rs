use super::*;
use anyhow::{Context, ensure};
use source::Collected;
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
const MAX_SNAPSHOTS: usize = 8;
const TTL: Duration = Duration::from_secs(120);
struct Snapshot {
    born: Instant,
    scope: IntegrationScope,
    fence: String,
    observation: Collected,
    enrichment: enrichment::ObservedEnrichment,
    task_capability_scope_target: Option<IntegrationTaskCapabilityScopeControlTarget>,
}
#[derive(Default)]
pub(super) struct ObservationPages {
    snapshots: BTreeMap<String, Snapshot>,
}
impl ObservationPages {
    pub(super) fn start(
        &mut self,
        scope: IntegrationScope,
        observation: Collected,
        fence: &str,
        task_capability_scope_target: Option<IntegrationTaskCapabilityScopeControlTarget>,
        enrichment: enrichment::ObservedEnrichment,
        cancel: &CancellationToken,
    ) -> Result<TaskWorkspaceSnapshot> {
        ensure!(!cancel.is_cancelled(), "TASK_WORKSPACE_CANCELLED");
        ensure!(
            enrichment.task_capability_scope_target.is_none()
                || enrichment.task_capability_scope_target == task_capability_scope_target,
            "TASK_WORKSPACE_SCOPE_TARGET_CHANGED"
        );
        ensure!(observation.entries.len() <= 1024, "TASK_WORKSPACE_CAPACITY");
        self.snapshots
            .retain(|_, snapshot| snapshot.born.elapsed() < TTL);
        if self.snapshots.len() >= MAX_SNAPSHOTS {
            let oldest = self
                .snapshots
                .iter()
                .min_by_key(|(_, snapshot)| snapshot.born)
                .map(|(key, _)| key.clone());
            if let Some(key) = oldest {
                self.snapshots.remove(&key);
            }
        }
        let id = format!("task-observation-{}", uuid::Uuid::new_v4());
        self.snapshots.insert(
            id.clone(),
            Snapshot {
                born: Instant::now(),
                scope: scope.clone(),
                fence: fence.into(),
                observation,
                enrichment,
                task_capability_scope_target,
            },
        );
        self.result(&id, 0)
    }
    pub(super) fn page(
        &self,
        scope: &IntegrationScope,
        thread: &str,
        cursor: &str,
        fence: &str,
        task_capability_scope_target: Option<&IntegrationTaskCapabilityScopeControlTarget>,
        cancel: &CancellationToken,
    ) -> Result<TaskWorkspaceSnapshot> {
        ensure!(!cancel.is_cancelled(), "TASK_WORKSPACE_CANCELLED");
        let (id, offset) = cursor
            .rsplit_once(':')
            .context("TASK_WORKSPACE_CURSOR_INVALID")?;
        let offset: usize = offset.parse().context("TASK_WORKSPACE_CURSOR_INVALID")?;
        let snapshot = self
            .snapshots
            .get(id)
            .context("TASK_WORKSPACE_CURSOR_EXPIRED")?;
        ensure!(
            snapshot.born.elapsed() < TTL
                && snapshot.scope == *scope
                && snapshot.fence == fence
                && snapshot.task_capability_scope_target.as_ref() == task_capability_scope_target
                && snapshot.observation.thread.reference.thread_id() == thread
                && offset > 0
                && offset.is_multiple_of(TASK_WORKSPACE_PAGE_SIZE)
                && offset < snapshot.observation.entries.len(),
            "TASK_WORKSPACE_CURSOR_INVALID"
        );
        self.result(id, offset)
    }
    fn result(&self, id: &str, offset: usize) -> Result<TaskWorkspaceSnapshot> {
        let saved = self
            .snapshots
            .get(id)
            .context("TASK_WORKSPACE_CURSOR_EXPIRED")?;
        let view = &saved.observation;
        let end = (offset + TASK_WORKSPACE_PAGE_SIZE).min(view.entries.len());
        let mut facets = view.facets.clone();
        if saved.task_capability_scope_target.is_some() {
            for facet in &mut facets {
                match facet.kind {
                    TaskWorkspaceFacetKind::Sources => {
                        facet.availability =
                            if saved.enrichment.task_capability_scope_selection.is_some() {
                                TaskWorkspaceAvailability::Available
                            } else {
                                TaskWorkspaceAvailability::Unknown
                            };
                        facet.observed_count = saved
                            .enrichment
                            .task_capability_scope_selection
                            .as_ref()
                            .map(|source| source.effective_sources.len() as u64);
                        facet.reason_code = saved
                            .enrichment
                            .task_capability_scope_reason
                            .or_else(|| {
                                saved
                                    .enrichment
                                    .task_capability_scope_selection
                                    .is_none()
                                    .then_some("TASK_WORKSPACE_SCOPE_UNCONFIRMED")
                            })
                            .map(str::to_owned);
                    }
                    TaskWorkspaceFacetKind::Runtime => {
                        facet.availability = if saved.enrichment.runtime.is_some() {
                            TaskWorkspaceAvailability::Available
                        } else {
                            TaskWorkspaceAvailability::Unknown
                        };
                        facet.observed_count = saved.enrichment.runtime.as_ref().map(|_| 1);
                        facet.reason_code = saved
                            .enrichment
                            .runtime_reason
                            .or_else(|| {
                                saved
                                    .enrichment
                                    .runtime
                                    .is_none()
                                    .then_some("TASK_WORKSPACE_RUNTIME_UNCONFIRMED")
                            })
                            .map(str::to_owned);
                    }
                    _ => {}
                }
            }
        }
        let snapshot = TaskWorkspaceSnapshot {
            schema_version: 1,
            scope: saved.scope.clone(),
            snapshot_id: id.into(),
            observed_at_ms: view.observed_at_ms,
            thread: view.thread.clone(),
            entries: view.entries[offset..end].to_vec(),
            facets,
            artifact_refs: view.artifacts.clone(),
            runtime: saved.enrichment.runtime.clone(),
            task_capability_scope_selection: saved
                .enrichment
                .task_capability_scope_selection
                .clone(),
            task_capability_scope_target: saved.task_capability_scope_target.clone(),
            next_cursor: (end < view.entries.len()).then(|| format!("{id}:{end}")),
        };
        snapshot.validate()?;
        Ok(snapshot)
    }
}
