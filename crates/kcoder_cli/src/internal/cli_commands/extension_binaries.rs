//! Explicit, bounded probes of CLI binaries that skills and MCP launchers use.
//!
//! These probes resolve executables on the `PATH` this process sees and run
//! `--version` with a deadline. They are for explicit diagnostics (`kcoder
//! doctor`, `extensions/inventory` with `includeBinaries`) only and never run
//! on polling, session lookup or catalog paths.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Marker written by `scripts/release/prepare-lark-cli.mjs` beside the bundled binary.
pub const LARK_CLI_MARKER: &str = ".kcoder-lark-cli.json";
const LARK_CLI_MARKER_SCHEMA: &str = "kcoder.lark-cli-resource.v1";
/// Upper bound for one `--version` probe.
pub const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_VERSION_OUTPUT: u64 = 16 * 1024;
const MAX_PATH_ENTRIES: usize = 256;

/// Binaries reported by the extension inventory.
pub const INVENTORY_BINARIES: &[(&str, &str)] = &[
    ("lark-cli", "Feishu/Lark skills"),
    ("node", "skill scripts and Node MCP launchers"),
    ("playwright-mcp", "Playwright MCP launcher"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryProbe {
    pub name: String,
    /// Every executable with this name on `PATH`, in resolution order.
    pub copies: Vec<PathBuf>,
    /// Version reported by the first copy, when the probe succeeded in time.
    pub version: Option<String>,
    /// The first copy is the one bundled with KCoder Studio.
    pub bundled: bool,
    /// Version recorded by the bundled copy's marker.
    pub bundled_marker_version: Option<String>,
    pub probe_error: Option<String>,
}

impl BinaryProbe {
    pub fn resolved(&self) -> Option<&Path> {
        self.copies.first().map(PathBuf::as_path)
    }
}

fn executable_names(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        let mut names: Vec<String> = extensions
            .split(';')
            .filter(|extension| !extension.is_empty())
            .map(|extension| format!("{name}{}", extension.to_ascii_lowercase()))
            .collect();
        names.push(name.to_owned());
        names
    }
    #[cfg(not(windows))]
    {
        vec![name.to_owned()]
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// All executables named `name` on `path_value`, first match first. Duplicate
/// `PATH` entries that resolve to the same file are reported once.
pub fn find_on_path(name: &str, path_value: Option<&std::ffi::OsStr>) -> Vec<PathBuf> {
    let Some(path_value) = path_value else {
        return Vec::new();
    };
    let mut copies: Vec<PathBuf> = Vec::new();
    let mut identities: Vec<PathBuf> = Vec::new();
    for directory in std::env::split_paths(path_value).take(MAX_PATH_ENTRIES) {
        if directory.as_os_str().is_empty() || !directory.is_absolute() {
            continue;
        }
        for candidate in executable_names(name) {
            let path = directory.join(&candidate);
            if !is_executable(&path) {
                continue;
            }
            let identity = dunce::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if !identities.contains(&identity) {
                identities.push(identity);
                copies.push(path);
            }
            break;
        }
    }
    copies
}

/// Extract the first `X.Y.Z`-like token, accepting a leading `v`.
pub fn parse_version(output: &str) -> Option<String> {
    output
        .lines()
        .take(4)
        .flat_map(|line| line.split(|c: char| c.is_whitespace() || c == ',' || c == '('))
        .map(|token| token.trim_start_matches('v').trim_end_matches(')'))
        .find(|token| {
            let parts: Vec<&str> = token.split('.').collect();
            parts.len() >= 2
                && parts.len() <= 4
                && parts[0].chars().all(|c| c.is_ascii_digit())
                && !parts[0].is_empty()
                && parts[1].chars().next().is_some_and(|c| c.is_ascii_digit())
        })
        .map(|token| token.chars().take(64).collect())
}

/// Run `<path> --version` with a deadline; the child is always reaped.
pub fn probe_version(path: &Path, timeout: Duration) -> Result<Option<String>, String> {
    let mut child = Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("could not start: {}", error.kind()))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "--version did not finish within {}s",
                    timeout.as_secs()
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("could not wait: {}", error.kind()));
            }
        }
    }
    let mut output = String::new();
    if let Some(stdout) = child.stdout.take() {
        let _ = stdout.take(MAX_VERSION_OUTPUT).read_to_string(&mut output);
    }
    Ok(parse_version(&output))
}

