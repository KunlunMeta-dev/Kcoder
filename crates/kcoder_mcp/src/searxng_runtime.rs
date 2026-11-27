//! Sealed bundled search service with a private lifetime and loopback authority.
use crate::{McpTransport, StdioTransport};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    time::Duration,
};

const PIN: &str = include_str!("../../../scripts/searxng/upstream.json");
const LAUNCHER: &[u8] = include_bytes!("../../../scripts/searxng/launch.py");
const EGRESS: &[u8] = include_bytes!("../../../scripts/searxng/egress.py");
const REQUIREMENTS: &[u8] = include_bytes!("../../../scripts/searxng/requirements.lock");

mod verify_metrics;
use verify_metrics::Phase;
#[cfg(windows)]
mod windows_verify;
pub use verify_metrics::VerifyMetrics;

#[cfg(test)]
#[path = "searxng_runtime/startup_probe.rs"]
mod startup_probe;

pub(super) struct Service {
    pub endpoint: String,
    pub headers: HashMap<String, String>,
    owner: Option<StdioTransport>,
    #[cfg(not(any(target_os = "linux", windows)))]
    workspace: Option<kcoder_config::PrivateTempDir>,
}

impl Service {
    fn new(owner: StdioTransport, token: &str) -> Self {
        Self {
            endpoint: String::new(),
            headers: HashMap::from([("Authorization".into(), format!("Bearer {token}"))]),
            owner: Some(owner),
            #[cfg(not(any(target_os = "linux", windows)))]
            workspace: None,
        }
    }
    pub(super) fn is_healthy(&mut self) -> bool {
        self.owner.as_mut().is_some_and(McpTransport::is_healthy)
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
impl Drop for Service {
    fn drop(&mut self) {
        if let (Some(owner), Some(workspace)) = (self.owner.take(), self.workspace.take()) {
            owner.stop_and_reap(workspace);
        }
    }
}

fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win-x64"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "mac-arm64"
        } else {
            "mac-x64"
        }
    } else {
        "linux-x64"
    }
}

fn runtime_root() -> Result<PathBuf> {
    if let Some(root) = std::env::var_os("KCODER_SEARXNG_RUNTIME") {
        let root = PathBuf::from(root);
        ensure!(
            root.is_absolute(),
            "KCODER_SEARXNG_RUNTIME must be absolute"
        );
        return Ok(root);
    }
    let executable = std::env::current_exe()?;
    let bin = executable
        .parent()
        .context("Executable directory unavailable")?;
    for candidate in [
        bin.join("../searxng"),
        bin.join("../lib/kcoder/searxng"),
        bin.join("lib/kcoder/searxng"),
    ] {
        if candidate.join("runtime-manifest.json").is_file() {
            return Ok(candidate);
        }
    }
    #[cfg(debug_assertions)]
    if let Some(workspace) = std::env::var_os("KCODER_WORKSPACE_ROOT") {
        let workspace = PathBuf::from(workspace);
        ensure!(
            workspace.is_absolute(),
            "KCODER_WORKSPACE_ROOT must be absolute"
        );
        let candidate = workspace.join("target/runtime/searxng").join(platform());
        if candidate.join("runtime-manifest.json").is_file() {
            return Ok(candidate);
        }
    }
    anyhow::bail!(
        "Bundled SearXNG component is missing; install a full KCoder package or prepare its search runtime"
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    service_protocol_version: u32,
    platform: String,
    python: String,
    python_version: String,
    upstream: serde_json::Value,
    launcher_sha256: String,
    egress_sha256: String,
    requirements_sha256: String,
}

#[derive(Deserialize)]
struct Inventory {
    files: BTreeMap<String, Entry>,
}
#[derive(Deserialize)]
struct Entry {
    bytes: u64,
    sha256: String,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path).context("Cannot read bundled SearXNG component")?;
    ensure!(
        file.metadata()?.len() <= limit,
        "Bundled SearXNG metadata exceeds its limit"
    );
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= limit,
        "Bundled SearXNG component exceeds its limit"
    );
    Ok(bytes)
}

