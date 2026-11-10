//! A bounded producer stream publishes only after native package inspection and byte proof.
use super::*;
use crate::plugin_migration::{PluginExportSelection, PluginPackageOrigin};
use kcoder_config::PortableLeaseIdentity;
use kcoder_plugins::PluginCancellationToken;
use std::{
    cell::RefCell,
    rc::Rc,
    sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
    time::Duration,
};
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Generated {
    owner: String,
    selection: String,
    entry: TransferEntry,
    identity: PortableLeaseIdentity,
}
struct Writer {
    sender: SyncSender<Vec<u8>>,
    cancel: PluginCancellationToken,
}
impl std::io::Write for Writer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        for part in bytes.chunks(TRANSFER_CHUNK_BYTES) {
            if self.cancel.is_cancelled() {
                return Err(std::io::Error::other("source_transfer_cancelled"));
            }
            self.sender
                .send(part.to_vec())
                .map_err(|_| std::io::Error::other("source_transfer_cancelled"))?;
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
#[derive(Clone)]
struct Stats {
    bytes: u64,
    hash: Sha256,
}
struct Reader<'a> {
    receiver: Receiver<Vec<u8>>,
    current: Cursor<Vec<u8>>,
    stats: Rc<RefCell<Stats>>,
    limit: u64,
    check: &'a mut dyn FnMut(u64) -> bool,
    directory: &'a PrivateDirectory,
    cancel: PluginCancellationToken,
}
impl Read for Reader<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        loop {
            let current = self.stats.borrow().bytes;
            if self.cancel.is_cancelled()
                || active(self.directory).is_err()
                || !(self.check)(current)
            {
                self.cancel.cancel();
                return Err(std::io::Error::other("source_transfer_cancelled"));
            }
            let count = self.current.read(bytes)?;
            if count > 0 {
                let mut stats = self.stats.borrow_mut();
                stats.bytes = stats
                    .bytes
                    .checked_add(count as u64)
                    .ok_or_else(|| std::io::Error::other("source_transfer_budget_exceeded"))?;
                if stats.bytes > self.limit {
                    self.cancel.cancel();
                    return Err(std::io::Error::other("source_transfer_budget_exceeded"));
                }
                stats.hash.update(&bytes[..count]);
                return Ok(count);
            }
            match self.receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(next) => self.current = Cursor::new(next),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
    }
}
fn metadata_name(index: usize) -> String {
    format!("plugin-publication-{index:04}.json")
}
pub(super) fn verify_generated(directory: &PrivateDirectory, entry: &TransferEntry) -> Result<()> {
    let Some(index) = entry
        .id
        .strip_prefix('e')
        .and_then(|id| id.get(..4))
        .and_then(|value| value.parse::<usize>().ok())
    else {
        anyhow::bail!("source_transfer_invalid_manifest");
    };
    let saved: Generated =
        load(directory, &metadata_name(index))?.context("source_transfer_recovery_required")?;
    ensure!(
        saved.owner == directory.directory_identity()?
            && saved.entry == *entry
            && directory.portable_regular_identity(OsStr::new(&payload_name(entry)))?
                == saved.identity,
        "source_transfer_payload_changed"
    );
    Ok(())
}
pub(super) fn capture(
    directory: &PrivateDirectory,
    index: usize,
    selection: &PluginExportSelection,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<TransferEntry> {
    let selection_digest = digest(selection)?;
    let meta = metadata_name(index);
    if let Some(previous) = load::<Generated>(directory, &meta)? {
        ensure!(
            previous.selection == selection_digest,
            "source_transfer_request_changed"
        );
        verify_generated(directory, &previous.entry)?;
        verify_payload(directory, &previous.entry, check)?;
        return Ok(previous.entry);
    }
    let id = format!("e{index:04}-0000");
    let name = format!("{id}.blob");
    match directory.entry_metadata(OsStr::new(&name)) {
        Err(error) if missing(&error) => {}
        _ => anyhow::bail!("source_transfer_recovery_required"),
    }
    let token = PluginCancellationToken::default();
    std::thread::scope(|scope| {
        let (sender, receiver) = mpsc::sync_channel(2);
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let worker_cancel = token.clone();
        let worker = scope.spawn(move || {
            let mut writer = Writer {
                sender,
                cancel: worker_cancel.clone(),
            };
            let result = selection.write_package(&mut writer, &worker_cancel);
            drop(writer);
            let _ = result_tx.send(result);
        });
        let stats = Rc::new(RefCell::new(Stats {
            bytes: 0,
            hash: Sha256::new(),
        }));
        let generated = RefCell::new(None::<TransferEntry>);
        let mut reader = Reader {
            receiver,
            current: Cursor::new(Vec::new()),
            stats: Rc::clone(&stats),
            limit: selection.reserved_bytes()? / 2,
            check,
            directory,
            cancel: token.clone(),
        };
        let published = directory.atomic_publish_observed_from_reader(
            OsStr::new(&name),
            &mut reader,
            false,
            || {
                let origin: PluginPackageOrigin = result_rx
                    .recv()
                    .map_err(|_| anyhow::anyhow!("source_transfer_capture_failed"))??;
                ensure!(!token.is_cancelled(), "source_transfer_cancelled");
                active(directory)?;
                origin.validate()?;
                let stats = stats.borrow();
                let entry = TransferEntry {
                    id: id.clone(),
                    bytes: stats.bytes,
                    sha256: format!("{:x}", stats.hash.clone().finalize()),
                    content: TransferContent::PluginPackage {
                        origin: Box::new(origin),
                        format: kcoder_plugins::migration::PLUGIN_TRANSFER_FORMAT.into(),
                        uploaded_source: selection.uploaded_source(),
                    },
                };
                *generated.borrow_mut() = Some(entry);
                Ok(None)
            },
            |file| {
                let entry = generated
                    .borrow()
                    .clone()
                    .context("source_transfer_capture_failed")?;
                ensure!(
                    file.metadata()?.len() == entry.bytes,
                    "source_transfer_payload_changed"
                );
                exact(
                    directory,
                    &meta,
                    &Generated {
                        owner: directory.directory_identity()?,
                        selection: selection_digest.clone(),
                        entry,
                        identity: directory.portable_regular_handle_identity(file)?,
                    },
                )
            },
        );
        if published.is_err() {
            token.cancel();
        }
        drop(reader);
        worker
            .join()
            .map_err(|_| anyhow::anyhow!("source_transfer_capture_failed"))?;
        published?;
        let entry = generated
            .into_inner()
            .context("source_transfer_capture_failed")?;
        verify_generated(directory, &entry)?;
        Ok(entry)
    })
}
