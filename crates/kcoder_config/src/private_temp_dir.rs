use anyhow::{Context, Result};
use chrono::{Local, NaiveDate};
use fs2::FileExt;
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

const CREATE_ATTEMPTS: usize = 128;
const TEMP_ROOT_NAME: &str = "tmp";
const MANAGER_LOCK_NAME: &str = ".manager.lock";
const LEASE_DIRECTORY_NAME: &str = ".leases";
const LEASE_SUFFIX: &str = ".lock";
const LEASE_RECORD_MAGIC: &str = "kcoder-private-temp-lease-v1\n";
const MAX_LEASE_RECORD_BYTES: usize = 512;
const TEMP_DIR_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60 * 60);
const MAX_GC_CANDIDATES: usize = 256;
const MAX_GC_DIRECTORIES: usize = 512;
const MAX_DIRECTORY_ENTRIES: usize = 1024;

#[derive(Debug)]
pub struct PrivateTempDir {
    path: PathBuf,
    tmp_root: crate::PrivateDirectory,
    year: Option<crate::PrivateDirectory>,
    month: Option<crate::PrivateDirectory>,
    day: Option<crate::PrivateDirectory>,
    year_name: OsString,
    month_name: OsString,
    day_name: OsString,
    leaf_name: OsString,
    leases: Option<crate::PrivateDirectory>,
    lease_name: OsString,
    leaf: Option<crate::PrivateDirectory>,
    lease: Option<File>,
    #[cfg(test)]
    cleanup_on_drop: bool,
}

#[derive(Debug)]
struct TempManagerLock(File);

impl Drop for TempManagerLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

#[cfg(test)]
struct TrustedTempParent {
    #[cfg(not(windows))]
    path: PathBuf,
    #[cfg(windows)]
    handle: std::fs::File,
}

#[cfg(test)]
#[derive(Debug)]
struct LegacyPrivateTempDir {
    path: PathBuf,
    #[cfg(windows)]
    handle: File,
}

#[cfg(test)]
impl LegacyPrivateTempDir {
    fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
impl Drop for LegacyPrivateTempDir {
    fn drop(&mut self) {
        #[cfg(not(windows))]
        let _ = std::fs::remove_dir_all(&self.path);
        #[cfg(windows)]
        {
            if let Ok(entries) = std::fs::read_dir(&self.path) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let _ = if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                        std::fs::remove_dir_all(path)
                    } else {
                        std::fs::remove_file(path)
                    };
                }
            }
            let _ = windows::delete_directory_handle(&self.handle);
        }
    }
}

impl PrivateTempDir {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for PrivateTempDir {
    fn drop(&mut self) {
        #[cfg(test)]
        if !self.cleanup_on_drop {
            return;
        }
        let Ok(_manager_lock) = acquire_manager_lock(&self.tmp_root) else {
            return;
        };
        self.lease.take();
        self.leaf.take();
        let leaf_removed = self
            .day
            .as_ref()
            .is_some_and(|day| day.remove_child_tree(&self.leaf_name).is_ok());
        if leaf_removed {
            if let Some(leases) = self.leases.as_ref() {
                let _ = leases.remove_regular_file(&self.lease_name);
            }
            if let Some(leases) = self.leases.take() {
                drop(leases);
                if let Some(day) = self.day.as_ref() {
                    let _ = day.remove_empty_child_directory(OsStr::new(LEASE_DIRECTORY_NAME));
                }
            }
        }
        if let Some(day) = self.day.take() {
            drop(day);
            if let Some(month) = self.month.as_ref() {
                let _ = month.remove_empty_child_directory(&self.day_name);
            }
        }
        if let Some(month) = self.month.take() {
            drop(month);
            if let Some(year) = self.year.as_ref() {
                let _ = year.remove_empty_child_directory(&self.month_name);
            }
        }
        if let Some(year) = self.year.take() {
            drop(year);
            let _ = self.tmp_root.remove_empty_child_directory(&self.year_name);
        }
    }
}

/// Create a private temporary directory under the application's configuration
/// directory using a local date partition and an unpredictable leaf name.
pub fn create_private_temp_dir(prefix: &str) -> Result<PrivateTempDir> {
    create_private_temp_dir_at_with(
        &crate::Settings::config_dir()?,
        prefix,
        Local::now().date_naive(),
        |bytes| {
            getrandom::fill(bytes).map_err(|error| {
                anyhow::anyhow!("failed to obtain operating-system randomness: {error}")
            })
        },
        true,
    )
}

fn create_private_temp_dir_at_with(
    config_dir: &Path,
    prefix: &str,
    date: NaiveDate,
    mut fill_random: impl FnMut(&mut [u8]) -> Result<()>,
    run_cleanup: bool,
) -> Result<PrivateTempDir> {
    validate_prefix(prefix)?;
    let config_dir = absolute_config_dir(config_dir)?;
    let config_root = open_config_root(&config_dir)?;
    let tmp_root = config_root.open_child(OsStr::new(TEMP_ROOT_NAME), true)?;
    tmp_root.verify_private_temp_directory()?;
    let _manager_lock = acquire_manager_lock(&tmp_root)?;

    if run_cleanup && cleanup_is_due(&config_dir.join(TEMP_ROOT_NAME)) {
        if let Err(error) = cleanup_expired_locked(
            &tmp_root,
            Local::now().date_naive(),
            SystemTime::now(),
            TEMP_DIR_TTL,
        ) {
            tracing::warn!(error = %error, "private temp cleanup skipped");
        }
    }

    let year = date.format("%Y").to_string();
    let month = date.format("%m").to_string();
    let day_name = date.format("%d").to_string();
    let year_dir = open_private_child(&tmp_root, &year)?;
    let month_dir = open_private_child(&year_dir, &month)?;
    let day = open_private_child(&month_dir, &day_name)?;
    let mut path = config_dir
        .join(TEMP_ROOT_NAME)
        .join(&year)
        .join(&month)
        .join(&day_name);
    let mut leases = None;
    for _ in 0..CREATE_ATTEMPTS {
        let component = match random_component(prefix, &mut fill_random) {
            Ok(component) => component,
            Err(error) => {
                discard_empty_lease_directory(&day, &mut leases);
                return Err(error);
            }
        };
        if leases.is_none() {
            leases = match open_private_child(&day, LEASE_DIRECTORY_NAME) {
                Ok(leases) => Some(leases),
                Err(error) => return Err(error),
            };
        }
        let lease_directory = leases.as_ref().expect("lease directory was opened");
        let lease_name = lease_file_name(OsStr::new(&component));
        let leaf = match day.create_child(OsStr::new(&component)) {
            Ok(leaf) => leaf,
            Err(error) if is_io_kind(&error, std::io::ErrorKind::AlreadyExists) => continue,
            Err(error) => {
                discard_empty_lease_directory(&day, &mut leases);
                return Err(error);
            }
        };
        let mut lease = match lease_directory.open_read_write_file(&lease_name, true) {
            Ok(lease) => lease,
            Err(error) if is_io_kind(&error, std::io::ErrorKind::AlreadyExists) => {
                drop(leaf);
                let _ = day.remove_child_tree(OsStr::new(&component));
                continue;
            }
            Err(error) => {
                drop(leaf);
                let _ = day.remove_child_tree(OsStr::new(&component));
                discard_empty_lease_directory(&day, &mut leases);
                return Err(error);
            }
        };
        if let Err(error) = FileExt::lock_exclusive(&lease) {
            drop(lease);
            let _ = lease_directory.remove_regular_file(&lease_name);
            drop(leaf);
            let _ = day.remove_child_tree(OsStr::new(&component));
            discard_empty_lease_directory(&day, &mut leases);
            return Err(error.into());
        }
        if let Err(error) = write_lease_record(&mut lease, SystemTime::now(), &component) {
            drop(lease);
            let _ = lease_directory.remove_regular_file(&lease_name);
            drop(leaf);
            let _ = day.remove_child_tree(OsStr::new(&component));
            discard_empty_lease_directory(&day, &mut leases);
            return Err(error);
        }
        path.push(&component);
        return Ok(PrivateTempDir {
            path,
            tmp_root,
            year: Some(year_dir),
            month: Some(month_dir),
            day: Some(day),
            year_name: OsString::from(year),
            month_name: OsString::from(month),
            day_name: OsString::from(day_name),
            leaf_name: OsString::from(component),
            leases,
            lease_name,
            leaf: Some(leaf),
            lease: Some(lease),
            #[cfg(test)]
            cleanup_on_drop: true,
        });
    }
    discard_empty_lease_directory(&day, &mut leases);
    anyhow::bail!("failed to allocate a unique private temporary directory")
}

fn discard_empty_lease_directory(
    day: &crate::PrivateDirectory,
    leases: &mut Option<crate::PrivateDirectory>,
) {
    if let Some(leases) = leases.take() {
        drop(leases);
        let _ = day.remove_empty_child_directory(OsStr::new(LEASE_DIRECTORY_NAME));
    }
}

fn validate_prefix(prefix: &str) -> Result<()> {
    anyhow::ensure!(
        !prefix.is_empty()
            && prefix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')),
        "private temporary directory prefix is not a safe component"
    );
    Ok(())
}

fn absolute_config_dir(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    anyhow::ensure!(
        absolute
            .components()
            .all(|component| { !matches!(component, std::path::Component::ParentDir) }),
        "configuration directory must not contain parent-directory components"
    );
    Ok(absolute)
}

fn open_config_root(path: &Path) -> Result<crate::PrivateDirectory> {
    let directory = match crate::PrivateDirectory::open_existing(path) {
        Ok(directory) => Ok(directory),
        Err(error) if is_io_kind(&error, std::io::ErrorKind::NotFound) => {
            crate::PrivateDirectory::open_or_create(path)
        }
        Err(error) => Err(error),
    }?;
    directory.verify_config_root_directory()?;
    Ok(directory)
}

fn open_private_child(
    parent: &crate::PrivateDirectory,
    name: &str,
) -> Result<crate::PrivateDirectory> {
    let child = parent.open_child(OsStr::new(name), true)?;
    child.verify_private_temp_directory()?;
    Ok(child)
}

fn acquire_manager_lock(root: &crate::PrivateDirectory) -> Result<TempManagerLock> {
    let name = OsStr::new(MANAGER_LOCK_NAME);
    let file = match root.open_read_write_file(name, true) {
        Ok(file) => file,
        Err(error) if is_io_kind(&error, std::io::ErrorKind::AlreadyExists) => {
            root.open_read_write_file(name, false)?
        }
        Err(error) => return Err(error),
    };
    FileExt::lock_exclusive(&file).context("failed to lock private temp manager")?;
    Ok(TempManagerLock(file))
}

fn is_io_kind(error: &anyhow::Error, kind: std::io::ErrorKind) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|io| io.kind() == kind)
}