fn contained(root: &Path, name: &str) -> Result<PathBuf> {
    use std::path::Component;
    let relative = Path::new(name);
    ensure!(
        !name.is_empty()
            && !name.contains('\\')
            && relative
                .components()
                .all(|c| matches!(c, Component::Normal(_))),
        "Unsafe bundled SearXNG resource path"
    );
    let mut path = root.to_owned();
    for part in relative.components() {
        path.push(part);
        ensure!(
            !std::fs::symlink_metadata(&path)
                .with_context(|| format!("Bundled SearXNG resource is missing or inaccessible: {name}; reinstall the full KCoder package"))?
                .file_type()
                .is_symlink(),
            "Bundled SearXNG symbolic links are not allowed"
        );
    }
    ensure!(
        path.canonicalize()?.starts_with(root),
        "Bundled SearXNG resource escaped its root"
    );
    Ok(path)
}

fn inspect_manifest(root: &Path) -> Result<(PathBuf, Manifest)> {
    ensure!(
        cfg!(target_arch = "x86_64"),
        "Bundled SearXNG currently requires an x64 runtime"
    );
    let root = root
        .canonicalize()
        .context("Bundled SearXNG directory unavailable")?;
    let metadata = contained(&root, "runtime-manifest.json")?;
    let manifest: Manifest = serde_json::from_slice(&read_bounded(&metadata, 64 * 1024)?)?;
    validate_manifest(&manifest)?;
    Ok((root, manifest))
}

fn validate_manifest(manifest: &Manifest) -> Result<()> {
    let pin: serde_json::Value = serde_json::from_str(PIN)?;
    ensure!(
        manifest.schema_version == 1
            && manifest.service_protocol_version == 1
            && manifest.platform == platform()
            && manifest.upstream == pin
            && manifest.python_version == pin["pythonVersion"]
            && manifest.python == pin["platforms"][platform()]["python"]
            && manifest.launcher_sha256 == hash(LAUNCHER)
            && manifest.egress_sha256 == hash(EGRESS)
            && manifest.requirements_sha256 == hash(REQUIREMENTS),
        "Bundled SearXNG identity does not match this KCoder build"
    );
    Ok(())
}

/// Locate the adapter's component without starting it or reading every payload file.
pub(crate) fn locate() -> Result<PathBuf> {
    locate_at(&runtime_root()?)
}

fn locate_at(root: &Path) -> Result<PathBuf> {
    let (root, manifest) = inspect_manifest(root)?;
    ensure!(
        contained(&root, &manifest.python)?.is_file()
            && contained(&root, "files.sha256.json")?.is_file(),
        "Bundled SearXNG component is incomplete"
    );
    Ok(root)
}

/// Verify every shipped file before running code from the component.
pub fn verify(root: &Path) -> Result<PathBuf> {
    verify_with_metrics(root, &mut VerifyMetrics::default())
}

/// Full verification with passive, secret-free development timing.
pub fn verify_with_metrics(root: &Path, metrics: &mut VerifyMetrics) -> Result<PathBuf> {
    #[cfg(windows)]
    {
        windows_verify::verify(root, metrics).map(|runtime| runtime.python)
    }
    #[cfg(not(windows))]
    {
        verify_portable(root, metrics)
    }
}

