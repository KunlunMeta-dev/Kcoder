//! Per-expert skill snapshots are configuration, never an execution permit.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeAssistantSkill {
    pub slug: String,
    pub title: String,
    pub description: String,
    pub content: String,
    pub enabled: bool,
    /// Omitted inherits task tools; an explicit list only narrows the registry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
}

impl OfficeAssistantSkill {
    pub fn validate(&self) -> Result<(), OfficeValidationError> {
        if self.slug.is_empty()
            || matches!(self.slug.as_str(), "." | "..")
            || self.slug.len() > 128
            || !self
                .slug
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        {
            return Err(invalid("skills.slug"));
        }
        bounded(&self.title, 200, false, "skills.title")?;
        bounded(&self.description, 4000, true, "skills.description")?;
        if let Some(tools) = &self.allowed_tools {
            if tools.len() > 256 {
                return Err(invalid("skills.allowedTools"));
            }
            let mut seen = std::collections::BTreeSet::new();
            for tool in tools {
                identifier(tool, "skills.allowedTools")?;
                if !seen.insert(tool) {
                    return Err(invalid("skills.allowedTools"));
                }
            }
        }
        bounded(&self.content, 24_000, false, "skills.content")
    }
}

impl OfficeAssistantDefinition {
    /// Only explicitly enabled snapshots enter a newly accepted task's instructions.
    /// Tool registries, resource guards and external-send policy remain independent.
    pub fn runtime_instructions(&self) -> String {
        let mut text = self.instructions.clone();
        for skill in self.skills.iter().filter(|skill| skill.enabled) {
            text.push_str(&format!(
                "\n\n## Expert skill: {}\n{}\n",
                skill.slug, skill.content
            ));
        }
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn old_snapshots_keep_their_serialization_and_enabled_skills_are_isolated() {
        let old = json!({"schemaVersion":1,"id":"personal.test","scope":"personal",
            "title":"Test","description":"Test","language":"en","inputSchema":{"type":"object"},
            "instructions":"Base","capabilities":[],"resources":[],"modelSelection":{"kind":"inherit_current"},
            "allowedTools":[],"outputKinds":["document"],"acceptanceCriteria":["Review"],"externalSend":"deny"});
        let mut definition: OfficeAssistantDefinition =
            serde_json::from_value(old.clone()).unwrap();
        definition.validate().unwrap();
        assert_eq!(serde_json::to_value(&definition).unwrap(), old);
        for (slug, enabled) in [("selected", true), ("disabled", false)] {
            definition.skills.push(OfficeAssistantSkill {
                slug: slug.into(),
                title: slug.into(),
                description: String::new(),
                content: format!("{slug} private instructions"),
                enabled,
                allowed_tools: None,
            });
        }
        definition.validate().unwrap();
        let rendered = definition.runtime_instructions();
        assert!(rendered.contains("selected private instructions"));
        assert!(!rendered.contains("disabled private instructions"));
        assert_eq!(definition.allowed_tools, Some(Vec::new()));
        definition.skills.push(definition.skills[0].clone());
        assert!(definition.validate().is_err());
        definition.skills.pop();
        definition.skills[0].slug = "../other".into();
        assert!(definition.validate().is_err());
    }
}
