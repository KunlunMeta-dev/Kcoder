//! Native-only verified component/runtime inputs. No business RPC constructs this authority.
pub use crate::node_generator::OfficeNodeRuntimeMode;
use crate::node_generator::{
    NativeOfficeNodeLaunch, NativeOfficeResourceVerifier, OfficeNodeGenerator,
};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_config::PrivateDirectory;
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_types::integrations::office::OfficeGeneratorIdentity;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;
#[path = "../../app_server/integrations/office/resource_files.rs"]
mod resource_files;
use resource_files::{hash_runtime, verify_tree};

/// Constructed by Native startup/packaging, never from a business RPC payload.
#[derive(Clone)]
pub struct NativeOfficeInstalledPaths {
    generator: Arc<OfficeNodeGenerator>,
}
impl NativeOfficeInstalledPaths {
    pub async fn verify_current_resources(
        &self,
        native: &NativeIntegrationContext,
        cancel: &CancellationToken,
    ) -> Result<()> {
        native.verify()?;
        // No worker is loaded here. Its call() path verifies the actual bytes
        // immediately before spawn, independently of task/tool authorization.
        self.generator.verify_native_owner(cancel).await?;
        native.verify()
    }
    pub async fn readiness(
        &self,
        context: &NativeIntegrationContext,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        context.verify()?;
        let result = self.generator.readiness(cancel).await;
        context.verify()?;
        result
    }
    #[cfg(any(test, feature = "test-oracle"))]
    pub fn from_verified_generator(generator: OfficeNodeGenerator) -> Self {
        Self {
            generator: Arc::new(generator),
        }
    }
    pub fn into_generator(self) -> Arc<OfficeNodeGenerator> {
        self.generator
    }
    fn mark_ready(&self) {
        self.generator.mark_ready();
    }
    #[cfg(any(test, feature = "test-oracle"))]
    pub fn from_native_installation(node: &Path, components: &Path) -> Result<Self> {
        Ok(Self {
            generator: Arc::new(OfficeNodeGenerator::from_trusted_paths(node, components)?),
        })
    }
}

