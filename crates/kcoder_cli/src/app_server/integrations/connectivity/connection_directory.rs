//! Read original namespaces at the selected target; never copy connection state.
use super::super::core::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use super::{NativeConnectivityLeaseFacade, NativeConnectivityPublicCall};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::integrations::connectivity::ConnectivityMethod;
use kcoder_config::PrivateDirectory;
use kcoder_types::integrations::{connectivity::*, core::*};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{ffi::OsStr, io::Read, path::Path};

const LOCATOR: &str = "connection-source-locator.json";
const MAX_BYTES: u64 = 16384;

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Locator {
    version: u32,
    namespace_id: String,
    directory_identity: String,
    owner: IntegrationOwner,
    workspace_path: String,
    workspace_identity: String,
    operation_id: String,
}
fn read_locator(directory: &PrivateDirectory) -> Result<Option<Locator>> {
    let file = match directory.open_single_link_regular_file(OsStr::new(LOCATOR)) {
        Ok(file) => file,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_BYTES as usize,
        "CONNECTION_DIRECTORY_LOCATOR_INVALID"
    );
    Ok(Some(serde_json::from_slice(&bytes)?))
}
fn verify_locator(
    locator: &Locator,
    directory: &PrivateDirectory,
    namespace: &str,
    owner: &IntegrationOwner,
) -> Result<()> {
    ensure!(
        locator.version == 1
            && locator.namespace_id == namespace
            && &locator.owner == owner
            && locator.directory_identity == directory.directory_identity()?
            && !locator.operation_id.is_empty()
            && locator.operation_id.len() <= 256
            && !locator.workspace_path.is_empty()
            && locator.workspace_path.len() <= 4096
            && !locator.workspace_path.chars().any(char::is_control)
            && Path::new(&locator.workspace_path).is_absolute(),
        "CONNECTION_DIRECTORY_LOCATOR_INVALID"
    );
    Ok(())
}

/// Invoked only after the exact original Native management mutation completed.
/// The original Main still holds its namespace lease. Atomic publication lets
/// readers observe a complete locator without becoming another business store.
pub(super) fn register(
    caller: &NativeConnectivityPublicCall,
    facade: &NativeConnectivityLeaseFacade,
) -> Result<()> {
    let native = caller.context();
    caller.verify(native.scope())?;
    ensure!(
        native.scope().organization_id.is_none(),
        "CONNECTION_DIRECTORY_ORGANIZATION_POLICY_REQUIRED"
    );
    ensure!(
        caller.call().method == ConnectivityMethod::PrepareConnectionAction
            && matches!(
                caller
                    .call()
                    .request
                    .payload
                    .get("action")
                    .and_then(Value::as_str),
                Some("save" | "start" | "stop")
            ),
        "CONNECTION_DIRECTORY_ORIGINAL_MANAGEMENT_REQUIRED"
    );
    let operation = caller
        .call()
        .request
        .operation_id
        .as_ref()
        .context("CONNECTION_DIRECTORY_OPERATION_REQUIRED")?;
    let namespace = facade.namespace_id(native)?;
    let guard = NativeDomainGuard::observe(
        native.profile()?,
        native.scope(),
        NativeDomain::Connectivity,
    )?
    .context("CONNECTION_DIRECTORY_ORIGINAL_NAMESPACE_REQUIRED")?;
    ensure!(
        guard.namespace_id() == namespace,
        "CONNECTION_DIRECTORY_NAMESPACE_CHANGED"
    );
    let directory = guard.directory(native.profile()?)?;
    let owner = IntegrationOwner::from(native.scope());
    let path = native
        .workspace_path()?
        .to_str()
        .context("CONNECTION_DIRECTORY_PATH_UNREPRESENTABLE")?
        .to_owned();
    let locator = Locator {
        version: 1,
        namespace_id: namespace.into(),
        directory_identity: directory.directory_identity()?,
        owner,
        workspace_path: path,
        workspace_identity: native.workspace_directory_identity()?,
        operation_id: operation.clone(),
    };
    verify_locator(&locator, &directory, namespace, &locator.owner)?;
    if let Some(previous) = read_locator(&directory)? {
        verify_locator(&previous, &directory, namespace, &locator.owner)?;
        ensure!(
            previous.workspace_identity == locator.workspace_identity,
            "CONNECTION_DIRECTORY_WORKSPACE_CHANGED"
        );
        if previous.workspace_path == locator.workspace_path {
            return Ok(());
        }
    }
    caller.verify(native.scope())?;
    directory.atomic_replace(OsStr::new(LOCATOR), &serde_json::to_vec(&locator)?)?;
    guard.directory(native.profile()?)?;
    caller.verify(native.scope())
}

