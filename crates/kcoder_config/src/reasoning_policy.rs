use anyhow::{Result, ensure};
use kcoder_types::{ModelReasoningPolicy, ReasoningControlMode, ReasoningEffort};
use serde_json::{Map, Value};

/// Policy constrains known request controls but never invents vendor parameters.
pub fn validate_reasoning_policy(
    policy: Option<&ModelReasoningPolicy>,
    effort: Option<&ReasoningEffort>,
    body: &Map<String, Value>,
) -> Result<()> {
    let Some(policy) = policy else { return Ok(()) };
    ensure!(
        policy.efforts.len() <= 8,
        "reasoning_policy.efforts exceeds supported size"
    );
    ensure!(policy.efforts.iter().all(|value| ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].contains(&value.as_str())), "reasoning_policy.efforts contains an unsupported value");
    let off = |value: &ReasoningEffort| *value == ReasoningEffort::None;
    let configured_on = effort.is_some_and(|value| !off(value));
    let configured_off = effort.is_some_and(off);
    let body_effort = body
        .get("reasoning_effort")
        .or_else(|| body.get("reasoning").and_then(|value| value.get("effort")))
        .and_then(Value::as_str);
    let body_off = body.get("enable_thinking") == Some(&Value::Bool(false))
        || body
            .get("thinking")
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
            == Some("disabled")
        || body_effort == Some("none");
    let body_on = body
        .get("thinking")
        .and_then(|value| value.get("budget_tokens"))
        .and_then(Value::as_u64)
        .is_some_and(|value| value > 0)
        || body.get("enable_thinking") == Some(&Value::Bool(true))
        || matches!(
            body.get("thinking")
                .and_then(|value| value.get("type"))
                .and_then(Value::as_str),
            Some("enabled" | "adaptive")
        )
        || body_effort.is_some_and(|value| value != "none");
    match policy.mode {
        ReasoningControlMode::AlwaysOff => ensure!(
            (configured_off || body_off)
                && !configured_on
                && !body_on
                && policy.efforts.iter().all(off),
            "reasoning_policy always_off conflicts with enabled reasoning; change reasoning_effort or extra_body"
        ),
        ReasoningControlMode::AlwaysOn => ensure!(
            (configured_on || body_on)
                && !configured_off
                && !body_off
                && !policy.efforts.iter().any(off),
            "reasoning_policy always_on conflicts with disabled reasoning; change reasoning_effort or extra_body"
        ),
        ReasoningControlMode::Optional => {
            ensure!(
                policy.efforts.iter().any(off) && policy.efforts.iter().any(|value| !off(value)),
                "reasoning_policy optional requires explicit none and enabled efforts"
            );
            ensure!(
                ![
                    "thinking",
                    "reasoning",
                    "reasoning_effort",
                    "enable_thinking"
                ]
                .iter()
                .any(|field| body.contains_key(*field)),
                "reasoning_policy optional conflicts with reasoning controls in extra_body; remove the override or use a fixed policy"
            );
        }
        ReasoningControlMode::Hidden => {}
    }
    if !policy.efforts.is_empty()
        && let Some(effort) = effort
    {
        ensure!(
            policy.efforts.contains(effort),
            "reasoning_effort is not declared in reasoning_policy.efforts"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_conflicts_are_rejected_without_inventing_vendor_parameters() {
        let optional = ModelReasoningPolicy {
            mode: ReasoningControlMode::Optional,
            efforts: vec![ReasoningEffort::None, ReasoningEffort::High],
        };
        let body = Map::new();
        assert!(
            validate_reasoning_policy(Some(&optional), Some(&ReasoningEffort::None), &body).is_ok()
        );
        assert!(
            validate_reasoning_policy(Some(&optional), Some(&ReasoningEffort::Low), &body).is_err()
        );
        for value in [
            serde_json::json!({"thinking":{"type":"enabled"}}),
            serde_json::json!({"reasoning":{"effort":"high"}}),
            serde_json::json!({"enable_thinking":false}),
        ] {
            assert!(
                validate_reasoning_policy(Some(&optional), None, value.as_object().unwrap())
                    .is_err()
            );
        }
        let mut fixed = ModelReasoningPolicy {
            mode: ReasoningControlMode::AlwaysOff,
            efforts: vec![],
        };
        assert!(validate_reasoning_policy(Some(&fixed), None, &body).is_err());
        assert!(
            validate_reasoning_policy(Some(&fixed), Some(&ReasoningEffort::None), &body).is_ok()
        );
        assert!(
            validate_reasoning_policy(Some(&fixed), Some(&ReasoningEffort::High), &body).is_err()
        );
        fixed.mode = ReasoningControlMode::AlwaysOn;
        assert!(
            validate_reasoning_policy(Some(&fixed), Some(&ReasoningEffort::High), &body).is_ok()
        );
        assert!(
            validate_reasoning_policy(Some(&fixed), Some(&ReasoningEffort::None), &body).is_err()
        );
        fixed.mode = ReasoningControlMode::Hidden;
        assert!(
            validate_reasoning_policy(Some(&fixed), Some(&ReasoningEffort::High), &body).is_ok()
        );
    }
}

impl crate::Settings {
    pub fn validate_model_reasoning_policy(&self) -> Result<()> {
        ensure!(self.model_reasoning_policy.as_ref().is_none_or(|policy| policy.mode == ReasoningControlMode::Hidden) || self.model_capabilities.reasoning,
            "reasoning_policy requires an enabled reasoning capability");
        validate_reasoning_policy(self.model_reasoning_policy.as_ref(), self.model_reasoning_effort.as_ref(), &self.provider_extra_body)
    }
}
