//! Discovery stage of configuration loading.

use super::*;

impl ConfigScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Executable => "executable",
            Self::Project => "project",
            Self::Local => "local",
        }
    }
}

impl ConfigPaths {
    pub fn discover(cwd: &Path) -> Result<Self> {
        let config_dir = user_config_dir()?;
        Ok(Self::with_config_dir(cwd, config_dir))
    }

    pub fn with_config_dir(cwd: &Path, config_dir: PathBuf) -> Self {
        let executable_dir = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf));
        Self::with_config_dir_and_executable_dir(cwd, config_dir, executable_dir)
    }

    pub fn with_config_dir_and_executable_dir(
        cwd: &Path,
        config_dir: PathBuf,
        executable_dir: Option<PathBuf>,
    ) -> Self {
        let cwd = canonical_or_original(cwd);
        let project_root = cwd;
        let project_config_dir = project_root.join(".kcoder");
        let executable_settings = executable_dir
            .map(|dir| canonical_or_original(&dir).join("settings.json"))
            .unwrap_or_default();
        Self {
            user_settings: config_dir.join("settings.json"),
            executable_settings,
            credentials: config_dir.join("credentials.json"),
            config_dir,
            project_settings: project_config_dir.join("settings.json"),
            local_settings: project_config_dir.join("settings.local.json"),
            project_root,
        }
    }

    pub fn for_scope(&self, scope: ConfigScope) -> &Path {
        match scope {
            ConfigScope::User => &self.user_settings,
            ConfigScope::Executable => &self.executable_settings,
            ConfigScope::Project => &self.project_settings,
            ConfigScope::Local => &self.local_settings,
        }
    }
}

/// Resolve the user-level KCoder configuration directory.
///
/// Use the frozen business snapshot when initialized, otherwise perform a pure
/// storage-path query. Explicit profiles and the libtest guard remain isolated
/// from the personal location record; the resolver owns default/development paths.
pub fn user_config_dir() -> Result<PathBuf> {
    Ok(crate::storage::current_storage_paths()?.data_root)
}

#[cfg(test)]
pub(super) fn resolve_user_config_dir(
    config_override: Option<std::ffi::OsString>,
    kcoder_home: Option<std::ffi::OsString>,
    executable_stem: Option<std::ffi::OsString>,
    home_dir: Option<PathBuf>,
) -> Result<PathBuf> {
    let mut env = BTreeMap::new();
    if let Some(value) = config_override {
        env.insert(CONFIG_DIR_ENV.into(), value);
    }
    if let Some(value) = kcoder_home {
        env.insert(KCODER_HOME_ENV.into(), value);
    }
    Ok(
        crate::storage::resolve_storage_paths(&crate::storage::StorageResolveInput {
            home: home_dir,
            development: executable_stem
                .as_deref()
                .is_some_and(|stem| stem.eq_ignore_ascii_case(DEVELOPMENT_EXECUTABLE_STEM)),
            env,
            ..Default::default()
        })?
        .data_root,
    )
}

pub(super) fn canonical_or_original(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}
