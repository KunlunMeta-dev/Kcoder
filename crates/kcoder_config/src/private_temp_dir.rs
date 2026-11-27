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
    nonblocking_cleanup: bool,
    #[cfg(test)]
    cleanup_on_drop: bool,
}

struct TempCreateControl<'a> {
    deadline: Instant,
    check_cancel: &'a dyn Fn() -> Result<()>,
}

#[derive(Debug)]
struct TempManagerLock(File);

impl Drop for TempManagerLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
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
        let _manager_lock = if self.nonblocking_cleanup {
            let Ok(Some(lock)) = try_acquire_manager_lock(&self.tmp_root) else {
                return;
            };
            lock
        } else {
            let Ok(lock) = acquire_manager_lock(&self.tmp_root) else {
                return;
            };
            lock
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

/// Create a private temporary directory below the resolved cache hierarchy,
/// retaining the legacy hierarchy until a new storage selection is committed.
pub fn create_private_temp_dir(prefix: &str) -> Result<PrivateTempDir> {
    create_private_temp_dir_in(&crate::storage::temporary_root_parent()?, prefix)
}
/// Native owners with an isolated profile/root keep worker resources in that
/// exact hierarchy instead of falling back to the process home.
pub fn create_private_temp_dir_in(config_dir: &Path, prefix: &str) -> Result<PrivateTempDir> {
    create_private_temp_dir_at_with(
        config_dir,
        prefix,
        Local::now().date_naive(),
        |bytes| {
            getrandom::fill(bytes).map_err(|error| {
                anyhow::anyhow!("failed to obtain operating-system randomness: {error}")
            })
        },
        true,
        None,
    )
}

/// Create a private temporary directory while honoring cancellation and a deadline
/// while waiting for the shared temporary-directory manager lock.
pub fn create_private_temp_dir_with_control(
    prefix: &str,
    deadline: Instant,
    check_cancel: impl Fn() -> Result<()>,
) -> Result<PrivateTempDir> {
    create_private_temp_dir_at_with(
        &crate::storage::temporary_root_parent()?,
        prefix,
        Local::now().date_naive(),
        |bytes| {
            getrandom::fill(bytes).map_err(|error| {
                anyhow::anyhow!("failed to obtain operating-system randomness: {error}")
            })
        },
        false,
        Some(TempCreateControl {
            deadline,
            check_cancel: &check_cancel,
        }),
    )
}

fn create_private_temp_dir_at_with(
    config_dir: &Path,
    prefix: &str,
    date: NaiveDate,
    mut fill_random: impl FnMut(&mut [u8]) -> Result<()>,
    run_cleanup: bool,
    control: Option<TempCreateControl<'_>>,
) -> Result<PrivateTempDir> {
    check_temp_create_control(control.as_ref())?;
    validate_prefix(prefix)?;
    let config_dir = absolute_config_dir(config_dir)?;
    let config_root = open_config_root(&config_dir)?;
    let tmp_root = config_root.open_child(OsStr::new(TEMP_ROOT_NAME), true)?;
    tmp_root.verify_private_temp_directory()?;
    let _manager_lock = match control.as_ref() {
        Some(control) => acquire_manager_lock_with_control(&tmp_root, control)?,
        None => acquire_manager_lock(&tmp_root)?,
    };

    if control.is_none()
        && run_cleanup
        && cleanup_is_due(&config_dir.join(TEMP_ROOT_NAME))
        && let Err(error) = cleanup_expired_locked(
            &tmp_root,
            Local::now().date_naive(),
            SystemTime::now(),
            TEMP_DIR_TTL,
        )
    {
        tracing::warn!(error = %error, "private temp cleanup skipped");
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
        check_temp_create_control(control.as_ref())?;
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
            nonblocking_cleanup: control.is_some(),
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
    crate::PrivateDirectory::open_config_root(path)
}

fn open_private_child(
    parent: &crate::PrivateDirectory,
    name: &str,
) -> Result<crate::PrivateDirectory> {
    let child = parent.open_child(OsStr::new(name), true)?;
    child.verify_private_temp_directory()?;
    Ok(child)
}

fn manager_lock_file(root: &crate::PrivateDirectory) -> Result<File> {
    let name = OsStr::new(MANAGER_LOCK_NAME);
    match root.open_read_write_file(name, true) {
        Ok(file) => Ok(file),
        Err(error) if is_io_kind(&error, std::io::ErrorKind::AlreadyExists) => {
            root.open_read_write_file(name, false)
        }
        Err(error) => Err(error),
    }
}

fn acquire_manager_lock(root: &crate::PrivateDirectory) -> Result<TempManagerLock> {
    let file = manager_lock_file(root)?;
    FileExt::lock_exclusive(&file).context("failed to lock private temp manager")?;
    Ok(TempManagerLock(file))
}

fn acquire_manager_lock_with_control(
    root: &crate::PrivateDirectory,
    control: &TempCreateControl<'_>,
) -> Result<TempManagerLock> {
    let file = manager_lock_file(root)?;
    loop {
        check_temp_create_control(Some(control))?;
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => {
                check_temp_create_control(Some(control))?;
                return Ok(TempManagerLock(file));
            }
            Err(error) if is_lock_contended(&error) => {
                let remaining = control.deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    check_temp_create_control(Some(control))?;
                }
                std::thread::sleep(remaining.min(Duration::from_millis(10)));
            }
            Err(error) => return Err(error).context("failed to lock private temp manager"),
        }
    }
}