#[cfg(not(windows))]
fn verify_portable(root: &Path, metrics: &mut VerifyMetrics) -> Result<PathBuf> {
    use std::io::Read;
    use std::time::Instant;
    *metrics = VerifyMetrics::default();
    let started = Instant::now();
    let metadata = inspect_manifest(root);
    metrics.record(Phase::Manifest, started.elapsed(), 1);
    let (root, manifest) = metadata?;
    let started = Instant::now();
    let inventory: Inventory = serde_json::from_slice(&read_bounded(
        &contained(&root, "files.sha256.json")?,
        8 * 1024 * 1024,
    )?)?;
    ensure!(
        inventory.files.len() <= 30000,
        "Bundled SearXNG inventory is too large"
    );
    metrics.inventory_files = inventory.files.len() as u64;
    metrics.record(Phase::Inventory, started.elapsed(), 1);
    let started = Instant::now();
    let mut directories = vec![root.clone()];
    let mut entries = 0;
    while let Some(directory) = directories.pop() {
        metrics.directories += 1;
        for child in std::fs::read_dir(directory)? {
            let child = child?;
            entries += 1;
            ensure!(
                entries <= 60000,
                "Bundled SearXNG directory budget exceeded"
            );
            let kind = child.file_type()?;
            ensure!(
                !kind.is_symlink(),
                "Bundled SearXNG symbolic links are not allowed"
            );
            if kind.is_dir() {
                directories.push(child.path());
            } else {
                ensure!(kind.is_file(), "Unexpected SearXNG resource type");
                let path = child.path();
                let name = path
                    .strip_prefix(&root)?
                    .to_str()
                    .context("Invalid SearXNG resource name")?
                    .replace('\\', "/");
                ensure!(
                    name == "files.sha256.json" || inventory.files.contains_key(&name),
                    "Unlisted bundled SearXNG resource"
                );
            }
        }
    }
    metrics.record(Phase::Enumeration, started.elapsed(), entries);
    for required in [
        manifest.python.as_str(),
        "launch.py",
        "egress.py",
        "source/searx/webapp.py",
        "runtime-manifest.json",
        "build-source/requirements.lock",
    ] {
        ensure!(
            inventory.files.contains_key(required),
            "Bundled SearXNG inventory is incomplete"
        );
    }
    let mut total = 0u64;
    for (name, entry) in &inventory.files {
        total = total.saturating_add(entry.bytes);
        ensure!(
            entry.bytes <= 256 * 1024 * 1024 && total <= 1024 * 1024 * 1024,
            "Bundled SearXNG file budget exceeded"
        );
        let started = Instant::now();
        let path = contained(&root, name)?;
        metrics.record(Phase::ResourcePaths, started.elapsed(), 1);
        let started = Instant::now();
        let open_started = Instant::now();
        let mut file = std::fs::File::open(path)?;
        metrics.record(Phase::ResourceOpenCall, open_started.elapsed(), 1);
        let metadata_started = Instant::now();
        let length = file.metadata()?.len();
        metrics.record(Phase::ResourceMetadata, metadata_started.elapsed(), 1);
        ensure!(length == entry.bytes, "Bundled SearXNG file size mismatch");
        metrics.record(Phase::ResourceOpen, started.elapsed(), 1);
        let started = Instant::now();
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
            metrics.hashed_bytes = metrics.hashed_bytes.saturating_add(count as u64);
        }
        ensure!(
            format!("{:x}", digest.finalize()) == entry.sha256,
            "Bundled SearXNG file hash mismatch"
        );
        metrics.record(Phase::ResourceHash, started.elapsed(), 1);
    }
    let started = Instant::now();
    ensure!(
        read_bounded(&contained(&root, "launch.py")?, 128 * 1024)? == LAUNCHER,
        "Bundled SearXNG launcher changed"
    );
    ensure!(
        read_bounded(
            &contained(&root, "build-source/requirements.lock")?,
            256 * 1024
        )? == REQUIREMENTS,
        "Bundled SearXNG requirements changed"
    );
    ensure!(
        read_bounded(&contained(&root, "egress.py")?, 128 * 1024)? == EGRESS,
        "Bundled SearXNG egress policy changed"
    );
    let python = contained(&root, &manifest.python)?;
    metrics.record(Phase::Recipe, started.elapsed(), 4);
    Ok(python)
}

