use super::*;

pub(crate) struct SideQuestionCacheBinding {
    pub(crate) owner: kcoder_state::AppStateLifecycleIdentity,
    pub(crate) snapshot: std::sync::Weak<crate::agent::CacheSafeParams>,
}

impl QueryEngine {
    pub(crate) fn with_project_user_context_from(mut self, parent: &Self) -> anyhow::Result<Self> {
        self.project_user_context = Arc::clone(&parent.project_user_context);
        self.project_instruction_facts = Arc::clone(&parent.project_instruction_facts);
        parent.capture_imported_context_snapshot()?;
        self.state
            .inherit_imported_context_snapshot(&parent.state)?;
        Ok(self)
    }

    pub fn last_cache_safe_params(&self) -> Option<crate::agent::CacheSafeParams> {
        self.cache_safe_snapshot()
            .map(|snapshot| snapshot.as_ref().clone())
    }

    /// Share an immutable request-boundary snapshot without cloning its transcript.
    pub(crate) fn cache_safe_snapshot(&self) -> Option<Arc<crate::agent::CacheSafeParams>> {
        recover_read_lock(&self.last_cache_safe_params, "last_cache_safe_params").clone()
    }

    pub(crate) fn side_question_cache_snapshot(
        &self,
        owner: &kcoder_state::AppStateLifecycleIdentity,
    ) -> Option<Arc<crate::agent::CacheSafeParams>> {
        let snapshot = self.last_cache_safe_params.try_read().ok()?.clone()?;
        let binding = self.side_question_cache_binding.try_read().ok()?;
        let binding = binding.as_ref()?;
        let original = binding.snapshot.upgrade()?;
        (Arc::ptr_eq(&snapshot, &original) && binding.owner.same_lifecycle(owner))
            .then_some(snapshot)
    }

    /// Run a forked agent that shares this engine's cache-safe parameters.
    ///
    /// This is the foundation-level API; full message replay and AgentTool
    /// integration are implemented on top of it in later phases.
    pub async fn run_forked_agent(
        &self,
        prompt_messages: Vec<kcoder_types::Message>,
        overrides: crate::agent::SubagentContextOverrides,
        max_turns: usize,
    ) -> anyhow::Result<crate::agent::ForkedAgentResult> {
        let cache_safe = self
            .cache_safe_snapshot()
            .ok_or_else(|| anyhow::anyhow!("no cache-safe params available; run a turn first"))?;
        crate::agent::run_forked_agent(self, &cache_safe, prompt_messages, overrides, max_turns)
            .await
    }
}

#[cfg(test)]
#[path = "tests/forking_unit.rs"]
mod tests;
