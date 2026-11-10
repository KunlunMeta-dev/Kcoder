//! A strict read projection of the existing Native workspace registry. It never writes user metadata.
use super::*;
use serde::de::DeserializeOwned;
use std::{collections::BTreeSet, fs::File};
struct RegistryReadLease {
    _file: File,
}
fn lock_identity(file: &File) -> Result<PortableLeaseIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        // SAFETY: geteuid only reads the current process identity.
        ensure!(
            metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o7022 == 0,
            "imported_project_registry_unsafe"
        );
    }
    #[cfg(windows)]
    crate::file_permissions::verify_windows_user_only_file_handle(file)?;
    PortableLeaseIdentity::from_regular_handle(file)
}

const REGISTRY: &str = "client-workspaces.json";
const REGISTRY_LOCK: &str = "client-workspaces.lock";
const MAX_REGISTRY_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectWorkspaceRegistryBinding {
    directory: PathBuf,
    directory_identity: String,
    lock_identity: PortableLeaseIdentity,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectWorkspaceMembership {
    registry: ProjectWorkspaceRegistryBinding,
    project_key: String,
    roots: Vec<String>,
}
#[derive(Clone)]
pub struct ProjectRegisteredWorkspace {
    pub project_key: String,
    pub label: String,
    /// These are existing Native registry values, not client-selected authorization paths.
    pub roots: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    workspace_path: String,
    label: String,
    project_key: String,
    #[serde(default)]
    roots: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    version: u64,
    records: BTreeMap<String, Record>,
    #[serde(default)]
    project_order: Vec<String>,
}
pub struct ProjectWorkspaceRegistry {
    directory: PrivateDirectory,
    binding: ProjectWorkspaceRegistryBinding,
}
fn text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn read<T: DeserializeOwned>(directory: &PrivateDirectory) -> Result<T> {
    let mut file = directory.open_single_link_regular_file(OsStr::new(REGISTRY))?;
    ensure!(
        file.metadata()?.len() <= MAX_REGISTRY_BYTES,
        "imported_project_registry_budget_exceeded"
    );
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_REGISTRY_BYTES + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_REGISTRY_BYTES,
        "imported_project_registry_budget_exceeded"
    );
    serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("imported_project_registry_invalid"))
}
impl ProjectWorkspaceRegistry {
    /// The Host supplies the original ClientWorkspaceStore base from its Engine context.
    /// This constructor must not be exposed as an RPC that accepts an arbitrary directory.
    pub fn open_native(directory: &Path) -> Result<Self> {
        let path = dunce::canonicalize(directory)?;
        let directory = PrivateDirectory::open_existing(directory)?;
        directory.verify_trusted_config_directory()?;
        let binding = ProjectWorkspaceRegistryBinding {
            directory: path,
            directory_identity: directory.directory_identity()?,
            lock_identity: lock_identity(
                &directory.open_single_link_regular_file(OsStr::new(REGISTRY_LOCK))?,
            )?,
        };
        let registry = Self { directory, binding };
        registry.verify()?;
        Ok(registry)
    }
    fn reopen(binding: &ProjectWorkspaceRegistryBinding) -> Result<Self> {
        let directory = PrivateDirectory::open_existing(&binding.directory)?;
        let registry = Self {
            directory,
            binding: binding.clone(),
        };
        registry.verify()?;
        Ok(registry)
    }
    fn verify(&self) -> Result<()> {
        self.directory.verify_trusted_config_directory()?;
        ensure!(
            self.directory.directory_identity()? == self.binding.directory_identity
                && PrivateDirectory::open_existing(&self.binding.directory)?
                    .directory_identity()?
                    == self.binding.directory_identity,
            "imported_project_registry_changed"
        );
        ensure!(
            lock_identity(
                &self
                    .directory
                    .open_single_link_regular_file(OsStr::new(REGISTRY_LOCK))?
            )? == self.binding.lock_identity,
            "imported_project_registry_changed"
        );
        Ok(())
    }
    fn lock(&self) -> Result<RegistryReadLease> {
        self.verify()?;
        let deadline = Instant::now() + Duration::from_millis(250);
        loop {
            let file = self
                .directory
                .open_single_link_regular_file(OsStr::new(REGISTRY_LOCK))?;
            ensure!(
                lock_identity(&file)? == self.binding.lock_identity,
                "imported_project_registry_changed"
            );
            let locked = fs2::FileExt::try_lock_shared(&file);
            self.verify()?;
            ensure!(
                lock_identity(&file)? == self.binding.lock_identity,
                "imported_project_registry_changed"
            );
            match locked {
                Ok(()) => return Ok(RegistryReadLease { _file: file }),
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.raw_os_error().is_some_and(|code| {
                            Some(code) == fs2::lock_contended_error().raw_os_error()
                        }) => {}
                Err(error) => return Err(error.into()),
            }
            ensure!(Instant::now() < deadline, "imported_project_registry_busy");
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    fn project_rows(&self) -> Result<Vec<ProjectRegisteredWorkspace>> {
        let registry: Registry = read(&self.directory)?;
        ensure!(
            registry.version == 1
                && registry.records.len() <= 4096
                && registry.project_order.len() <= 4096,
            "imported_project_registry_invalid"
        );
        let mut groups: BTreeMap<String, ProjectRegisteredWorkspace> = BTreeMap::new();
        for (key, row) in registry.records {
            ensure!(
                key == row.workspace_path
                    && text(&row.workspace_path, 4096)
                    && Path::new(&row.workspace_path).is_absolute()
                    && text(&row.project_key, 4096)
                    && text(&row.label, 256)
                    && row.roots.len() <= 64,
                "imported_project_registry_invalid"
            );
            let roots = if row.roots.is_empty() {
                vec![row.workspace_path.clone()]
            } else {
                row.roots
            };
            ensure!(
                roots
                    .iter()
                    .all(|root| text(root, 4096) && Path::new(root).is_absolute())
                    && roots.iter().collect::<BTreeSet<_>>().len() == roots.len()
                    && roots.contains(&row.workspace_path),
                "imported_project_registry_invalid"
            );
            let group = groups.entry(row.project_key.clone()).or_insert_with(|| {
                ProjectRegisteredWorkspace {
                    project_key: row.project_key,
                    label: row.label.clone(),
                    roots: roots.clone(),
                }
            });
            ensure!(group.roots == roots, "imported_project_registry_conflict");
            if group.roots[0] == row.workspace_path {
                group.label = row.label;
            }
        }
        let positions = registry
            .project_order
            .iter()
            .enumerate()
            .map(|(index, key)| (key, index))
            .collect::<BTreeMap<_, _>>();
        let mut rows = groups.into_values().collect::<Vec<_>>();
        rows.sort_by(|a, b| {
            (
                positions.get(&a.project_key).copied().unwrap_or(usize::MAX),
                &a.project_key,
            )
                .cmp(&(
                    positions.get(&b.project_key).copied().unwrap_or(usize::MAX),
                    &b.project_key,
                ))
        });
        Ok(rows)
    }
    pub fn list(&self) -> Result<Vec<ProjectRegisteredWorkspace>> {
        let _guard = self.lock()?;
        self.project_rows()
    }
    /// Capture metadata and membership under one original registry lock/read.
    pub fn pinned_projects(
        &self,
    ) -> Result<Vec<(ProjectRegisteredWorkspace, ProjectWorkspaceMembership)>> {
        let _guard = self.lock()?;
        Ok(self
            .project_rows()?
            .into_iter()
            .map(|row| {
                let membership = ProjectWorkspaceMembership {
                    registry: self.binding.clone(),
                    project_key: row.project_key.clone(),
                    roots: row.roots.clone(),
                };
                (row, membership)
            })
            .collect())
    }
    pub fn pin(&self, project_key: &str) -> Result<ProjectWorkspaceMembership> {
        let _guard = self.lock()?;
        let row = self
            .project_rows()?
            .into_iter()
            .find(|row| row.project_key == project_key)
            .ok_or_else(|| anyhow::anyhow!("imported_project_workspace_unregistered"))?;
        Ok(ProjectWorkspaceMembership {
            registry: self.binding.clone(),
            project_key: row.project_key,
            roots: row.roots,
        })
    }
}
impl ProjectWorkspaceMembership {
    /// This checks the original Native metadata namespace, not current membership/trust.
    /// Removing a workspace must not prevent removal of our own unchanged association.
    pub fn verify_registry_root(&self, root: &Path) -> Result<()> {
        let directory = PrivateDirectory::open_existing(root)?;
        directory.verify_trusted_config_directory()?;
        ensure!(
            directory.directory_identity()? == self.registry.directory_identity,
            "migration_wrong_target"
        );
        Ok(())
    }
    fn verify_mapping(&self, record: &ImportedProjectAssociation) -> Result<()> {
        ensure!(
            record.target.project_key == self.project_key
                && self
                    .roots
                    .first()
                    .is_some_and(|root| Path::new(root) == record.target.workspace)
                && record.target.roots.iter().all(|mapped| self
                    .roots
                    .iter()
                    .any(|root| Path::new(root) == mapped.target_root)),
            "imported_project_workspace_unregistered"
        );
        Ok(())
    }
    pub fn check_association(
        &self,
        store: &ImportedProjectAssociationsStore,
        record: &ImportedProjectAssociation,
    ) -> Result<()> {
        self.verify_mapping(record)?;
        self.with_registered(|| store.check_association(record))
    }
    pub fn associate(
        &self,
        store: &ImportedProjectAssociationsStore,
        record: &ImportedProjectAssociation,
    ) -> Result<ImportedProjectReceipt> {
        self.verify_mapping(record)?;
        self.with_registered(|| store.associate(record))
    }
    pub fn project_key(&self) -> &str {
        &self.project_key
    }
    pub fn roots(&self) -> &[String] {
        &self.roots
    }
    /// Lock order is original workspace registry, then imported associations. No network or
    /// model work belongs in this closure. The old workspace writer uses this same fs2 lock.
    pub fn with_registered<T>(&self, action: impl FnOnce() -> Result<T>) -> Result<T> {
        let registry = ProjectWorkspaceRegistry::reopen(&self.registry)?;
        let _guard = registry.lock()?;
        let row = registry
            .project_rows()?
            .into_iter()
            .find(|row| row.project_key == self.project_key)
            .ok_or_else(|| anyhow::anyhow!("imported_project_workspace_unregistered"))?;
        ensure!(row.roots == self.roots, "imported_project_registry_changed");
        action()
    }
}
