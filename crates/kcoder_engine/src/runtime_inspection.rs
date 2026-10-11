//! Runtime inspection within the shared engine ownership boundary.

use super::*;

impl QueryEngine {
    /// User-invocable skills exposed to desktop clients without returning prompt bodies or
    /// reference contents.
    pub fn client_skill_catalog(&self) -> Vec<ClientSkillSummary> {
        let cwd = self.state.cwd();
        let registry = recover_read_lock(&self.skill_registry, "skill_registry");
        let mut skills = registry
            .list()
            .into_iter()
            .map(|skill| ClientSkillSummary {
                name: skill.name.clone(),
                description: skill.description.clone(),
                path: skill.source.clone(),
                scope: if skill.source.starts_with(&cwd) {
                    "repo".into()
                } else {
                    "user".into()
                },
            })
            .collect::<Vec<_>>();
        skills.sort_by(|left, right| left.name.cmp(&right.name));
        skills
    }

    /// Best-effort token count for the current conversation.
    pub fn estimated_token_count(&self) -> usize {
        token_estimate_cache::count(self)
    }

    /// Cumulative API token usage observed so far in this session.
    pub fn cumulative_usage(&self) -> UsageAccumulator {
        recover_read_lock(&self.cumulative_usage, "cumulative_usage").clone()
    }

    /// Current context budget derived from the active model and settings.
    pub fn context_budget(&self) -> crate::context::budget::ContextBudget {
        let settings = recover_read_lock(&self.settings, "settings");
        crate::context::budget::ContextBudget::from_settings(&settings)
    }

    pub fn plugin_snapshot(&self) -> Arc<kcoder_plugins::EffectivePluginSnapshot> {
        Arc::clone(&self.plugin_snapshot)
    }

    pub fn folder_trusted(&self) -> bool {
        self.folder_trusted
    }
}