pub(super) async fn launch(
    root: &Path,
    network: &kcoder_config::WebFetchSettings,
    parent_egress: Option<crate::searxng_proxy_routes::Startup>,
) -> Result<Service> {
    let verify_root = root.to_owned();
    #[cfg(not(windows))]
    let python = tokio::task::spawn_blocking(move || verify(&verify_root)).await??;
    #[cfg(windows)]
    let verified = tokio::task::spawn_blocking(move || {
        windows_verify::verify(&verify_root, &mut VerifyMetrics::default())
    })
    .await??;
    #[cfg(windows)]
    let python = verified.python.clone();
    let workspace = kcoder_config::create_private_temp_dir("kcoder-searxng")?;
    let mut entropy = [0u8; 32];
    getrandom::fill(&mut entropy)
        .map_err(|_| anyhow::anyhow!("Search service authority unavailable"))?;
    let token: String = entropy.iter().map(|byte| format!("{byte:02x}")).collect();
    let settings = format!(
        "use_default_settings:\n  engines:\n    keep_only: [bing, brave, duckduckgo, google, wikipedia]\nengines:\n  - name: bing\n    disabled: false\n  - name: google\n    disabled: false\nplugins: {{}}\ngeneral:\n  enable_metrics: false\nserver:\n  secret_key: '{token}'\n  limiter: false\n  public_instance: false\nsearch:\n  formats: [json]\n"
    );
    std::fs::write(workspace.path().join("settings.yml"), settings)?;
    let args = vec![
        "-I".into(),
        "-B".into(),
        root.join("launch.py").to_string_lossy().into_owned(),
    ];
    let mut env = HashMap::from([("PYTHONDONTWRITEBYTECODE".into(), "1".into())]);
    for (name, value) in kcoder_tools::web_network::effective_environment(network)? {
        if let Some(value) = value {
            env.insert(name, value);
        }
    }
    #[cfg(any(target_os = "linux", windows))]
    let (mut owner, exit) = StdioTransport::new_owned_private(
        python
            .to_str()
            .context("Search runtime path is not Unicode")?,
        &args,
        &env,
        &std::env::current_exe()?,
    )
    .await?;
    #[cfg(any(target_os = "linux", windows))]
    let mut service = {
        // Retain the private lease if observation is canceled; never erase a live worker's data.
        let path = workspace.path().to_owned();
        #[cfg(windows)]
        let _retention = retain_windows_runtime(workspace, verified, exit);
        #[cfg(target_os = "linux")]
        {
            let mut retained = std::mem::ManuallyDrop::new(workspace);
            tokio::spawn(async move {
                if exit.wait().await.is_ok() {
                    unsafe {
                        std::mem::ManuallyDrop::drop(&mut retained);
                    }
                }
            });
        }
        start(&mut owner, &token, &path, network, parent_egress.as_ref()).await?;
        Service::new(owner, &token)
    };
    #[cfg(not(any(target_os = "linux", windows)))]
    let mut service = {
        let owner = StdioTransport::new_private(
            python
                .to_str()
                .context("Search runtime path is not Unicode")?,
            &args,
            &env,
            true,
        )
        .await?;
        let path = workspace.path().to_owned();
        let mut service = Service::new(owner, &token);
        service.workspace = Some(workspace);
        start(
            service.owner.as_mut().context("Search owner unavailable")?,
            &token,
            &path,
            network,
            parent_egress.as_ref(),
        )
        .await?;
        service
    };
    let ready = tokio::time::timeout(
        Duration::from_secs(20),
        service
            .owner
            .as_mut()
            .context("Search owner unavailable")?
            .recv(),
    )
    .await
    .context("Bundled SearXNG startup timed out")??
    .context("Bundled SearXNG exited during startup")?;
    let ready: serde_json::Value =
        serde_json::from_str(&ready).context("Invalid SearXNG startup response")?;
    let port = ready["port"]
        .as_u64()
        .filter(|p| (1..=65535).contains(p))
        .context("Bundled SearXNG could not start")?;
    ensure!(
        ready["protocolVersion"] == 1,
        "Unsupported search service protocol"
    );
    service.endpoint = format!("http://127.0.0.1:{port}/search");
    Ok(service)
}

#[cfg(windows)]
fn retain_windows_runtime(
    workspace: kcoder_config::PrivateTempDir,
    verified: windows_verify::VerifiedRuntime,
    exit: crate::transport::OwnedStdioExit,
) -> tokio::task::JoinHandle<()> {
    let mut workspace = std::mem::ManuallyDrop::new(workspace);
    let mut verified = std::mem::ManuallyDrop::new(verified);
    tokio::spawn(async move {
        if exit.wait().await.is_ok() {
            // SAFETY: release only after the original owned Job is observed empty.
            unsafe {
                std::mem::ManuallyDrop::drop(&mut workspace);
                std::mem::ManuallyDrop::drop(&mut verified);
            }
        }
    })
}

async fn start(
    owner: &mut StdioTransport,
    token: &str,
    workspace: &Path,
    network: &kcoder_config::WebFetchSettings,
    parent_egress: Option<&crate::searxng_proxy_routes::Startup>,
) -> Result<()> {
    owner
        .send(
            &serde_json::json!({"token":token,"workspace":workspace,"network":network,"parentEgress":parent_egress}).to_string(),
        )
        .await
}

#[cfg(all(test, target_arch = "x86_64"))]
mod tests {
    use super::*;
    use serde_json::json;

