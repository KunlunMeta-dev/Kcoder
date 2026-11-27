use serde::{Deserialize, Serialize};

/// Request to change the model for a resident thread while its current turn is running.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadModelSelectionParams {
    pub thread_id: String,
    pub model: String,
}

impl ThreadModelSelectionParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.thread_id.trim().is_empty() {
            return Err("threadId must not be empty");
        }
        if !self
            .model
            .split_once("::")
            .is_some_and(|(provider, model)| {
                !provider.trim().is_empty() && !model.trim().is_empty()
            })
        {
            return Err("model must be a qualified Provider::model selection");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ThreadModelSelectionResult {
    pub accepted: bool,
    pub model: String,
    pub applies_at: String,
}

pub const CAPABILITY_TURN_MODEL_SWITCH_V1: &str = "turnModelSwitchV1";
pub const METHOD_THREAD_MODEL_SELECT: &str = "thread/model/select";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_selection_requires_a_qualified_provider_model() {
        for (thread_id, model) in [
            ("", "provider::model"),
            ("thread", ""),
            ("thread", "model"),
            ("thread", "::model"),
            ("thread", "provider::"),
        ] {
            assert!(
                ThreadModelSelectionParams {
                    thread_id: thread_id.into(),
                    model: model.into(),
                }
                .validate()
                .is_err()
            );
        }
    }
}
