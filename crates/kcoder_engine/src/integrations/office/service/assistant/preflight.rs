//! Read-only observations for the existing definition-check entry. These checks
//! do not adopt an assistant, reserve a budget, generate output or run a model.
use super::*;

impl OfficeService {
    pub(super) async fn inspect_assistant_requirements(
        &self,
        request: &IntegrationRequest,
        definition: &OfficeAssistantDefinition,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.check(request, cancel)?;
        let started_at = now()?;
        let generator = self.generator_readiness(request, cancel).await?;
        let mut readiness_request = request.clone();
        readiness_request.payload = json!({
            "capabilityIds": definition.capabilities.iter().map(|item| &item.capability_id).collect::<Vec<_>>(),
            "resourceRefs": definition.resources.iter().map(readiness_resource).collect::<Result<Vec<_>>>()?,
        }).as_object().context("OFFICE_INVALID_INPUT")?.clone();
        let readiness = self
            .port(
                IntegrationPort::Readiness,
                "inspectReadiness",
                &readiness_request,
                cancel,
                false,
            )
            .await;
        self.check(request, cancel)?;
        let readiness = match readiness {
            Ok(value)
                if value.get("identityGeneration").and_then(Value::as_str)
                    == Some(request.scope.identity_generation.as_str())
                    && value.get("targetRevision").and_then(Value::as_str)
                        == Some(request.scope.target_revision.as_str())
                    && value
                        .get("requestRevision")
                        .and_then(Value::as_str)
                        .is_some_and(|revision| !revision.is_empty())
                    && value
                        .get("observedAt")
                        .and_then(Value::as_str)
                        .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
                        .is_some_and(|time| {
                            time.timestamp_millis() >= 0
                                && time.timestamp_millis() as u64
                                    >= started_at.saturating_sub(5_000)
                                && time.timestamp_millis() as u64
                                    <= now().unwrap_or(0).saturating_add(5_000)
                        }) =>
            {
                value
            }
            _ => {
                json!({"state":"unknown","observations":[],"capabilities":[],"reasonCode":"OFFICE_DEPENDENCY_UNKNOWN"})
            }
        };
        // The native model resolver reads current configuration and policy only.
        // Its not_reserved budget is kept verbatim and is never called ready.
        let model = self.resolve_model(request, definition, cancel).await;
        self.check(request, cancel)?;
        let (model, model_reason) = match model {
            Ok(value) => (serde_json::to_value(value)?, None),
            Err(error) => (
                Value::Null,
                Some(public_reason(&error, "OFFICE_MODEL_UNCONFIRMED")),
            ),
        };
        let mut resources = Vec::new();
        let mut references = definition.resources.clone();
        if let Some(workflow) = &definition.workflow_ref {
            references.push(OfficeResourceRef {
                kind: "workflow".into(),
                id: workflow.definition_id.clone(),
                revision: workflow.version.to_string(),
            });
        }
        for reference in references {
            let observed = self
                .host
                .validate_sources(request, std::slice::from_ref(&reference), cancel)
                .await;
            self.check(request, cancel)?;
            let (state, reason) = match observed {
                Ok(()) => ("observed", None),
                Err(error) => (
                    "unknown",
                    Some(public_reason(&error, "OFFICE_SOURCE_UNCONFIRMED")),
                ),
            };
            resources.push(json!({"reference":reference,"state":state,"reasonCode":reason}));
        }
        let observed_at = now()?;
        Ok(json!({
            "definitionValid":true,"requiredCapabilities":definition.capabilities,"requiredResources":definition.resources,
            "generator":generator,"readiness":readiness,"model":model,"modelReasonCode":model_reason,"resources":resources,
            "allowedFormats":self.settings.allowed_formats.iter().map(|format| format.extension()).collect::<Vec<_>>(),
            "requiredInputFields":definition.input_schema.get("required").and_then(Value::as_array).cloned().unwrap_or_default(),
            "staticOnly":true,"observedAtMs":observed_at,"expiresAtMs":observed_at.saturating_add(60_000),
            "identityGeneration":request.scope.identity_generation,"targetRevision":request.scope.target_revision,
            "adoptable":false,"reasonCode":"OFFICE_RECHECK_ON_ADOPTION"
        }))
    }
}

fn public_reason(error: &anyhow::Error, fallback: &str) -> String {
    error
        .chain()
        .map(ToString::to_string)
        .find(|message| {
            message.len() <= 96
                && (message.starts_with("OFFICE_") || message.starts_with("MODEL_"))
                && message
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        })
        .unwrap_or_else(|| fallback.into())
}
