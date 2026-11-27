//! Read and save the permission default owned by the connected runtime target.

use super::*;
use anyhow::{Context, Result};
use kcoder_app_protocol::{ExecutionDefaultsReadResult, ExecutionDefaultsSaveParams};

fn to_protocol_mode(
    mode: kcoder_config::PermissionMode,
) -> kcoder_app_protocol::ExecutionPermissionMode {
    match mode {
        kcoder_config::PermissionMode::Ask => kcoder_app_protocol::ExecutionPermissionMode::Ask,
        kcoder_config::PermissionMode::Auto => kcoder_app_protocol::ExecutionPermissionMode::Auto,
        kcoder_config::PermissionMode::AcceptEdits => {
            kcoder_app_protocol::ExecutionPermissionMode::AcceptEdits
        }
        kcoder_config::PermissionMode::DontAsk => {
            kcoder_app_protocol::ExecutionPermissionMode::DontAsk
        }
        kcoder_config::PermissionMode::Bypass => {
            kcoder_app_protocol::ExecutionPermissionMode::Bypass
        }
        kcoder_config::PermissionMode::Yolo => kcoder_app_protocol::ExecutionPermissionMode::Yolo,
    }
}

fn from_protocol_mode(
    mode: kcoder_app_protocol::ExecutionPermissionMode,
) -> kcoder_config::PermissionMode {
    match mode {
        kcoder_app_protocol::ExecutionPermissionMode::Ask => kcoder_config::PermissionMode::Ask,
        kcoder_app_protocol::ExecutionPermissionMode::Auto => kcoder_config::PermissionMode::Auto,
        kcoder_app_protocol::ExecutionPermissionMode::AcceptEdits => {
            kcoder_config::PermissionMode::AcceptEdits
        }
        kcoder_app_protocol::ExecutionPermissionMode::DontAsk => {
            kcoder_config::PermissionMode::DontAsk
        }
        kcoder_app_protocol::ExecutionPermissionMode::Bypass => {
            kcoder_config::PermissionMode::Bypass
        }
        kcoder_app_protocol::ExecutionPermissionMode::Yolo => kcoder_config::PermissionMode::Yolo,
    }
}

pub(super) fn read(
    engine: &QueryEngine,
    engine_factory: &AppServerEngineFactory,
) -> Result<ExecutionDefaultsReadResult> {
    let path = engine
        .settings_persistence_path()
        .context("Execution defaults are unavailable because this target has no settings file")?;
    let user_settings = kcoder_config::read_settings_file(&path)?;
    let persisted_permission_mode = user_settings
        .get("permission_mode")
        .cloned()
        .map(|value| {
            serde_json::from_value::<kcoder_config::PermissionMode>(value)
                .context("stored permission_mode is invalid")
        })
        .transpose()?
        .map(to_protocol_mode);
    let effective_permission_mode = engine_factory.current_settings()?.permission_mode;
    let cli_permission_mode_override = engine_factory.cli_permission_mode_override()?;
    Ok(ExecutionDefaultsReadResult {
        persisted_permission_mode,
        effective_permission_mode: to_protocol_mode(effective_permission_mode),
        cli_permission_mode_override: cli_permission_mode_override.map(to_protocol_mode),
    })
}

pub(super) fn save(
    engine: &QueryEngine,
    engine_factory: &AppServerEngineFactory,
    params: ExecutionDefaultsSaveParams,
) -> Result<ExecutionDefaultsReadResult> {
    let path = engine
        .settings_persistence_path()
        .context("Execution defaults are unavailable because this target has no settings file")?;
    match params.permission_mode {
        Some(mode) => {
            let value = serde_json::to_value(from_protocol_mode(mode))?;
            kcoder_config::update_settings_file(&path, |user| {
                kcoder_config::set_dotted_value(user, "permission_mode", value.clone())
            })?;
        }
        None => {
            kcoder_config::update_settings_file(&path, |user| {
                kcoder_config::remove_dotted_value(user, "permission_mode").map(|_| ())
            })?;
        }
    }
    read(engine, engine_factory)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_permission_mode_round_trips_between_runtime_and_protocol() {
        for mode in [
            kcoder_config::PermissionMode::Ask,
            kcoder_config::PermissionMode::Auto,
            kcoder_config::PermissionMode::AcceptEdits,
            kcoder_config::PermissionMode::DontAsk,
            kcoder_config::PermissionMode::Bypass,
            kcoder_config::PermissionMode::Yolo,
        ] {
            assert_eq!(from_protocol_mode(to_protocol_mode(mode)), mode);
        }
    }
}
