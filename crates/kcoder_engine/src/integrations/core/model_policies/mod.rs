//! Current configured AUTO pools, resolved without activating a model or making requests.
use crate::QueryEngine;
use anyhow::{Context, Result, ensure};
use kcoder_config::{Settings, integrations::core::ConfiguredModelPolicyCandidate};
use kcoder_types::{ModelConfigurationBoundary, ModelConfigurationSummary, integrations::core::*};

fn catalog_settings(engine: &QueryEngine) -> Result<Settings> {
    match &engine.client_model_configuration {
        Some(source) => source
            .catalog_settings()?
            .context("MODEL_POLICY_CATALOG_UNAVAILABLE"),
        None => Ok(engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("MODEL_POLICY_CATALOG_UNAVAILABLE"))?
            .clone()),
    }
}
pub fn configured_integration_model_policies(
    engine: &QueryEngine,
) -> Result<IntegrationModelPolicyCatalog> {
    let settings = catalog_settings(engine)?;
    settings.integrations.core.validate()?;
    let policies = settings
        .integrations
        .core
        .model_policies
        .iter()
        .map(|policy| {
            Ok(IntegrationModelPolicyDescriptor {
                reference: IntegrationModelPolicyRef {
                    id: policy.id.clone(),
                    version: policy.version()?,
                },
                title: policy.title.clone(),
                enabled: policy.enabled,
                candidates: policy
                    .candidates
                    .iter()
                    .map(|candidate| IntegrationModelPolicyCandidate {
                        provider: candidate.provider.clone(),
                        model: candidate.model.clone(),
                        enabled: candidate.enabled,
                        configuration_revision: candidate.configuration_revision.clone(),
                    })
                    .collect(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(IntegrationModelPolicyCatalog { policies })
}

pub fn read_configured_integration_model_health(
    engine: &QueryEngine,
    request: &IntegrationModelHealthReadParams,
) -> Result<IntegrationModelHealthReport> {
    let settings = catalog_settings(engine)?;
    let policy = settings
        .integrations
        .core
        .policy(&request.id, &request.version)?;
    let observations = policy
        .candidates
        .iter()
        .filter(|candidate| candidate.enabled)
        .filter_map(|candidate| {
            resolve_candidate(
                engine,
                &settings,
                candidate,
                &request.id,
                &request.version,
                &Default::default(),
            )
            .ok()
        })
        .map(|model| engine.integration_model_health(&model))
        .collect();
    let latest = catalog_settings(engine)?;
    let _ = latest
        .integrations
        .core
        .policy(&request.id, &request.version)?;
    Ok(IntegrationModelHealthReport {
        policy_ref: IntegrationModelPolicyRef {
            id: request.id.clone(),
            version: request.version.clone(),
        },
        observations,
    })
}

pub fn read_configured_integration_model_usage(
    engine: &QueryEngine,
    request: &IntegrationModelHealthReadParams,
) -> Result<IntegrationModelUsageReport> {
    let settings = catalog_settings(engine)?;
    let policy = settings
        .integrations
        .core
        .policy(&request.id, &request.version)?;
    let observations = policy
        .candidates
        .iter()
        .filter(|candidate| candidate.enabled)
        .filter_map(|candidate| {
            resolve_candidate(
                engine,
                &settings,
                candidate,
                &request.id,
                &request.version,
                &Default::default(),
            )
            .ok()
        })
        .map(|model| engine.integration_model_usage(&model))
        .collect();
    let latest = catalog_settings(engine)?;
    let _ = latest
        .integrations
        .core
        .policy(&request.id, &request.version)?;
    Ok(IntegrationModelUsageReport {
        policy_ref: IntegrationModelPolicyRef {
            id: request.id.clone(),
            version: request.version.clone(),
        },
        observations,
    })
}

/// Revalidate an already prepared AUTO model at the original runtime install
/// boundary. This only narrows the host's authority; it never grants execution.
/// A task may lower max_tokens, but may not change endpoint/protocol/identity
/// behind an unchanged policy reference or expand the configured limits.
pub fn validate_integration_auto_model(
    engine: &QueryEngine,
    resolution: &IntegrationModelResolutionResult,
) -> Result<()> {
    if resolution.selection_kind != IntegrationModelSelectionKind::AutoPolicy {
        return Ok(());
    }
    let IntegrationNullable::Value(reference) = &resolution.policy_ref else {
        anyhow::bail!("MODEL_AUTO_POLICY_REFERENCE_REQUIRED");
    };
    let current = catalog_settings(engine)?;
    let policy = current
        .integrations
        .core
        .policy(&reference.id, &reference.version)?;
    let candidate = policy
        .candidates
        .iter()
        .find(|candidate| {
            candidate.enabled
                && resolution.model.provider_id.as_deref() == Some(candidate.provider.as_str())
                && resolution.model.model_id == candidate.model
        })
        .context("MODEL_AUTO_SELECTION_NOT_APPROVED")?;
    let base = resolve_candidate(
        engine,
        &current,
        candidate,
        &reference.id,
        &reference.version,
        &Default::default(),
    )?;
    let selected = engine.active_model_configuration_summary()?;
    ensure!(
        selected.provider_id == resolution.model.provider_id
            && selected.model_id == resolution.model.model_id
            && selected.revision == resolution.model.revision,
        "MODEL_AUTO_CONFIGURATION_CHANGED"
    );
    let (configured, _) = engine.resolve_client_model_configuration(&format!(
        "{}::{}",
        candidate.provider, candidate.model
    ))?;
    let mut actual = engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("MODEL_AUTO_CONFIGURATION_CHANGED"))?
        .clone();
    ensure!(
        actual.max_tokens.is_some_and(|limit| limit > 0
            && configured
                .max_tokens
                .is_some_and(|maximum| limit <= maximum)),
        "MODEL_AUTO_OUTPUT_LIMIT_EXPANDED"
    );
    // Only the known task-owned output narrowing is normalized. The private
    // summary hash still binds endpoints, transport and all other semantics.
    actual.max_tokens = configured.max_tokens;
    let normalized =
        crate::model_configuration_summary(&actual, ModelConfigurationBoundary::NextTurn)?;
    ensure!(
        normalized.revision == base.revision,
        "MODEL_AUTO_CONFIGURATION_CHANGED"
    );
    let latest = catalog_settings(engine)?;
    let _ = latest
        .integrations
        .core
        .policy(&reference.id, &reference.version)?;
    Ok(())
}

pub(super) fn resolve_auto_policy(
    engine: &QueryEngine,
    id: &str,
    version: &str,
    requirements: &IntegrationModelRequirements,
    authorizer: Option<&dyn super::model_selection::NativeModelCandidateAuthorizer>,
) -> Result<IntegrationModelResolutionResult> {
    let settings = catalog_settings(engine)?;
    let policy = settings.integrations.core.policy(id, version)?.clone();
    for candidate in &policy.candidates {
        if !candidate.enabled {
            continue;
        }
        // Only the explicitly configured pool is considered. Errors exclude
        // this candidate, never inherit a model or enumerate catalog fallbacks.
        let model = match resolve_candidate(engine, &settings, candidate, id, version, requirements)
        {
            Ok(model) => model,
            Err(_) => continue,
        };
        match engine.model_health.routing(&model) {
            Ok(()) => {}
            Err(error) if error.to_string() == "MODEL_AUTO_CONFIGURATION_BLOCKED" => {
                return Err(error);
            }
            Err(_) => continue,
        }
        let current = catalog_settings(engine)?;
        let _ = current.integrations.core.policy(id, version)?;
        let confirmed = resolve_candidate(engine, &current, candidate, id, version, requirements)?;
        ensure!(
            confirmed.revision == model.revision,
            "MODEL_AUTO_CONFIGURATION_CHANGED"
        );
        if let Some(policy) = authorizer
            && !policy.allows(engine, &model)?
        {
            continue;
        }
        return Ok(IntegrationModelResolutionResult {
            selection_kind: IntegrationModelSelectionKind::AutoPolicy,
            model,
            policy_ref: IntegrationNullable::Value(IntegrationModelPolicyRef {
                id: id.into(),
                version: version.into(),
            }),
            budget: IntegrationModelBudget {
                reservation_state: IntegrationBudgetReservationState::NotReserved,
                cost_known: false,
            },
        });
    }
    anyhow::bail!("MODEL_AUTO_NO_ELIGIBLE_CANDIDATE")
}
fn configured(settings: &Settings, candidate: &ConfiguredModelPolicyCandidate) -> bool {
    settings
        .providers
        .get(&candidate.provider)
        .is_some_and(|provider| provider.has_model(&candidate.model))
}
fn resolve_candidate(
    engine: &QueryEngine,
    catalog: &Settings,
    candidate: &ConfiguredModelPolicyCandidate,
    id: &str,
    version: &str,
    requirements: &IntegrationModelRequirements,
) -> Result<ModelConfigurationSummary> {
    ensure!(
        configured(catalog, candidate),
        "MODEL_AUTO_CANDIDATE_NOT_CONFIGURED"
    );
    let (settings, provider) = engine
        .resolve_client_model_configuration(&format!("{}::{}", candidate.provider, candidate.model))
        .map_err(|_| anyhow::anyhow!("MODEL_AUTO_CANDIDATE_UNAVAILABLE"))?;
    let current = settings.integrations.core.policy(id, version)?;
    ensure!(
        current.candidates.contains(candidate) && configured(&settings, candidate),
        "MODEL_AUTO_POLICY_VERSION_CHANGED"
    );
    let deployment = settings
        .providers
        .get(&candidate.provider)
        .context("MODEL_AUTO_CANDIDATE_NOT_CONFIGURED")?;
    ensure!(
        !deployment.authentication.is_api_key() || provider.api_key_configured() == Some(true),
        "MODEL_AUTO_CREDENTIAL_UNAVAILABLE"
    );
    let model =
        crate::model_configuration_summary(&settings, ModelConfigurationBoundary::NextTurn)?;
    ensure!(
        model.provider_id.as_deref() == Some(candidate.provider.as_str())
            && model.model_id == candidate.model
            && model.text,
        "MODEL_AUTO_CONFIGURATION_CHANGED"
    );
    ensure!(
        candidate
            .configuration_revision
            .as_ref()
            .is_none_or(|expected| expected == &model.revision),
        "MODEL_AUTO_CONFIGURATION_CHANGED"
    );
    super::model_selection::validate_requirements(&model, requirements)?;
    let window = model
        .context_window_tokens
        .filter(|value| *value > 0)
        .context("MODEL_CONTEXT_CAPACITY_UNKNOWN")? as u64;
    let capacity = u64::from(
        model
            .max_output_tokens
            .filter(|value| *value > 0)
            .context("MODEL_OUTPUT_CAPACITY_UNKNOWN")?,
    );
    ensure!(
        !model.request_output_limits.is_empty()
            && model.request_output_limits.values().all(Option::is_some),
        "MODEL_OUTPUT_CAPACITY_UNKNOWN"
    );
    let effective_output = model
        .request_output_limits
        .values()
        .flatten()
        .copied()
        .map(u64::from)
        .max()
        .context("MODEL_OUTPUT_CAPACITY_UNKNOWN")?;
    ensure!(
        effective_output > 0 && effective_output <= capacity,
        "MODEL_OUTPUT_CAPACITY_EXCEEDED"
    );
    let reserve = effective_output.max(requirements.output_tokens.unwrap_or(0));
    let total = requirements
        .input_tokens
        .unwrap_or(0)
        .checked_add(reserve)
        .context("MODEL_CONTEXT_CAPACITY_EXCEEDED")?;
    ensure!(total <= window, "MODEL_CONTEXT_CAPACITY_EXCEEDED");
    Ok(model)
}

#[cfg(test)]
mod tests;

mod owned_resolution;
