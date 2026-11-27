//! Pure request validation for the trusted workspace receipt methods.

use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::*;
use kcoder_workspace_resources::managed_worktrees::validate_worktree_id;
use std::path::Path;

fn atom(value: &str, max: usize) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control),
        "Invalid workspace operation input"
    );
    Ok(())
}
pub fn validate_digest(value: &str) -> Result<()> {
    ensure!(
        value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid workspace scope"
    );
    Ok(())
}
fn path(value: &str) -> Result<()> {
    atom(value, 4096)?;
    ensure!(
        Path::new(value).is_absolute(),
        "Invalid workspace operation path"
    );
    Ok(())
}

/// Pure validation precedes root verification and all storage access.
pub fn validate_request(request: &PrivateRetentionRequestV1) -> Result<Option<String>> {
    atom(
        request
            .private_retention
            .workspace_target_id
            .as_deref()
            .context("Missing trusted target")?,
        256,
    )?;
    match (
        &request.private_retention.context.principal,
        &request.private_retention.workspace_account,
    ) {
        (RetentionPrincipalV1::LocalOs, None) => {}
        (RetentionPrincipalV1::VerifiedAccount { .. }, Some(account)) => {
            atom(&account.role, 64)?;
            let generation = account.authorization_generation.parse::<u64>()?;
            ensure!(
                generation.to_string() == account.authorization_generation,
                "Invalid account generation"
            );
        }
        _ => anyhow::bail!("Invalid workspace parent account"),
    }
    let (id, expected) = match request.method.as_str() {
        METHOD_WORKSPACE_OPERATION_SCOPE_V2 => {
            let _: WorkspaceOperationScopeParamsV2 =
                serde_json::from_value(request.params.clone())?;
            return Ok(None);
        }
        METHOD_WORKSPACE_OPERATION_READ_V2 => {
            let input: WorkspaceOperationReadParamsV2 =
                serde_json::from_value(request.params.clone())?;
            (input.client_request_id, input.scope_id)
        }
        METHOD_WORKSPACE_OPEN_V2 | METHOD_WORKSPACE_PREPARE_V2 => {
            let input: WorkspaceOperationMutationParamsV2 =
                serde_json::from_value(request.params.clone())?;
            path(&input.workspace_path)?;
            for value in [&input.label, &input.name].into_iter().flatten() {
                atom(value, 256)?;
            }
            if let Some(value) = &input.project_key {
                atom(value, 512)?;
            }
            if let Some(runtime) = &input.runtime {
                ensure!(
                    matches!(runtime.as_str(), "kcoder" | "codex"),
                    "Invalid runtime"
                );
            }
            (input.client_request_id, input.scope_id)
        }
        METHOD_WORKTREE_PREPARE_V2 => {
            let input: WorktreeOperationMutationParamsV2 =
                serde_json::from_value(request.params.clone())?;
            path(&input.source_path)?;
            validate_worktree_id(&input.worktree_id)?;
            if let Some(value) = &input.git_ref {
                atom(value, 512)?;
            }
            (input.client_request_id, input.scope_id)
        }
        _ => anyhow::bail!("Invalid workspace receipt method"),
    };
    atom(&id, 128)?;
    validate_digest(&expected)?;
    Ok(Some(expected))
}
