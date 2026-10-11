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
/// `KCODER_CONFIG_DIR` is the highest-priority explicit override; `KCODER_HOME`
/// selects an explicit profile directory. When neither is set, choose the
/// development profile from the executable name, while regular `kcoder` uses
/// `$HOME/.config/kcoder`。
pub fn user_config_dir() -> Result<PathBuf> {
    resolve_user_config_dir(
        std::env::var_os(CONFIG_DIR_ENV),
        std::env::var_os(KCODER_HOME_ENV),
        std::env::current_exe()
            .ok()
            .and_then(|path| path.file_stem().map(|stem| stem.to_os_string())),
        dirs::home_dir(),
    )
}

pub(super) fn resolve_user_config_dir(
    config_override: Option<std::ffi::OsString>,
    kcoder_home: Option<std::ffi::OsString>,
    executable_stem: Option<std::ffi::OsString>,
    home_dir: Option<PathBuf>,
) -> Result<PathBuf> {
    if let Some(path) = config_override.filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = kcoder_home.filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }

    let home_dir = home_dir.context("could not determine home directory")?;
    let config_dir = home_dir.join(".config").join("kcoder");
    let executable_stem = executable_stem
        .as_deref()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default();
    let development_profile = executable_stem.eq_ignore_ascii_case(DEVELOPMENT_EXECUTABLE_STEM);
    if development_profile {
        return Ok(home_dir.join(".config").join("kcoder-dev"));
    }
    Ok(config_dir)
}

pub(super) fn canonical_or_original(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}
