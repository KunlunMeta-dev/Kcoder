//! Windows installed resources are read relative to retained directory handles.
use super::{
    EGRESS, Entry, Inventory, LAUNCHER, Manifest, Phase, REQUIREMENTS, VerifyMetrics,
    validate_manifest,
};
use anyhow::{Context, Result, ensure};
use kcoder_config::{ReadOnlyDirectoryPin, ReadOnlyDirectoryStamp, ReadOnlyFilePin};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

/// Private launch lease. The public diagnostic may drop it after verification;
/// an actual worker retains it until its trusted exit observation completes.
pub(super) struct VerifiedRuntime {
    pub(super) python: PathBuf,
    _files: BTreeMap<String, ReadOnlyFilePin>,
    _directories: Vec<DirectoryFact>,
}

struct DirectoryFact {
    directory: ReadOnlyDirectoryPin,
    stamp: ReadOnlyDirectoryStamp,
    names: Vec<OsString>,
}

struct OpenJob {
    name: String,
    parent: ReadOnlyDirectoryPin,
    leaf: OsString,
}

struct Opened {
    name: String,
    file: ReadOnlyFilePin,
    elapsed: Duration,
}

fn open_payloads(jobs: Vec<OpenJob>, metrics: &mut VerifyMetrics) -> Result<Vec<Opened>> {
    let started = Instant::now();
    let count = jobs.len().min(8);
    if count == 0 {
        return Ok(Vec::new());
    }
    let mut batches = (0..count).map(|_| Vec::new()).collect::<Vec<_>>();
    for (index, job) in jobs.into_iter().enumerate() {
        batches[index % count].push(job);
    }
    let result = std::thread::scope(|scope| {
        let handles = batches
            .into_iter()
            .map(|batch| {
                scope.spawn(move || -> Result<Vec<Opened>> {
                    let mut opened = Vec::new();
                    for job in batch {
                        let started = Instant::now();
                        let file = job.parent.open_file(&job.leaf)?;
                        opened.push(Opened {
                            name: job.name,
                            file,
                            elapsed: started.elapsed(),
                        });
                    }
                    Ok(opened)
                })
            })
            .collect::<Vec<_>>();
        let mut opened = Vec::new();
        let mut failure = None;
        // Explicitly join every worker even on error. No open task survives
        // this scope and every successful pin is released if any worker fails.
        for handle in handles {
            match handle.join() {
                Ok(Ok(batch)) => opened.extend(batch),
                Ok(Err(error)) => {
                    failure.get_or_insert(error);
                }
                Err(_) => {
                    failure.get_or_insert_with(|| anyhow::anyhow!("Sealed resource reader failed"));
                }
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(opened),
        }
    });
    metrics.record(Phase::ResourceOpenWall, started.elapsed(), count as u64);
    let opened = result?;
    for entry in &opened {
        let (native, identity, basic) = entry.file.open_timings();
        metrics.record(Phase::ResourceOpenCall, native, 1);
        metrics.record(Phase::ResourceMetadata, identity + basic, 1);
        metrics.record(Phase::ResourceIdentity, identity, 1);
        metrics.record(Phase::ResourceBasicInfo, basic, 1);
        metrics.record(Phase::ResourceOpen, entry.elapsed, 1);
    }
    Ok(opened)
}

fn relative_parts(name: &str) -> Result<Vec<&str>> {
    ensure!(
        !name.is_empty()
            && !name.contains('\\')
            && Path::new(name)
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "Unsafe bundled SearXNG resource path"
    );
    Ok(name.split('/').collect())
}

fn bounded(file: &ReadOnlyFilePin, limit: u64) -> Result<Vec<u8>> {
    ensure!(
        file.len() <= limit,
        "Bundled SearXNG metadata exceeds its limit"
    );
    let mut reader = file.file();
    reader.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= limit,
        "Bundled SearXNG component exceeds its limit"
    );
    file.verify_unchanged()?;
    Ok(bytes)
}

fn hash_file(file: &ReadOnlyFilePin, entry: &Entry, metrics: &mut VerifyMetrics) -> Result<()> {
    ensure!(
        file.len() == entry.bytes,
        "Bundled SearXNG file size mismatch"
    );
    file.verify_unchanged()?;
    let mut reader = file.file();
    reader.seek(SeekFrom::Start(0))?;
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes = bytes.saturating_add(count as u64);
        ensure!(
            bytes <= entry.bytes,
            "Bundled SearXNG file grew while hashing"
        );
        digest.update(&buffer[..count]);
    }
    ensure!(
        bytes == entry.bytes && format!("{:x}", digest.finalize()) == entry.sha256,
        "Bundled SearXNG file hash mismatch"
    );
    file.verify_unchanged()?;
    metrics.hashed_bytes = metrics.hashed_bytes.saturating_add(bytes);
    Ok(())
}

