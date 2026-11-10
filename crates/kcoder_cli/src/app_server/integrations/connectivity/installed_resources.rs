//! Sealed channel resources are resolved only after the real native parent.
mod service_copy;
use super::{super::core::NativeIntegrationContext, NativeConnectivityHostPaths};
use crate::app_server::native_component_parent::NativeComponentParentAuthority;
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

pub(crate) const NATIVE_CONNECTIVITY_STARTUP_ENV: &str = "KCODER_NATIVE_CONNECTIVITY_BINDING_V1";
const MANIFEST: &str = "channel-resource-manifest.json";
#[cfg(test)]
#[path = "installed_resources/fixture_resources.rs"]
mod fixture_resources;
#[cfg(test)]
pub(super) use fixture_resources::{
    controlled_installed_stage, controlled_resource_stage, controlled_startup_binding,
    controlled_workspace_root,
};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Startup {
    schema_version: u32,
    component_root: PathBuf,
    manifest_sha256: String,
    node_program: PathBuf,
    node_sha256: String,
    #[serde(default = "standalone_mode")]
    node_mode: String,
    #[serde(default)]
    node_version: Option<String>,
    #[serde(default)]
    electron_version: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    name: String,
    version: String,
    node_minimum_major: u32,
    entry: String,
    lock_sha256: String,
    files: Vec<ResourceFile>,
    total_bytes: u64,
    #[serde(default)]
    catalog: Option<serde_json::Value>,
    #[serde(default)]
    features: DeclaredFeatures,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeclaredFeatures {
    #[serde(default)]
    task_first_routing_v1: bool,
    #[serde(default)]
    member_identity_readback_v1: bool,
    #[serde(default, rename = "memberApprovalIdentityReadbackV1")]
    _retired_member_approval_identity_readback_v1: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceFile {
    path: String,
    bytes: u64,
    sha256: String,
}
pub(crate) struct NativeConnectivityStartupBinding {
    value: Startup,
    profile_identity: String,
    workspace_identity: String,
    resolved: tokio::sync::Mutex<Option<NativeConnectivityInstalledPaths>>,
}
impl std::fmt::Debug for NativeConnectivityStartupBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeConnectivityStartupBinding { actual_native_parent: captured }")
    }
}
#[derive(Clone)]
pub(crate) struct NativeConnectivityInstalledPaths {
    pub(super) paths: NativeConnectivityHostPaths,
    pub(super) verifier: Arc<NativeConnectivityResourceLease>,
    pub(super) catalog: Option<serde_json::Value>,
    pub(super) task_first_routing_supported: bool,
}
pub(crate) struct NativeConnectivityResourceLease {
    context: NativeIntegrationContext,
    root: PrivateDirectory,
    root_path: PathBuf,
    root_identity: String,
    manifest_sha: String,
    node: PathBuf,
    node_sha: String,
    node_mode: String,
    node_version: Option<String>,
    electron_version: Option<String>,
    launch_verified: AtomicBool,
    member_identity_readback: AtomicBool,
}
impl NativeConnectivityInstalledPaths {
    pub(crate) fn scope_host_resources(
        &self,
        cancel: &CancellationToken,
    ) -> Result<kcoder_types::integrations::core::NativeScopeHostResources> {
        self.verifier.verify_runtime_owner(cancel)?;
        let value = &self.verifier;
        Ok(kcoder_types::integrations::core::NativeScopeHostResources {
            component_root: value.root_path.clone(),
            component_manifest_sha256: value.manifest_sha.clone(),
            node_program: value.node.clone(),
            node_image_sha256: value.node_sha.clone(),
            runtime_mode: value.node_mode.clone(),
            node_version: value.node_version.clone(),
            electron_version: value.electron_version.clone(),
        })
    }
    pub(crate) fn retain_scope_host_resources(
        &self,
        target: &PrivateDirectory,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<kcoder_types::integrations::core::NativeScopeHostResources> {
        self.verifier.retain_service_resources(target, path, cancel)
    }
}
impl NativeConnectivityStartupBinding {
    pub(in crate::app_server) fn capture_after_verified_parent(
        parent: Option<&dyn NativeComponentParentAuthority>,
        engine: &QueryEngine,
        raw: Option<&str>,
    ) -> Result<Option<Self>> {
        let (Some(parent), Some(raw)) = (parent, raw) else {
            return Ok(None);
        };
        ensure!(raw.len() <= 65536, "CHANNEL_STARTUP_INVALID");
        let decoded = URL_SAFE_NO_PAD
            .decode(raw)
            .context("CHANNEL_STARTUP_INVALID")?;
        ensure!(decoded.len() <= 49152, "CHANNEL_STARTUP_INVALID");
        let value: Startup = serde_json::from_slice(&decoded).context("CHANNEL_STARTUP_INVALID")?;
        ensure!(
            value.schema_version == 1
                && value.component_root.is_absolute()
                && value.node_program.is_absolute()
                && valid_sha(&value.manifest_sha256)
                && valid_sha(&value.node_sha256),
            "CHANNEL_STARTUP_INVALID"
        );
        ensure!(
            (value.node_mode == "standalone_node" && value.electron_version.is_none())
                || value.node_mode == "electron_as_node"
                    && value
                        .electron_version
                        .as_deref()
                        .is_some_and(|version| !version.is_empty() && version.len() <= 128),
            "CHANNEL_RUNTIME_MODE_UNAVAILABLE"
        );
        ensure!(
            value
                .node_version
                .as_deref()
                .is_none_or(|version| version.len() <= 128
                    && version
                        .split('.')
                        .next()
                        .and_then(|major| major.parse::<u32>().ok())
                        .is_some_and(|major| major >= 22)),
            "CHANNEL_NODE_UNAVAILABLE"
        );
        let profile_path = engine
            .settings_persistence_path()
            .context("CHANNEL_NATIVE_PROFILE_UNAVAILABLE")?;
        let profile = PrivateDirectory::open_existing(
            profile_path
                .parent()
                .context("CHANNEL_NATIVE_PROFILE_UNAVAILABLE")?,
        )?;
        profile.verify_private_directory()?;
        let workspace_path = engine.state.cwd().canonicalize()?;
        let workspace = PrivateDirectory::open_existing(&workspace_path)?;
        parent.verify_native_component_roots(&profile, &workspace)?;
        ensure!(
            !value.component_root.starts_with(&workspace_path)
                && !value.node_program.starts_with(&workspace_path),
            "CHANNEL_MUTABLE_WORKSPACE_RESOURCE_DENIED"
        );
        Ok(Some(Self {
            value,
            profile_identity: profile.directory_identity()?,
            workspace_identity: workspace.directory_identity()?,
            resolved: Default::default(),
        }))
    }
    pub(crate) fn verify_context(&self, context: &NativeIntegrationContext) -> Result<()> {
        ensure!(
            context.profile()?.directory_identity()? == self.profile_identity
                && context.workspace_directory_identity()? == self.workspace_identity,
            "CHANNEL_NATIVE_CALL_OWNER_CHANGED"
        );
        Ok(())
    }
    pub(crate) async fn resolve(
        &self,
        context: &NativeIntegrationContext,
        cancel: &CancellationToken,
    ) -> Result<NativeConnectivityInstalledPaths> {
        self.verify_context(context)?;
        let mut resolved = tokio::select! { biased;
            _ = cancel.cancelled() => anyhow::bail!("CHANNEL_RESOURCE_OWNER_CANCELLED"),
            resolved = self.resolved.lock() => resolved,
        };
        if let Some(installed) = resolved.as_ref() {
            // Model/configuration revisions are not bundle generations. The
            // caller's current scope is authorized independently at each use.
            installed.verifier.verify_runtime_owner(cancel)?;
            return Ok(installed.clone());
        }
        let root = PrivateDirectory::open_existing(&self.value.component_root)?;
        let lease = Arc::new(NativeConnectivityResourceLease {
            context: context.recapture_for_owned_service()?,
            root_identity: root.directory_identity()?,
            root,
            root_path: self.value.component_root.clone(),
            manifest_sha: self.value.manifest_sha256.clone(),
            node: self.value.node_program.clone(),
            node_sha: self.value.node_sha256.clone(),
            node_mode: self.value.node_mode.clone(),
            node_version: self.value.node_version.clone(),
            electron_version: self.value.electron_version.clone(),
            launch_verified: AtomicBool::new(false),
            member_identity_readback: AtomicBool::new(false),
        });
        let own = lease.clone();
        let token = cancel.clone();
        crate::app_server::task_spawn::spawn_blocking(move || own.verify_for_launch(&token))
            .await
            .context("CHANNEL_COMPONENT_UNAVAILABLE")??;
        self.verify_context(context)?;
        let manifest: Manifest =
            serde_json::from_slice(&read(&lease.root, MANIFEST, 4 * 1024 * 1024)?)?;
        lease.member_identity_readback.store(
            manifest.features.member_identity_readback_v1,
            Ordering::Release,
        );
        if let Some(catalog) = &manifest.catalog {
            ensure!(
                catalog.as_object().is_some_and(|object| object.len() == 2)
                    && ["applications", "channels"].iter().all(|kind| catalog
                        .get(kind)
                        .and_then(serde_json::Value::as_array)
                        .is_some_and(|entries| entries.len() <= 64))
                    && serde_json::to_vec(catalog)?.len() <= 128 * 1024,
                "CHANNEL_CATALOG_INVALID"
            );
        }
        let installed = NativeConnectivityInstalledPaths {
            paths: NativeConnectivityHostPaths {
                node: self.value.node_program.clone(),
                entry: self.value.component_root.join("src/applications/stdio.mjs"),
                supervisor: std::env::current_exe().context("CHANNEL_SUPERVISOR_UNAVAILABLE")?,
            },
            verifier: lease,
            task_first_routing_supported: manifest.features.task_first_routing_v1,
            catalog: manifest.catalog,
        };
        *resolved = Some(installed.clone());
        Ok(installed)
    }
}
impl NativeConnectivityResourceLease {
    pub(super) fn member_identity_readback_supported(&self) -> bool {
        self.member_identity_readback.load(Ordering::Acquire)
    }
    /// Identify the resource generation verified for this owner's launch.
    /// This does not inspect loaded instructions or grant execution authority.
    pub(super) fn service_fingerprint(&self, cancel: &CancellationToken) -> Result<String> {
        self.verify_runtime_owner(cancel)?;
        Ok(hex(&serde_json::to_vec(&(
            "native-channel-service-resources-v1",
            &self.manifest_sha,
            &self.node_sha,
            &self.node_mode,
            &self.node_version,
            &self.electron_version,
        ))?))
    }
    /// Check the live native owner without reading component files or Node bytes.
    /// New processes must independently pass verify_for_launch before loading them.
    pub(crate) fn verify_runtime_owner(&self, cancel: &CancellationToken) -> Result<()> {
        ensure!(!cancel.is_cancelled(), "CHANNEL_RESOURCE_OWNER_CANCELLED");
        ensure!(
            self.launch_verified.load(Ordering::Acquire),
            "CHANNEL_RESOURCE_LAUNCH_NOT_VERIFIED"
        );
        self.context.verify()
    }
    /// Validate on-disk resources for a new load, not code already in memory.
    pub(crate) fn verify_for_launch(&self, cancel: &CancellationToken) -> Result<()> {
        self.context.verify()?;
        ensure!(
            !cancel.is_cancelled()
                && PrivateDirectory::open_existing(&self.root_path)?.directory_identity()?
                    == self.root_identity,
            "CHANNEL_COMPONENT_IDENTITY_CHANGED"
        );
        let bytes = read(&self.root, MANIFEST, 4 * 1024 * 1024)?;
        ensure!(
            hex(&bytes) == self.manifest_sha,
            "CHANNEL_COMPONENT_IDENTITY_CHANGED"
        );
        let manifest: Manifest =
            serde_json::from_slice(&bytes).context("CHANNEL_COMPONENT_UNAVAILABLE")?;
        ensure!(
            manifest.schema_version == 1
                && manifest.name == "@kunlunmeta/kcoder-channel-host"
                && manifest.version == "0.1.0"
                && manifest.node_minimum_major == 22
                && manifest.entry == "src/applications/stdio.mjs"
                && valid_sha(&manifest.lock_sha256)
                && !manifest.files.is_empty()
                && manifest.files.len() <= 20000
                && manifest.total_bytes <= 512 * 1024 * 1024,
            "CHANNEL_COMPONENT_UNAVAILABLE"
        );
        let expected = manifest
            .files
            .iter()
            .map(|entry| (entry.path.as_str(), entry))
            .collect::<BTreeMap<_, _>>();
        ensure!(
            expected.len() == manifest.files.len()
                && manifest.files.iter().all(|entry| valid_sha(&entry.sha256))
                && manifest
                    .files
                    .iter()
                    .map(|entry| entry.bytes)
                    .try_fold(0u64, u64::checked_add)
                    == Some(manifest.total_bytes),
            "CHANNEL_COMPONENT_UNAVAILABLE"
        );
        for path in [
            "package.json",
            "package-lock.json",
            "src/applications/stdio.mjs",
            "licenses/LICENSE.txt",
        ] {
            ensure!(expected.contains_key(path), "CHANNEL_COMPONENT_UNAVAILABLE");
        }
        let mut directories = BTreeSet::new();
        for path in expected.keys() {
            let parts = parts(path)?;
            for end in 1..parts.len() {
                directories.insert(parts[..end].join("/"));
            }
        }
        let mut found = BTreeSet::new();
        visit(
            &self.root,
            "",
            0,
            &expected,
            &directories,
            &mut found,
            cancel,
        )?;
        ensure!(
            found.len() == expected.len(),
            "CHANNEL_COMPONENT_IDENTITY_CHANGED"
        );
        ensure!(
            hex(&read(&self.root, "package-lock.json", 4 * 1024 * 1024)?) == manifest.lock_sha256,
            "CHANNEL_COMPONENT_IDENTITY_CHANGED"
        );
        let node_parent = PrivateDirectory::open_existing(
            self.node.parent().context("CHANNEL_NODE_UNAVAILABLE")?,
        )?;
        let mut node = node_parent.open_single_link_regular_file(
            self.node.file_name().context("CHANNEL_NODE_UNAVAILABLE")?,
        )?;
        let size = node.metadata()?.len();
        ensure!(
            size <= 1024 * 1024 * 1024
                && digest(
                    &mut node,
                    size,
                    cancel,
                    (!self.launch_verified.load(Ordering::Acquire))
                        .then_some(self.node_mode.as_str())
                )? == self.node_sha,
            "CHANNEL_NODE_IDENTITY_CHANGED"
        );
        self.context.verify()?;
        // A later launch still hashes every byte; only the mode scan is reused
        // when the complete image matches the originally verified image.
        self.launch_verified.store(true, Ordering::Release);
        Ok(())
    }
}
fn visit(
    root: &PrivateDirectory,
    prefix: &str,
    depth: usize,
    expected: &BTreeMap<&str, &ResourceFile>,
    directories: &BTreeSet<String>,
    found: &mut BTreeSet<String>,
    cancel: &CancellationToken,
) -> Result<()> {
    ensure!(depth <= 40, "CHANNEL_COMPONENT_UNAVAILABLE");
    root.visit_entry_names_bounded(20001, |name| {
        ensure!(!cancel.is_cancelled(), "CHANNEL_CANCELLED");
        let name = name.to_str().context("CHANNEL_COMPONENT_UNAVAILABLE")?;
        let path = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}/{name}")
        };
        if prefix.is_empty() && name == MANIFEST {
            return Ok(());
        }
        let entry = root.open_entry_handle(OsStr::new(name))?;
        if entry.metadata().is_dir() {
            ensure!(
                directories.contains(&path),
                "CHANNEL_COMPONENT_IDENTITY_CHANGED"
            );
            return visit(
                &entry.open_child_directory()?,
                &path,
                depth + 1,
                expected,
                directories,
                found,
                cancel,
            );
        }
        ensure!(
            entry.metadata().is_file(),
            "CHANNEL_COMPONENT_IDENTITY_CHANGED"
        );
        let wanted = expected
            .get(path.as_str())
            .context("CHANNEL_COMPONENT_IDENTITY_CHANGED")?;
        let mut file = root.open_single_link_regular_file(OsStr::new(name))?;
        ensure!(
            digest(&mut file, wanted.bytes, cancel, None)? == wanted.sha256 && found.insert(path),
            "CHANNEL_COMPONENT_IDENTITY_CHANGED"
        );
        Ok(())
    })
}
fn parts(path: &str) -> Result<Vec<&str>> {
    ensure!(
        !path.is_empty()
            && !path.contains(['\\', ':'])
            && !path.chars().any(char::is_control)
            && !Path::new(path).is_absolute(),
        "CHANNEL_COMPONENT_UNAVAILABLE"
    );
    let parts = path.split('/').collect::<Vec<_>>();
    ensure!(
        parts
            .iter()
            .all(|part| !part.is_empty() && *part != "." && *part != ".."),
        "CHANNEL_COMPONENT_UNAVAILABLE"
    );
    Ok(parts)
}
fn digest(
    file: &mut File,
    size: u64,
    cancel: &CancellationToken,
    runtime_mode: Option<&str>,
) -> Result<String> {
    ensure!(
        file.metadata()?.len() == size,
        "CHANNEL_COMPONENT_IDENTITY_CHANGED"
    );
    let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buffer = [0u8; 65536];
    let mut total = 0u64;
    let mut tail = Vec::new();
    let mut fuses = std::collections::BTreeMap::new();
    const ELECTRON_FUSE: &[u8] = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
    loop {
        ensure!(!cancel.is_cancelled(), "CHANNEL_CANCELLED");
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        ensure!(total <= size, "CHANNEL_COMPONENT_IDENTITY_CHANGED");
        hash.update(&buffer[..n]);
        if runtime_mode.is_some() {
            let start = total - n as u64 - tail.len() as u64;
            tail.extend_from_slice(&buffer[..n]);
            for (index, part) in tail.windows(ELECTRON_FUSE.len()).enumerate() {
                let at = index + ELECTRON_FUSE.len();
                if part == ELECTRON_FUSE && at + 2 < tail.len() {
                    fuses.insert(
                        start + index as u64,
                        tail[at] == 1 && tail[at + 1] >= 1 && tail[at + 2] == 49,
                    );
                    ensure!(fuses.len() <= 8, "CHANNEL_RUNTIME_MODE_UNAVAILABLE");
                }
            }
            let keep = ELECTRON_FUSE.len() + 260;
            if tail.len() > keep {
                tail.drain(..tail.len() - keep);
            }
        }
    }
    ensure!(
        total == size && file.metadata()?.len() == size,
        "CHANNEL_COMPONENT_IDENTITY_CHANGED"
    );
    ensure!(
        match runtime_mode {
            Some("standalone_node") => fuses.is_empty(),
            Some("electron_as_node") => !fuses.is_empty() && fuses.values().all(|enabled| *enabled),
            None => true,
            _ => false,
        },
        "CHANNEL_RUNTIME_MODE_UNAVAILABLE"
    );
    Ok(hash
        .finish()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
fn read(root: &PrivateDirectory, name: &str, maximum: usize) -> Result<Vec<u8>> {
    let file = root.open_single_link_regular_file(OsStr::new(name))?;
    let mut bytes = Vec::new();
    file.take((maximum + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= maximum, "CHANNEL_COMPONENT_UNAVAILABLE");
    Ok(bytes)
}
fn valid_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn standalone_mode() -> String {
    "standalone_node".into()
}

#[cfg(test)]
mod digest_tests;
#[cfg(test)]
pub(super) use digest_tests::benchmark_node_digest;
