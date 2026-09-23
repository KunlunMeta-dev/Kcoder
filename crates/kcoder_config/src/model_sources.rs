//! Value-free provenance for model configuration. Paths stay private so arbitrary
//! keys inside user request bodies never become diagnostic field names.
use crate::{ProviderConfig, Result};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone)]
enum Node {
    Object(BTreeMap<String, Node>, &'static str),
    Leaf(&'static str),
}

impl Node {
    fn from_value(value: &Value, layer: &'static str) -> Self {
        match value {
            Value::Object(fields) => Self::Object(
                fields
                    .iter()
                    .map(|(key, value)| (key.clone(), Self::from_value(value, layer)))
                    .collect(),
                layer,
            ),
            _ => Self::Leaf(layer),
        }
    }

    fn merge(&mut self, value: &Value, layer: &'static str, path: &mut Vec<String>) {
        match (&mut *self, value) {
            (Self::Object(fields, empty_layer), Value::Object(source)) => {
                if fields.is_empty() {
                    *empty_layer = layer;
                }
                for (key, value) in source {
                    // Keep exactly the same model-table replacement boundary as
                    // the configuration loader, including an explicitly empty table.
                    if path.len() == 2 && path[0] == "providers" && key == "models" {
                        fields.insert(key.clone(), Self::from_value(value, layer));
                        continue;
                    }
                    path.push(key.clone());
                    if let Some(existing) = fields.get_mut(key) {
                        existing.merge(value, layer, path);
                    } else {
                        fields.insert(key.clone(), Self::from_value(value, layer));
                    }
                    path.pop();
                }
            }
            _ => *self = Self::from_value(value, layer),
        }
    }

    fn get(&self, path: &[&str]) -> Option<&Self> {
        if path.is_empty() {
            return Some(self);
        }
        match self {
            Self::Object(fields, _) => fields.get(path[0])?.get(&path[1..]),
            Self::Leaf(_) => None,
        }
    }

    fn layers(&self, output: &mut BTreeSet<String>) {
        match self {
            Self::Object(fields, empty_layer) if fields.is_empty() => {
                output.insert((*empty_layer).into());
            }
            Self::Object(fields, _) => {
                for node in fields.values() {
                    node.layers(output);
                }
            }
            Self::Leaf(layer) => {
                output.insert((*layer).into());
            }
        }
    }

    fn overlay_node(&mut self, source: &Self) {
        match (&mut *self, source) {
            (Self::Object(fields, empty_layer), Self::Object(incoming, source_layer)) => {
                if fields.is_empty() {
                    *empty_layer = source_layer;
                }
                for (key, node) in incoming {
                    if let Some(existing) = fields.get_mut(key) {
                        existing.overlay_node(node);
                    } else {
                        fields.insert(key.clone(), node.clone());
                    }
                }
            }
            _ => *self = source.clone(),
        }
    }
}

/// Public projection of file provenance; deliberately contains no setting values.
#[derive(Clone, Debug)]
pub struct ModelConfigurationFieldSources {
    pub provider: String,
    pub model: String,
    pub fields: BTreeMap<String, BTreeSet<String>>,
}

#[derive(Clone)]
pub struct ModelConfigurationSources(Node);

impl Default for ModelConfigurationSources {
    fn default() -> Self {
        Self(Node::Object(BTreeMap::new(), "default"))
    }
}

impl std::fmt::Debug for ModelConfigurationSources {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ModelConfigurationSources { .. }")
    }
}

impl ModelConfigurationSources {
    pub(crate) fn from_defaults(value: &Value) -> Self {
        Self(Node::from_value(value, "default"))
    }

    pub(crate) fn merge(&mut self, value: &Value, layer: &'static str) {
        self.0.merge(value, layer, &mut Vec::new());
    }