pub(super) fn verify(root: &Path, metrics: &mut VerifyMetrics) -> Result<VerifiedRuntime> {
    *metrics = VerifyMetrics::default();
    ensure!(
        cfg!(target_arch = "x86_64"),
        "Bundled SearXNG currently requires an x64 runtime"
    );
    let started = Instant::now();
    let root = ReadOnlyDirectoryPin::open_existing(root)
        .context("Bundled SearXNG directory unavailable")?;
    let manifest_file = root.open_file(OsStr::new("runtime-manifest.json"))?;
    let manifest: Manifest = serde_json::from_slice(&bounded(&manifest_file, 64 * 1024)?)?;
    validate_manifest(&manifest)?;
    metrics.record(Phase::Manifest, started.elapsed(), 1);
    let started = Instant::now();
    let inventory_file = root.open_file(OsStr::new("files.sha256.json"))?;
    let inventory: Inventory = serde_json::from_slice(&bounded(&inventory_file, 8 * 1024 * 1024)?)?;
    ensure!(
        inventory.files.len() <= 30000,
        "Bundled SearXNG inventory is too large"
    );
    metrics.inventory_files = inventory.files.len() as u64;
    let mut expected_directories = BTreeSet::new();
    let mut total = 0u64;
    for (name, entry) in &inventory.files {
        relative_parts(name)?;
        total = total.saturating_add(entry.bytes);
        ensure!(
            entry.bytes <= 256 * 1024 * 1024 && total <= 1024 * 1024 * 1024,
            "Bundled SearXNG file budget exceeded"
        );
        let mut prefix = name.as_str();
        while let Some((parent, _)) = prefix.rsplit_once('/') {
            expected_directories.insert(parent.to_owned());
            prefix = parent;
        }
    }
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
    metrics.record(Phase::Inventory, started.elapsed(), 1);
    let mut files = BTreeMap::from([
        ("runtime-manifest.json".to_owned(), manifest_file),
        ("files.sha256.json".to_owned(), inventory_file),
    ]);
    let mut pending = vec![(String::new(), root.clone())];
    let mut directories = Vec::new();
    let mut observed = BTreeSet::new();
    let mut jobs = Vec::new();
    let mut entries = 0u64;
    let entry_budget = directory_entry_budget();
    while let Some((prefix, directory)) = pending.pop() {
        let started = Instant::now();
        let stamp = directory.stamp()?;
        let mut names = directory.names_bounded(60000)?;
        names.sort();
        entries = entries.saturating_add(names.len() as u64);
        ensure!(
            entries <= entry_budget,
            "Bundled SearXNG directory budget exceeded"
        );
        for name in &names {
            let text = name.to_str().context("Invalid SearXNG resource name")?;
            let relative = if prefix.is_empty() {
                text.to_owned()
            } else {
                format!("{prefix}/{text}")
            };
            if expected_directories.contains(&relative) {
                pending.push((relative, directory.open_child(name)?));
            } else if relative == "files.sha256.json" || inventory.files.contains_key(&relative) {
                if !files.contains_key(&relative) {
                    jobs.push(OpenJob {
                        name: relative.clone(),
                        parent: directory.clone(),
                        leaf: name.clone(),
                    });
                }
                ensure!(
                    observed.insert(relative),
                    "Duplicate bundled SearXNG resource"
                );
            } else {
                // Empty unlisted directories were allowed before. Unknown files,
                // links and other types fail this no-follow directory open.
                let child = directory
                    .open_child(name)
                    .context("Unlisted bundled SearXNG resource")?;
                pending.push((relative, child));
            }
        }
        metrics.directories += 1;
        metrics.record(Phase::Enumeration, started.elapsed(), names.len() as u64);
        directories.push(DirectoryFact {
            directory,
            stamp,
            names,
        });
    }
    for name in inventory.files.keys() {
        ensure!(
            observed.contains(name),
            "Bundled SearXNG resource is missing or inaccessible: {name}; reinstall the full KCoder package"
        );
    }
    for entry in open_payloads(jobs, metrics)? {
        ensure!(
            files.insert(entry.name, entry.file).is_none(),
            "Duplicate bundled SearXNG resource"
        );
    }
    ensure!(
        observed.len() == files.len(),
        "Unlisted bundled SearXNG resource"
    );
    for (name, entry) in &inventory.files {
        let started = Instant::now();
        let file = files
            .get(name)
            .context("Bundled SearXNG resource unavailable")?;
        metrics.record(Phase::ResourcePaths, started.elapsed(), 1);
        let started = Instant::now();
        hash_file(file, entry, metrics)?;
        metrics.record(Phase::ResourceHash, started.elapsed(), 1);
    }
    let started = Instant::now();
    for (name, expected, limit) in [
        ("launch.py", LAUNCHER, 128 * 1024),
        ("egress.py", EGRESS, 128 * 1024),
        ("build-source/requirements.lock", REQUIREMENTS, 256 * 1024),
    ] {
        ensure!(
            bounded(
                files
                    .get(name)
                    .context("Bundled SearXNG recipe unavailable")?,
                limit
            )? == expected,
            "Bundled SearXNG embedded recipe changed"
        );
    }
    let python = root.path().join(&manifest.python);
    metrics.record(Phase::Recipe, started.elapsed(), 4);
    before_final_validation();
    let started = Instant::now();
    for fact in &directories {
        let mut names = fact.directory.names_bounded(60000)?;
        names.sort();
        ensure!(
            names == fact.names && fact.directory.stamp()? == fact.stamp,
            "Bundled SearXNG namespace changed during verification"
        );
    }
    metrics.record(
        Phase::FinalNamespace,
        started.elapsed(),
        directories.len() as u64,
    );
    let started = Instant::now();
    for file in files.values() {
        file.verify_unchanged()?;
    }
    metrics.record(Phase::FinalFiles, started.elapsed(), files.len() as u64);
    Ok(VerifiedRuntime {
        python,
        _files: files,
        _directories: directories,
    })
}

fn directory_entry_budget() -> u64 {
    #[cfg(test)]
    if let Some(limit) = DIRECTORY_BUDGET.with(|slot| slot.take()) {
        return limit.min(60000);
    }
    60000
}

#[cfg(not(test))]
fn before_final_validation() {}
#[cfg(test)]
fn before_final_validation() {
    let hook = FINAL_HOOK.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}
#[cfg(test)]
thread_local! { static FINAL_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) }; }
#[cfg(test)]
thread_local! { static DIRECTORY_BUDGET: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) }; }

#[cfg(test)]
#[path = "windows_verify_tests.rs"]
mod tests;
