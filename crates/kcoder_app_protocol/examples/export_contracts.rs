//! Export only reviewed public data contracts, using their actual serde schema.
use kcoder_app_protocol::{KnowledgeFileCapabilitiesResult, KnowledgeFileCapability};
use kcoder_types::{ModelConfigurationBoundary, ModelConfigurationSummary, ModelReasoningPolicy};
use schemars::{JsonSchema, schema_for};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::collections::BTreeMap;

use kcoder_types::wiki_job_progress::WikiJobProgress;

fn register<T: JsonSchema + DeserializeOwned + Serialize>(
    name: &str,
    fixtures: &mut Value,
    schemas: &mut BTreeMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    schemas.insert(name.into(), serde_json::to_value(schema_for!(T))?);
    for case in fixtures[name]["valid"]
        .as_array_mut()
        .ok_or("missing legal examples")?
    {
        let decoded: T = serde_json::from_value(case["value"].clone())?;
        case["decoded"] = serde_json::to_value(decoded)?;
        if matches!(
            name,
            "TaskStatus" | "TurnAttemptStatus" | "WikiJobStatus" | "WikiJobPhase"
        ) && case["decoded"] != case["value"]
        {
            return Err("status raw value was not preserved".into());
        }
    }
    for case in fixtures[name]["invalid"]
        .as_array()
        .ok_or("missing negative examples")?
    {
        if serde_json::from_value::<T>(case["value"].clone()).is_ok() {
            return Err(format!("invalid fixture accepted: {name}/{}", case["name"]).into());
        }
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut fixtures: Value =
        serde_json::from_str(include_str!("../../../scripts/contracts/fixtures.json"))?;
    let mut schemas = BTreeMap::new();
    register::<ModelConfigurationSummary>(
        "ModelConfigurationSummary",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<ModelConfigurationBoundary>(
        "ModelConfigurationBoundary",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<ModelReasoningPolicy>("ModelReasoningPolicy", &mut fixtures, &mut schemas)?;
    register::<WikiJobProgress>("WikiJobProgress", &mut fixtures, &mut schemas)?;
    register::<kcoder_types::wiki_pipeline::WikiPipelineProgress>(
        "WikiPipelineProgress",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_types::WorkflowAgentConfigurationSummary>(
        "WorkflowAgentConfigurationSummary",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_types::knowledge::WikiImageImport>(
        "WikiImageImport",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::KnowledgeImageImportListResult>(
        "KnowledgeImageImportListResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<KnowledgeFileCapability>("KnowledgeFileCapability", &mut fixtures, &mut schemas)?;
    register::<KnowledgeFileCapabilitiesResult>(
        "KnowledgeFileCapabilitiesResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_types::mcp_failure::McpFailureReason>(
        "McpFailureReason",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpConnectionAttempt>(
        "McpConnectionAttempt",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpServerSummary>(
        "McpServerSummary",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_types::TaskStatus>("TaskStatus", &mut fixtures, &mut schemas)?;
    register::<kcoder_types::TurnAttemptStatus>("TurnAttemptStatus", &mut fixtures, &mut schemas)?;
    register::<kcoder_types::domain_status::WikiJobStatus>(
        "WikiJobStatus",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_types::domain_status::WikiJobPhase>(
        "WikiJobPhase",
        &mut fixtures,
        &mut schemas,
    )?;
    let failure_schema = schemas
        .get_mut("McpFailureReason")
        .ok_or("missing failure schema")?;
    let mut codes = BTreeMap::new();
    for label in failure_schema["enum"]
        .as_array()
        .ok_or("missing failure labels")?
    {
        let reason: kcoder_types::mcp_failure::McpFailureReason =
            serde_json::from_value(label.clone())?;
        codes.insert(
            label.as_str().ok_or("invalid failure label")?.to_owned(),
            reason.error_code(),
        );
    }
    failure_schema["x-error-codes"] = serde_json::to_value(codes)?;
    println!(
        "{}",
        serde_json::to_string(&json!({"schemas": schemas, "fixtures": fixtures}))?
    );
    Ok(())
}