fn cleanup_is_due(path: &Path) -> bool {
    static LAST_CLEANUP: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    let now = Instant::now();
    let mut last_cleanup = LAST_CLEANUP
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if last_cleanup
        .get(path)
        .is_some_and(|last| now.duration_since(*last) < CLEANUP_INTERVAL)
    {
        return false;
    }
    last_cleanup.insert(path.to_path_buf(), now);
    true
}

fn cleanup_expired_locked(
    root: &crate::PrivateDirectory,
    today: NaiveDate,
    now: SystemTime,
    ttl: Duration,
) -> Result<usize> {
    let date_cutoff = today
        .checked_sub_days(chrono::Days::new(7))
        .unwrap_or(NaiveDate::MIN);
    let created_cutoff = now.checked_sub(ttl).unwrap_or(SystemTime::UNIX_EPOCH);
    let years = root.entry_names_bounded(MAX_DIRECTORY_ENTRIES)?;
    let mut visited_directories = 0usize;
    let mut visited_candidates = 0usize;
    let mut removed = 0usize;

    'years: for year_name in years {
        if visited_directories >= MAX_GC_DIRECTORIES {
            break;
        }
        let Some(year) = parse_year(&year_name) else {
            continue;
        };
        let Ok(year_dir) = root.open_child(&year_name, false) else {
            continue;
        };
        if year_dir.verify_private_temp_directory().is_err() {
            continue;
        }
        visited_directories += 1;
        if visited_directories >= MAX_GC_DIRECTORIES {
            break;
        }
        let Ok(months) = year_dir.entry_names_bounded(MAX_DIRECTORY_ENTRIES) else {
            continue;
        };
        for month_name in months {
            if visited_directories >= MAX_GC_DIRECTORIES {
                break 'years;
            }
            let Some(month) =
                parse_two_digits(&month_name).filter(|month| (1..=12).contains(month))
            else {
                continue;
            };
            let Ok(month_dir) = year_dir.open_child(&month_name, false) else {
                continue;
            };
            if month_dir.verify_private_temp_directory().is_err() {
                continue;
            }
            visited_directories += 1;
            if visited_directories >= MAX_GC_DIRECTORIES {
                break 'years;
            }
            let Ok(days) = month_dir.entry_names_bounded(MAX_DIRECTORY_ENTRIES) else {
                continue;
            };
            for day_name in days {
                if visited_directories >= MAX_GC_DIRECTORIES {
                    break 'years;
                }
                let Some(day_of_month) = parse_two_digits(&day_name) else {
                    continue;
                };
                let Some(date) = NaiveDate::from_ymd_opt(year, month, day_of_month) else {
                    continue;
                };
                if date >= date_cutoff {
                    continue;
                }
                let Ok(day) = month_dir.open_child(&day_name, false) else {
                    continue;
                };
                if day.verify_private_temp_directory().is_err() {
                    continue;
                }
                visited_directories += 1;
                if visited_directories >= MAX_GC_DIRECTORIES {
                    break 'years;
                }
                let Ok(leaves) = day.entry_names_bounded(MAX_DIRECTORY_ENTRIES) else {
                    continue;
                };
                for leaf_name in leaves {
                    if !is_temp_leaf_name(&leaf_name) {
                        continue;
                    }
                    if visited_candidates >= MAX_GC_CANDIDATES
                        || visited_directories >= MAX_GC_DIRECTORIES
                    {
                        break 'years;
                    }
                    visited_candidates += 1;
                    let leases = match day.open_child(OsStr::new(LEASE_DIRECTORY_NAME), false) {
                        Ok(leases) if leases.verify_private_temp_directory().is_ok() => leases,
                        _ => continue,
                    };
                    let lease_name = lease_file_name(&leaf_name);
                    let Ok(mut lease) = leases.open_read_write_file(&lease_name, false) else {
                        continue;
                    };
                    if FileExt::try_lock_exclusive(&lease).is_err() {
                        continue;
                    }
                    let Ok(created) = read_lease_record(&mut lease, &leaf_name) else {
                        continue;
                    };
                    if created > created_cutoff {
                        continue;
                    }
                    let Ok(leaf) = day.open_child(&leaf_name, false) else {
                        continue;
                    };
                    if leaf.verify_private_temp_directory().is_err() {
                        continue;
                    }
                    drop(lease);
                    drop(leaf);
                    drop(leases);
                    if day.remove_child_tree(&leaf_name).is_ok() {
                        let leases = day.open_child(OsStr::new(LEASE_DIRECTORY_NAME), false);
                        if let Ok(leases) = leases {
                            let _ = leases.remove_regular_file(&lease_name);
                            drop(leases);
                            let _ =
                                day.remove_empty_child_directory(OsStr::new(LEASE_DIRECTORY_NAME));
                        }
                        removed += 1;
                    }
                }
                drop(day);
                let _ = month_dir.remove_empty_child_directory(&day_name);
            }
            drop(month_dir);
            let _ = year_dir.remove_empty_child_directory(&month_name);
        }
        drop(year_dir);
        let _ = root.remove_empty_child_directory(&year_name);
    }
    Ok(removed)
}

