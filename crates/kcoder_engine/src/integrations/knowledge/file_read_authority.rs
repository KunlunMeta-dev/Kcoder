//! Observe the actual existing file-read permission and sandbox, never mint a grant.
use crate::QueryEngine;
use anyhow::{Context, Result, ensure};
use kcoder_permissions::PermissionDecision;
use std::path::Path;

impl QueryEngine {
    /// Native recurring readers use the same current Read tool rules and
    /// sandbox as ordinary tool execution. Ask requires the existing explicit
    /// permission interaction; this helper never approves it or reads bytes.
    pub fn verify_native_file_observation_read(&self, actual_path: &Path) -> Result<()> {
        ensure!(
            actual_path.is_absolute(),
            "NATIVE_FILE_READ_PATH_UNAVAILABLE"
        );
        self.sandbox
            .check_path(actual_path, false)
            .map_err(|_| anyhow::anyhow!("NATIVE_FILE_READ_SANDBOX_DENIED"))?;
        let path = actual_path
            .to_str()
            .context("NATIVE_FILE_READ_PATH_UNAVAILABLE")?;
        let input = serde_json::json!({"file_path":path,"format":"raw","fresh":true});
        let permission = self
            .permissions
            .read()
            .map_err(|_| anyhow::anyhow!("NATIVE_FILE_READ_POLICY_UNAVAILABLE"))?;
        match permission.decide(&kcoder_tools::FileReadTool, &input) {
            PermissionDecision::Allow => Ok(()),
            PermissionDecision::Ask => anyhow::bail!("NATIVE_FILE_READ_AUTHORIZATION_REQUIRED"),
            PermissionDecision::Deny => anyhow::bail!("NATIVE_FILE_READ_DENIED"),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::test_support::engine_builder::TestEngineBuilder;
    #[test]
    fn native_read_observation_uses_actual_permission_changes_and_never_approves_ask() {
        let root = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(root.path()).build_with_profile_directory();
        let path = root.path().join("selected.txt");
        std::fs::write(&path, "isolated read authority").unwrap();
        engine.permissions.write().unwrap().mode = kcoder_config::PermissionMode::Ask;
        assert_eq!(
            engine
                .verify_native_file_observation_read(&path)
                .unwrap_err()
                .to_string(),
            "NATIVE_FILE_READ_AUTHORIZATION_REQUIRED"
        );
        engine
            .permissions
            .write()
            .unwrap()
            .allow_for_session("read");
        engine.verify_native_file_observation_read(&path).unwrap();
        engine.permissions.write().unwrap().deny_for_session("read");
        assert_eq!(
            engine
                .verify_native_file_observation_read(&path)
                .unwrap_err()
                .to_string(),
            "NATIVE_FILE_READ_DENIED"
        );
    }
    #[test]
    fn native_read_observation_keeps_the_actual_sandbox_denial_even_with_read_allow() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("selected.txt");
        std::fs::write(&path, "isolated sandbox source").unwrap();
        let mut settings = kcoder_config::Settings::default();
        settings.sandbox.enabled = true;
        settings.sandbox.denied_paths = vec![path.to_string_lossy().into_owned()];
        let engine = TestEngineBuilder::new(root.path())
            .settings(settings)
            .build_with_profile_directory();
        engine
            .permissions
            .write()
            .unwrap()
            .allow_for_session("read");
        assert_eq!(
            engine
                .verify_native_file_observation_read(&path)
                .unwrap_err()
                .to_string(),
            "NATIVE_FILE_READ_SANDBOX_DENIED"
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_read_observation_refuses_lossy_path_aliases_before_permission_matching() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};

        let root = tempfile::tempdir().unwrap();
        let path = root
            .path()
            .join(OsString::from_vec(b"selected-\xff.txt".to_vec()));
        std::fs::write(&path, "native path must retain its exact identity").unwrap();
        let engine = TestEngineBuilder::new(root.path()).build_with_profile_directory();
        engine
            .permissions
            .write()
            .unwrap()
            .allow_for_session("read");
        assert_eq!(
            engine
                .verify_native_file_observation_read(&path)
                .unwrap_err()
                .to_string(),
            "NATIVE_FILE_READ_PATH_UNAVAILABLE"
        );
    }
}
