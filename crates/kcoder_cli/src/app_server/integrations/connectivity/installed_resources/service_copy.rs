//! Retain the original sealed Channel component under the native service owner.
use super::*;
use kcoder_types::integrations::core::NativeScopeHostResources;

impl NativeConnectivityResourceLease {
    pub(in crate::app_server::integrations::connectivity) fn retain_service_resources(
        &self,
        target: &PrivateDirectory,
        target_path: &std::path::Path,
        cancel: &CancellationToken,
    ) -> Result<NativeScopeHostResources> {
        self.verify_for_launch(cancel)?;
        target.verify_private_directory()?;
        ensure!(
            PrivateDirectory::open_existing(target_path)?.directory_identity()?
                == target.directory_identity()?,
            "CHANNEL_SERVICE_RESOURCE_TARGET_CHANGED"
        );
        let bytes = read(&self.root, MANIFEST, 4 * 1024 * 1024)?;
        let manifest: Manifest = serde_json::from_slice(&bytes)?;
        let expected = manifest
            .files
            .iter()
            .map(|entry| (entry.path.as_str(), entry))
            .collect::<BTreeMap<_, _>>();
        let mut directories = BTreeSet::new();
        for path in expected.keys() {
            let components = parts(path)?;
            for end in 1..components.len() {
                directories.insert(components[..end].join("/"));
            }
        }
        copy_branch(&self.root, target, "", 0, &expected, &directories, cancel)?;
        target.atomic_replace(std::ffi::OsStr::new(MANIFEST), &bytes)?;
        self.verify_for_launch(cancel)?;
        ensure!(
            hex(&read(target, MANIFEST, 4 * 1024 * 1024)?) == self.manifest_sha,
            "CHANNEL_SERVICE_RESOURCE_COPY_CHANGED"
        );
        Ok(self.retained_descriptor(target_path))
    }
    pub(in crate::app_server::integrations::connectivity) fn retained_manifest_sha256(
        &self,
        cancel: &CancellationToken,
    ) -> Result<&str> {
        self.verify_runtime_owner(cancel)?;
        Ok(&self.manifest_sha)
    }

    pub(in crate::app_server::integrations::connectivity) fn reuse_service_resources(
        &self,
        target: &PrivateDirectory,
        target_path: &std::path::Path,
        cancel: &CancellationToken,
    ) -> Result<NativeScopeHostResources> {
        self.verify_for_launch(cancel)?;
        target.verify_private_directory()?;
        let original = target.directory_identity()?;
        ensure!(
            PrivateDirectory::open_existing(target_path)?.directory_identity()? == original,
            "CHANNEL_SERVICE_RESOURCE_TARGET_CHANGED"
        );
        let bytes = read(target, MANIFEST, 4 * 1024 * 1024)?;
        ensure!(
            hex(&bytes) == self.manifest_sha,
            "CHANNEL_SERVICE_RESOURCE_COPY_CHANGED"
        );
        let manifest: Manifest = serde_json::from_slice(&bytes)?;
        let expected = manifest
            .files
            .iter()
            .map(|entry| (entry.path.as_str(), entry))
            .collect::<BTreeMap<_, _>>();
        let mut directories = BTreeSet::new();
        for path in expected.keys() {
            let components = parts(path)?;
            for end in 1..components.len() {
                directories.insert(components[..end].join("/"));
            }
        }
        let mut found = BTreeSet::new();
        visit(target, "", 0, &expected, &directories, &mut found, cancel)?;
        ensure!(
            found.len() == expected.len()
                && PrivateDirectory::open_existing(target_path)?.directory_identity()? == original,
            "CHANNEL_SERVICE_RESOURCE_COPY_CHANGED"
        );
        self.verify_runtime_owner(cancel)?;
        Ok(self.retained_descriptor(target_path))
    }

    fn retained_descriptor(&self, target_path: &std::path::Path) -> NativeScopeHostResources {
        NativeScopeHostResources {
            component_root: target_path.to_path_buf(),
            component_manifest_sha256: self.manifest_sha.clone(),
            node_program: self.node.clone(),
            node_image_sha256: self.node_sha.clone(),
            runtime_mode: self.node_mode.clone(),
            node_version: self.node_version.clone(),
            electron_version: self.electron_version.clone(),
        }
    }
}
fn copy_branch(
    source: &PrivateDirectory,
    target: &PrivateDirectory,
    prefix: &str,
    depth: usize,
    expected: &BTreeMap<&str, &ResourceFile>,
    directories: &BTreeSet<String>,
    cancel: &CancellationToken,
) -> Result<()> {
    ensure!(depth <= 40, "CHANNEL_SERVICE_RESOURCE_DEPTH");
    source.visit_entry_names_bounded(20001, |name| {
        ensure!(
            !cancel.is_cancelled(),
            "CHANNEL_SERVICE_RESOURCE_COPY_CANCELLED"
        );
        let component = name
            .to_str()
            .context("CHANNEL_SERVICE_RESOURCE_NAME_INVALID")?;
        let path = if prefix.is_empty() {
            component.to_owned()
        } else {
            format!("{prefix}/{component}")
        };
        if path == MANIFEST {
            return Ok(());
        }
        if let Some(entry) = expected.get(path.as_str()) {
            let file = source.open_single_link_regular_file(name)?;
            ensure!(
                file.metadata()?.len() == entry.bytes && entry.bytes <= 512 * 1024 * 1024,
                "CHANNEL_SERVICE_RESOURCE_COPY_CHANGED"
            );
            let mut bytes = Vec::new();
            std::io::Read::take(file, entry.bytes + 1).read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() as u64 == entry.bytes && hex(&bytes) == entry.sha256,
                "CHANNEL_SERVICE_RESOURCE_COPY_CHANGED"
            );
            target.atomic_replace(name, &bytes)?;
            ensure!(
                hex(&read(target, component, bytes.len())?) == entry.sha256,
                "CHANNEL_SERVICE_RESOURCE_COPY_CHANGED"
            );
        } else {
            ensure!(
                directories.contains(&path),
                "CHANNEL_SERVICE_UNEXPECTED_RESOURCE"
            );
            let child = source.open_entry_handle(name)?.open_child_directory()?;
            let target_child = target.create_private_child(name)?;
            copy_branch(
                &child,
                &target_child,
                &path,
                depth + 1,
                expected,
                directories,
                cancel,
            )?;
        }
        Ok(())
    })
}