fn parse_year(name: &OsStr) -> Option<i32> {
    let value = name.to_str()?;
    (value.len() == 4 && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| value.parse().ok())?
}

fn parse_two_digits(name: &OsStr) -> Option<u32> {
    let value = name.to_str()?;
    (value.len() == 2 && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| value.parse().ok())?
}

fn is_temp_leaf_name(name: &OsStr) -> bool {
    let Some(value) = name.to_str() else {
        return false;
    };
    let Some((prefix, random)) = value.rsplit_once('-') else {
        return false;
    };
    !prefix.is_empty()
        && prefix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && random.len() == 32
        && random.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn lease_file_name(leaf_name: &OsStr) -> OsString {
    let mut name = leaf_name.to_os_string();
    name.push(LEASE_SUFFIX);
    name
}

fn write_lease_record(file: &mut File, created_at: SystemTime, leaf_name: &str) -> Result<()> {
    let elapsed = created_at
        .duration_since(SystemTime::UNIX_EPOCH)
        .context("private temp creation time precedes the Unix epoch")?;
    let seconds = elapsed
        .as_secs()
        .checked_add(u64::from(elapsed.subsec_nanos() > 0))
        .context("private temp creation time is out of range")?;
    let contents = format!("{LEASE_RECORD_MAGIC}{seconds}\n{leaf_name}\n");
    anyhow::ensure!(
        contents.len() <= MAX_LEASE_RECORD_BYTES,
        "private temp lease record exceeds its size limit"
    );
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

fn read_lease_record(file: &mut File, expected_leaf_name: &OsStr) -> Result<SystemTime> {
    file.seek(SeekFrom::Start(0))?;
    let mut contents = Vec::new();
    Read::by_ref(file)
        .take((MAX_LEASE_RECORD_BYTES + 1) as u64)
        .read_to_end(&mut contents)?;
    anyhow::ensure!(
        contents.len() <= MAX_LEASE_RECORD_BYTES,
        "private temp lease record exceeds its size limit"
    );
    let contents = std::str::from_utf8(&contents)?;
    let body = contents
        .strip_prefix(LEASE_RECORD_MAGIC)
        .context("private temp lease record version is invalid")?;
    let mut lines = body.split('\n');
    let seconds = lines
        .next()
        .context("private temp lease record is missing its timestamp")?
        .parse::<u64>()?;
    let leaf_name = lines
        .next()
        .context("private temp lease record is missing its leaf name")?;
    anyhow::ensure!(
        leaf_name == expected_leaf_name.to_str().unwrap_or_default(),
        "private temp lease record leaf name does not match"
    );
    anyhow::ensure!(
        lines.next() == Some("") && lines.next().is_none(),
        "private temp lease record has trailing data"
    );
    SystemTime::UNIX_EPOCH
        .checked_add(Duration::from_secs(seconds))
        .context("private temp lease timestamp is out of range")
}

#[cfg(test)]
fn create_private_temp_dir_at_for_test(
    config_dir: &Path,
    prefix: &str,
    date: NaiveDate,
    fill_random: impl FnMut(&mut [u8]) -> Result<()>,
) -> Result<PrivateTempDir> {
    create_private_temp_dir_at_with(config_dir, prefix, date, fill_random, false)
}

#[cfg(test)]
fn cleanup_expired_for_test(config_dir: &Path, today: NaiveDate, now: SystemTime) -> Result<usize> {
    let config_dir = absolute_config_dir(config_dir)?;
    let config_root = open_config_root(&config_dir)?;
    let root = config_root.open_child(OsStr::new(TEMP_ROOT_NAME), false)?;
    root.verify_private_temp_directory()?;
    let _manager_lock = acquire_manager_lock(&root)?;
    cleanup_expired_locked(&root, today, now, TEMP_DIR_TTL)
}

#[cfg(test)]
fn create_private_temp_dir_with_parent(
    parent: &TrustedTempParent,
    prefix: &str,
    mut fill_random: impl FnMut(&mut [u8]) -> Result<()>,
) -> Result<LegacyPrivateTempDir> {
    for _ in 0..CREATE_ATTEMPTS {
        let component = random_component(prefix, &mut fill_random)?;
        match create_private_dir_candidate(parent, &component) {
            Ok(created) => {
                return Ok(LegacyPrivateTempDir {
                    path: created.path,
                    #[cfg(windows)]
                    handle: created.handle,
                });
            }
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::AlreadyExists) => {}
            Err(error) => return Err(error),
        }
    }
    anyhow::bail!("failed to allocate a unique private temporary directory")
}

#[cfg(test)]
fn create_private_temp_dir_in_with(
    parent: &Path,
    prefix: &str,
    fill_random: impl FnMut(&mut [u8]) -> Result<()>,
) -> Result<LegacyPrivateTempDir> {
    let parent = resolve_trusted_temp_parent(parent)?;
    create_private_temp_dir_with_parent(&parent, prefix, fill_random)
}

fn random_component(
    prefix: &str,
    fill_random: &mut impl FnMut(&mut [u8]) -> Result<()>,
) -> Result<String> {
    let mut random = [0u8; 16];
    fill_random(&mut random)?;
    let mut component = String::with_capacity(prefix.len() + 1 + random.len() * 2);
    component.push_str(prefix);
    component.push('-');
    for byte in random {
        use std::fmt::Write as _;
        write!(&mut component, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(component)
}

#[cfg(test)]
fn trusted_temp_parent_with_fallback(
    primary: &Path,
    fallback: impl FnOnce() -> Result<PathBuf>,
) -> Result<TrustedTempParent> {
    match resolve_trusted_temp_parent(primary) {
        Ok(parent) => Ok(parent),
        Err(primary_error) => {
            // Do not weaken ACL checks or rewrite an existing directory's ACL.
            // Both candidates must satisfy the same trusted-parent contract.
            resolve_trusted_temp_parent(&fallback()?).with_context(|| {
                format!("no trusted temporary parent; system temporary directory rejected: {primary_error}")
            })
        }
    }
}

#[cfg(all(not(windows), test))]
fn resolve_trusted_temp_parent(configured: &Path) -> Result<TrustedTempParent> {
    let original = std::fs::symlink_metadata(configured).with_context(|| {
        format!(
            "failed to inspect configured temporary directory {}",
            configured.display()
        )
    })?;
    anyhow::ensure!(
        original.is_dir() && !original.file_type().is_symlink(),
        "configured temporary directory is not an ordinary directory: {}",
        configured.display()
    );
    let parent = configured.canonicalize().with_context(|| {
        format!(
            "failed to resolve temporary directory {}",
            configured.display()
        )
    })?;
    validate_temp_parent(&parent)?;
    Ok(TrustedTempParent { path: parent })
}

#[cfg(all(unix, test))]
fn validate_temp_parent(parent: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;

    anyhow::ensure!(parent.is_absolute(), "temporary directory must be absolute");
    let effective_uid = unsafe { libc::geteuid() };
    for ancestor in parent.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor).with_context(|| {
            format!(
                "failed to inspect temporary ancestor {}",
                ancestor.display()
            )
        })?;
        anyhow::ensure!(
            metadata.file_type().is_dir() && !metadata.file_type().is_symlink(),
            "temporary ancestor is not an ordinary directory: {}",
            ancestor.display()
        );
        anyhow::ensure!(
            metadata.uid() == 0 || metadata.uid() == effective_uid,
            "temporary ancestor has an untrusted owner: {}",
            ancestor.display()
        );
        let mode = metadata.mode();
        let shared_sticky_boundary = mode & 0o002 != 0 && mode & 0o1000 != 0;
        anyhow::ensure!(
            mode & 0o020 == 0 || shared_sticky_boundary,
            "temporary ancestor is group-writable without a sticky shared boundary: {}",
            ancestor.display()
        );
        anyhow::ensure!(
            mode & 0o002 == 0 || mode & 0o1000 != 0,
            "world-writable temporary ancestor lacks the sticky bit: {}",
            ancestor.display()
        );
    }
    Ok(())
}

#[cfg(all(unix, test))]
fn create_private_dir_candidate(
    parent: &TrustedTempParent,
    component: &str,
) -> Result<CreatedPrivateDir> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};

    let path = parent.path.join(component);
    let mut builder = std::fs::DirBuilder::new();
    builder.mode(0o700);
    builder.create(&path).with_context(|| {
        format!(
            "failed to create private temporary directory {}",
            path.display()
        )
    })?;

    let cleanup_on_error = || {
        let _ = std::fs::remove_dir(&path);
    };
    let result = (|| -> Result<()> {
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&path)
            .with_context(|| {
                format!(
                    "failed to open private temporary directory {}",
                    path.display()
                )
            })?;
        let metadata = handle.metadata()?;
        let effective_uid = unsafe { libc::geteuid() };
        anyhow::ensure!(
            metadata.is_dir(),
            "private temporary leaf is not a directory"
        );
        anyhow::ensure!(
            metadata.uid() == effective_uid,
            "private temporary directory is not owned by the effective user"
        );
        anyhow::ensure!(
            metadata.permissions().mode() & 0o777 == 0o700,
            "private temporary directory permissions are not 0700"
        );
        Ok(())
    })();
    if let Err(error) = result {
        cleanup_on_error();
        return Err(error);
    }
    Ok(CreatedPrivateDir { path })
}

