//! Model selection intent is distinct from the resolved model of a running turn.
use serde::{Deserialize, Serialize};

/// Missing intent in legacy records must be handled by the host explicitly;
/// it must never silently opt an old conversation into following defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ModelSelectionMode {
    #[default]
    Explicit,
    FollowTargetDefault,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_mode_has_unambiguous_wire_values() {
        assert_eq!(serde_json::to_string(&ModelSelectionMode::FollowTargetDefault).unwrap(), "\"follow_target_default\"");
        assert_eq!(serde_json::from_str::<ModelSelectionMode>("\"explicit\"").unwrap(), ModelSelectionMode::Explicit);
        for invalid in ["null", "true", "\"\"", "\"default\"", "{}"] {
            assert!(serde_json::from_str::<ModelSelectionMode>(invalid).is_err());
        }
        assert_eq!(ModelSelectionMode::default(), ModelSelectionMode::Explicit);
    }
}

/// A failed attempt normally retains its accepted model semantics. Current is
/// an explicit user decision to resolve the selected model's current settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RetryModelConfiguration {
    #[default]
    Snapshot,
    Current,
}