    pub(super) fn sealed_fixture() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let pin: serde_json::Value = serde_json::from_str(PIN).unwrap();
        let python = pin["platforms"][platform()]["python"].as_str().unwrap();
        for (name, data) in [
            (python, b"fixture interpreter".as_slice()),
            ("launch.py", LAUNCHER),
            ("egress.py", EGRESS),
            ("source/searx/webapp.py", b"fixture app"),
            ("build-source/requirements.lock", REQUIREMENTS),
        ] {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, data).unwrap();
        }
        let manifest = json!({"schemaVersion":1,"serviceProtocolVersion":1,"platform":platform(),"python":python,"pythonVersion":pin["pythonVersion"],"upstream":pin,"launcherSha256":hash(LAUNCHER),"egressSha256":hash(EGRESS),"requirementsSha256":hash(REQUIREMENTS)});
        std::fs::write(root.join("runtime-manifest.json"), manifest.to_string()).unwrap();
        let mut files = serde_json::Map::new();
        for name in [
            python,
            "launch.py",
            "egress.py",
            "source/searx/webapp.py",
            "build-source/requirements.lock",
            "runtime-manifest.json",
        ] {
            let bytes = std::fs::read(root.join(name)).unwrap();
            files.insert(
                name.into(),
                json!({"bytes":bytes.len(),"sha256":hash(&bytes)}),
            );
        }
        std::fs::write(
            root.join("files.sha256.json"),
            json!({"schemaVersion":1,"files":files}).to_string(),
        )
        .unwrap();
        directory
    }

    #[test]
    fn passive_metrics_preserve_full_verification_and_only_report_aggregates() {
        let fixture = sealed_fixture();
        let mut metrics = VerifyMetrics::default();
        assert_eq!(
            verify_with_metrics(fixture.path(), &mut metrics).unwrap(),
            verify(fixture.path()).unwrap()
        );
        let output = metrics.json();
        assert_eq!(output["inventoryFiles"], 6);
        assert_eq!(output["phases"][3]["count"], 6);
        assert_eq!(output["phases"][5]["count"], 6);
        assert!(output["hashedBytes"].as_u64().unwrap() > 0);
        assert!(!output.to_string().contains("launch.py"));
        std::fs::write(fixture.path().join("launch.py"), b"modified").unwrap();
        assert!(verify_with_metrics(fixture.path(), &mut metrics).is_err());
    }

    #[test]
    fn sealed_inventory_rejects_tampering_and_unlisted_importable_code() {
        let fixture = sealed_fixture();
        assert!(verify(fixture.path()).is_ok());
        let unexpected = fixture.path().join("source/searx/unlisted.py");
        std::fs::write(&unexpected, "unlisted code").unwrap();
        assert!(
            verify(fixture.path())
                .unwrap_err()
                .to_string()
                .contains("Unlisted")
        );
        std::fs::remove_file(unexpected).unwrap();
        std::fs::write(fixture.path().join("launch.py"), "modified").unwrap();
        assert!(verify(fixture.path()).is_err());
    }

    #[test]
    fn inventory_paths_cannot_escape_the_runtime_root() {
        let fixture = sealed_fixture();
        for name in [
            "../outside",
            "/absolute",
            "source/../../outside",
            "source\\outside",
        ] {
            assert!(contained(fixture.path(), name).is_err());
        }
    }

    #[test]
    fn missing_resources_identify_the_component_instead_of_system_python() {
        let fixture = sealed_fixture();
        std::fs::remove_file(fixture.path().join("source/searx/webapp.py")).unwrap();
        let message = verify(fixture.path()).unwrap_err().to_string();
        assert!(message.contains("Bundled SearXNG resource is missing or inaccessible"));
        assert!(message.contains("source/searx/webapp.py"));
        assert!(message.contains("reinstall the full KCoder package"));
    }

    #[tokio::test]
    async fn bundled_discovery_is_static_but_first_search_still_rejects_tampered_code() {
        let fixture = sealed_fixture();
        // A non-executable interpreter proves that discovery must not spawn it.
        let root = locate_at(fixture.path()).unwrap();
        let transport = crate::searxng::SearxngTransport::bundled(root);
        let mut client = crate::McpClient::with_transport(Box::new(transport));
        client.initialize().await.unwrap();
        assert_eq!(client.list_tools().await.unwrap()[0].name, "search");

        std::fs::write(fixture.path().join("launch.py"), b"modified launcher").unwrap();
        let invalid = client
            .call_tool("search", json!({"query":""}))
            .await
            .unwrap();
        assert!(invalid.is_error);
        assert!(
            invalid.content[0]
                .text
                .as_ref()
                .unwrap()
                .contains("query must")
        );
        let rejected = client
            .call_tool("search", json!({"query":"bounded fixture"}))
            .await
            .unwrap();
        assert!(rejected.is_error);
        assert!(
            rejected.content[0]
                .text
                .as_ref()
                .unwrap()
                .contains("SearXNG file")
        );
        assert_eq!(
            std::fs::read(fixture.path().join("launch.py")).unwrap(),
            b"modified launcher"
        );
    }
}
