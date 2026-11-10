//! Handle-relative, bounded verification of the sealed public Office bundle.
use super::*;
use std::{
    collections::{BTreeSet, HashSet},
    fs::File,
};

pub(super) fn parts(value: &str) -> Result<Vec<&str>> {
    ensure!(
        !value.is_empty()
            && !value.contains('\\')
            && !value.contains(':')
            && !value.chars().any(char::is_control)
            && !Path::new(value).is_absolute(),
        "OFFICE_COMPONENT_IDENTITY_UNAVAILABLE"
    );
    let parts = value.split('/').collect::<Vec<_>>();
    ensure!(
        parts
            .iter()
            .all(|part| !part.is_empty() && *part != "." && *part != ".."),
        "OFFICE_COMPONENT_IDENTITY_UNAVAILABLE"
    );
    Ok(parts)
}
pub(super) fn open_relative(root: &PrivateDirectory, path: &str) -> Result<File> {
    let names = parts(path)?;
    let mut current = root.duplicate_handle()?;
    for name in &names[..names.len() - 1] {
        current = current
            .open_entry_handle(OsStr::new(name))?
            .open_child_directory()?;
    }
    current
        .open_single_link_regular_file(OsStr::new(
            names.last().context("OFFICE_COMPONENT_UNAVAILABLE")?,
        ))
        .context("OFFICE_COMPONENT_UNAVAILABLE")
}
fn digest(file: &mut File, expected: u64, cancel: &CancellationToken) -> Result<String> {
    ensure!(
        file.metadata()?.len() == expected,
        "OFFICE_COMPONENT_IDENTITY_CHANGED"
    );
    let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buffer = [0u8; 65536];
    let mut total = 0u64;
    loop {
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        ensure!(total <= expected, "OFFICE_COMPONENT_IDENTITY_CHANGED");
        hash.update(&buffer[..read]);
    }
    ensure!(
        total == expected && file.metadata()?.len() == expected,
        "OFFICE_COMPONENT_IDENTITY_CHANGED"
    );
    Ok(hash
        .finish()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
pub(super) fn verify_tree(
    root: &PrivateDirectory,
    manifest: &ResourceManifest,
    cancel: &CancellationToken,
) -> Result<()> {
    let expected = manifest
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    let mut found = HashSet::new();
    let mut directories = BTreeSet::new();
    for path in expected.keys() {
        let p = parts(path)?;
        for end in 1..p.len() {
            directories.insert(p[..end].join("/"));
        }
    }
    fn visit(
        root: &PrivateDirectory,
        prefix: &str,
        depth: usize,
        expected: &BTreeMap<&str, &ResourceFile>,
        directories: &BTreeSet<String>,
        found: &mut HashSet<String>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        ensure!(depth <= 40, "OFFICE_COMPONENT_IDENTITY_UNAVAILABLE");
        root.visit_entry_names_bounded(20001, |name| {
            ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
            let name = name
                .to_str()
                .context("OFFICE_COMPONENT_IDENTITY_UNAVAILABLE")?;
            let path = if prefix.is_empty() {
                name.to_string()
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
                    "OFFICE_COMPONENT_IDENTITY_CHANGED"
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
                "OFFICE_COMPONENT_IDENTITY_CHANGED"
            );
            let target = expected
                .get(path.as_str())
                .context("OFFICE_COMPONENT_IDENTITY_CHANGED")?;
            let mut file = root.open_single_link_regular_file(OsStr::new(name))?;
            ensure!(
                digest(&mut file, target.bytes, cancel)? == target.sha256,
                "OFFICE_COMPONENT_IDENTITY_CHANGED"
            );
            ensure!(found.insert(path), "OFFICE_COMPONENT_IDENTITY_CHANGED");
            Ok(())
        })
    }
    visit(root, "", 0, &expected, &directories, &mut found, cancel)?;
    ensure!(
        found.len() == expected.len(),
        "OFFICE_COMPONENT_IDENTITY_CHANGED"
    );
    let mut lock = open_relative(root, "components/package-lock.json")?;
    let lock_bytes = lock.metadata()?.len();
    ensure!(
        digest(&mut lock, lock_bytes, cancel)? == manifest.lock_sha256,
        "OFFICE_COMPONENT_IDENTITY_CHANGED"
    );
    for dependency in &manifest.dependencies {
        let path = format!("components/{}/package.json", dependency.path);
        let mut file = open_relative(root, &path)?;
        ensure!(
            file.metadata()?.len() <= 2 * 1024 * 1024,
            "OFFICE_DEPENDENCY_UNAVAILABLE"
        );
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).context("OFFICE_DEPENDENCY_UNAVAILABLE")?;
        ensure!(
            value.get("version").and_then(serde_json::Value::as_str)
                == Some(dependency.version.as_str()),
            "OFFICE_DEPENDENCY_UNAVAILABLE"
        );
    }
    Ok(())
}
pub(super) struct RuntimeFacts {
    pub(super) sha256: String,
    pub(super) has_electron_fuse: bool,
    pub(super) run_as_node_enabled: bool,
}
pub(super) fn hash_runtime(
    path: &Path,
    cancel: &CancellationToken,
    inspect_fuses: bool,
) -> Result<RuntimeFacts> {
    ensure!(path.is_absolute(), "OFFICE_NODE_UNAVAILABLE");
    let root = PrivateDirectory::open_existing(path.parent().context("OFFICE_NODE_UNAVAILABLE")?)?;
    let mut file =
        root.open_single_link_regular_file(path.file_name().context("OFFICE_NODE_UNAVAILABLE")?)?;
    let size = file.metadata()?.len();
    ensure!(size <= 1024 * 1024 * 1024, "OFFICE_NODE_UNAVAILABLE");
    const SENTINEL: &[u8] = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
    let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buffer = vec![0u8; 256 * 1024];
    let mut tail = Vec::new();
    let mut positions = BTreeSet::new();
    let mut modes = Vec::new();
    let mut total = 0u64;
    loop {
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        let start = total.saturating_sub(tail.len() as u64);
        total += read as u64;
        if !inspect_fuses {
            continue;
        }
        tail.extend_from_slice(&buffer[..read]);
        for (index, window) in tail.windows(SENTINEL.len()).enumerate() {
            if window == SENTINEL && index + SENTINEL.len() + 2 < tail.len() {
                let position = start + index as u64;
                if positions.insert(position) {
                    let at = index + SENTINEL.len();
                    modes.push(tail[at] == 1 && tail[at + 1] >= 1 && tail[at + 2] == 49);
                    ensure!(modes.len() <= 8, "OFFICE_RUNTIME_MODE_UNAVAILABLE");
                }
            }
        }
        let keep = SENTINEL.len() + 260;
        if tail.len() > keep {
            tail.drain(..tail.len() - keep);
        }
    }
    ensure!(
        total == size && file.metadata()?.len() == size,
        "OFFICE_COMPONENT_IDENTITY_CHANGED"
    );
    Ok(RuntimeFacts {
        sha256: hash
            .finish()
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        has_electron_fuse: !modes.is_empty(),
        run_as_node_enabled: !modes.is_empty() && modes.iter().all(|mode| *mode),
    })
}

#[cfg(test)]
#[path = "resource_digest_tests.rs"]
mod digest_tests;