fn try_acquire_manager_lock(root: &crate::PrivateDirectory) -> Result<Option<TempManagerLock>> {
    let file = manager_lock_file(root)?;
    match FileExt::try_lock_exclusive(&file) {
        Ok(()) => Ok(Some(TempManagerLock(file))),
        Err(error) if is_lock_contended(&error) => Ok(None),
        Err(error) => Err(error).context("failed to try-lock private temp manager"),
    }
}

fn is_lock_contended(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::WouldBlock
        || matches!(
            (
                error.raw_os_error(),
                fs2::lock_contended_error().raw_os_error()
            ),
            (Some(error_code), Some(contended_code)) if error_code == contended_code
        )
}

fn check_temp_create_control(control: Option<&TempCreateControl<'_>>) -> Result<()> {
    if let Some(control) = control {
        (control.check_cancel)()?;
        anyhow::ensure!(
            Instant::now() < control.deadline,
            "private temporary directory creation timed out"
        );
    }
    Ok(())
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
    create_private_temp_dir_at_with(config_dir, prefix, date, fill_random, false, None)
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
mod tests {
    use super::*;

    fn private_tempdir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn controlled_temp_creation_and_drop_do_not_wait_on_a_busy_manager() {
        let config = private_tempdir();
        let config_path = config.path().canonicalize().unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let config_root = open_config_root(&config_path).unwrap();
        let tmp_root = config_root
            .open_child(OsStr::new(TEMP_ROOT_NAME), true)
            .unwrap();
        let manager_lock = acquire_manager_lock(&tmp_root).unwrap();

        let check_cancelled = || Ok(());
        let started = Instant::now();
        let timed_out = create_private_temp_dir_at_with(
            &config_path,
            "bounded",
            date,
            |_| Ok(()),
            false,
            Some(TempCreateControl {
                deadline: Instant::now() + Duration::from_millis(60),
                check_cancel: &check_cancelled,
            }),
        );
        assert!(timed_out.unwrap_err().to_string().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));

        let cancel_checks = std::sync::atomic::AtomicUsize::new(0);
        let check_cancelled = || {
            if cancel_checks.fetch_add(1, std::sync::atomic::Ordering::Relaxed) >= 2 {
                anyhow::bail!("injected cancellation");
            }
            Ok(())
        };
        let started = Instant::now();
        let cancelled = create_private_temp_dir_at_with(
            &config_path,
            "cancelled",
            date,
            |_| Ok(()),
            false,
            Some(TempCreateControl {
                deadline: Instant::now() + Duration::from_secs(5),
                check_cancel: &check_cancelled,
            }),
        );
        assert!(
            cancelled
                .unwrap_err()
                .to_string()
                .contains("injected cancellation")
        );
        assert!(started.elapsed() < Duration::from_millis(250));

        drop(manager_lock);
        let check_cancelled = || Ok(());
        let owner = create_private_temp_dir_at_with(
            &config_path,
            "bounded",
            date,
            |_| Ok(()),
            false,
            Some(TempCreateControl {
                deadline: Instant::now() + Duration::from_secs(1),
                check_cancel: &check_cancelled,
            }),
        )
        .unwrap();
        let path = owner.path().to_path_buf();
        let manager_lock = acquire_manager_lock(&tmp_root).unwrap();
        let started = Instant::now();
        drop(owner);
        assert!(started.elapsed() < Duration::from_millis(250));
        assert!(
            path.exists(),
            "a busy manager leaves cleanup to lease/GC recovery"
        );
        drop(manager_lock);
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
    fn private_temp_directory_is_created_under_profile_and_removed() {
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
        drop(owner);
        assert!(!path.exists());
    }

    #[test]
    fn missing_config_root_is_created_and_existing_root_is_not_rewritten() {
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
        drop(owner);

        let existing = parent.path().join("existing");
        std::fs::create_dir(&existing).unwrap();
        let owner = create_private_temp_dir_at_for_test(&existing, "layout", date, |bytes| {
            bytes.fill(2);
            Ok(())
        })
        .unwrap();
        drop(owner);
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
            None,
        );
        assert!(exhausted.unwrap_err().to_string().contains("unique"));

        let rng_error = create_private_temp_dir_at_with(
            &config_path,
            "retry",
            date,
            |_| anyhow::bail!("injected RNG failure"),
            false,
            None,
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
}
