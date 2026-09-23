use crate::{InstallLimits, InstalledPluginSource, PluginCancellationToken};
use anyhow::{Context, Result, bail};
use base64::Engine as _;
use kcoder_config::{PrivateTempDir, create_private_temp_dir};
use sha2::{Digest, Sha512};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAX_COMMAND_OUTPUT_BYTES: u64 = 1024 * 1024;
const MAX_COMPRESSION_RATIO: u64 = 200;

pub(crate) struct MaterializedPlugin {
    _temporary: PrivateTempDir,
    pub root: PathBuf,
    pub evidence: InstalledPluginSource,
}

pub(crate) struct GitMaterializeRequest<'a> {
    pub limits: InstallLimits,
    pub proxy_url: Option<&'a str>,
    pub url: &'a str,
    pub path: Option<&'a str>,
    pub ref_name: Option<&'a str>,
    pub sha: Option<&'a str>,
    pub deadline: Instant,
    pub cancellation: &'a PluginCancellationToken,
}

pub(crate) fn materialize_git(request: GitMaterializeRequest<'_>) -> Result<MaterializedPlugin> {
    request.cancellation.check()?;
    validate_git_selector(request.ref_name, "ref")?;
    validate_git_sha(request.sha)?;
    let temporary = create_private_temp_dir("kcoder-plugin-git")?;
    let checkout = temporary.path().join("checkout");
    // Git interprets argv paths itself and can reject Windows verbatim prefixes.
    // Keep the validated private root internally and address its child relative to cwd.
    let git_checkout = OsString::from("checkout");
    let logs = temporary.path().join("logs");
    fs::create_dir(&logs)?;
    kcoder_config::set_user_only_dir_permissions(&logs)?;
    let source = normalize_git_source(request.url)?;
    let command_context = CommandContext {
        limits: request.limits,
        proxy: if source.redacted.starts_with("https://") {
            crate::network::resolve_proxy(request.proxy_url)?
        } else {
            None
        },
        cwd: temporary.path(),
        deadline: request.deadline,
        logs: &logs,
        cancellation: request.cancellation,
    };
    let common = [
        OsString::from("-c"),
        OsString::from("protocol.allow=never"),
        OsString::from("-c"),
        OsString::from("protocol.https.allow=always"),
        OsString::from("-c"),
        OsString::from("protocol.file.allow=always"),
        OsString::from("-c"),
        OsString::from("core.hooksPath=/dev/null"),
        OsString::from("-c"),
        OsString::from("init.templateDir="),
    ];
    let mut clone_args = common.to_vec();
    clone_args.extend([
        OsString::from("clone"),
        OsString::from("--no-checkout"),
        OsString::from("--no-recurse-submodules"),
        OsString::from("--no-local"),
    ]);
    // Fetch pinned revisions separately, rather than downloading an entire repository
    // history just to install a small plugin subdirectory.
    clone_args.push(OsString::from("--depth=1"));
    clone_args.extend([
        OsString::from("--"),
        source.command_argument.clone(),
        git_checkout.clone(),
    ]);
    for attempt in 0..3 {
        request.cancellation.check()?;
        let result = run_isolated_command(
            "git",
            &clone_args,
            &[],
            &format!("clone-{attempt}"),
            &command_context,
        );
        match result {
            Ok(_) => break,
            Err(error)
                if attempt < 2
                    && crate::network::transient(&error)
                    && Instant::now() < request.deadline =>
            {
                if checkout.exists() {
                    fs::remove_dir_all(&checkout)
                        .context("failed to remove partial Git checkout")?;
                }
                // HTTP/1.1 is a bounded retry path for proxies that reset HTTP/2 streams.
                if attempt == 1 {
                    clone_args.splice(
                        0..0,
                        [
                            OsString::from("-c"),
                            OsString::from("http.version=HTTP/1.1"),
                        ],
                    );
                }
                for _ in 0..(10 * (attempt + 1)) {
                    request.cancellation.check()?;
                    if Instant::now() >= request.deadline {
                        bail!("git operation timed out");
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            Err(error) => return Err(error).context("failed to clone plugin Git source"),
        }
    }

    let pinned = request.sha.or(request.ref_name);
    if let Some(selector) = pinned {
        let mut fetch_args = common.to_vec();
        fetch_args.extend([
            OsString::from("-C"),
            git_checkout.clone(),
            OsString::from("fetch"),
            OsString::from("--depth=1"),
            OsString::from("--no-tags"),
            OsString::from("--no-recurse-submodules"),
            OsString::from("--"),
            OsString::from("origin"),
            OsString::from(selector),
        ]);
        for attempt in 0..3 {
            request.cancellation.check()?;
            match run_isolated_command(
                "git",
                &fetch_args,
                &[],
                &format!("fetch-{attempt}"),
                &command_context,
            ) {
                Ok(_) => break,
                Err(error)
                    if attempt < 2
                        && crate::network::transient(&error)
                        && Instant::now() < request.deadline =>
                {
                    if attempt == 1 {
                        fetch_args.splice(
                            0..0,
                            [
                                OsString::from("-c"),
                                OsString::from("http.version=HTTP/1.1"),
                            ],
                        );
                    }
                }
                Err(error) => {
                    return Err(error).context("failed to fetch pinned plugin Git revision");
                }
            }
        }
    }
    let selector = if pinned.is_some() {
        "FETCH_HEAD"
    } else {
        "HEAD"
    };
    let checkout_args = [
        OsString::from("-C"),
        git_checkout.clone(),
        OsString::from("-c"),
        OsString::from("core.hooksPath=/dev/null"),
        OsString::from("checkout"),
        OsString::from("--detach"),
        OsString::from(selector),
    ];
    run_isolated_command("git", &checkout_args, &[], "checkout", &command_context)
        .context("failed to checkout plugin Git revision")?;
    let revision_args = [
        OsString::from("-C"),
        git_checkout,
        OsString::from("rev-parse"),
        OsString::from("HEAD"),
    ];
    let revision = run_isolated_command("git", &revision_args, &[], "revision", &command_context)?;
    let revision = String::from_utf8(revision)
        .context("Git revision output is not UTF-8")?
        .trim()
        .to_ascii_lowercase();
    if let Some(expected) = request.sha
        && revision != expected.to_ascii_lowercase()
    {
        bail!("Git source resolved to {revision}, expected exact SHA {expected}");
    }
    if checkout.join(".gitmodules").exists() {
        bail!("plugin Git source may not contain submodules");
    }

    let selected = match request.path {
        Some(path) => {
            let path = normalized_relative_path(path, "Git plugin path")?;
            checkout.join(path)
        }
        None => checkout.clone(),
    };
    let selected = dunce::canonicalize(&selected)
        .context("failed to resolve plugin path inside Git checkout")?;
    let checkout_root = dunce::canonicalize(&checkout).context("failed to resolve Git checkout")?;
    if !selected.starts_with(&checkout_root) || !selected.is_dir() {
        bail!("Git plugin path is outside the checkout or is not a directory");
    }
    if selected == checkout_root {
        fs::remove_dir_all(checkout.join(".git"))
            .context("failed to remove Git metadata before plugin validation")?;
    }
    Ok(MaterializedPlugin {
        _temporary: temporary,
        root: selected,
        evidence: InstalledPluginSource::Git {
            redacted_url: source.redacted,
            resolved_sha: revision,
        },
    })
}

pub(crate) struct NpmMaterializeRequest<'a> {
    pub proxy_url: Option<&'a str>,
    pub package: &'a str,
    pub version: Option<&'a str>,
    pub registry: Option<&'a str>,
    pub expected_integrity: Option<&'a str>,
    pub require_integrity: bool,
    pub limits: InstallLimits,
    pub deadline: Instant,
    pub cancellation: &'a PluginCancellationToken,
}

pub(crate) fn materialize_npm(request: NpmMaterializeRequest<'_>) -> Result<MaterializedPlugin> {
    request.cancellation.check()?;
    let temporary = create_private_temp_dir("kcoder-plugin-npm")?;
    let logs = temporary.path().join("logs");
    let package_root = temporary.path().join("package");
    fs::create_dir(&logs)?;
    fs::create_dir(&package_root)?;
    kcoder_config::set_user_only_dir_permissions(&logs)?;
    kcoder_config::set_user_only_dir_permissions(&package_root)?;
    let registry = request.registry.map(validate_registry_url).transpose()?;
    let spec = match request
        .version
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(version) => format!("{}@{version}", request.package),
        None => request.package.to_string(),
    };
    let args = [
        OsString::from("pack"),
        OsString::from(spec),
        OsString::from("--ignore-scripts"),
        OsString::from("--json"),
        OsString::from("--pack-destination"),
        temporary.path().as_os_str().to_os_string(),
    ];
    let mut env = vec![
        (
            OsString::from("npm_config_ignore_scripts"),
            OsString::from("true"),
        ),
        (
            OsString::from("npm_config_cache"),
            temporary.path().join("cache").into_os_string(),
        ),
        (
            OsString::from("npm_config_update_notifier"),
            OsString::from("false"),
        ),
        (OsString::from("npm_config_audit"), OsString::from("false")),
        (OsString::from("npm_config_fund"), OsString::from("false")),
    ];
    if let Some(registry) = &registry {
        env.push((
            OsString::from("npm_config_registry"),
            OsString::from(registry),
        ));
    }
    let command_context = CommandContext {
        limits: request.limits,
        proxy: crate::network::resolve_proxy(request.proxy_url)?,
        cwd: temporary.path(),
        deadline: request.deadline,
        logs: &logs,
        cancellation: request.cancellation,
    };
    let output = run_isolated_command("npm", &args, &env, "pack", &command_context)
        .context("failed to download npm plugin package")?;
    let packed: Vec<NpmPackOutput> =
        serde_json::from_slice(&output).context("npm pack returned invalid JSON")?;
    let packed = packed
        .into_iter()
        .next()
        .context("npm pack returned no package result")?;
    let filename = Path::new(&packed.filename);
    if filename.components().count() != 1 || filename.file_name().is_none() {
        bail!("npm pack returned an unsafe tarball filename");
    }
    let tarball = temporary.path().join(filename);
    let reported_integrity = packed.integrity.trim();
    if request.require_integrity && reported_integrity.is_empty() {
        bail!("npm registry did not provide package integrity");
    }
    if let Some(expected) = request.expected_integrity
        && expected != reported_integrity
    {
        bail!("npm package integrity does not match marketplace declaration");
    }
    if !reported_integrity.is_empty() {
        verify_sha512_integrity(&tarball, reported_integrity)?;
    }
    extract_npm_tarball(
        &tarball,
        &package_root,
        request.limits,
        request.cancellation,
    )?;
    Ok(MaterializedPlugin {
        _temporary: temporary,
        root: package_root,
        evidence: InstalledPluginSource::Npm {
            package: request.package.to_string(),
            integrity: reported_integrity.to_string(),
        },
    })
}

#[derive(Debug, serde::Deserialize)]
struct NpmPackOutput {
    filename: String,
    #[serde(default)]
    integrity: String,
}

struct NormalizedGitSource {
    command_argument: OsString,
    redacted: String,
}

fn normalize_git_source(value: &str) -> Result<NormalizedGitSource> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('-') {
        bail!("Git source URL is empty or option-like");
    }
    if value.starts_with("https://") {
        let mut url = url::Url::parse(value).context("invalid HTTPS Git source URL")?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("Git source URL may not contain credentials, query, or fragment");
        }
        url.set_query(None);
        url.set_fragment(None);
        return Ok(NormalizedGitSource {
            command_argument: OsString::from(value),
            redacted: url.to_string(),
        });
    }
    if let Some(path) = value.strip_prefix("file://") {
        return normalize_local_git_path(Path::new(path));
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return normalize_local_git_path(path);
    }
    bail!("Git plugin sources must use HTTPS, file://, or an absolute local fixture path")
}

