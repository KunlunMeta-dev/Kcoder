//! Exact-run observations are restricted to native registered producer streams.
use crate::{
    QueryEngine,
    agent_conversation_stream::{AgentConversationSubscription, AgentExactLiveRead},
};
use anyhow::{Result, ensure};
use kcoder_types::BackgroundRunKey;

impl QueryEngine {
    /// A selector is not authority. The actual State must still own this run.
    pub fn ensure_subagent_run_current(&self, expected: &BackgroundRunKey) -> Result<()> {
        ensure!(
            !expected.run_id.is_empty()
                && expected.run_id.len() <= 128
                && expected
                    .run_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                && !expected.agent_id.is_empty()
                && expected.agent_id.len() <= 256
                && expected.parent_session_id == self.session_id()
                && self
                    .state
                    .task(&expected.agent_id)
                    .is_some_and(|task| task.kind == kcoder_state::TaskKind::Subagent
                        && task.parent_session_id.as_deref()
                            == Some(expected.parent_session_id.as_str())
                        && task.background_run.as_ref() == Some(expected)),
            "agent_run_identity_conflict"
        );
        Ok(())
    }

    /// Does not initialize or relabel a legacy Message[] checkpoint as a run.
    /// Completed registered streams remain readable while the same State run is current.
    pub fn subscribe_subagent_conversation_for_run(
        &self,
        expected: &BackgroundRunKey,
    ) -> Result<AgentConversationSubscription> {
        self.ensure_subagent_run_current(expected)?;
        let subscription = self
            .background_jobs
            .live_views
            .subscribe_registered_run(&expected.agent_id, &expected.run_id)
            .ok_or_else(|| anyhow::anyhow!("agent_exact_run_unavailable"))?;
        self.ensure_subagent_run_current(expected)?;
        Ok(subscription)
    }

    pub fn subagent_public_live_tail_for_run(
        &self,
        expected: &BackgroundRunKey,
        previous: Option<u64>,
    ) -> Result<AgentExactLiveRead> {
        let snapshot = self
            .subscribe_subagent_conversation_for_run(expected)?
            .snapshot;
        let unchanged = snapshot.active && previous == Some(snapshot.sequence);
        let start = snapshot.entries.len().saturating_sub(16);
        let messages = snapshot.entries[start..]
            .iter()
            .map(|entry| entry.message.clone())
            .collect::<Vec<_>>();
        let bytes = if unchanged {
            Vec::new()
        } else {
            crate::subagent_boundary_runtime::public_subagent_transcript(&messages)?
        };
        let mut offset = bytes.len().saturating_sub(64 * 1024);
        while offset < bytes.len() && bytes[offset] & 0xc0 == 0x80 {
            offset += 1;
        }
        self.ensure_subagent_run_current(expected)?;
        Ok(AgentExactLiveRead {
            active: snapshot.active,
            revision: snapshot.sequence,
            status: snapshot.status,
            content: std::str::from_utf8(&bytes[offset..])?.to_owned(),
            truncated: snapshot.truncated || start > 0 || offset > 0,
            unchanged,
        })
    }
}

#[cfg(test)]
#[path = "exact_run/tests.rs"]
mod tests;