pub(super) fn read(native: &NativeIntegrationContext) -> Result<ConnectivityConnectionDirectory> {
    native.verify()?;
    if native.scope().organization_id.is_some() {
        return Ok(ConnectivityConnectionDirectory {
            supported: false,
            complete: false,
            sources: Vec::new(),
        });
    }
    let (domains, mut complete) = NativeDomainGuard::observe_owned_domains(
        native.profile()?,
        native.profile_path()?,
        native.scope(),
        NativeDomain::Connectivity,
    )?;
    let current_owner = IntegrationOwner::from(native.scope());
    let mut sources = Vec::new();
    for (owner, guard) in domains {
        let current = owner == current_owner;
        let mut source = ConnectivityConnectionSource {
            namespace_id: guard.namespace_id().into(),
            owner: owner.clone(),
            workspace_path: None,
            state: ConnectivityConnectionSourceState::Unregistered,
            current,
        };
        let observation = (|| -> Result<()> {
            let directory = guard.directory(native.profile()?)?;
            if let Some(locator) = read_locator(&directory)? {
                verify_locator(&locator, &directory, guard.namespace_id(), &owner)?;
                source.workspace_path = Some(locator.workspace_path.clone());
                let workspace =
                    PrivateDirectory::open_existing(Path::new(&locator.workspace_path))?;
                ensure!(
                    workspace.directory_identity()? == locator.workspace_identity,
                    "CONNECTION_DIRECTORY_WORKSPACE_UNAVAILABLE"
                );
                // Bind the observed inode to the original Native workspace owner,
                // not merely to another identity supplied inside the locator file.
                NativeIntegrationContext::observe_existing_data_scope(
                    native.profile()?,
                    &workspace,
                    &owner,
                    &native.scope().target_revision,
                )?;
                guard.directory(native.profile()?)?;
                source.state = ConnectivityConnectionSourceState::Available;
            } else if current {
                // This path belongs to the actual caller, not a guessed old owner.
                source.workspace_path = Some(
                    native
                        .workspace_path()?
                        .to_str()
                        .context("CONNECTION_DIRECTORY_PATH_UNREPRESENTABLE")?
                        .into(),
                );
            }
            Ok(())
        })();
        if observation.is_err() {
            source.state = ConnectivityConnectionSourceState::Unavailable;
            complete = false;
        }
        if source.state != ConnectivityConnectionSourceState::Available {
            complete = false;
        }
        sources.push(source);
    }
    native.verify()?;
    Ok(ConnectivityConnectionDirectory {
        supported: true,
        complete,
        sources,
    })
}

pub(super) fn directory_only(
    caller: &NativeConnectivityPublicCall,
) -> Result<Option<IntegrationReply>> {
    if caller.call().method != ConnectivityMethod::ListConnections
        || caller.call().request.payload.get("connectionDirectoryOnly") != Some(&Value::Bool(true))
    {
        return Ok(None);
    }
    caller.verify(caller.context().scope())?;
    ensure!(
        caller.call().request.payload.len() == 1 && caller.call().request.operation_id.is_none(),
        "CONNECTION_DIRECTORY_READ_ONLY"
    );
    let directory = read(caller.context())?;
    caller.verify(caller.context().scope())?;
    let request = &caller.call().request;
    Ok(Some(IntegrationReply {
        contract_version: request.contract_version,
        request_id: request.request_id.clone(),
        operation_id: IntegrationNullable::Null,
        entity_revision: IntegrationNullable::Null,
        status: IntegrationStatus::Completed,
        observed_at: chrono::Utc::now().to_rfc3339(),
        error: IntegrationNullable::Null,
        result: IntegrationNullable::Value(
            json!({"connectionDirectory":directory})
                .as_object()
                .unwrap()
                .clone(),
        ),
    }))
}

#[cfg(test)]
mod tests;