fn normalize_local_git_path(path: &Path) -> Result<NormalizedGitSource> {
    let canonical = dunce::canonicalize(path)
        .with_context(|| format!("failed to resolve local Git source {}", path.display()))?;
    if !canonical.is_dir() {
        bail!("local Git source is not a directory");
    }
    Ok(NormalizedGitSource {
        command_argument: canonical.as_os_str().to_os_string(),
        redacted: canonical.display().to_string(),
    })
}

fn validate_git_selector(value: Option<&str>, field: &str) -> Result<()> {
    if let Some(value) = value
        && (value.is_empty()
            || value.len() > 256
            || value.starts_with('-')
            || value.chars().any(|character| character.is_control()))
    {
        bail!("Git source {field} is invalid");
    }
    Ok(())
}

fn validate_git_sha(value: Option<&str>) -> Result<()> {
    validate_git_selector(value, "sha")?;
    if let Some(value) = value
        && !matches!(value.len(), 40 | 64)
    {
        bail!("Git source SHA must be a full 40- or 64-character digest");
    }
    if let Some(value) = value
        && !value.chars().all(|character| character.is_ascii_hexdigit())
    {
        bail!("Git source SHA must contain only hexadecimal characters");
    }
    Ok(())
}

fn validate_registry_url(value: &str) -> Result<String> {
    let mut url = url::Url::parse(value).context("invalid npm registry URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("npm registry URL must be credential-free HTTP(S)");
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url.to_string())
}