/// Version recorded by the bundled lark-cli marker beside `binary`, if any.
pub fn bundled_lark_cli_marker_version(binary: &Path) -> Option<String> {
    let marker = binary.parent()?.join(LARK_CLI_MARKER);
    let metadata = std::fs::symlink_metadata(&marker).ok()?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&marker).ok()?).ok()?;
    if value.get("schema").and_then(serde_json::Value::as_str) != Some(LARK_CLI_MARKER_SCHEMA) {
        return None;
    }
    value
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

/// Studio writes Node and MCP launchers into `<data>/skill-runtime/bin`.
fn is_studio_launcher(binary: &Path) -> bool {
    let mut components = binary.parent().into_iter().flat_map(Path::components).rev();
    matches!(
        (components.next(), components.next()),
        (Some(bin), Some(runtime))
            if bin.as_os_str() == "bin" && runtime.as_os_str() == "skill-runtime"
    )
}

/// Resolve and probe one binary on `path_value`.
pub fn probe(name: &str, path_value: Option<&std::ffi::OsStr>, timeout: Duration) -> BinaryProbe {
    let copies = find_on_path(name, path_value);
    let mut probe = BinaryProbe {
        name: name.to_owned(),
        copies,
        version: None,
        bundled: false,
        bundled_marker_version: None,
        probe_error: None,
    };
    if let Some(resolved) = probe.copies.first().cloned() {
        if name == "lark-cli" {
            probe.bundled_marker_version = bundled_lark_cli_marker_version(&resolved);
            probe.bundled = probe.bundled_marker_version.is_some();
        } else {
            probe.bundled = is_studio_launcher(&resolved);
        }
        // Studio's `playwright-mcp` launcher starts a server; only ask Node itself.
        if name != "playwright-mcp" {
            match probe_version(&resolved, timeout) {
                Ok(version) => probe.version = version,
                Err(error) => probe.probe_error = Some(error),
            }
        }
    }
    probe
}

/// The lark-cli release KCoder bundles, from the embedded `lark-shared` record.
pub fn bundled_lark_cli_version() -> Option<String> {
    kcoder_skills::sources::bundled_upstream("lark-shared").and_then(|upstream| upstream.version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_tokens_are_parsed_from_common_cli_outputs() {
        assert_eq!(
            parse_version("lark-cli version 1.0.100\n").as_deref(),
            Some("1.0.100")
        );
        assert_eq!(parse_version("v22.11.0\n").as_deref(), Some("22.11.0"));
        assert_eq!(parse_version("lark-cli (v0.1.1)").as_deref(), Some("0.1.1"));
        assert_eq!(parse_version("no version here"), None);
    }

    #[cfg(unix)]
    #[test]
    fn path_copies_are_ordered_deduplicated_and_marker_identifies_bundled_copy() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("bundled");
        let second = temp.path().join("system");
        for directory in [&first, &second] {
            std::fs::create_dir_all(directory).unwrap();
            let binary = directory.join("lark-cli");
            std::fs::write(&binary, "#!/bin/sh\necho 'lark-cli version 1.0.100'\n").unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::write(
            first.join(LARK_CLI_MARKER),
            r#"{"schema":"kcoder.lark-cli-resource.v1","version":"1.0.100"}"#,
        )
        .unwrap();
        let path = std::env::join_paths([&first, &second, &first]).unwrap();
        let result = probe("lark-cli", Some(&path), VERSION_PROBE_TIMEOUT);
        assert_eq!(
            result.copies,
            [first.join("lark-cli"), second.join("lark-cli")]
        );
        assert!(result.bundled);
        assert_eq!(result.version.as_deref(), Some("1.0.100"));
        let reversed = std::env::join_paths([&second, &first]).unwrap();
        assert!(!probe("lark-cli", Some(&reversed), VERSION_PROBE_TIMEOUT).bundled);
    }

    #[cfg(unix)]
    #[test]
    fn hung_version_probe_is_bounded_and_reaped() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("lark-cli");
        std::fs::write(&binary, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = Instant::now();
        let error = probe_version(&binary, Duration::from_millis(200)).unwrap_err();
        assert!(error.contains("did not finish"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
