//! Scope-owned copies retain exactly the original sealed component bytes.
use super::*;
use std::io::Read;

pub struct NativeOfficeRetainedScopeResources {
    pub component_root: PathBuf,
    pub runtime_program: PathBuf,
}

impl NativeOfficeLaunchAuthority {
    pub async fn retain_scope_resources(
        self,
        target: &PrivateDirectory,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<NativeOfficeRetainedScopeResources> {
        self.context.verify()?;
        target.verify_private_directory()?;
        ensure!(
            path.is_absolute()
                && PrivateDirectory::open_existing(path)?.directory_identity()?
                    == target.directory_identity()?,
            "OFFICE_SCOPE_COPY_OWNER_CHANGED"
        );
        let lease = self.resource_lease()?;
        lease.verify(cancel).await?;
        let root = target.duplicate_handle()?;
        let location = path.to_path_buf();
        let token = cancel.child_token();
        let _stop_on_drop = token.clone().drop_guard();
        let copy_lease = lease.clone();
        let copied =
            tokio::task::spawn_blocking(move || retain(&copy_lease, &root, &location, &token))
                .await
                .context("OFFICE_SCOPE_COPY_UNCONFIRMED")??;
        lease.verify(cancel).await?;
        self.context.verify()?;
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        Ok(copied)
    }
}

pub(super) fn retain(
    source: &ResourceLease,
    target: &PrivateDirectory,
    path: &Path,
    cancel: &CancellationToken,
) -> Result<NativeOfficeRetainedScopeResources> {
    ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
    source.verify_sync(cancel)?;
    target.verify_private_directory()?;
    ensure!(
        PrivateDirectory::open_existing(path)?.directory_identity()?
            == target.directory_identity()?,
        "OFFICE_SCOPE_COPY_OWNER_CHANGED"
    );
    let office = target.open_child(OsStr::new("office"), true)?;
    office.verify_private_directory()?;
    let office_path = path.join("office");
    let root_path = source.root_path.canonicalize()?;
    let runtime_path = source.runtime.program.canonicalize()?;
    let runtime_relative = runtime_path.strip_prefix(&root_path).ok();
    if let Some(relative) = runtime_relative {
        let name = relative
            .to_str()
            .context("OFFICE_SCOPE_COPY_INVALID")?
            .replace('\\', "/");
        ensure!(
            source
                .manifest
                .files
                .iter()
                .any(|entry| entry.path == name && entry.sha256 == source.runtime.sha256),
            "OFFICE_SCOPE_RUNTIME_NOT_IN_MANIFEST"
        );
    }
    let program = runtime_relative.map_or_else(
        || source.runtime.program.clone(),
        |relative| office_path.join(relative),
    );
    let mut present = 0usize;
    office.visit_entry_names_bounded(20001, |_| {
        present += 1;
        Ok(())
    })?;
    if present == 0 {
        for entry in &source.manifest.files {
            ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
            let names = resource_files::parts(&entry.path)?;
            let mut parent = office.duplicate_handle()?;
            for name in &names[..names.len() - 1] {
                parent = parent.open_child(OsStr::new(name), true)?;
                parent.verify_private_directory()?;
            }
            let mut input = resource_files::open_relative(&source.root, &entry.path)?;
            ensure!(
                input.metadata()?.len() == entry.bytes,
                "OFFICE_COMPONENT_IDENTITY_CHANGED"
            );
            let mut content = Vec::with_capacity(usize::try_from(entry.bytes)?);
            let mut buffer = [0; 65536];
            let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
            loop {
                ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
                let count = input.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                ensure!(
                    (content.len() as u64).saturating_add(count as u64) <= entry.bytes,
                    "OFFICE_COMPONENT_IDENTITY_CHANGED"
                );
                hash.update(&buffer[..count]);
                content.extend_from_slice(&buffer[..count]);
            }
            let sha = hash
                .finish()
                .as_ref()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            ensure!(
                content.len() as u64 == entry.bytes
                    && input.metadata()?.len() == entry.bytes
                    && sha == entry.sha256,
                "OFFICE_COMPONENT_IDENTITY_CHANGED"
            );
            let leaf = OsStr::new(names.last().context("OFFICE_SCOPE_COPY_INVALID")?);
            parent.atomic_replace(leaf, &content)?;
            #[cfg(unix)]
            if runtime_relative.is_some_and(|relative| {
                source.root_path.join(relative) == source.root_path.join(&entry.path)
            }) {
                use std::os::unix::fs::PermissionsExt;
                parent
                    .open_single_link_regular_file(leaf)?
                    .set_permissions(std::fs::Permissions::from_mode(0o700))?;
            }
        }
        let manifest = read_leaf(&source.root, MANIFEST, 4 * 1024 * 1024)?;
        ensure!(
            hex(&manifest) == source.manifest_sha256,
            "OFFICE_COMPONENT_IDENTITY_CHANGED"
        );
        office.atomic_replace(OsStr::new(MANIFEST), &manifest)?;
    }
    // Existing nonempty/partial copies are observed, never repaired or overwritten.
    let manifest =
        read_leaf(&office, MANIFEST, 4 * 1024 * 1024).context("OFFICE_SCOPE_COPY_UNCONFIRMED")?;
    ensure!(
        hex(&manifest) == source.manifest_sha256,
        "OFFICE_SCOPE_COPY_CONFLICT"
    );
    let mut runtime = source.runtime.clone();
    runtime.program = program.clone();
    let retained = ResourceLease {
        root_identity: office.directory_identity()?,
        root: Arc::new(office),
        root_path: office_path.clone(),
        manifest_sha256: source.manifest_sha256.clone(),
        runtime,
        manifest: source.manifest.clone(),
        runtime_mode_verified: source.runtime_mode_verified.clone(),
    };
    retained.verify_sync(cancel)?;
    source.verify_sync(cancel)?;
    target.verify_private_directory()?;
    ensure!(
        PrivateDirectory::open_existing(path)?.directory_identity()?
            == target.directory_identity()?,
        "OFFICE_SCOPE_COPY_OWNER_CHANGED"
    );
    Ok(NativeOfficeRetainedScopeResources {
        component_root: office_path,
        runtime_program: program,
    })
}