#[cfg(all(windows, test))]
fn resolve_trusted_temp_parent(configured: &Path) -> Result<TrustedTempParent> {
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ADD_SUBDIRECTORY, FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, READ_CONTROL, SYNCHRONIZE,
    };

    anyhow::ensure!(
        configured.is_absolute(),
        "temporary directory must be absolute"
    );
    let mut options = std::fs::OpenOptions::new();
    options
        .access_mode(
            FILE_LIST_DIRECTORY
                | FILE_READ_ATTRIBUTES
                | FILE_ADD_SUBDIRECTORY
                | FILE_DELETE_CHILD
                | READ_CONTROL
                | SYNCHRONIZE,
        )
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    let handle = options.open(configured).with_context(|| {
        format!(
            "failed to open configured temporary parent {}",
            configured.display()
        )
    })?;
    let metadata = handle.metadata()?;
    anyhow::ensure!(
        metadata.is_dir() && metadata.file_attributes() & 0x0400 == 0,
        "configured temporary parent handle is not an ordinary directory"
    );
    crate::file_permissions::verify_windows_trusted_parent_handle(&handle)?;

    let parent = windows::final_path_from_handle(&handle)?;
    for ancestor in parent.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor).with_context(|| {
            format!(
                "failed to inspect temporary ancestor {}",
                ancestor.display()
            )
        })?;
        anyhow::ensure!(metadata.is_dir(), "temporary ancestor is not a directory");
        anyhow::ensure!(
            metadata.file_attributes() & 0x0400 == 0,
            "temporary ancestor is a reparse point: {}",
            ancestor.display()
        );
    }
    Ok(TrustedTempParent { handle })
}

#[cfg(all(windows, test))]
fn create_private_dir_candidate(
    parent: &TrustedTempParent,
    component: &str,
) -> Result<CreatedPrivateDir> {
    windows::create_private_dir_candidate(parent, component)
}

#[cfg(all(not(any(unix, windows)), test))]
fn validate_temp_parent(_parent: &Path) -> Result<()> {
    anyhow::bail!("private temporary directories are unsupported on this platform")
}

#[cfg(all(not(any(unix, windows)), test))]
fn create_private_dir_candidate(
    _parent: &TrustedTempParent,
    _component: &str,
) -> Result<CreatedPrivateDir> {
    anyhow::bail!("private temporary directories are unsupported on this platform")
}

#[cfg(test)]
struct CreatedPrivateDir {
    path: PathBuf,
    #[cfg(windows)]
    handle: std::fs::File,
}