const MANIFEST: &str = "office-resource-manifest.json";
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceFile {
    path: String,
    bytes: u64,
    sha256: String,
    legal: bool,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Dependency {
    path: String,
    version: String,
    integrity: Option<String>,
    license: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceManifest {
    schema_version: u32,
    component_name: String,
    component_version: String,
    node_minimum_major: u32,
    package_root: String,
    entry: String,
    lock_sha256: String,
    generator: OfficeGeneratorIdentity,
    dependencies: Vec<Dependency>,
    files: Vec<ResourceFile>,
    total_bytes: u64,
}
/// Values from the actual native launcher process and verified release inventory.
/// Neither a manifest nor JSON/Scope creates this Rust authority.
#[derive(Clone)]
pub struct NativeOfficeRuntimeAuthority {
    program: PathBuf,
    sha256: String,
    mode: OfficeNodeRuntimeMode,
    node_version: String,
    electron_version: Option<String>,
}
impl NativeOfficeRuntimeAuthority {
    pub fn from_native_launcher(
        program: &Path,
        sha256: &str,
        mode: OfficeNodeRuntimeMode,
        node_version: &str,
        electron_version: Option<&str>,
    ) -> Result<Self> {
        ensure!(
            program.is_absolute()
                && valid_sha(sha256)
                && node_major(node_version).is_some_and(|major| major >= 22),
            "OFFICE_NODE_UNAVAILABLE"
        );
        ensure!(
            electron_version.is_some() == (mode == OfficeNodeRuntimeMode::ElectronAsNode),
            "OFFICE_RUNTIME_MODE_UNAVAILABLE"
        );
        ensure!(
            electron_version.is_none_or(|version| version.len() <= 128
                && !version.is_empty()
                && !version.chars().any(char::is_control)),
            "OFFICE_RUNTIME_MODE_UNAVAILABLE"
        );
        Ok(Self {
            program: program.to_path_buf(),
            sha256: sha256.into(),
            mode,
            node_version: node_version.into(),
            electron_version: electron_version.map(str::to_owned),
        })
    }
}
#[cfg(feature = "test-oracle")]
impl NativeOfficeRuntimeAuthority {
    pub fn with_test_runtime_mode(mut self, mode: OfficeNodeRuntimeMode) -> Self {
        self.mode = mode;
        self
    }
}

pub struct NativeOfficeLaunchAuthority {
    context: NativeIntegrationContext,
    root: PathBuf,
    manifest_sha256: String,
    runtime: NativeOfficeRuntimeAuthority,
    owner_program: PathBuf,
}
impl NativeOfficeLaunchAuthority {
    pub fn from_native_launch(
        context: &NativeIntegrationContext,
        root: &Path,
        manifest_sha256: &str,
        runtime: NativeOfficeRuntimeAuthority,
    ) -> Result<Self> {
        context.verify()?;
        ensure!(
            root.is_absolute() && valid_sha(manifest_sha256),
            "OFFICE_COMPONENT_UNAVAILABLE"
        );
        Ok(Self {
            context: context.recapture_for_owned_service()?,
            root: root.to_path_buf(),
            manifest_sha256: manifest_sha256.into(),
            runtime,
            owner_program: std::env::current_exe().context("OFFICE_COMPONENT_UNAVAILABLE")?,
        })
    }
    #[cfg(any(test, feature = "test-oracle"))]
    pub fn with_owned_test_program(mut self, program: &Path) -> Self {
        self.owner_program = program.into();
        self
    }
    fn resource_lease(&self) -> Result<Arc<ResourceLease>> {
        self.context.verify()?;
        let root = Arc::new(
            PrivateDirectory::open_existing(&self.root).context("OFFICE_COMPONENT_UNAVAILABLE")?,
        );
        let bytes = read_leaf(&root, MANIFEST, 4 * 1024 * 1024)?;
        ensure!(
            hex(&bytes) == self.manifest_sha256,
            "OFFICE_COMPONENT_IDENTITY_CHANGED"
        );
        let manifest: ResourceManifest =
            serde_json::from_slice(&bytes).context("OFFICE_COMPONENT_IDENTITY_UNAVAILABLE")?;
        manifest.validate()?;
        let lease = Arc::new(ResourceLease {
            root,
            root_path: self.root.clone(),
            root_identity: PrivateDirectory::open_existing(&self.root)?.directory_identity()?,
            manifest_sha256: self.manifest_sha256.clone(),
            runtime: self.runtime.clone(),
            manifest: Arc::new(manifest),
            runtime_mode_verified: Arc::new(AtomicBool::new(false)),
        });
        Ok(lease)
    }
    /// Construct the protected tool endpoint without starting a worker for ordinary chat.
    pub fn prepare_deferred(self) -> Result<NativeOfficeInstalledPaths> {
        let lease = self.resource_lease()?;
        self.context.verify()?;
        let generator = OfficeNodeGenerator::from_verified_native_launch(
            &self.runtime.program,
            &self.root.join("components"),
            NativeOfficeNodeLaunch {
                mode: self.runtime.mode,
                owner_program: self.owner_program,
                verify: lease,
            },
        )?;
        self.context.verify()?;
        Ok(NativeOfficeInstalledPaths {
            generator: Arc::new(generator),
        })
    }
    pub async fn resolve(self, cancel: &CancellationToken) -> Result<NativeOfficeInstalledPaths> {
        let context = self.context.recapture_for_owned_service()?;
        let installed = self.prepare_deferred()?;
        installed.readiness(&context, cancel).await?;
        installed.mark_ready();
        Ok(installed)
    }
}
#[derive(Clone)]
struct ResourceLease {
    root: Arc<PrivateDirectory>,
    root_path: PathBuf,
    root_identity: String,
    manifest_sha256: String,
    runtime: NativeOfficeRuntimeAuthority,
    manifest: Arc<ResourceManifest>,
    runtime_mode_verified: Arc<AtomicBool>,
}
#[async_trait]
impl NativeOfficeResourceVerifier for ResourceLease {
    async fn verify_owner(&self, cancel: &CancellationToken) -> Result<()> {
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        self.root.verify_private_directory()?;
        ensure!(
            PrivateDirectory::open_existing(&self.root_path)?.directory_identity()?
                == self.root_identity,
            "OFFICE_COMPONENT_IDENTITY_CHANGED"
        );
        Ok(())
    }
    async fn verify(&self, cancel: &CancellationToken) -> Result<()> {
        let lease = self.clone();
        let token = cancel.clone();
        tokio::task::spawn_blocking(move || lease.verify_sync(&token))
            .await
            .context("OFFICE_COMPONENT_UNAVAILABLE")?
    }
    fn verify_readiness(&self, probe: &serde_json::Value) -> Result<()> {
        self.validate_probe(probe)
    }
}
impl ResourceLease {
    fn validate_probe(&self, probe: &serde_json::Value) -> Result<()> {
        ensure!(
            probe.get("status").and_then(serde_json::Value::as_str) == Some("available"),
            "OFFICE_DEPENDENCY_UNAVAILABLE"
        );
        ensure!(
            probe
                .pointer("/runtime/version")
                .and_then(serde_json::Value::as_str)
                == Some(self.runtime.node_version.as_str()),
            "OFFICE_RUNTIME_MODE_UNAVAILABLE"
        );
        let matches_mode = match self.runtime.mode {
            OfficeNodeRuntimeMode::StandaloneNode => {
                probe
                    .pointer("/runtime/hostKind")
                    .and_then(serde_json::Value::as_str)
                    == Some("node")
                    && probe
                        .pointer("/runtime/electronVersion")
                        .is_none_or(serde_json::Value::is_null)
            }
            OfficeNodeRuntimeMode::ElectronAsNode => {
                probe
                    .pointer("/runtime/hostKind")
                    .and_then(serde_json::Value::as_str)
                    == Some("electron")
                    && probe.pointer("/runtime/electronRunAsNode")
                        == Some(&serde_json::Value::Bool(true))
                    && probe
                        .pointer("/runtime/electronVersion")
                        .and_then(serde_json::Value::as_str)
                        == self.runtime.electron_version.as_deref()
            }
        };
        ensure!(matches_mode, "OFFICE_RUNTIME_MODE_UNAVAILABLE");
        let actual: OfficeGeneratorIdentity = rpc_codec::decode(
            probe
                .get("generator")
                .cloned()
                .context("OFFICE_COMPONENT_IDENTITY_UNAVAILABLE")?,
        )
        .context("OFFICE_COMPONENT_IDENTITY_UNAVAILABLE")?;
        ensure!(
            actual == self.manifest.generator,
            "OFFICE_GENERATOR_IDENTITY_MISMATCH"
        );
        Ok(())
    }
    fn verify_sync(&self, cancel: &CancellationToken) -> Result<()> {
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        ensure!(
            PrivateDirectory::open_existing(&self.root_path)?.directory_identity()?
                == self.root_identity,
            "OFFICE_COMPONENT_IDENTITY_CHANGED"
        );
        ensure!(
            hex(&read_leaf(&self.root, MANIFEST, 4 * 1024 * 1024)?) == self.manifest_sha256,
            "OFFICE_COMPONENT_IDENTITY_CHANGED"
        );
        verify_tree(&self.root, &self.manifest, cancel)?;
        verify_locked_dependencies(&self.root, &self.manifest)?;
        let inspect_mode = !self.runtime_mode_verified.load(Ordering::Acquire);
        let facts = hash_runtime(&self.runtime.program, cancel, inspect_mode)?;
        ensure!(
            facts.sha256 == self.runtime.sha256,
            "OFFICE_COMPONENT_IDENTITY_CHANGED"
        );
        if inspect_mode {
            ensure!(
                match self.runtime.mode {
                    OfficeNodeRuntimeMode::StandaloneNode => !facts.has_electron_fuse,
                    OfficeNodeRuntimeMode::ElectronAsNode => facts.run_as_node_enabled,
                },
                "OFFICE_RUNTIME_MODE_UNAVAILABLE"
            );
            // Every invocation still verifies the complete runtime hash. Matching
            // bytes retain the already verified fuse state without rescanning it.
            self.runtime_mode_verified.store(true, Ordering::Release);
        }
        Ok(())
    }
}
impl ResourceManifest {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == 1
                && self.component_name == "@kcoder/office-components"
                && self.component_version == self.generator.version
                && self.node_minimum_major == 22
                && self.package_root == "components"
                && self.entry == "components/src/cli.mjs"
                && valid_sha(&self.lock_sha256)
                && self.lock_sha256 == self.generator.dependency_lock_sha256,
            "OFFICE_COMPONENT_IDENTITY_UNAVAILABLE"
        );
        self.generator.validate()?;
        ensure!(
            !self.files.is_empty()
                && self.files.len() <= 20000
                && self.total_bytes <= 256 * 1024 * 1024
                && self.dependencies.len() <= 2000,
            "OFFICE_COMPONENT_IDENTITY_UNAVAILABLE"
        );
        let mut files = BTreeMap::new();
        let mut total = 0u64;
        for file in &self.files {
            resource_files::parts(&file.path)?;
            ensure!(
                valid_sha(&file.sha256) && files.insert(file.path.as_str(), file).is_none(),
                "OFFICE_COMPONENT_IDENTITY_UNAVAILABLE"
            );
            total = total
                .checked_add(file.bytes)
                .context("OFFICE_COMPONENT_IDENTITY_UNAVAILABLE")?;
        }
        ensure!(
            total == self.total_bytes
                && files.contains_key(self.entry.as_str())
                && files.contains_key("components/package.json")
                && files.contains_key("components/package-lock.json")
                && self.files.iter().any(|file| file.legal),
            "OFFICE_COMPONENT_IDENTITY_UNAVAILABLE"
        );
        for required in [
            "licenses/kcoder-office/LICENSE.txt",
            "licenses/saxes/LICENSE.txt",
            "licenses/electron-fuses/LICENSE.txt",
            "licenses/PROVENANCE.md",
        ] {
            ensure!(
                files.contains_key(required),
                "OFFICE_COMPONENT_IDENTITY_UNAVAILABLE"
            );
        }
        for dependency in &self.dependencies {
            resource_files::parts(&dependency.path)?;
            ensure!(
                dependency.path.starts_with("node_modules/")
                    && !dependency.version.is_empty()
                    && dependency.version.len() <= 128
                    && dependency
                        .integrity
                        .as_ref()
                        .is_none_or(|value| value.len() < 1024)
                    && dependency.license.len() < 4096,
                "OFFICE_DEPENDENCY_UNAVAILABLE"
            );
        }
        Ok(())
    }
}
fn node_major(value: &str) -> Option<u32> {
    if value.len() > 128 {
        return None;
    };
    value.split('.').next()?.parse().ok()
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
fn read_leaf(directory: &PrivateDirectory, name: &str, limit: usize) -> Result<Vec<u8>> {
    let mut file = directory
        .open_single_link_regular_file(OsStr::new(name))
        .context("OFFICE_COMPONENT_UNAVAILABLE")?;
    ensure!(
        file.metadata()?.len() <= limit as u64,
        "OFFICE_COMPONENT_IDENTITY_UNAVAILABLE"
    );
    let mut bytes = Vec::new();
    file.by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= limit,
        "OFFICE_COMPONENT_IDENTITY_UNAVAILABLE"
    );
    Ok(bytes)
}

