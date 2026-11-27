//! Connection-owned idle view protection with bounded, monotonic expiry.
use super::*;
use kcoder_migration::history_view::{
    HistoryViewLeaseObservation, HistoryViewLeaseState, HistoryViewLeases,
};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
mod cursor;

pub(in super::super) struct ViewWorkers {
    leases: HistoryViewLeases,
    cancellation: CancellationToken,
    timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
    cursor: cursor::Cursor,
}

impl ViewWorkers {
    pub(in super::super) fn new(parent: CancellationToken) -> Self {
        Self {
            leases: HistoryViewLeases::default(),
            cancellation: parent.child_token(),
            timer: Mutex::new(None),
            cursor: cursor::Cursor::default(),
        }
    }

    fn timer(&self) -> Result<()> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "history_view_connection_closed"
        );
        let mut timer = self
            .timer
            .lock()
            .map_err(|_| anyhow::anyhow!("history_view_unavailable"))?;
        if timer.is_some() {
            return Ok(());
        }
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| anyhow::anyhow!("history_view_runtime_unavailable"))?;
        let cancellation = self.cancellation.clone();
        let leases = self.leases.clone();
        *timer = Some(runtime.spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(250));
            loop {
                tokio::select! {
                    _ = cancellation.cancelled() => break,
                    _ = tick.tick() => if leases.expire().is_err() { break },
                }
            }
            leases.clear();
        }));
        Ok(())
    }

    pub(in super::super) async fn shutdown(&self) {
        self.cancellation.cancel();
        self.leases.clear();
        let task = self
            .timer
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }
    pub(in super::super) fn seal_page(&self, profile: &Path, after: &str) -> Result<String> {
        self.cursor.seal(profile, after)
    }
    pub(in super::super) fn open_page(&self, profile: &Path, cursor: &str) -> Result<String> {
        self.cursor.open(profile, cursor)
    }
}

pub(super) fn handles(method: &str) -> bool {
    matches!(
        method,
        method::MIGRATION_HISTORY_VIEW_OPEN
            | method::MIGRATION_HISTORY_VIEW_READ
            | method::MIGRATION_HISTORY_VIEW_RENEW
            | method::MIGRATION_HISTORY_VIEW_RELEASE
    )
}

fn project(value: HistoryViewLeaseObservation) -> MigrationHistoryViewLease {
    MigrationHistoryViewLease {
        request_id: value.request_id,
        lease_id: value.lease_id,
        job_id: value.binding.job_id,
        archive_id: value.binding.archive_id,
        normalization_revision: value.binding.normalization_revision,
        view_id: value.binding.view_id,
        sequence: value.sequence,
        remaining_ms: value.remaining_ms,
        managed_archives: value.binding.managed_archives as u32,
        legacy_archives: value.binding.legacy_archives as u32,
        state: match value.state {
            HistoryViewLeaseState::Active => MigrationHistoryViewState::Active,
            HistoryViewLeaseState::Released => MigrationHistoryViewState::Released,
            HistoryViewLeaseState::Expired => MigrationHistoryViewState::Expired,
            HistoryViewLeaseState::Invalidated => MigrationHistoryViewState::Invalidated,
        },
    }
}

pub(super) fn execute(
    processor: &MigrationProcessor,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    let leases = &processor.views.leases;
    let lease = match operation {
        method::MIGRATION_HISTORY_VIEW_OPEN => {
            let params: MigrationHistoryViewOpenParams = decode(params)?;
            processor.views.timer()?;
            Some(leases.open(
                profile,
                &params.request_id,
                &params.job_id,
                &params.expected_archive_id,
                params.view_id.as_deref(),
            )?)
        }
        method::MIGRATION_HISTORY_VIEW_READ => {
            let params: MigrationHistoryViewReadParams = decode(params)?;
            leases.read(profile, &params.request_id, params.lease_id.as_deref())?
        }
        method::MIGRATION_HISTORY_VIEW_RENEW => {
            let params: MigrationHistoryViewRenewParams = decode(params)?;
            Some(leases.renew(
                profile,
                &params.request_id,
                &params.lease_id,
                params.expected_sequence,
            )?)
        }
        method::MIGRATION_HISTORY_VIEW_RELEASE => {
            let params: MigrationHistoryViewReleaseParams = decode(params)?;
            leases.release(profile, &params.request_id, &params.lease_id)?
        }
        _ => anyhow::bail!("history_view_unknown_method"),
    };
    Ok(serde_json::to_value(MigrationHistoryViewResult {
        lease: lease.map(project),
    })?)
}
