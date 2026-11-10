use super::*;
use kcoder_config::PrivateDirectory;
use std::{ffi::OsStr, path::Component};

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}
fn safe(error: anyhow::Error) -> anyhow::Error {
    if missing(&error) {
        anyhow::anyhow!("migration_source_changed")
    } else {
        anyhow::anyhow!("migration_unsafe_source_path")
    }
}
fn file_identity(directory: &PrivateDirectory, name: &OsStr) -> Result<String> {
    let file = directory
        .open_single_link_regular_file(name)
        .map_err(safe)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file
            .metadata()
            .map_err(|_| anyhow::anyhow!("migration_source_unavailable"))?;
        Ok(format!("unix:{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        // SAFETY: this Win32 output structure permits zero initialization.
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: the owned regular descriptor and output structure are valid for the call.
        ensure!(
            unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } != 0,
            "migration_source_unavailable"
        );
        Ok(format!(
            "windows:{}:{}:{}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        ))
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Directory {
    anchor: PathBuf,
    identity: String,
    absent: Vec<String>,
}
impl Directory {
    fn capture(path: &Path) -> Result<Self> {
        ensure!(
            path.is_absolute()
                && path
                    .components()
                    .all(|part| !matches!(part, Component::CurDir | Component::ParentDir)),
            "migration_unsafe_source_path"
        );
        let mut current = path.to_owned();
        let mut absent = Vec::new();
        loop {
            match PrivateDirectory::open_existing(&current) {
                Ok(directory) => {
                    directory.verify_trusted_config_directory().map_err(safe)?;
                    let anchor = current
                        .canonicalize()
                        .map_err(|_| anyhow::anyhow!("migration_source_unavailable"))?;
                    let identity = directory.directory_identity().map_err(safe)?;
                    ensure!(
                        PrivateDirectory::open_existing(&anchor)?.directory_identity()? == identity,
                        "migration_source_changed"
                    );
                    absent.reverse();
                    let result = Self {
                        anchor,
                        identity,
                        absent,
                    };
                    result.open()?;
                    return Ok(result);
                }
                Err(error) if missing(&error) => {
                    ensure!(absent.len() < 16, "migration_source_budget_exceeded");
                    let name = current
                        .file_name()
                        .and_then(OsStr::to_str)
                        .filter(|name| !name.is_empty() && name.len() <= 4096)
                        .ok_or_else(|| anyhow::anyhow!("migration_unsafe_source_path"))?
                        .to_owned();
                    ensure!(current.pop(), "migration_unsafe_source_path");
                    absent.push(name);
                }
                Err(error) => return Err(safe(error)),
            }
        }
    }
    fn path(&self) -> PathBuf {
        self.absent
            .iter()
            .fold(self.anchor.clone(), |path, name| path.join(name))
    }
    fn anchor(&self) -> Result<PrivateDirectory> {
        ensure!(
            self.anchor.is_absolute()
                && self
                    .anchor
                    .components()
                    .all(|part| !matches!(part, Component::CurDir | Component::ParentDir))
                && self.absent.len() <= 16
                && self.absent.iter().all(|name| !name.is_empty()
                    && name.len() <= 4096
                    && Path::new(name).components().count() == 1
                    && matches!(
                        Path::new(name).components().next(),
                        Some(Component::Normal(_))
                    )),
            "migration_invalid_source_binding"
        );
        let directory = PrivateDirectory::open_existing(&self.anchor).map_err(safe)?;
        directory.verify_trusted_config_directory().map_err(safe)?;
        ensure!(
            directory.directory_identity().map_err(safe)? == self.identity,
            "migration_source_changed"
        );
        Ok(directory)
    }
    fn open(&self) -> Result<Option<PrivateDirectory>> {
        let directory = self.anchor()?;
        if let Some(first) = self.absent.first() {
            match directory.entry_metadata(OsStr::new(first)) {
                Err(error) if missing(&error) => return Ok(None),
                _ => anyhow::bail!("migration_source_changed"),
            }
        }
        Ok(Some(directory))
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Layer {
    scope: ConfigurationLayerScope,
    directory: Directory,
    name: String,
    revision: Option<String>,
    identity: Option<String>,
}
impl Layer {
    pub(crate) fn capture(root: &Path, name: &str, scope: ConfigurationLayerScope) -> Result<Self> {
        ensure!(
            matches!(
                name,
                "settings.json" | "settings.local.json" | "config.toml"
            ),
            "migration_invalid_source_binding"
        );
        let directory = Directory::capture(root)?;
        let mut value = Self {
            scope,
            directory,
            name: name.into(),
            revision: None,
            identity: None,
        };
        if let Some(root) = value.directory.open()? {
            match root.entry_metadata(OsStr::new(name)) {
                Err(error) if missing(&error) => {}
                Err(error) => return Err(safe(error)),
                Ok(_) => {
                    let identity = file_identity(&root, OsStr::new(name))?;
                    let document = SourceDocument::read_configuration_at(&root, OsStr::new(name))?;
                    ensure!(
                        file_identity(&root, OsStr::new(name))? == identity,
                        "migration_source_changed"
                    );
                    value.revision = Some(document.revision());
                    value.identity = Some(identity);
                }
            }
        }
        Ok(value)
    }
    pub(crate) fn refreshed(&self) -> Result<Self> {
        self.directory.anchor()?;
        Self::capture(&self.directory.path(), &self.name, self.scope)
    }
    pub(crate) fn read(&self) -> Result<Option<SourceDocument>> {
        ensure!(
            matches!(
                self.name.as_str(),
                "settings.json" | "settings.local.json" | "config.toml"
            ) && self.revision.is_some() == self.identity.is_some(),
            "migration_invalid_source_binding"
        );
        let Some(root) = self.directory.open()? else {
            ensure!(!self.present(), "migration_source_changed");
            return Ok(None);
        };
        if !self.present() {
            return match root.entry_metadata(OsStr::new(&self.name)) {
                Err(error) if missing(&error) => Ok(None),
                _ => anyhow::bail!("migration_source_changed"),
            };
        }
        let expected = self.identity.as_ref().unwrap();
        ensure!(
            &file_identity(&root, OsStr::new(&self.name))? == expected,
            "migration_source_changed"
        );
        let document = SourceDocument::read_configuration_at(&root, OsStr::new(&self.name))?;
        ensure!(
            &file_identity(&root, OsStr::new(&self.name))? == expected
                && Some(document.revision()) == self.revision,
            "migration_source_changed"
        );
        Ok(Some(document))
    }
    pub(crate) fn present(&self) -> bool {
        self.revision.is_some()
    }
    pub(crate) fn scope(&self) -> ConfigurationLayerScope {
        self.scope
    }
    pub(crate) fn name(&self) -> &str {
        &self.name
    }
    pub(crate) fn path(&self) -> PathBuf {
        self.directory.path().join(&self.name)
    }
    pub(crate) fn directory_path(&self) -> PathBuf {
        self.directory.path()
    }
    pub(crate) fn hash_logical(&self, digest: &mut sha2::Sha256) {
        use sha2::Digest;
        for bytes in [
            self.directory.anchor.as_os_str().as_encoded_bytes(),
            self.directory.identity.as_bytes(),
            self.name.as_bytes(),
        ] {
            digest.update((bytes.len() as u64).to_le_bytes());
            digest.update(bytes);
        }
        for name in &self.directory.absent {
            digest.update((name.len() as u64).to_le_bytes());
            digest.update(name.as_bytes());
        }
        digest.update([match self.scope {
            ConfigurationLayerScope::User => 0,
            ConfigurationLayerScope::Project => 1,
            ConfigurationLayerScope::Local => 2,
        }]);
    }
}
