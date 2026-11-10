//! Current-owner CAS precedes release of the original resident runtime.
use super::*;
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{
    ThreadRuntimeHandoffReadParams, ThreadRuntimeHandoffReadResult, ThreadRuntimeHandoffReceipt,
    ThreadRuntimeHandoffReleaseParams, ThreadRuntimeHandoffSnapshot, ThreadRuntimeHandoffStatus,
};

#[derive(Default)]
pub(in crate::app_server) struct RuntimeHandoffReceipts {
    rows: HashMap<
        String,
        (
            ThreadRuntimeHandoffReleaseParams,
            ThreadRuntimeHandoffReceipt,
        ),
    >,
}
pub(in crate::app_server) enum HandoffBegin {
    Reply(ThreadRuntimeHandoffReceipt),
    Reserved(kcoder_engine::BackgroundWorkIdleReservation),
}
fn receipt(
    p: &ThreadRuntimeHandoffReleaseParams,
    status: ThreadRuntimeHandoffStatus,
    code: Option<&str>,
) -> ThreadRuntimeHandoffReceipt {
    ThreadRuntimeHandoffReceipt {
        server_id: p.expected_server_id.clone(),
        thread_id: p.thread_id.clone(),
        operation_id: p.operation_id.clone(),
        owner_ref: p.expected_owner_ref.clone(),
        status,
        reason_code: code.map(str::to_string),
    }
}
impl ThreadManager {
    pub(in crate::app_server) fn handoff_snapshot(
        &self,
        thread: &str,
        server: &str,
    ) -> ThreadRuntimeHandoffSnapshot {
        let runtime = self.runtimes.get(thread);
        ThreadRuntimeHandoffSnapshot {
            server_id: server.into(),
            thread_id: thread.into(),
            owner_ref: runtime.map(|r| r.handoff_ref.clone()),
            client_turn_count: runtime
                .and_then(|r| r.background_followups.client_turn_count.get())
                .map(|n| n as u64),
            releasable: runtime.is_some_and(|r| {
                !r.ephemeral
                    && r.is_evictable()
                    && r.background_followups.client_turn_count.get().is_some()
                    && r.engine.state.history_path().is_some()
                    && r.engine
                        .settings
                        .try_read()
                        .is_ok_and(|s| s.history_enabled)
            }),
        }
    }
    pub(in crate::app_server) fn handoff_read(
        &self,
        p: &ThreadRuntimeHandoffReadParams,
        server: &str,
    ) -> Result<ThreadRuntimeHandoffReadResult> {
        crate::app_server::transcript_projection::validate_thread_id(&p.thread_id)?;
        let operation = p
            .operation_id
            .as_ref()
            .map(|id| {
                ensure!(
                    kcoder_app_protocol::valid_thread_handoff_reference(id),
                    "THREAD_HANDOFF_OPERATION_INVALID"
                );
                let row = self.handoffs.rows.get(id);
                ensure!(
                    row.is_none_or(|(request, _)| request.thread_id == p.thread_id),
                    "THREAD_HANDOFF_OPERATION_MISMATCH"
                );
                Ok::<_, anyhow::Error>(row.map(|(_, receipt)| receipt.clone()))
            })
            .transpose()?
            .flatten();
        Ok(ThreadRuntimeHandoffReadResult {
            snapshot: self.handoff_snapshot(&p.thread_id, server),
            operation,
        })
    }
    pub(in crate::app_server) fn begin_handoff(
        &mut self,
        p: &ThreadRuntimeHandoffReleaseParams,
        server: &str,
        resources_idle: bool,
    ) -> Result<HandoffBegin> {
        ensure!(p.is_valid(), "THREAD_HANDOFF_REQUEST_INVALID");
        crate::app_server::transcript_projection::validate_thread_id(&p.thread_id)?;
        if p.expected_server_id != server {
            return Ok(HandoffBegin::Reply(receipt(
                p,
                ThreadRuntimeHandoffStatus::Unknown,
                Some("THREAD_HANDOFF_SERVER_CHANGED"),
            )));
        }
        if let Some((request, original)) = self.handoffs.rows.get(&p.operation_id) {
            ensure!(request == p, "THREAD_HANDOFF_OPERATION_MISMATCH");
            return Ok(HandoffBegin::Reply(original.clone()));
        }
        ensure!(
            self.handoffs.rows.len() < 256,
            "THREAD_HANDOFF_RECEIPT_CAPACITY"
        );
        if !resources_idle {
            return Ok(self.reject_handoff(p, "THREAD_HANDOFF_RESOURCES_BUSY"));
        }
        let reason =
            self.runtimes
                .get(&p.thread_id)
                .map_or(Some("THREAD_HANDOFF_OWNER_CHANGED"), |r| {
                    if r.handoff_ref != p.expected_owner_ref {
                        Some("THREAD_HANDOFF_OWNER_CHANGED")
                    } else if r.ephemeral {
                        Some("THREAD_HANDOFF_PERSISTENT_TASK_REQUIRED")
                    } else if r
                        .background_followups
                        .client_turn_count
                        .get()
                        .map(|n| n as u64)
                        != Some(p.expected_client_turn_count)
                    {
                        Some("THREAD_HANDOFF_TURN_CHANGED")
                    } else {
                        None
                    }
                });
        if let Some(code) = reason {
            return Ok(self.reject_handoff(p, code));
        }
        let runtime = self
            .runtimes
            .get(&p.thread_id)
            .context("THREAD_HANDOFF_OWNER_CHANGED")?;
        runtime.turn_state.stop_accepting_turns();
        let reserved = runtime.engine.try_reserve_background_work_idle();
        if !runtime.is_evictable() || reserved.is_none() {
            drop(reserved);
            runtime.turn_state.resume_accepting_turns();
            return Ok(self.reject_handoff(p, "THREAD_HANDOFF_BUSY"));
        }
        // The original admissions are held closed while committing its checkpoint.
        // Failure reopens them; no replacement Engine or lease is constructed.
        if validate_checkpoint(runtime).is_err() {
            drop(reserved);
            runtime.turn_state.resume_accepting_turns();
            return Ok(self.reject_handoff(p, "THREAD_HANDOFF_HISTORY_UNAVAILABLE"));
        }
        self.handoffs.rows.insert(
            p.operation_id.clone(),
            (
                p.clone(),
                receipt(p, ThreadRuntimeHandoffStatus::Unknown, None),
            ),
        );
        Ok(HandoffBegin::Reserved(reserved.unwrap()))
    }
    fn reject_handoff(
        &mut self,
        p: &ThreadRuntimeHandoffReleaseParams,
        code: &str,
    ) -> HandoffBegin {
        let result = receipt(p, ThreadRuntimeHandoffStatus::Rejected, Some(code));
        self.handoffs
            .rows
            .insert(p.operation_id.clone(), (p.clone(), result.clone()));
        HandoffBegin::Reply(result)
    }
    pub(in crate::app_server) fn abort_handoff(
        &mut self,
        p: &ThreadRuntimeHandoffReleaseParams,
        reason: &'static str,
    ) -> Result<ThreadRuntimeHandoffReceipt> {
        let runtime = self
            .runtimes
            .get(&p.thread_id)
            .context("THREAD_HANDOFF_OWNER_CHANGED")?;
        ensure!(
            runtime.handoff_ref == p.expected_owner_ref,
            "THREAD_HANDOFF_OWNER_CHANGED"
        );
        runtime.turn_state.resume_accepting_turns();
        let result = receipt(p, ThreadRuntimeHandoffStatus::Rejected, Some(reason));
        self.handoffs
            .rows
            .insert(p.operation_id.clone(), (p.clone(), result.clone()));
        Ok(result)
    }
    pub(in crate::app_server) async fn flush_handoff(
        &self,
        p: &ThreadRuntimeHandoffReleaseParams,
    ) -> Result<()> {
        let runtime = self
            .runtimes
            .get(&p.thread_id)
            .context("THREAD_HANDOFF_OWNER_CHANGED")?;
        ensure!(
            runtime.handoff_ref == p.expected_owner_ref,
            "THREAD_HANDOFF_OWNER_CHANGED"
        );
        runtime.engine.state.flush_history().await?;
        validate_checkpoint(runtime)
    }
    pub(in crate::app_server) fn commit_handoff(
        &mut self,
        p: &ThreadRuntimeHandoffReleaseParams,
        reserved: kcoder_engine::BackgroundWorkIdleReservation,
    ) -> Result<Box<ThreadRuntime>> {
        let runtime = self
            .runtimes
            .get(&p.thread_id)
            .context("THREAD_HANDOFF_OWNER_CHANGED")?;
        ensure!(
            runtime.handoff_ref == p.expected_owner_ref,
            "THREAD_HANDOFF_OWNER_CHANGED"
        );
        reserved.commit();
        if self.active_thread_id.as_deref() == Some(p.thread_id.as_str()) {
            self.active_thread_id = None;
        }
        Ok(Box::new(
            self.runtimes
                .remove(&p.thread_id)
                .context("THREAD_HANDOFF_OWNER_CHANGED")?,
        ))
    }
    pub(in crate::app_server) fn finish_handoff(
        &mut self,
        p: &ThreadRuntimeHandoffReleaseParams,
    ) -> Result<ThreadRuntimeHandoffReceipt> {
        let (original, result) = self
            .handoffs
            .rows
            .get_mut(&p.operation_id)
            .context("THREAD_HANDOFF_RECEIPT_MISSING")?;
        ensure!(original == p, "THREAD_HANDOFF_OPERATION_MISMATCH");
        result.status = ThreadRuntimeHandoffStatus::Released;
        Ok(result.clone())
    }
}
fn validate_checkpoint(runtime: &ThreadRuntime) -> Result<()> {
    ensure!(
        runtime
            .engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("THREAD_HANDOFF_SETTINGS_UNAVAILABLE"))?
            .history_enabled,
        "THREAD_HANDOFF_HISTORY_REQUIRED"
    );
    let path = runtime
        .engine
        .state
        .history_path()
        .context("THREAD_HANDOFF_HISTORY_REQUIRED")?;
    ensure!(
        runtime
            .lease
            .matches_target(&runtime.engine.session_lease_target())
            && runtime.lease.matches_target(&path),
        "THREAD_HANDOFF_LEASE_CHANGED"
    );
    runtime
        .lease
        .native_witness()?
        .verify_target(runtime.lease.target())?;
    // Do not materialize a missing task merely to make it eligible for transfer.
    let metadata = std::fs::symlink_metadata(&path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "THREAD_HANDOFF_HISTORY_REQUIRED"
    );
    let cwd = runtime.engine.state.base_cwd().canonicalize()?;
    // An invalid original checkpoint is an error, never permission to repair it
    // from an in-memory projection while transferring ownership.
    let prior = kcoder_state::prepare_session_resume(&path)?;
    ensure!(
        prior
            .persisted_base_cwd()
            .is_some_and(|p| p.canonicalize().is_ok_and(|p| p == cwd)),
        "THREAD_HANDOFF_WORKSPACE_CHANGED"
    );
    Ok(())
}

#[cfg(test)]
mod tests;