fn normalized_relative_path<'a>(value: &'a str, field: &str) -> Result<&'a Path> {
    let value = value.trim().strip_prefix("./").unwrap_or(value.trim());
    let path = Path::new(value);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        bail!("{field} must be a normalized relative path");
    }
    Ok(path)
}

fn verify_sha512_integrity(path: &Path, integrity: &str) -> Result<()> {
    let encoded = integrity
        .strip_prefix("sha512-")
        .context("npm package integrity must use sha512")?;
    let expected = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("npm package integrity is not valid base64")?;
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha512::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if hasher.finalize().as_slice() != expected.as_slice() {
        bail!("npm tarball does not match its reported integrity");
    }
    Ok(())
}

fn extract_npm_tarball(
    tarball: &Path,
    destination: &Path,
    limits: InstallLimits,
    cancellation: &PluginCancellationToken,
) -> Result<()> {
    cancellation.check()?;
    let compressed_bytes = fs::metadata(tarball)?.len().max(1);
    if compressed_bytes > limits.max_total_bytes {
        bail!("npm tarball exceeds the configured total byte limit");
    }
    let file = fs::File::open(tarball)?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let mut files = 0usize;
    let mut total_bytes = 0u64;
    for entry in archive
        .entries()
        .context("failed to enumerate npm tarball")?
    {
        cancellation.check()?;
        let mut entry = entry.context("failed to read npm tarball entry")?;
        let archive_path = entry.path().context("npm tarball path is invalid")?;
        let relative = strip_npm_package_prefix(&archive_path)?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        if relative.as_os_str().as_encoded_bytes().len() > limits.max_path_bytes
            || relative.components().count() > limits.max_depth
        {
            bail!("npm tarball entry exceeds path limits");
        }
        let target = destination.join(&relative);
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            fs::create_dir_all(&target)?;
            kcoder_config::set_user_only_dir_permissions(&target)?;
            continue;
        }
        if !kind.is_file() {
            bail!(
                "npm tarball contains a link or unsupported entry at {}",
                relative.display()
            );
        }
        files = files.checked_add(1).context("npm file count overflow")?;
        if files > limits.max_files {
            bail!("npm package exceeds {} files", limits.max_files);
        }
        let declared = entry.header().size().context("invalid npm entry size")?;
        if declared > limits.max_file_bytes {
            bail!("npm package file exceeds {} bytes", limits.max_file_bytes);
        }
        total_bytes = total_bytes
            .checked_add(declared)
            .context("npm package size overflow")?;
        if total_bytes > limits.max_total_bytes
            || total_bytes > compressed_bytes.saturating_mul(MAX_COMPRESSION_RATIO)
        {
            bail!("npm package exceeds total size or compression-ratio limits");
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
            kcoder_config::set_user_only_dir_permissions(parent)?;
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?;
        let copied = std::io::copy(
            &mut Read::by_ref(&mut entry).take(limits.max_file_bytes + 1),
            &mut output,
        )?;
        if copied != declared || copied > limits.max_file_bytes {
            bail!("npm package entry changed size while extracting");
        }
        output.flush()?;
        output.sync_all()?;
        kcoder_config::set_user_only_file_permissions(&target)?;
        #[cfg(unix)]
        if entry.header().mode().unwrap_or(0) & 0o111 != 0 {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

fn strip_npm_package_prefix(path: &Path) -> Result<PathBuf> {
    let mut components = path.components();
    match components.next() {
        Some(Component::Normal(prefix)) if prefix == OsStr::new("package") => {}
        _ => bail!("npm tarball entry must stay under the package/ prefix"),
    }
    let mut relative = PathBuf::new();
    for component in components {
        match component {
            Component::Normal(value) => relative.push(value),
            _ => bail!("npm tarball entry contains an unsafe path component"),
        }
    }
    Ok(relative)
}

struct CommandContext<'a> {
    limits: InstallLimits,
    proxy: Option<OsString>,
    cwd: &'a Path,
    deadline: Instant,
    logs: &'a Path,
    cancellation: &'a PluginCancellationToken,
}

fn configure_git_proxy(command: &mut Command, proxy: Option<&OsStr>) -> Result<()> {
    let Some(proxy) = proxy.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let proxy = proxy.to_str().context("Git proxy URL is not UTF-8")?;
    let parsed = url::Url::parse(proxy).context("invalid Git proxy URL")?;
    if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        bail!("Git proxy must be a credential-free HTTP(S) or SOCKS5 endpoint");
    }
    // Proxy inheritance is limited to this validated endpoint.
    command
        .env("HTTPS_PROXY", proxy)
        .env("HTTP_PROXY", proxy)
        .env("ALL_PROXY", proxy);
    Ok(())
}

fn run_isolated_command(
    program: &str,
    args: &[OsString],
    extra_env: &[(OsString, OsString)],
    label: &str,
    context: &CommandContext<'_>,
) -> Result<Vec<u8>> {
    context.cancellation.check()?;
    let stdout_path = context.logs.join(format!("{label}.stdout"));
    let stderr_path = context.logs.join(format!("{label}.stderr"));
    let stdout = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&stdout_path)?;
    let stderr = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&stderr_path)?;
    // Simplify only when Windows can represent the same path without changing semantics.
    let external_cwd = dunce::simplified(context.cwd);
    let mut command = Command::new(program);
    if program == "git" {
        // The isolated environment excludes global Git settings, including Windows long-path support.
        command.args(["-c", "core.longpaths=true"]);
    }
    command
        .current_dir(external_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .env_clear()
        .env(
            "PATH",
            std::env::var_os("PATH")
                .unwrap_or_else(|| OsString::from("/usr/local/bin:/usr/bin:/bin")),
        )
        .env("LC_ALL", "C")
        .env("HOME", external_cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            external_cwd.join("no-global-git-config"),
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "false");
    configure_git_proxy(&mut command, context.proxy.as_deref())?;
    crate::network::configure_target_ca(&mut command, program)?;
    for key in ["NO_PROXY", "no_proxy"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(windows)]
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", system_root);
    }
    for (key, value) in extra_env {
        command.env(key, value);
    }
    command.args(args);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("failed to start {program}"))?;
    let mut last_budget_check = Instant::now();
    let status = loop {
        if context.cancellation.is_cancelled() {
            terminate_process_tree(&mut child);
            bail!("{program} operation cancelled");
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= context.deadline {
            terminate_process_tree(&mut child);
            bail!("{program} operation timed out");
        }
        if last_budget_check.elapsed() >= Duration::from_millis(500) {
            if let Err(error) = command_disk_budget(context) {
                terminate_process_tree(&mut child);
                return Err(error);
            }
            last_budget_check = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let output = read_limited_file(&stdout_path)?;
    if !status.success() {
        let stderr_bytes = read_limited_file(&stderr_path)?;
        let stderr = String::from_utf8_lossy(&stderr_bytes);
        bail!("{program} exited with {status}: {}", stderr.trim());
    }
    Ok(output)
}

// Count the live checkout/cache as well as command logs; download limits must
// apply before materialization finishes, not only when copying the final tree.
fn command_disk_budget(context: &CommandContext<'_>) -> Result<()> {
    let mut pending = vec![context.cwd.to_path_buf()];
    let mut files = 0usize;
    let mut bytes = 0u64;
    while let Some(directory) = pending.pop() {
        context.cancellation.check()?;
        if Instant::now() >= context.deadline {
            bail!("external command operation timed out");
        }
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = entry?;
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            files = files.saturating_add(1);
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                bytes = bytes.saturating_add(metadata.len());
            }
            if files > context.limits.max_files.saturating_mul(4)
                || bytes
                    > context
                        .limits
                        .max_total_bytes
                        .saturating_mul(2)
                        .saturating_add(2 * MAX_COMMAND_OUTPUT_BYTES)
            {
                bail!("plugin download exceeds the configured disk budget");
            }
            if entry.path().parent() == Some(context.logs)
                && metadata.len() > MAX_COMMAND_OUTPUT_BYTES
            {
                bail!("external command output exceeds {MAX_COMMAND_OUTPUT_BYTES} bytes");
            }
        }
    }
    Ok(())
}

