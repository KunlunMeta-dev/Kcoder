//! A complete run selector is only an identity fence, never caller authority.
use super::workspace_registry::NativeSessionLeaseWitness;
use super::*;
use kcoder_app_protocol::{AgentStreamCloseReason, AgentStreamClosedParams};
use kcoder_types::BackgroundRunKey;

#[derive(Debug)]
pub(super) struct ExactRunUnavailable(pub(super) AgentStreamCloseReason);
impl std::fmt::Display for ExactRunUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self.0 {
            AgentStreamCloseReason::RunChanged => "agent_run_identity_conflict",
            AgentStreamCloseReason::OwnerUnavailable => "agent_exact_run_unavailable",
        })
    }
}
impl std::error::Error for ExactRunUnavailable {}
fn unavailable() -> anyhow::Error {
    ExactRunUnavailable(AgentStreamCloseReason::OwnerUnavailable).into()
}
fn changed() -> anyhow::Error {
    ExactRunUnavailable(AgentStreamCloseReason::RunChanged).into()
}

pub(super) fn verify_state(
    engine: &QueryEngine,
    thread: &str,
    agent: &str,
    expected: Option<&BackgroundRunKey>,
) -> Result<()> {
    let Some(expected) = expected else {
        return Ok(());
    };
    if expected.parent_session_id != thread
        || expected.agent_id != agent
        || engine.session_id() != thread
    {
        return Err(changed());
    }
    engine
        .ensure_subagent_run_current(expected)
        .map_err(|_| changed())
}
pub(super) fn response_code(error: &anyhow::Error, fallback: i64) -> i64 {
    if error.downcast_ref::<ExactRunUnavailable>().is_some() {
        -32038
    } else {
        fallback
    }
}
/// Weak original lock ownership does not extend the resident lifetime.
pub(super) struct AgentRunObservation {
    expected: BackgroundRunKey,
    owner: NativeSessionLeaseWitness,
}
impl AgentRunObservation {
    pub(super) fn capture(
        engine: &QueryEngine,
        lease: &SessionLease,
        thread: &str,
        agent: &str,
        expected: &BackgroundRunKey,
    ) -> Result<Self> {
        ensure_active_thread(engine, Some(lease), thread).map_err(|_| unavailable())?;
        verify_state(engine, thread, agent, Some(expected))?;
        let owner = lease.native_witness().map_err(|_| unavailable())?;
        let observation = Self {
            expected: expected.clone(),
            owner,
        };
        observation.verify(engine)?;
        Ok(observation)
    }
    pub(super) fn verify(&self, engine: &QueryEngine) -> Result<()> {
        self.owner
            .verify_target(&engine.session_lease_target())
            .map_err(|_| unavailable())?;
        verify_state(
            engine,
            &self.expected.parent_session_id,
            &self.expected.agent_id,
            Some(&self.expected),
        )
    }
    pub(super) fn closed(
        &self,
        subscription_id: &str,
        error: &anyhow::Error,
    ) -> AgentStreamClosedParams {
        AgentStreamClosedParams {
            thread_id: self.expected.parent_session_id.clone(),
            agent_id: self.expected.agent_id.clone(),
            subscription_id: subscription_id.into(),
            expected_background_run: self.expected.clone(),
            reason_code: error
                .downcast_ref::<ExactRunUnavailable>()
                .map(|e| e.0.clone())
                .unwrap_or(AgentStreamCloseReason::OwnerUnavailable),
        }
    }
}

pub(super) fn verify_artifact(
    engine: &QueryEngine,
    params: &kcoder_app_protocol::AgentArtifactReadParams,
) -> Result<()> {
    let Some(expected) = params.expected_background_run.as_ref() else {
        return Ok(());
    };
    verify_state(engine, &params.thread_id, &params.agent_id, Some(expected))?;
    // Legacy public transcript projections carry no native run identity. The
    // exact viewer reads its registered structured stream instead.
    if params.kind == Some(kcoder_app_protocol::AgentArtifactKind::Transcript) {
        return Err(unavailable());
    }
    let task = engine.state.task(&params.agent_id).ok_or_else(changed)?;
    let legacy = engine.state.subagent_output_path(&params.agent_id);
    let path = legacy
        .parent()
        .ok_or_else(unavailable)?
        .join("runs")
        .join(&expected.run_id)
        .join("output.md");
    if task.output_path.as_ref().map(|p| dunce::simplified(p)) != Some(dunce::simplified(&path)) {
        return Err(unavailable());
    }
    Ok(())
}

#[cfg(test)]
#[path = "agent_run_constraint/tests.rs"]
mod tests;