#[cfg(all(windows, test))]
mod windows {
    use super::*;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
    use windows_sys::Wdk::Storage::FileSystem::{
        FILE_CREATE, FILE_DIRECTORY_FILE, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
        NtCreateFile,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        EXPLICIT_ACCESS_W, SET_ACCESS, SetEntriesInAclW, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        ACL, CONTAINER_INHERIT_ACE, GetTokenInformation, InitializeSecurityDescriptor,
        OBJECT_INHERIT_ACE, SECURITY_DESCRIPTOR, SetSecurityDescriptorControl,
        SetSecurityDescriptorDacl, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFinalPathNameByHandleW,
        READ_CONTROL, SYNCHRONIZE, WRITE_DAC, WRITE_OWNER,
    };
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
    use windows_sys::Win32::System::SystemServices::SECURITY_DESCRIPTOR_REVISION;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    struct SecurityOwner {
        token: HANDLE,
        dacl: *mut ACL,
        descriptor: SECURITY_DESCRIPTOR,
        _user: Vec<u8>,
    }

    impl Drop for SecurityOwner {
        fn drop(&mut self) {
            unsafe {
                let _ = windows_sys::Win32::Foundation::LocalFree(self.dacl.cast());
                CloseHandle(self.token);
            }
        }
    }

    fn current_user_security() -> Result<SecurityOwner> {
        let mut token = std::ptr::null_mut();
        anyhow::ensure!(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } != 0,
            "OpenProcessToken failed: {}",
            std::io::Error::last_os_error()
        );
        let result = (|| -> Result<SecurityOwner> {
            let mut needed = 0;
            unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
            anyhow::ensure!(needed != 0, "GetTokenInformation(TokenUser size) failed");
            let mut user = vec![0u8; needed as usize];
            anyhow::ensure!(
                unsafe {
                    GetTokenInformation(
                        token,
                        TokenUser,
                        user.as_mut_ptr().cast(),
                        needed,
                        &mut needed,
                    )
                } != 0,
                "GetTokenInformation(TokenUser) failed: {}",
                std::io::Error::last_os_error()
            );
            let sid = unsafe { (*(user.as_ptr() as *const TOKEN_USER)).User.Sid };
            let explicit = EXPLICIT_ACCESS_W {
                grfAccessPermissions: FILE_ALL_ACCESS,
                grfAccessMode: SET_ACCESS,
                grfInheritance: CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: std::ptr::null_mut(),
                    MultipleTrusteeOperation: 0,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_USER,
                    ptstrName: sid.cast(),
                },
            };
            let mut dacl = std::ptr::null_mut();
            let acl_result = unsafe { SetEntriesInAclW(1, &explicit, std::ptr::null(), &mut dacl) };
            anyhow::ensure!(acl_result == 0, "SetEntriesInAclW failed: {acl_result}");
            let mut descriptor = SECURITY_DESCRIPTOR::default();
            if unsafe {
                InitializeSecurityDescriptor(
                    (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                    SECURITY_DESCRIPTOR_REVISION,
                )
            } == 0
                || unsafe {
                    SetSecurityDescriptorDacl(
                        (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                        1,
                        dacl,
                        0,
                    )
                } == 0
                || unsafe {
                    SetSecurityDescriptorControl(
                        (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                        windows_sys::Win32::Security::SE_DACL_PROTECTED,
                        windows_sys::Win32::Security::SE_DACL_PROTECTED,
                    )
                } == 0
            {
                let _ = unsafe { windows_sys::Win32::Foundation::LocalFree(dacl.cast()) };
                anyhow::bail!(
                    "failed to construct protected current-user security descriptor: {}",
                    std::io::Error::last_os_error()
                );
            }
            Ok(SecurityOwner {
                token,
                dacl,
                descriptor,
                _user: user,
            })
        })();
        if result.is_err() {
            unsafe { CloseHandle(token) };
        }
        result
    }

    pub(super) fn create_private_dir_candidate(
        parent: &TrustedTempParent,
        component: &str,
    ) -> Result<CreatedPrivateDir> {
        let security = current_user_security()?;
        let handle = nt_create_private_directory(&parent.handle, component, &security.descriptor)?;

        let result = (|| -> Result<()> {
            crate::set_and_verify_windows_user_only_handle(&handle, true)?;
            let verified = handle.metadata()?;
            anyhow::ensure!(
                verified.is_dir() && verified.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
                "private temporary directory handle is not an ordinary directory"
            );
            Ok(())
        })();
        if let Err(error) = result {
            let _ = delete_directory_handle(&handle);
            return Err(error);
        }
        let path = match final_path_from_handle(&handle) {
            Ok(path) => path,
            Err(error) => {
                let _ = delete_directory_handle(&handle);
                return Err(error.into());
            }
        };
        // Preserve the exact NtCreateFile handle: no pathname reopen is
        // permitted between relative creation, ACL verification, and RAII.
        Ok(CreatedPrivateDir { path, handle })
    }

    pub(super) fn final_path_from_handle(handle: &std::fs::File) -> std::io::Result<PathBuf> {
        let raw = handle.as_raw_handle() as HANDLE;
        let needed = unsafe { GetFinalPathNameByHandleW(raw, std::ptr::null_mut(), 0, 0) };
        if needed == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut path = vec![0u16; needed as usize + 1];
        let written =
            unsafe { GetFinalPathNameByHandleW(raw, path.as_mut_ptr(), path.len() as u32, 0) };
        if written == 0 || written as usize >= path.len() {
            return Err(std::io::Error::last_os_error());
        }
        path.truncate(written as usize);
        Ok(PathBuf::from(String::from_utf16_lossy(&path)))
    }

    fn nt_create_private_directory(
        parent: &std::fs::File,
        component: &str,
        descriptor: *const SECURITY_DESCRIPTOR,
    ) -> std::io::Result<std::fs::File> {
        use windows_sys::Win32::Foundation::{
            GENERIC_READ, GENERIC_WRITE, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError,
            UNICODE_STRING,
        };

        let mut name = std::ffi::OsStr::new(component)
            .encode_wide()
            .collect::<Vec<_>>();
        let byte_len = u16::try_from(name.len().saturating_mul(size_of::<u16>()))
            .map_err(|_| std::io::Error::other("private temp component is too long"))?;
        let unicode = UNICODE_STRING {
            Length: byte_len,
            MaximumLength: byte_len,
            Buffer: name.as_mut_ptr(),
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: parent.as_raw_handle() as HANDLE,
            ObjectName: &unicode,
            Attributes: OBJ_CASE_INSENSITIVE,
            SecurityDescriptor: descriptor,
            SecurityQualityOfService: std::ptr::null(),
        };
        let mut handle: HANDLE = std::ptr::null_mut();
        let mut io_status = IO_STATUS_BLOCK::default();
        let status = unsafe {
            NtCreateFile(
                &mut handle,
                GENERIC_READ
                    | GENERIC_WRITE
                    | READ_CONTROL
                    | WRITE_DAC
                    | WRITE_OWNER
                    | DELETE
                    | SYNCHRONIZE,
                &attributes,
                &mut io_status,
                std::ptr::null(),
                FILE_ATTRIBUTE_NORMAL,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_CREATE,
                FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
                std::ptr::null(),
                0,
            )
        };
        if status < 0 {
            return Err(std::io::Error::from_raw_os_error(
                unsafe { RtlNtStatusToDosError(status) } as i32,
            ));
        }
        Ok(unsafe { std::fs::File::from_raw_handle(handle) })
    }

    pub(super) fn delete_directory_handle(handle: &std::fs::File) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
            FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX, FileDispositionInfoEx,
            SetFileInformationByHandle,
        };

