//! Native subscription configuration to the original journal; no caller-defined policy identities.
use super::*;
use kcoder_types::integrations::knowledge::{AutomationPeriodBudget, AutomationSubscriptionDraft};

pub(in crate::app_server::integrations::knowledge) fn policy(
    key: &str,
    revision: u64,
    configuration: &AutomationPeriodBudget,
    now_ms: u64,
) -> Result<NativeBudgetPolicy> {
    let window = configuration.window(now_ms).map_err(anyhow::Error::msg)?;
    NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
        id: "native-personal-automation-period".into(),
        version: revision,
        revision: digest(&("explicit-automation-period-v1", key, configuration))?,
        scope: BudgetScope::Subscription(key.into()),
        window: BudgetWindow {
            id: format!("utc-{}", window.starts_at_ms),
            starts_at_ms: window.starts_at_ms,
            ends_at_ms: window.ends_at_ms,
        },
        limits: BudgetLimits {
            tokens: Some(configuration.maximum_tokens),
            model_calls: Some(configuration.maximum_model_calls),
            concurrent_tasks: Some(1),
            concurrent_calls: Some(1),
            ..Default::default()
        },
        currency: None,
    })
}
fn key(native: &NativeIntegrationContext, id: &str) -> Result<String> {
    Ok(format!(
        "automation-sub-{}",
        digest(&(IntegrationOwner::from(native.scope()), id))?
    ))
}
/// A read-only preview; it never creates a journal, installs a policy or admits work.
pub(in crate::app_server::integrations::knowledge) fn preview(
    native: &NativeIntegrationContext,
    draft: &AutomationSubscriptionDraft,
    configuration: &AutomationPeriodBudget,
    now_ms: u64,
) -> Result<serde_json::Value> {
    native.verify()?;
    let current_window = configuration.window(now_ms).map_err(anyhow::Error::msg)?;
    let candidate = policy(&key(native, &draft.id)?, 1, configuration, now_ms)?;
    let existing = crate::app_server::integrations::core::NativeBudgetService::load(native)?
        .map(|service| {
            service
                .accounting_store()
                .preview_subscription_window(&candidate)
        })
        .transpose()?;
    let tokens = existing
        .as_ref()
        .and_then(|observation| observation.limits.tokens)
        .map_or(configuration.maximum_tokens, |old| {
            old.min(configuration.maximum_tokens)
        });
    let calls = existing
        .as_ref()
        .and_then(|observation| observation.limits.model_calls)
        .map_or(configuration.maximum_model_calls, |old| {
            old.min(configuration.maximum_model_calls)
        });
    native.verify()?;
    Ok(serde_json::to_value(
        kcoder_app_protocol::integrations::knowledge::AutomationPeriodBudgetPreview {
            configuration: configuration.clone(),
            current_window,
            effective_maximum_tokens: tokens,
            effective_maximum_model_calls: calls,
            charged_tokens: existing.as_ref().map_or(0, |value| value.charged.tokens),
            charged_model_calls: existing
                .as_ref()
                .map_or(0, |value| value.charged.model_calls),
            unknown_cost_reservations: existing
                .as_ref()
                .map_or(0, |value| value.unknown_cost_reservations),
            active_tasks: existing.as_ref().map_or(0, |value| value.active_tasks),
            active_calls: existing.as_ref().map_or(0, |value| value.active_calls),
            increases_apply_next_window: true,
            creates_subscription: false,
        },
    )?)
}
