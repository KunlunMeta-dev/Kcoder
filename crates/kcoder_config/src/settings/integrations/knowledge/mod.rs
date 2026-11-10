//! Explicit knowledge-domain switches. Registration and native authority remain host-owned.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct KnowledgeIntegrationSettings {
    pub memory_center_enabled: bool,
    pub publications_enabled: bool,
    pub business_automation_enabled: bool,
    pub observer_candidates_enabled: bool,
    pub auxiliary_extraction_enabled: bool,
    pub extraction_maximum_tokens: u64,
    pub extraction_maximum_input_bytes: usize,
    pub extraction_maximum_candidates: usize,
}
impl Default for KnowledgeIntegrationSettings {
    fn default() -> Self {
        Self {
            memory_center_enabled: false,
            publications_enabled: false,
            business_automation_enabled: false,
            observer_candidates_enabled: false,
            auxiliary_extraction_enabled: false,
            extraction_maximum_tokens: 2000,
            extraction_maximum_input_bytes: 65536,
            extraction_maximum_candidates: 8,
        }
    }
}
impl KnowledgeIntegrationSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.extraction_maximum_tokens == 0
            || self.extraction_maximum_tokens > 20000
            || self.extraction_maximum_input_bytes == 0
            || self.extraction_maximum_input_bytes > 512 * 1024
            || self.extraction_maximum_candidates == 0
            || self.extraction_maximum_candidates > 32
        {
            return Err("knowledge_integration_invalid_maintenance_budget".into());
        }
        if self.auxiliary_extraction_enabled && !self.observer_candidates_enabled {
            return Err("knowledge_integration_auxiliary_requires_candidates".into());
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn background_work_and_ports_are_not_enabled_by_default() {
        let c = KnowledgeIntegrationSettings::default();
        assert!(
            !c.memory_center_enabled
                && !c.publications_enabled
                && !c.business_automation_enabled
                && !c.observer_candidates_enabled
                && !c.auxiliary_extraction_enabled
        );
        assert!(c.validate().is_ok());
        let mut c = c;
        c.auxiliary_extraction_enabled = true;
        assert!(c.validate().is_err());
    }
}