fn read_limited_file(path: &Path) -> Result<Vec<u8>> {
    let mut file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_COMMAND_OUTPUT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_COMMAND_OUTPUT_BYTES {
        bail!("external command output exceeds {MAX_COMMAND_OUTPUT_BYTES} bytes");
    }
    Ok(bytes)
}

fn terminate_process_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    // SAFETY: child.id() belongs to a child still owned by this process; a negative PID signals only the process group created for that child.
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use std::net::{TcpListener, TcpStream};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use tempfile::TempDir;

    #[test]
    fn git_proxy_is_explicit_validated_and_does_not_restore_unrelated_environment() {
        let mut command = Command::new("git");
        command.env_clear();
        configure_git_proxy(&mut command, None).unwrap();
        assert_eq!(command.get_envs().count(), 0);
        configure_git_proxy(&mut command, Some(OsStr::new("http://proxy.invalid:10809"))).unwrap();
        let values = command.get_envs().collect::<Vec<_>>();
        assert_eq!(values.len(), 3);
        assert!(
            values
                .iter()
                .all(|(_, value)| *value == Some(OsStr::new("http://proxy.invalid:10809")))
        );
        for invalid in [
            "http://user:password@proxy.invalid:8080",
            "file:///tmp/socket",
            "http://proxy.invalid/path",
        ] {
            assert!(
                configure_git_proxy(&mut Command::new("git"), Some(OsStr::new(invalid))).is_err()
            );
        }
    }

    #[test]
    fn git_materialization_resolves_exact_revision_without_git_metadata() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("repo with spaces");
        fs::create_dir(&repo).unwrap();
        run_test_git(&repo, &["init"]);
        fs::create_dir_all(repo.join(".codex-plugin")).unwrap();
        fs::write(
            repo.join(".codex-plugin/plugin.json"),
            r#"{"name":"git-demo"}"#,
        )
        .unwrap();
        let deep_relative = PathBuf::from("nested-plugin-resources".repeat(2))
            .join("nested-reference-directory".repeat(2))
            .join("nested-reference-directory".repeat(2))
            .join("nested-reference-directory".repeat(2))
            .join("reference.md");
        fs::create_dir_all(repo.join(&deep_relative).parent().unwrap()).unwrap();
        fs::write(repo.join(&deep_relative), "long path fixture").unwrap();
        run_test_git(&repo, &["add", "."]);
        run_test_git(
            &repo,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-m",
                "fixture",
            ],
        );
        let sha = String::from_utf8(
            Command::new("git")
                .args(["-C", repo.to_str().unwrap(), "rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let materialized = materialize_git(GitMaterializeRequest {
            limits: InstallLimits::default(),
            proxy_url: None,
            url: repo.to_str().unwrap(),
            path: None,
            ref_name: None,
            sha: Some(sha.trim()),
            deadline: Instant::now() + Duration::from_secs(10),
            cancellation: &PluginCancellationToken::default(),
        })
        .unwrap();

        assert!(
            materialized
                .root
                .join(".codex-plugin/plugin.json")
                .is_file()
        );
        assert!(!materialized.root.join(".git").exists());
        assert_eq!(
            fs::read_to_string(materialized.root.join(&deep_relative)).unwrap(),
            "long path fixture"
        );
        #[cfg(windows)]
        assert!(
            materialized
                ._temporary
                .path()
                .as_os_str()
                .to_string_lossy()
                .starts_with(r"\\?\"),
            "Windows regression must exercise a handle-derived verbatim private root"
        );
        assert!(matches!(
            materialized.evidence,
            InstalledPluginSource::Git { .. }
        ));
        let shallow = materialize_git(GitMaterializeRequest {
            limits: InstallLimits::default(),
            proxy_url: None,
            url: repo.to_str().unwrap(),
            path: None,
            ref_name: None,
            sha: None,
            deadline: Instant::now() + Duration::from_secs(10),
            cancellation: &PluginCancellationToken::default(),
        })
        .unwrap();
        assert!(shallow.root.join(".codex-plugin/plugin.json").is_file());
        assert!(!shallow.root.join(".git").exists());
    }

    #[test]
    fn npm_materialization_uses_registry_integrity_and_ignores_scripts() {
        if Command::new("npm").arg("--version").status().is_err() {
            return;
        }
        let tarball = npm_fixture_tarball();
        let integrity = sha512_integrity(&tarball);
        let server = TestRegistry::start(tarball, integrity.clone());

        let materialized = materialize_npm(NpmMaterializeRequest {
            proxy_url: None,
            package: "fixture-plugin",
            version: Some("1.0.0"),
            registry: Some(&server.registry_url),
            expected_integrity: Some(&integrity),
            require_integrity: true,
            limits: InstallLimits::default(),
            deadline: Instant::now() + Duration::from_secs(20),
            cancellation: &PluginCancellationToken::default(),
        })
        .unwrap();

        assert!(
            materialized
                .root
                .join(".codex-plugin/plugin.json")
                .is_file()
        );
        assert!(matches!(
            materialized.evidence,
            InstalledPluginSource::Npm {
                package,
                integrity: stored,
            } if package == "fixture-plugin" && stored == integrity
        ));
    }

    #[test]
    fn npm_extractor_rejects_symbolic_links() {
        let temp = TempDir::new().unwrap();
        let tarball = temp.path().join("malicious.tgz");
        let output = fs::File::create(&tarball).unwrap();
        let encoder = GzEncoder::new(output, Compression::default());
        let mut archive = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_cksum();
        archive
            .append_link(&mut header, "package/link", "../../outside")
            .unwrap();
        let encoder = archive.into_inner().unwrap();
        encoder.finish().unwrap();
        let destination = temp.path().join("output");
        fs::create_dir(&destination).unwrap();

        assert!(
            extract_npm_tarball(
                &tarball,
                &destination,
                InstallLimits::default(),
                &PluginCancellationToken::default(),
            )
            .is_err()
        );
        assert!(!destination.join("link").exists());
    }

    #[test]
    fn npm_materialization_rejects_mismatched_marketplace_integrity() {
        if Command::new("npm").arg("--version").status().is_err() {
            return;
        }
        let tarball = npm_fixture_tarball();
        let integrity = sha512_integrity(&tarball);
        let server = TestRegistry::start(tarball, integrity);

        let error = materialize_npm(NpmMaterializeRequest {
            proxy_url: None,
            package: "fixture-plugin",
            version: Some("1.0.0"),
            registry: Some(&server.registry_url),
            expected_integrity: Some("sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
            require_integrity: true,
            limits: InstallLimits::default(),
            deadline: Instant::now() + Duration::from_secs(20),
            cancellation: &PluginCancellationToken::default(),
        })
        .err()
        .expect("mismatched integrity must fail");

        assert!(format!("{error:#}").contains("does not match"));
    }

    fn run_test_git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(["-c", "core.longpaths=true"])
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", cwd.join("no-fixture-global-config"))
            .status()
            .unwrap();
        assert!(status.success());
    }

    pub(crate) fn npm_fixture_tarball() -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut archive = tar::Builder::new(encoder);
        append_tar_file(
            &mut archive,
            "package/package.json",
            br#"{"name":"fixture-plugin","version":"1.0.0","scripts":{"prepare":"exit 99"}}"#,
        );
        append_tar_file(
            &mut archive,
            "package/.codex-plugin/plugin.json",
            br#"{"name":"fixture-plugin","version":"1.0.0"}"#,
        );
        let encoder = archive.into_inner().unwrap();
        encoder.finish().unwrap()
    }

    fn append_tar_file(archive: &mut tar::Builder<GzEncoder<Vec<u8>>>, path: &str, bytes: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive.append_data(&mut header, path, bytes).unwrap();
    }

    pub(crate) fn sha512_integrity(bytes: &[u8]) -> String {
        format!("sha512-{}", STANDARD.encode(Sha512::digest(bytes)))
    }

    pub(crate) struct TestRegistry {
        pub(crate) registry_url: String,
        stopped: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl TestRegistry {
        pub(crate) fn start(tarball: Vec<u8>, integrity: String) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let address = listener.local_addr().unwrap();
            let registry_url = format!("http://{address}/");
            let stopped = Arc::new(AtomicBool::new(false));
            let stopped_for_thread = Arc::clone(&stopped);
            let tarball_url = format!("http://{address}/fixture-plugin/-/fixture-plugin-1.0.0.tgz");
            let thread = std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(20);
                while !stopped_for_thread.load(Ordering::Relaxed) && Instant::now() < deadline {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            serve_registry_request(stream, &tarball, &integrity, &tarball_url);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                registry_url,
                stopped,
                thread: Some(thread),
            }
        }
    }

    impl Drop for TestRegistry {
        fn drop(&mut self) {
            self.stopped.store(true, Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn serve_registry_request(
        mut stream: TcpStream,
        tarball: &[u8],
        integrity: &str,
        tarball_url: &str,
    ) {
        let mut request = [0u8; 8192];
        let read = stream.read(&mut request).unwrap_or(0);
        let first_line = String::from_utf8_lossy(&request[..read])
            .lines()
            .next()
            .unwrap_or_default()
            .to_string();
        let (content_type, body) =
            if first_line.contains("/fixture-plugin/-/fixture-plugin-1.0.0.tgz") {
                ("application/octet-stream", tarball.to_vec())
            } else {
                (
                    "application/json",
                    serde_json::to_vec(&serde_json::json!({
                        "name": "fixture-plugin",
                        "dist-tags": {"latest": "1.0.0"},
                        "versions": {
                            "1.0.0": {
                                "name": "fixture-plugin",
                                "version": "1.0.0",
                                "dist": {
                                    "tarball": tarball_url,
                                    "integrity": integrity
                                }
                            }
                        }
                    }))
                    .unwrap(),
                )
            };
        let headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(headers.as_bytes()).unwrap();
        stream.write_all(&body).unwrap();
    }
}
