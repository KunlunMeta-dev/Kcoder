use serde::{Deserialize, Serialize};

/// Opt-in personal Wiki. Enabling availability does not enable implicit retrieval
/// or automatic conversation ingestion. Scope is the current execution target.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct KnowledgeSettings {
    /// Legacy shorthand: absent individual switches inherit this value.
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retrieval_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_enabled: Option<bool>,
    /// Qualified target model override; None inherits the active Provider/model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_model: Option<String>,
    /// Wiki-only reasoning override; never updates the Provider default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_reasoning_effort: Option<kcoder_types::ReasoningEffort>,
}

impl KnowledgeSettings {
    pub fn can_retrieve(&self) -> bool {
        self.retrieval_enabled.unwrap_or(self.enabled)
    }
    pub fn can_organize(&self) -> bool {
        self.organization_enabled.unwrap_or(self.enabled)
    }
    pub fn is_available(&self) -> bool {
        self.can_retrieve() || self.can_organize()
    }
    pub fn set_both(&mut self, enabled: bool) {
        self.enabled = enabled;
        self.retrieval_enabled = Some(enabled);
        self.organization_enabled = Some(enabled);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wiki_is_disabled_for_defaults_and_legacy_settings() {
        assert!(!KnowledgeSettings::default().enabled);
        assert!(
            !serde_json::from_str::<KnowledgeSettings>("{}")
                .unwrap()
                .enabled
        );
        assert!(!crate::Settings::default().knowledge.enabled);
        let settings: crate::Settings =
            serde_json::from_value(serde_json::json!({"knowledge":{"enabled":true}})).unwrap();
        assert!(settings.knowledge.enabled);
    }
}

#[cfg(test)]
mod independent_modes {
    use super::*;
    #[test]
    fn legacy_and_independent_switches_have_unambiguous_precedence() {
        let mut settings: KnowledgeSettings =
            serde_json::from_str(r#"{"enabled":true,"organization_enabled":false}"#).unwrap();
        assert!(settings.can_retrieve());
        assert!(!settings.can_organize());
        settings.set_both(false);
        assert!(!settings.is_available());
        let settings: KnowledgeSettings =
            serde_json::from_str(r#"{"organization_enabled":true}"#).unwrap();
        assert!(!settings.can_retrieve());
        assert!(settings.can_organize());
        assert!(settings.is_available());
    }
}
