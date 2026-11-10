use super::*;
use kcoder_config::PrivateLeaseMode;

impl PluginVersionLease {
    pub(super) fn capture(
        store: &PluginStore,
        record: &InstalledPluginRecord,
        lock: FileLock,
    ) -> Result<Self> {
        record.validate()?;
        let state_lock_anchor = store
            .private_locks
            .open_single_link_regular_file(OsStr::new(STATE_LOCK_FILE))?;
        Ok(Self {
            version_lock_identity: store
                .private_locks
                .portable_regular_handle_identity(&lock.file)?,
            _lock: lock,
            plugin_id: record.plugin_id.clone(),
            operation_id: record.operation_id.clone(),
            store: store.private_root.duplicate_handle()?,
            version_path: record.root(&store.root),
            version: PrivateDirectory::open_existing(&record.root(&store.root))?,
            state_lock_identity: store
                .private_locks
                .portable_regular_handle_identity(&state_lock_anchor)?,
            state_lock_anchor,
        })
    }

    /// Identity comparison alone grants nothing. Use verify_runtime_binding for native use.
    pub fn identifies(&self, plugin_id: &str, operation_id: &str) -> bool {
        self.plugin_id.to_string() == plugin_id && self.operation_id == operation_id
    }

    /// Certify only the exact non-secret root environment emitted by the plugin loader.
    /// This is not an account/credential observation or an execution permission.
    pub fn matches_root_environment(
        &self,
        environment: &std::collections::HashMap<String, String>,
    ) -> bool {
        let keys = crate::contributions::mcp::PLUGIN_ROOT_ENVIRONMENT_KEYS;
        let Some(root) = self.version_path.to_str() else {
            return false;
        };
        environment.len() == keys.len()
            && keys
                .iter()
                .all(|key| environment.get(*key).is_some_and(|value| value == root))
    }

    /// Compare complete configurations after substituting only real version-root paths.
    /// This comparison is metadata; callers still verify both live bindings and current policy.
    pub fn same_configuration_except_version_paths(
        &self,
        original: &kcoder_config::McpServerConfig,
        current_lease: &Self,
        current: &kcoder_config::McpServerConfig,
    ) -> bool {
        fn path(value: &str, root: &Path) -> String {
            let Ok(relative) = Path::new(value).strip_prefix(root) else {
                return value.to_owned();
            };
            if relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
            {
                return value.to_owned();
            }
            format!("{{PLUGIN_VERSION_ROOT}}/{}", relative.to_string_lossy())
        }
        fn normalize(
            value: &kcoder_config::McpServerConfig,
            root: &Path,
        ) -> kcoder_config::McpServerConfig {
            let mut value = value.clone();
            value.command = path(&value.command, root);
            for arg in &mut value.args {
                if let Some((key, body)) = arg.split_once('=')
                    && key.starts_with('-')
                    && key
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
                {
                    *arg = format!("{key}={}", path(body, root));
                } else {
                    *arg = path(arg, root);
                }
            }
            for key in crate::contributions::mcp::PLUGIN_ROOT_ENVIRONMENT_KEYS {
                if let Some(item) = value.env.get_mut(key)
                    && Some(item.as_str()) == root.to_str()
                {
                    *item = "{PLUGIN_VERSION_ROOT}".into();
                }
            }
            value.policy.cwd = value.policy.cwd.as_ref().map(|item| path(item, root));
            value.policy.workspace = value.policy.workspace.as_ref().map(|item| path(item, root));
            value
        }
        normalize(original, &self.version_path) == normalize(current, &current_lease.version_path)
    }