        let info = FILE_DISPOSITION_INFO_EX {
            Flags: FILE_DISPOSITION_FLAG_DELETE
                | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
                | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
        };
        if unsafe {
            SetFileInformationByHandle(
                handle.as_raw_handle() as _,
                FileDispositionInfoEx,
                (&info as *const FILE_DISPOSITION_INFO_EX).cast(),
                std::mem::size_of_val(&info) as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn private_tempdir() -> tempfile::TempDir {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            tempfile::Builder::new()
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap()
        }
        #[cfg(not(unix))]
        {
            tempfile::tempdir().unwrap()
        }
    }

    #[test]
    fn private_temp_directory_supports_ephemeral_session_artifacts() {
        let config = private_tempdir();
        let config_path = config.path().canonicalize().unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let owner = create_private_temp_dir_at_for_test(
            &config_path,
            "kcoder-ephemeral-test",
            date,
            |bytes| {
                bytes.fill(7);
                Ok(())
            },
        )
        .unwrap();
        let path = owner.path().to_path_buf();
        {
            let directory = crate::PrivateDirectory::open_existing(&path).unwrap();
            directory
                .atomic_replace(std::ffi::OsStr::new("history.jsonl"), b"{}\n")
                .unwrap();
            let artifacts = directory
                .open_child(std::ffi::OsStr::new("session"), true)
                .unwrap();
            artifacts
                .atomic_replace(std::ffi::OsStr::new("state.json"), b"{}")
                .unwrap();
            assert_eq!(std::fs::read(path.join("history.jsonl")).unwrap(), b"{}\n");
            assert_eq!(
                std::fs::read(path.join("session").join("state.json")).unwrap(),
                b"{}"
            );
        }
        drop(owner);
        assert!(!path.exists());
    }

    #[test]
    fn public_profile_temp_probe() {
        let Ok(_) = std::env::var("KCODER_PRIVATE_TEMP_PUBLIC_PROBE") else {
            return;
        };
        let config_dir = crate::Settings::config_dir().unwrap();
        let date = Local::now().date_naive();
        let owner = create_private_temp_dir("kcoder-qoder-catalog").unwrap();
        let expected_day = config_dir
            .join(TEMP_ROOT_NAME)
            .join(date.format("%Y").to_string())
            .join(date.format("%m").to_string())
            .join(date.format("%d").to_string());
        assert_eq!(owner.path().parent(), Some(expected_day.as_path()));
        let path = owner.path().to_path_buf();
        let directory = crate::PrivateDirectory::open_existing(&path).unwrap();
        directory
            .atomic_replace(OsStr::new("catalog.json"), b"{}")
            .unwrap();
        assert_eq!(std::fs::read(path.join("catalog.json")).unwrap(), b"{}");
        drop(owner);
        assert!(!path.exists());
    }

    #[test]
    fn public_api_uses_config_profile_even_when_system_tmp_is_set() {
        let fixture = private_tempdir();
        let fixture_path = fixture.path().canonicalize().unwrap();
        let config_dir = fixture_path.join("profile");
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "private_temp_dir::tests::public_profile_temp_probe",
                "--nocapture",
            ])
            .env("KCODER_CONFIG_DIR", &config_dir)
            .env("KCODER_PRIVATE_TEMP_PUBLIC_PROBE", "1");
        #[cfg(unix)]
        command.env("TMPDIR", "/tmp");
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "public temp probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(config_dir.join(TEMP_ROOT_NAME).exists());
    }

    #[test]
    fn private_temp_fallback_is_validated_without_repairing_the_rejected_parent() {
        let root = private_tempdir();
        let rejected = root.path().join("not-a-directory");
        std::fs::write(&rejected, b"unchanged").unwrap();
        let fallback = root.path().join("private-parent");
        std::fs::create_dir(&fallback).unwrap();
        crate::set_user_only_dir_permissions(&fallback).unwrap();
        let parent = trusted_temp_parent_with_fallback(&rejected, || Ok(fallback.clone())).unwrap();
        let created = create_private_temp_dir_with_parent(&parent, "fallback", |bytes| {
            bytes.fill(7);
            Ok(())
        })
        .unwrap();
        assert!(created.path().starts_with(fallback.canonicalize().unwrap()));
        assert_eq!(std::fs::read(&rejected).unwrap(), b"unchanged");
        assert!(trusted_temp_parent_with_fallback(&rejected, || Ok(rejected.clone())).is_err());
        assert!(
            trusted_temp_parent_with_fallback(&fallback, || anyhow::bail!(
                "must not resolve an unused fallback"
            ))
            .is_ok()
        );
    }

    #[test]
    fn private_temp_directory_is_new_and_private() {
        let config = private_tempdir();
        let config_path = config.path().canonicalize().unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let owner =
            create_private_temp_dir_at_for_test(&config_path, "kcoder-test", date, |bytes| {
                bytes.fill(8);
                Ok(())
            })
            .unwrap();
        let path = owner.path().to_path_buf();
        assert!(path.ends_with(Path::new(
            "tmp/2026/10/09/kcoder-test-08080808080808080808080808080808"
        )));
        assert!(path.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let metadata = std::fs::metadata(&path).unwrap();
            assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
            assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
        }
        drop(owner);
        assert!(!path.exists());
    }

    #[test]
    fn missing_config_root_is_created_private_and_existing_root_is_not_repaired() {
        let parent = private_tempdir();
        let parent_path = parent.path().canonicalize().unwrap();
        let config = parent_path.join("config");
        let date = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let owner = create_private_temp_dir_at_for_test(&config, "layout", date, |bytes| {
            bytes.fill(1);
            Ok(())
        })
        .unwrap();
        assert!(owner.path().starts_with(&config));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&config).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
        }
        drop(owner);

        let existing = parent.path().join("existing");
        std::fs::create_dir(&existing).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let owner = create_private_temp_dir_at_for_test(&existing, "layout", date, |bytes| {
            bytes.fill(2);
            Ok(())
        })
        .unwrap();
        drop(owner);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&existing).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
    }

    #[test]
    fn active_lease_blocks_cleanup_and_is_visible_to_another_process() {
        let config = private_tempdir();
        let config_path = config.path().canonicalize().unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let old_date = today.checked_sub_days(chrono::Days::new(10)).unwrap();
        let owner =
            create_private_temp_dir_at_for_test(&config_path, "active", old_date, |bytes| {
                bytes.fill(3);
                Ok(())
            })
            .unwrap();
        let path = owner.path().to_path_buf();
        std::fs::write(path.join(".lease"), b"caller-owned artifact").unwrap();
        assert_eq!(
            cleanup_expired_for_test(
                &config_path,
                today.checked_add_days(chrono::Days::new(8)).unwrap(),
                SystemTime::now() + TEMP_DIR_TTL + Duration::from_secs(1),
            )
            .unwrap(),
            0
        );
        assert!(path.exists());

        let day_path = path.parent().unwrap().to_path_buf();
        let leaf_name = path.file_name().unwrap().to_string_lossy().into_owned();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "private_temp_dir::tests::lease_lock_probe_subprocess",
                "--nocapture",
            ])
            .env("KCODER_PRIVATE_TEMP_LOCK_PROBE_DAY", day_path)
            .env("KCODER_PRIVATE_TEMP_LOCK_PROBE_LEAF", leaf_name)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "cross-process lease probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        drop(owner);
        assert!(!path.exists());
    }

    #[test]
    fn expired_cleanup_requires_old_creation_time_and_managed_ordinary_leaf() {
        let config = private_tempdir();
        let config_path = config.path().canonicalize().unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let old_date = today.checked_sub_days(chrono::Days::new(10)).unwrap();
        let mut owner =
            create_private_temp_dir_at_for_test(&config_path, "stale", old_date, |bytes| {
                bytes.fill(4);
                Ok(())
            })
            .unwrap();
        let managed_path = owner.path().to_path_buf();
        owner.cleanup_on_drop = false;
        drop(owner);

        let day = open_day(&config_path, old_date);
        let unmanaged_name = OsString::from(format!("unmanaged-{}", "a".repeat(32)));
        drop(day.create_child(&unmanaged_name).unwrap());
        let bad_marker_name = OsString::from(format!("badmarker-{}", "b".repeat(32)));
        let bad_marker = day.create_child(&bad_marker_name).unwrap();
        bad_marker
            .atomic_replace(OsStr::new(".kcoder-private-temp-v1"), b"different\n")
            .unwrap();
        drop(bad_marker);

        #[cfg(unix)]
        let outside = {
            use std::os::unix::fs::symlink;
            let outside = private_tempdir();
            let outside_file = outside.path().join("preserve");
            std::fs::write(&outside_file, b"untouched").unwrap();
            let link_name = OsString::from(format!("linked-{}", "c".repeat(32)));
            symlink(
                outside.path(),
                day_path(&config_path, old_date).join(link_name),
            )
            .unwrap();
            (outside, outside_file)
        };

        let before_expiry = SystemTime::now();
        assert_eq!(
            cleanup_expired_for_test(&config_path, today, before_expiry).unwrap(),
            0
        );
        assert!(
            managed_path.exists(),
            "date partition alone must not prove age"
        );
        let future_today = today.checked_add_days(chrono::Days::new(8)).unwrap();
        let after_expiry = before_expiry + TEMP_DIR_TTL + Duration::from_secs(1);
        assert_eq!(
            cleanup_expired_for_test(&config_path, future_today, after_expiry).unwrap(),
            1
        );
        assert!(!managed_path.exists());
        assert!(
            day_path(&config_path, old_date)
                .join(&unmanaged_name)
                .exists()
        );
        assert!(
            day_path(&config_path, old_date)
                .join(&bad_marker_name)
                .exists()
        );
        #[cfg(unix)]
        {
            assert_eq!(std::fs::read(&outside.1).unwrap(), b"untouched");
            assert!(
                day_path(&config_path, old_date)
                    .join(format!("linked-{}", "c".repeat(32)))
                    .exists()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn failed_drop_cleanup_keeps_external_lease_for_later_gc() {
        use std::os::unix::fs::PermissionsExt;

        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let config = private_tempdir();
        let config_path = config.path().canonicalize().unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let old_date = today.checked_sub_days(chrono::Days::new(10)).unwrap();
        let owner =
            create_private_temp_dir_at_for_test(&config_path, "retrygc", old_date, |bytes| {
                bytes.fill(9);
                Ok(())
            })
            .unwrap();
        let path = owner.path().to_path_buf();
        let blocked = path.join("blocked");
        std::fs::create_dir(&blocked).unwrap();
        std::fs::write(blocked.join("payload"), b"retry me").unwrap();
        std::fs::write(
            path.join(".kcoder-private-temp-v1"),
            b"partial delete marker",
        )
        .unwrap();
        std::fs::remove_file(path.join(".kcoder-private-temp-v1")).unwrap();
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let lease_path = path
            .parent()
            .unwrap()
            .join(LEASE_DIRECTORY_NAME)
            .join(format!(
                "{}{}",
                path.file_name().unwrap().to_string_lossy(),
                LEASE_SUFFIX
            ));

        drop(owner);
        assert!(path.exists());
        assert!(lease_path.exists());
        assert!(!path.join(".kcoder-private-temp-v1").exists());

        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o700)).unwrap();
        let future_today = today.checked_add_days(chrono::Days::new(8)).unwrap();
        let after_expiry = SystemTime::now() + TEMP_DIR_TTL + Duration::from_secs(1);
        assert_eq!(
            cleanup_expired_for_test(&config_path, future_today, after_expiry).unwrap(),
            1
        );
        assert!(!path.exists());
        assert!(!lease_path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn date_layout_rejects_existing_unprivate_components_without_chmod() {
        let config = private_tempdir();
        let config_path = config.path().canonicalize().unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let root = open_config_root(&config_path).unwrap();
        let tmp = root.open_child(OsStr::new(TEMP_ROOT_NAME), true).unwrap();
        let year = tmp.open_child(OsStr::new("2026"), true).unwrap();
        let month_path = config_path.join("tmp/2026/10");
        std::fs::create_dir(&month_path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&month_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(
            create_private_temp_dir_at_for_test(&config_path, "blocked", date, |_| Ok(())).is_err()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&month_path).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        drop(year);
    }

    #[test]
    fn dated_temp_entropy_retries_collisions_and_reports_exhaustion_and_rng_failure() {
        let config = private_tempdir();
        let config_path = config.path().canonicalize().unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let day = open_day(&config_path, date);
        let collision_name = random_component("retry", &mut |bytes: &mut [u8]| {
            bytes.fill(7);
            Ok(())
        })
        .unwrap();
        drop(day.create_child(OsStr::new(&collision_name)).unwrap());
        let mut calls = 0usize;
        let owner = create_private_temp_dir_at_for_test(&config_path, "retry", date, |bytes| {
            calls += 1;
            bytes.fill(if calls == 1 { 7 } else { 8 });
            Ok(())
        })
        .unwrap();
        assert_eq!(calls, 2);
        drop(owner);

        let exhausted = create_private_temp_dir_at_with(
            &config_path,
            "retry",
            date,
            |bytes| {
                bytes.fill(7);
                Ok(())
            },
            false,
        );
        assert!(exhausted.unwrap_err().to_string().contains("unique"));

        let rng_error = create_private_temp_dir_at_with(
            &config_path,
            "retry",
            date,
            |_| anyhow::bail!("injected RNG failure"),
            false,
        );
        assert!(
            rng_error
                .unwrap_err()
                .to_string()
                .contains("injected RNG failure")
        );
    }

    #[test]
    fn lease_lock_probe_subprocess() {
        let (Some(day_path), Some(leaf_name)) = (
            std::env::var_os("KCODER_PRIVATE_TEMP_LOCK_PROBE_DAY"),
            std::env::var_os("KCODER_PRIVATE_TEMP_LOCK_PROBE_LEAF"),
        ) else {
            return;
        };
        let day = crate::PrivateDirectory::open_existing(Path::new(&day_path)).unwrap();
        let leases = day
            .open_child(OsStr::new(LEASE_DIRECTORY_NAME), false)
            .unwrap();
        let lease_name = lease_file_name(OsStr::new(&leaf_name));
        let lease = leases.open_read_write_file(&lease_name, false).unwrap();
        assert!(FileExt::try_lock_exclusive(&lease).is_err());
    }

    #[test]
    fn lease_creation_timestamp_rounds_fractional_seconds_up() {
        let temporary = private_tempdir();
        let leaf_name = "lease-rounding-0123456789abcdef0123456789abcdef";
        let created_at = SystemTime::UNIX_EPOCH + Duration::new(1_800_000_000, 1);
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(temporary.path().join("lease-record"))
            .unwrap();

        write_lease_record(&mut file, created_at, leaf_name).unwrap();
        let recorded_at = read_lease_record(&mut file, OsStr::new(leaf_name)).unwrap();

        assert!(recorded_at >= created_at);
        assert!(recorded_at.duration_since(created_at).unwrap() < Duration::from_secs(1));
    }

    fn open_day(config: &Path, date: NaiveDate) -> crate::PrivateDirectory {
        let config = absolute_config_dir(config).unwrap();
        let root = open_config_root(&config).unwrap();
        let tmp = root.open_child(OsStr::new(TEMP_ROOT_NAME), true).unwrap();
        let year = open_private_child(&tmp, &date.format("%Y").to_string()).unwrap();
        let month = open_private_child(&year, &date.format("%m").to_string()).unwrap();
        open_private_child(&month, &date.format("%d").to_string()).unwrap()
    }

    fn day_path(config: &Path, date: NaiveDate) -> PathBuf {
        config
            .join(TEMP_ROOT_NAME)
            .join(date.format("%Y").to_string())
            .join(date.format("%m").to_string())
            .join(date.format("%d").to_string())
    }

    #[cfg(unix)]
    #[test]
    fn candidate_rejects_preexisting_symlink_without_touching_outside() {
        use std::os::unix::fs::symlink;

        let parent = private_tempdir();
        let outside = private_tempdir();
        let marker = outside.path().join("marker");
        std::fs::write(&marker, b"unchanged").unwrap();
        symlink(outside.path(), parent.path().join("occupied")).unwrap();

        let parent = resolve_trusted_temp_parent(parent.path()).unwrap();
        assert!(create_private_dir_candidate(&parent, "occupied").is_err());
        assert_eq!(std::fs::read(marker).unwrap(), b"unchanged");
    }

    #[test]
    fn candidate_rejects_a_parent_file_and_returns_no_path() {
        let parent = private_tempdir();
        let file = parent.path().join("not-a-directory");
        std::fs::write(&file, b"unchanged").unwrap();

        assert!(resolve_trusted_temp_parent(&file).is_err());
        assert_eq!(std::fs::read(file).unwrap(), b"unchanged");
    }

    #[test]
    fn legacy_injected_entropy_retries_collisions_and_reports_exhaustion_and_rng_failure() {
        let parent = private_tempdir();
        let collision = random_component("retry", &mut |bytes: &mut [u8]| {
            bytes.fill(7);
            Ok(())
        })
        .unwrap();
        std::fs::create_dir(parent.path().join(&collision)).unwrap();
        let mut calls = 0usize;
        let owner = create_private_temp_dir_in_with(parent.path(), "retry", |bytes| {
            calls += 1;
            bytes.fill(if calls == 1 { 7 } else { 8 });
            Ok(())
        })
        .unwrap();
        assert_eq!(calls, 2);
        drop(owner);

        let exhausted = create_private_temp_dir_in_with(parent.path(), "retry", |bytes| {
            bytes.fill(7);
            Ok(())
        });
        assert!(exhausted.unwrap_err().to_string().contains("unique"));

        let rng_error = create_private_temp_dir_in_with(parent.path(), "retry", |_| {
            anyhow::bail!("injected RNG failure")
        });
        assert!(
            rng_error
                .unwrap_err()
                .to_string()
                .contains("injected RNG failure")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_untrusted_or_symlinked_configured_temp_parent() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let root = private_tempdir();
        let untrusted = root.path().join("untrusted");
        std::fs::create_dir(&untrusted).unwrap();
        std::fs::set_permissions(&untrusted, std::fs::Permissions::from_mode(0o770)).unwrap();
        assert!(resolve_trusted_temp_parent(&untrusted).is_err());

        let link = root.path().join("temp-link");
        symlink(&untrusted, &link).unwrap();
        assert!(resolve_trusted_temp_parent(&link).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_private_temp_directory_is_not_reparse_and_acl_is_enforced() {
        use std::os::windows::fs::MetadataExt;

        let owner = create_private_temp_dir("kcoder-test").unwrap();
        let path = owner.path().to_path_buf();
        assert_eq!(
            std::fs::symlink_metadata(&path).unwrap().file_attributes() & 0x0400,
            0
        );
        crate::set_user_only_dir_permissions(&path).unwrap();
        drop(owner);
    }

    #[cfg(windows)]
    #[test]
    fn windows_rejects_original_reparse_parent_and_preexisting_reparse_leaf() {
        use std::os::windows::fs::symlink_dir;

        let root = private_tempdir();
        let outside = private_tempdir();
        let parent_link = root.path().join("temp-link");
        symlink_dir(outside.path(), &parent_link).unwrap();
        assert!(resolve_trusted_temp_parent(&parent_link).is_err());

        let occupied = root.path().join("occupied");
        symlink_dir(outside.path(), &occupied).unwrap();
        let trusted_root = resolve_trusted_temp_parent(root.path()).unwrap();
        assert!(create_private_dir_candidate(&trusted_root, "occupied").is_err());
        assert!(outside.path().exists());

        // The validated parent capability is the creation root even if its
        // pathname is replaced by a reparse point after validation.
        let parent_path = root.path().join("held-parent");
        let moved_path = root.path().join("held-parent-moved");
        std::fs::create_dir(&parent_path).unwrap();
        let trusted_parent = resolve_trusted_temp_parent(&parent_path).unwrap();
        std::fs::rename(&parent_path, &moved_path).unwrap();
        symlink_dir(outside.path(), &parent_path).unwrap();
        let created = create_private_dir_candidate(&trusted_parent, "same-handle").unwrap();
        assert!(moved_path.join("same-handle").is_dir());
        assert!(!outside.path().join("same-handle").exists());
        windows::delete_directory_handle(&created.handle).unwrap();
        drop(created);
        std::fs::remove_dir(&parent_path).unwrap();
    }
}
