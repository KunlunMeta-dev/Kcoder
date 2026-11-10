//! The index rename publishes a complete template/index pair; recovery never replays a save.
use super::*;
use crate::PrivateDirectory;
use std::{
    ffi::OsStr,
    io::{Read, Write},
};
const JOURNAL: &str = ".transaction.json";
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Stamp {
    identity: String,
    pub(super) digest: String,
    bytes: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    version: u8,
    id: String,
    nonce: String,
    before_index: Option<Stamp>,
    after_index: Stamp,
    before_body: Option<Stamp>,
    after_body: Option<Stamp>,
}
fn name(nonce: &str, suffix: &str) -> String {
    format!(".staging-{nonce}-{suffix}")
}
pub(super) fn stamp(directory: &PrivateDirectory, name: &str, limit: u64) -> Result<Option<Stamp>> {
    let mut file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if storage::missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    anyhow::ensure!(
        file.metadata()?.len() <= limit,
        "settings_template_read_budget_exceeded"
    );
    let before = PrivateDirectory::identity_of_file(&file)?;
    let mut bytes = Vec::new();
    (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 <= limit
            && before == PrivateDirectory::identity_of_file(&file)?
            && before == directory.regular_file_identity(OsStr::new(name))?,
        "settings_template_file_changed"
    );
    Ok(Some(Stamp {
        identity: before,
        digest: hex_sha256(&bytes),
        bytes: bytes.len() as u64,
    }))
}
fn remove_owned(
    directory: &PrivateDirectory,
    name: &str,
    expected: &Stamp,
    limit: u64,
) -> Result<()> {
    if let Some(actual) = stamp(directory, name, limit)? {
        anyhow::ensure!(
            actual == *expected,
            "settings_template_transaction_conflict"
        );
        directory.remove_regular_file(OsStr::new(name))?;
    }
    Ok(())
}
struct Preparation {
    directory: PrivateDirectory,
    files: Vec<(String, Stamp)>,
    armed: bool,
}
impl Preparation {
    fn create(&mut self, name: String, bytes: &[u8]) -> Result<Stamp> {
        let mut file = self
            .directory
            .open_read_write_file(OsStr::new(&name), true)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        let stamp = stamp(&self.directory, &name, bytes.len() as u64)?.unwrap();
        self.files.push((name, stamp.clone()));
        Ok(stamp)
    }
}
impl Drop for Preparation {
    fn drop(&mut self) {
        if self.armed {
            for (name, expected) in &self.files {
                let _ = remove_owned(&self.directory, name, expected, expected.bytes);
            }
        }
    }
}
impl SettingsTemplateStore {
    pub(super) fn publish(
        &self,
        id: &str,
        body: Option<&[u8]>,
        index: &TemplateIndex,
    ) -> Result<()> {
        self.publish_with(id, body, |_| Ok(index.clone()))
    }
    pub(super) fn publish_with(
        &self,
        id: &str,
        body: Option<&[u8]>,
        build_index: impl FnOnce(Option<Stamp>) -> Result<TemplateIndex>,
    ) -> Result<()> {
        validate_id(id)?;
        let directory = self.directory(true)?.unwrap();
        let mut preparations = 0;
        directory.visit_entry_names_bounded(4096, |name| {
            if name
                .to_str()
                .is_some_and(|name| name.starts_with(".staging-"))
            {
                directory.open_single_link_regular_file(name)?;
                preparations += 1;
            }
            Ok(())
        })?;
        anyhow::ensure!(
            preparations < 512,
            "settings_template_staging_budget_exceeded"
        );
        let mut entropy = [0; 16];
        getrandom::fill(&mut entropy)
            .map_err(|_| anyhow::anyhow!("settings_template_entropy_unavailable"))?;
        let nonce = entropy
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let canonical = format!("{id}.jsonc");
        let before_body = stamp(&directory, &canonical, MAX_TEMPLATE_BYTES as u64)?;
        let before_index = stamp(&directory, INDEX_FILE, storage::INDEX_LIMIT)?;
        let mut prepared = Preparation {
            directory: directory.try_clone()?,
            files: Vec::new(),
            armed: true,
        };
        let after_body = body
            .map(|bytes| prepared.create(name(&nonce, "body"), bytes))
            .transpose()?;
        let index = build_index(after_body.clone())?;
        storage::check_index(&index)?;
        let after_index =
            prepared.create(name(&nonce, "index"), &serde_json::to_vec_pretty(&index)?)?;
        let pending = Pending {
            version: 1,
            id: id.into(),
            nonce,
            before_index,
            after_index,
            before_body,
            after_body,
        };
        directory.atomic_replace(OsStr::new(JOURNAL), &serde_json::to_vec(&pending)?)?;
        prepared.armed = false;
        fault(1)?;
        anyhow::ensure!(
            stamp(&directory, &canonical, MAX_TEMPLATE_BYTES as u64)? == pending.before_body,
            "settings_template_transaction_conflict"
        );
        if let Some(before) = &pending.before_body {
            directory.publish_prepared(
                OsStr::new(&canonical),
                OsStr::new(&name(&pending.nonce, "previous")),
                &before.identity,
            )?;
        }
        fault(2)?;
        if let Some(after) = &pending.after_body {
            directory.publish_prepared(
                OsStr::new(&name(&pending.nonce, "body")),
                OsStr::new(&canonical),
                &after.identity,
            )?;
        }
        fault(3)?;
        anyhow::ensure!(
            stamp(&directory, INDEX_FILE, storage::INDEX_LIMIT)? == pending.before_index
                && stamp(&directory, &canonical, MAX_TEMPLATE_BYTES as u64)? == pending.after_body,
            "settings_template_transaction_conflict"
        );
        directory.publish_prepared(
            OsStr::new(&name(&pending.nonce, "index")),
            OsStr::new(INDEX_FILE),
            &pending.after_index.identity,
        )?;
        fault(4)?;
        cleanup(&directory, &pending)
    }
    pub(super) fn recover(&self) -> Result<()> {
        let Some(bytes) = self.read_file(JOURNAL, 16 * 1024)? else {
            return Ok(());
        };
        let pending: Pending = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("settings_template_invalid_transaction"))?;
        validate_id(&pending.id)?;
        let valid = |stamp: &Stamp, limit| {
            !stamp.identity.is_empty()
                && stamp.identity.len() <= 256
                && stamp.bytes <= limit
                && stamp.digest.len() == 64
                && stamp
                    .digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        anyhow::ensure!(
            pending.version == 1
                && pending.nonce.len() == 32
                && pending.nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
                && pending
                    .before_index
                    .as_ref()
                    .is_none_or(|stamp| valid(stamp, storage::INDEX_LIMIT))
                && valid(&pending.after_index, storage::INDEX_LIMIT)
                && pending
                    .before_body
                    .as_ref()
                    .is_none_or(|stamp| valid(stamp, MAX_TEMPLATE_BYTES as u64))
                && pending
                    .after_body
                    .as_ref()
                    .is_none_or(|stamp| valid(stamp, MAX_TEMPLATE_BYTES as u64)),
            "settings_template_invalid_transaction"
        );
        let directory = self.directory(false)?.unwrap();
        let index = stamp(&directory, INDEX_FILE, storage::INDEX_LIMIT)?;
        let canonical = format!("{}.jsonc", pending.id);
        let current = stamp(&directory, &canonical, MAX_TEMPLATE_BYTES as u64)?;
        if index.as_ref() == Some(&pending.after_index) {
            anyhow::ensure!(
                current == pending.after_body,
                "settings_template_transaction_conflict"
            );
        } else {
            anyhow::ensure!(
                index == pending.before_index,
                "settings_template_transaction_conflict"
            );
            if current != pending.before_body {
                let backup_name = name(&pending.nonce, "previous");
                anyhow::ensure!(
                    stamp(&directory, &backup_name, MAX_TEMPLATE_BYTES as u64)?
                        == pending.before_body
                        && (current.is_none() || current == pending.after_body),
                    "settings_template_transaction_conflict"
                );
                if let Some(after) = &current {
                    directory.publish_prepared(
                        OsStr::new(&canonical),
                        OsStr::new(&name(&pending.nonce, "body")),
                        &after.identity,
                    )?;
                }
                if let Some(before) = &pending.before_body {
                    directory.publish_prepared(
                        OsStr::new(&backup_name),
                        OsStr::new(&canonical),
                        &before.identity,
                    )?;
                }
            }
        }
        cleanup(&directory, &pending)
    }
}
fn cleanup(directory: &PrivateDirectory, pending: &Pending) -> Result<()> {
    if let Some(before) = &pending.before_body {
        remove_owned(
            directory,
            &name(&pending.nonce, "previous"),
            before,
            MAX_TEMPLATE_BYTES as u64,
        )?;
    }
    if let Some(after) = &pending.after_body {
        remove_owned(
            directory,
            &name(&pending.nonce, "body"),
            after,
            MAX_TEMPLATE_BYTES as u64,
        )?;
    }
    remove_owned(
        directory,
        &name(&pending.nonce, "index"),
        &pending.after_index,
        storage::INDEX_LIMIT,
    )?;
    directory.remove_regular_file(OsStr::new(JOURNAL))
}
#[cfg(test)]
thread_local! { pub(super) static FAIL_STEP: std::cell::Cell<u8> = const { std::cell::Cell::new(0) }; }
#[cfg(test)]
thread_local! { pub(super) static BLOCK_ON_FAIL: std::cell::RefCell<Option<std::path::PathBuf>> = const { std::cell::RefCell::new(None) }; }
fn fault(step: u8) -> Result<()> {
    #[cfg(test)]
    if FAIL_STEP.with(|value| value.get() == step) {
        if let Some(path) = BLOCK_ON_FAIL.with(|value| value.borrow().clone()) {
            std::fs::write(&path, b"ready")?;
            std::fs::File::open(path)?.sync_all()?;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        anyhow::bail!("settings_template_injected_interruption");
    }
    let _ = step;
    Ok(())
}
