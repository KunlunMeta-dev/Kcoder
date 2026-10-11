//! Execution-profile plugin credential lookup. Never modifies global environment.
use anyhow::Result;
use kcoder_config::{CredentialStore, CredentialStoreMode, OsCredentialBackend};
use kcoder_plugins::PluginManager;
use std::{collections::BTreeMap, path::Path};

pub(crate) fn by_scope(
    path: &Path,
    mode: CredentialStoreMode,
) -> Result<BTreeMap<String, BTreeMap<String, String>>> {
    let store = CredentialStore::load_from(path)?;
    let backend = OsCredentialBackend::new();
    store
        .plugin_credentials
        .scopes
        .keys()
        .map(|scope| {
            store
                .plugin_credentials
                .resolve(scope, &backend, mode)
                .map(|values| (scope.clone(), values))
        })
        .collect()
}

pub(crate) fn by_operation(
    path: &Path,
    mode: CredentialStoreMode,
    manager: &PluginManager,
) -> Result<BTreeMap<String, BTreeMap<String, String>>> {
    let store = CredentialStore::load_from(path)?;
    let backend = OsCredentialBackend::new();
    let installed = manager.store().installed_plugins()?;
    let mut result = BTreeMap::new();
    for (scope, entry) in &store.plugin_credentials.scopes {
        let Some(operation) = &entry.operation_id else {
            continue;
        };
        let Some(record) = installed
            .iter()
            .find(|record| &record.operation_id == operation)
        else {
            continue;
        };
        let declared = manager.required_mcp_environment_names(&record.plugin_id)?;
        let mut values = store.plugin_credentials.resolve(scope, &backend, mode)?;
        values.retain(|name, _| declared.contains(name));
        result.insert(operation.clone(), values);
    }
    Ok(result)
}

pub(crate) fn bind_install(path: &Path, scope: &str, operation: &str) -> Result<()> {
    CredentialStore::update_file(path, |store| {
        if let Some(entry) = store.plugin_credentials.scopes.get_mut(scope) {
            entry.operation_id = Some(operation.into());
        }
        store.plugin_credentials.validate()
    })
}