#[cfg(test)]
#[path = "../../app_server/integrations/office/resource_validation_tests.rs"]
mod tests;

fn verify_locked_dependencies(root: &PrivateDirectory, manifest: &ResourceManifest) -> Result<()> {
    let components = root.open_child(OsStr::new("components"), false)?;
    let value: serde_json::Value = serde_json::from_slice(&read_leaf(
        &components,
        "package-lock.json",
        4 * 1024 * 1024,
    )?)
    .context("OFFICE_DEPENDENCY_UNAVAILABLE")?;
    let packages = value
        .get("packages")
        .and_then(serde_json::Value::as_object)
        .context("OFFICE_DEPENDENCY_UNAVAILABLE")?;
    ensure!(
        packages.keys().filter(|path| !path.is_empty()).count() == manifest.dependencies.len(),
        "OFFICE_DEPENDENCY_UNAVAILABLE"
    );
    let mut unique = std::collections::BTreeSet::new();
    for dependency in &manifest.dependencies {
        ensure!(
            unique.insert(dependency.path.as_str()),
            "OFFICE_DEPENDENCY_UNAVAILABLE"
        );
        let locked = packages
            .get(&dependency.path)
            .context("OFFICE_DEPENDENCY_UNAVAILABLE")?;
        ensure!(
            locked.get("version").and_then(serde_json::Value::as_str)
                == Some(dependency.version.as_str()),
            "OFFICE_DEPENDENCY_UNAVAILABLE"
        );
        ensure!(
            locked.get("integrity").and_then(serde_json::Value::as_str)
                == dependency.integrity.as_deref(),
            "OFFICE_DEPENDENCY_UNAVAILABLE"
        );
    }
    for (name, version) in [
        ("docx", "9.5.1"),
        ("exceljs", "4.4.0"),
        ("pptxgenjs", "4.0.1"),
        ("fflate", "0.8.3"),
        ("saxes", "6.0.0"),
    ] {
        ensure!(
            packages
                .get(&format!("node_modules/{name}"))
                .and_then(|package| package.get("version"))
                .and_then(serde_json::Value::as_str)
                == Some(version),
            "OFFICE_DEPENDENCY_UNAVAILABLE"
        );
    }
    Ok(())
}

#[path = "../../app_server/integrations/office/scope_retention.rs"]
mod scope_retention;
pub use scope_retention::NativeOfficeRetainedScopeResources;