    /// Recheck the actual held store/version and current installation without creating storage.
    /// Returns false for a retained older installed version; uninstall and handle replacement fail.
    pub fn verify_runtime_binding(
        &self,
        profile: &PrivateDirectory,
        plugin_id: &str,
        operation_id: &str,
    ) -> Result<bool> {
        anyhow::ensure!(
            self.identifies(plugin_id, operation_id),
            "PLUGIN_VERSION_IDENTITY_MISMATCH"
        );
        profile.verify_private_directory()?;
        let current_store = profile.open_child(OsStr::new("plugin_store"), false)?;
        current_store.verify_private_directory()?;
        self.store.verify_private_directory()?;
        anyhow::ensure!(
            current_store.directory_identity()? == self.store.directory_identity()?,
            "PLUGIN_VERSION_STORE_CHANGED"
        );
        let current_version = PrivateDirectory::open_existing(&self.version_path)?;
        current_version.verify_private_directory()?;
        self.version.verify_private_directory()?;
        anyhow::ensure!(
            current_version.directory_identity()? == self.version.directory_identity()?,
            "PLUGIN_VERSION_DIRECTORY_CHANGED"
        );
        let locks = current_store.open_child(OsStr::new(LOCKS_DIRECTORY), false)?;
        anyhow::ensure!(
            locks.portable_regular_handle_identity(&self._lock.file)? == self.version_lock_identity
                && locks.portable_regular_identity(OsStr::new(&version_lock_name(
                    &self.operation_id
                )?))?
                    == self.version_lock_identity,
            "PLUGIN_VERSION_LOCK_CHANGED"
        );
        anyhow::ensure!(
            locks.portable_regular_handle_identity(&self.state_lock_anchor)?
                == self.state_lock_identity,
            "PLUGIN_VERSION_STATE_LOCK_CHANGED"
        );
        let _state = locks
            .try_existing_portable_lock(
                OsStr::new(STATE_LOCK_FILE),
                &self.state_lock_identity,
                PrivateLeaseMode::Shared,
            )?
            .context("PLUGIN_VERSION_STATE_BUSY")?;
        let file = current_store.open_regular_file_snapshot(OsStr::new("state.json"))?;
        let mut bytes = Vec::new();
        file.take(state::MAX_STATE_BYTES + 1)
            .read_to_end(&mut bytes)?;
        anyhow::ensure!(
            bytes.len() <= state::MAX_STATE_BYTES as usize,
            "PLUGIN_VERSION_STATE_TOO_LARGE"
        );
        let state: StoreState =
            serde_json::from_slice(&bytes).context("PLUGIN_VERSION_STATE_INVALID")?;
        state.validate()?;
        let installed = state
            .installed
            .get(plugin_id)
            .context("PLUGIN_VERSION_UNINSTALLED")?;
        Ok(installed.operation_id == self.operation_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_binding_uses_real_profile_version_and_current_installation() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let owner = PrivateDirectory::open_existing(temp.path())?;
        let profile = owner.create_private_child(OsStr::new("profile"))?;
        let source = temp.path().join("source");
        std::fs::create_dir_all(source.join(".codex-plugin"))?;
        let write = |version: &str| {
            std::fs::write(
                source.join(".codex-plugin/plugin.json"),
                serde_json::json!({"name":"lease-proof","version":version}).to_string(),
            )
        };
        write("1.0.0")?;
        let store = PluginStore::open(&temp.path().join("profile/plugin_store"))?;
        let first = store.install_local(&source, "owned")?;
        let (_, leases) = store.snapshot_with_leases()?;
        let lease = &leases[0];
        let id = first.plugin_id.to_string();
        assert!(lease.verify_runtime_binding(&profile, &id, &first.operation_id)?);
        let mut environment = crate::contributions::mcp::PLUGIN_ROOT_ENVIRONMENT_KEYS
            .into_iter()
            .map(|key| {
                (
                    key.to_owned(),
                    first.root(store.root()).to_string_lossy().into_owned(),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        assert!(lease.matches_root_environment(&environment));
        environment.insert("UNBOUND_PRIVATE_VALUE".into(), "owned-unit-value".into());
        assert!(!lease.matches_root_environment(&environment));
        environment.remove("UNBOUND_PRIVATE_VALUE");
        environment.insert("PLUGIN_ROOT".into(), source.to_string_lossy().into_owned());
        assert!(!lease.matches_root_environment(&environment));
        assert!(
            lease
                .verify_runtime_binding(&profile, &id, "foreign-operation")
                .is_err()
        );
        let foreign = tempfile::tempdir()?;
        let foreign_owner = PrivateDirectory::open_existing(foreign.path())?;
        let foreign_profile = foreign_owner.create_private_child(OsStr::new("profile"))?;
        let _foreign_store = PluginStore::open(&foreign.path().join("profile/plugin_store"))?;
        assert!(
            lease
                .verify_runtime_binding(&foreign_profile, &id, &first.operation_id)
                .is_err()
        );
        write("2.0.0")?;
        let second = store.install_local(&source, "owned")?;
        assert_ne!(first.operation_id, second.operation_id);
        assert!(!lease.verify_runtime_binding(&profile, &id, &first.operation_id)?);
        let (_, current_leases) = store.snapshot_with_leases()?;
        let current_lease = current_leases
            .iter()
            .find(|lease| lease.identifies(&id, &second.operation_id))
            .context("current real version lease")?;
        let original_config: kcoder_config::McpServerConfig = serde_json::from_value(
            serde_json::json!({"name":"owned-configuration","command":"python3","args":[first.root(store.root()).join("server.py")],"env":crate::contributions::mcp::PLUGIN_ROOT_ENVIRONMENT_KEYS.into_iter().map(|key|(key,first.root(store.root()).to_string_lossy().into_owned())).collect::<std::collections::HashMap<_,_>>()}),
        )?;
        let mut current_config = original_config.clone();
        current_config.args = vec![
            second
                .root(store.root())
                .join("server.py")
                .to_string_lossy()
                .into_owned(),
        ];
        current_config.env = crate::contributions::mcp::PLUGIN_ROOT_ENVIRONMENT_KEYS
            .into_iter()
            .map(|key| {
                (
                    key.to_owned(),
                    second.root(store.root()).to_string_lossy().into_owned(),
                )
            })
            .collect();
        assert!(lease.same_configuration_except_version_paths(
            &original_config,
            current_lease,
            &current_config
        ));
        let mut changed_account = current_config.clone();
        changed_account.policy.oauth_account = Some("new-owned-account-slot".into());
        assert!(!lease.same_configuration_except_version_paths(
            &original_config,
            current_lease,
            &changed_account
        ));
        let mut changed_endpoint = current_config.clone();
        changed_endpoint.url = "https://changed.example.invalid/mcp".into();
        assert!(!lease.same_configuration_except_version_paths(
            &original_config,
            current_lease,
            &changed_endpoint
        ));
        let mut changed_policy = current_config.clone();
        changed_policy.policy.disabled_tools.push("old-tool".into());
        assert!(!lease.same_configuration_except_version_paths(
            &original_config,
            current_lease,
            &changed_policy
        ));
        let mut changed_environment = current_config.clone();
        changed_environment
            .env
            .insert("UNBOUND_AUTH".into(), "owned-value".into());
        assert!(!lease.same_configuration_except_version_paths(
            &original_config,
            current_lease,
            &changed_environment
        ));
        #[cfg(unix)]
        {
            let old = first.root(store.root());
            let backup = old.with_file_name("owned-original-version-backup");
            std::fs::rename(&old, &backup)?;
            PrivateDirectory::open_or_create(&old)?;
            assert!(
                lease
                    .verify_runtime_binding(&profile, &id, &first.operation_id)
                    .is_err()
            );
            std::fs::remove_dir(&old)?;
            std::fs::rename(&backup, &old)?;
            assert!(!lease.verify_runtime_binding(&profile, &id, &first.operation_id)?);
            let alias = store.root().join("owned-state-lock-alias");
            std::fs::hard_link(store.root().join("locks/state.lock"), &alias)?;
            assert!(
                lease
                    .verify_runtime_binding(&profile, &id, &first.operation_id)
                    .is_err()
            );
            std::fs::remove_file(alias)?;
        }
        store.uninstall(&first.plugin_id, false)?;
        assert!(first.root(store.root()).exists());
        assert!(
            lease
                .verify_runtime_binding(&profile, &id, &first.operation_id)
                .is_err()
        );
        Ok(())
    }
}