    /// Return only predefined field names and layer labels, never paths or values.
    /// These are configuration layers; transport environment/CLI overrides are
    /// supplied separately by the host that owns their resolution.
    pub fn model_fields(
        &self,
        id: &str,
        profile: &ProviderConfig,
        model: &str,
    ) -> Result<BTreeMap<String, BTreeSet<String>>> {
        profile.effective_for_model(model)?;
        let mut result = BTreeMap::new();
        for (field, runtime, model_specific) in [
            ("endpoint", "base_url", false),
            ("api_format", "api_format", false),
            ("authentication", "", false),
            ("chat_protocol", "provider_chat_protocol", false),
            ("context_window_tokens", "context_window_tokens", true),
            ("output_headroom_tokens", "context_output_headroom", true),
            ("max_output_tokens", "max_tokens", true),
            ("capabilities", "model_capabilities", true),
            ("reasoning_effort", "model_reasoning_effort", true),
            ("reasoning_policy", "model_reasoning_policy", true),
            ("extra_body", "provider_extra_body", true),
        ] {
            let from_model = model_specific
                && !profile.models.is_empty()
                && !(field == "extra_body" && profile.models[model].extra_body.is_none());
            let path = if from_model {
                vec!["providers", id, "models", model, field]
            } else {
                vec!["providers", id, field]
            };
            let mut node = self.0.get(&path).cloned().unwrap_or(Node::Leaf("default"));
            if !runtime.is_empty()
                && let Some(root) = self.0.get(&[runtime])
            {
                let mut layers = BTreeSet::new();
                root.layers(&mut layers);
                if layers.iter().any(|layer| layer != "default") {
                    node.overlay_node(root);
                }
            }
            let mut layers = BTreeSet::new();
            node.layers(&mut layers);
            result.insert(field.to_string(), layers);
        }
        // Deserialization fills undeclared booleans, but that does not make them
        // explicit capability declarations. Track each predefined capability leaf.
        let mut capability_layers = BTreeSet::new();
        for capability in ["text", "tools", "vision", "reasoning", "structured_output"] {
            let path = if profile.models.is_empty() {
                vec!["providers", id, "capabilities", capability]
            } else {
                vec!["providers", id, "models", model, "capabilities", capability]
            };
            let mut node = self.0.get(&path).cloned().unwrap_or(Node::Leaf("default"));
            if let Some(root) = self.0.get(&["model_capabilities", capability]) {
                let mut labels = BTreeSet::new();
                root.layers(&mut labels);
                if labels.iter().any(|label| label != "default") { node.overlay_node(root); }
            }
            let mut labels = BTreeSet::new();
            node.layers(&mut labels);
            capability_layers.extend(labels.iter().cloned());
            result.insert(format!("capabilities.{capability}"), labels);
        }
        result.insert("capabilities".into(), capability_layers);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use crate::SettingsLoader;
    use serde_json::json;

    #[test]
    fn partial_capability_declarations_do_not_claim_unknown_defaults_are_explicit() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("settings.json"), json!({
            "active_provider":"fixture", "providers":{"fixture":{
                "api_format":"openai_chat_completions", "endpoint":"http://127.0.0.1:1/v1", "default_model":"model",
                "context_window_tokens":32000, "max_output_tokens":1024, "output_headroom_tokens":1024,
                "capabilities":{"vision":true}
            }}
        }).to_string()).unwrap();
        let loaded = SettingsLoader::new(temp.path()).with_config_dir(temp.path()).load().unwrap();
        let fields = loaded.model_configuration_sources.model_fields("fixture", &loaded.settings.providers["fixture"], "model").unwrap();
        assert!(fields["capabilities.vision"].contains("user"));
        assert!(fields["capabilities.reasoning"].contains("default"));
        assert!(fields["capabilities.tools"].contains("default"));
    }

    #[test]
    fn model_sources_follow_real_layers_without_values_or_dotted_name_collisions() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let config = temp.path().join("config");
        std::fs::create_dir_all(project.join(".kcoder")).unwrap();
        std::fs::create_dir(&config).unwrap();
        let model = |body| json!({"context_window_tokens":32000,"output_headroom_tokens":1024,"max_output_tokens":1024,"extra_body":body});
        std::fs::write(config.join("settings.json"), json!({"active_provider":"a.b", "providers":{"a.b": {
            "api_format":"openai_chat_completions","endpoint":"http://127.0.0.1:1/v1?token=private-fixture",
            "default_model":"m.v1", "context_window_tokens":32000,"output_headroom_tokens":1024,"max_output_tokens":1024,
            "models":{"m.v1":model(json!({"private-field-name":"private-value"})),"m":model(json!({}))}
        }}}).to_string()).unwrap();
        std::fs::write(project.join(".kcoder/settings.json"), json!({"providers":{"a.b":{"endpoint":"http://127.0.0.1:2/v1"}}, "model_capabilities":{"tools":false}}).to_string()).unwrap();
        let overlay = temp.path().join("overlay.json");
        std::fs::write(
            &overlay,
            json!({"providers":{"a.b":{"models":{"m.v1":model(json!({}))}}}}).to_string(),
        )
        .unwrap();
        let loader = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .with_executable_dir(temp.path());
        let loaded = loader.clone().load().unwrap();
        let sources = loaded
            .model_configuration_sources
            .model_fields("a.b", &loaded.settings.providers["a.b"], "m.v1")
            .unwrap();
        assert_eq!(sources["endpoint"].iter().next().unwrap(), "project");
        assert_eq!(sources["extra_body"].iter().next().unwrap(), "user");
        assert!(sources["capabilities"].contains("project"));
        let serialized = serde_json::to_string(&sources).unwrap();
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains("127.0.0.1"));
        let loaded = loader.with_overlay_files([overlay]).load().unwrap();
        let profile = &loaded.settings.providers["a.b"];
        assert!(!profile.has_model("m"));
        let sources = loaded
            .model_configuration_sources
            .model_fields("a.b", profile, "m.v1")
            .unwrap();
        assert_eq!(sources["extra_body"].iter().next().unwrap(), "overlay");
        assert_eq!(
            sources["max_output_tokens"].iter().next().unwrap(),
            "overlay"
        );
        assert_eq!(sources["endpoint"].iter().next().unwrap(), "project");
    }
}
