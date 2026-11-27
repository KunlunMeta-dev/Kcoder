//! Parsed original bytes, never an allow decision or a replacement ledger.
//!
//! A verified snapshot is reused only while the live files still describe the
//! same chain position: the pinned journal identity (checked by
//! `verify_storage`), the checkpoint identity and length, the exact head bytes,
//! the journal length, and the digest of the final record (re-read on every
//! observation). A grown journal is consumed incrementally from the cached
//! offset; any other difference falls back to a full parse that fails closed.
//!
//! In-place rewriting of an earlier record with the same length and an
//! unchanged head is detected by the next full parse (every `open_in`), not by
//! the warm path. That is safe: the cached state was fully verified when it
//! was built, legitimate revocations only arrive as appended records (which
//! change the length and head), and every authorization still evaluates the
//! current revocation, epoch and expiry facts from that state.
use super::*;
use kcoder_types::diagnostic_cause::coded;

pub(super) struct VerifiedJournal {
    pub(super) head: Vec<u8>,
    pub(super) checkpoint: Option<CheckpointObservation>,
    pub(super) length: u64,
    /// Offset of the final complete record; meaningful only when `length > 0`.
    pub(super) last_record_offset: u64,
    pub(super) state: Arc<Journal>,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct CheckpointObservation {
    identity: PortableLeaseIdentity,
    length: u64,
}

#[cfg(test)]
#[derive(Default)]
pub(super) struct TestCounters {
    pub(super) full_replays: std::sync::atomic::AtomicUsize,
    pub(super) tail_parses: std::sync::atomic::AtomicUsize,
    pub(super) journal_bytes_read: std::sync::atomic::AtomicUsize,
    pub(super) compactions: std::sync::atomic::AtomicUsize,
    /// 1: stop before publishing the checkpoint; 2: stop after publishing it
    /// but before truncating the journal. Simulates a crash at that step.
    pub(super) compaction_crash: std::sync::atomic::AtomicU8,
}

#[cfg(test)]
impl TestCounters {
    pub(super) fn get(counter: &std::sync::atomic::AtomicUsize) -> usize {
        counter.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn add(counter: &std::sync::atomic::AtomicUsize, value: usize) {
        counter.fetch_add(value, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Where a parse stopped: the chain position and the final record offset.
struct ParseEnd {
    head_seen: bool,
    last_record_offset: u64,
}

impl NativeDelegationAuthority {
    pub(super) fn read_journal(&self) -> Result<Arc<Journal>> {
        self.verify_storage()?;
        let head_bytes = read_file(&self.directory, HEAD_FILE, MAX_RECORD_BYTES)?;
        let head: Head =
            serde_json::from_slice(&head_bytes).map_err(coded("DELEGATION_HEAD_INVALID"))?;
        ensure!(head.version == 1, "DELEGATION_HEAD_INVALID");
        let mut file = self
            .directory
            .open_single_link_regular_file(OsStr::new(JOURNAL_FILE))?;
        // Binding identities are signed genesis history; this open is fenced
        // by the current journal anchor, including after a verified relocation.
        ensure!(
            self.directory.portable_regular_handle_identity(&file)? == self.journal_identity,
            "DELEGATION_STORAGE_CHANGED"
        );
        let length = file.metadata()?.len();
        ensure!(
            length <= MAX_JOURNAL_BYTES as u64,
            "DELEGATION_STORAGE_TOO_LARGE"
        );
        let checkpoint = self.open_checkpoint()?;
        let observation = checkpoint.as_ref().map(|(_, observed)| observed.clone());
        let mut verified = self
            .verified_journal
            .lock()
            .map_err(coded("DELEGATION_JOURNAL_CACHE_UNAVAILABLE"))?;
        if let Some(cached) = verified.as_mut()
            && cached.checkpoint == observation
            && let Ok(true) = self.refresh(cached, &mut file, &head_bytes, &head, length)
        {
            return Ok(cached.state.clone());
        }
        // Any mismatch or tail failure discards the snapshot (it may have been
        // partially advanced) and replays the complete current files.
        *verified = None;
        #[cfg(test)]
        TestCounters::add(&self.counters.full_replays, 1);
        let mut journal = match checkpoint {
            Some((mut checkpoint, _)) => {
                let mut bytes = Vec::new();
                (&mut checkpoint)
                    .take(MAX_JOURNAL_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)?;
                ensure!(
                    bytes.len() <= MAX_JOURNAL_BYTES,
                    "DELEGATION_STORAGE_TOO_LARGE"
                );
                self.restore_checkpoint(&bytes)?
            }
            None => self.initial_journal()?,
        };
        let bytes = self.read_journal_range(&mut file, 0, length)?;
        let end = self.parse_records(&mut journal, &bytes, 0, &head, observation.is_some())?;
        ensure!(end.head_seen, "DELEGATION_COMMITTED_HISTORY_MISSING");
        journal.bytes = bytes.len();
        let state = Arc::new(journal);
        *verified = Some(VerifiedJournal {
            head: head_bytes,
            checkpoint: observation,
            length,
            last_record_offset: end.last_record_offset,
            state: state.clone(),
        });
        Ok(state)
    }

    pub(super) fn invalidate_journal_cache(&self) -> Result<()> {
        *self
            .verified_journal
            .lock()
            .map_err(coded("DELEGATION_JOURNAL_CACHE_UNAVAILABLE"))? = None;
        Ok(())
    }

    pub(super) fn initial_journal(&self) -> Result<Journal> {
        Ok(Journal {
            epoch: self.binding.initial_epoch.clone(),
            identity_enabled: true,
            grants: BTreeMap::new(),
            code_services: BTreeMap::new(),
            operations: BTreeMap::new(),
            sequence: 0,
            digest: binding_digest(&self.binding)?,
            bytes: 0,
            records: 0,
            revocations: Vec::new(),
        })
    }

    /// Ok(true): the snapshot now describes the current files. Ok(false) or an
    /// error: the caller must discard it and run a full replay.
    fn refresh(
        &self,
        cached: &mut VerifiedJournal,
        file: &mut File,
        head_bytes: &[u8],
        head: &Head,
        length: u64,
    ) -> Result<bool> {
        if length < cached.length || (length == cached.length && head_bytes != cached.head) {
            return Ok(false);
        }
        // Re-read the final verified record together with any appended tail.
        let start = if cached.length == 0 {
            0
        } else {
            cached.last_record_offset
        };
        let bytes = self.read_journal_range(file, start, length)?;
        let verified_end = usize::try_from(cached.length - start)?;
        if cached.length > 0 {
            let last = bytes[..verified_end]
                .strip_suffix(b"\n")
                .context("DELEGATION_JOURNAL_CHANGED")?;
            if last.contains(&b'\n') || digest(last) != cached.state.digest {
                return Ok(false);
            }
        }
        if length == cached.length {
            return Ok(true);
        }
        #[cfg(test)]
        TestCounters::add(&self.counters.tail_parses, 1);
        let unchanged_head = head_bytes == cached.head;
        let state = Arc::make_mut(&mut cached.state);
        let end = self.parse_records(state, &bytes[verified_end..], cached.length, head, false)?;
        if !(end.head_seen || unchanged_head) {
            return Ok(false);
        }
        state.bytes = usize::try_from(length)?;
        cached.head = head_bytes.to_vec();
        cached.length = length;
        cached.last_record_offset = end.last_record_offset;
        Ok(true)
    }

    /// Apply complete records that start at `offset` in the journal file. With
    /// a checkpoint, a leading run of records at or below its base sequence is
    /// a prefix left by a compaction interrupted before truncation: it must be
    /// a contiguous chain ending exactly at the checkpoint base digest.
    fn parse_records(
        &self,
        journal: &mut Journal,
        bytes: &[u8],
        offset: u64,
        head: &Head,
        checkpointed: bool,
    ) -> Result<ParseEnd> {
        ensure!(
            bytes.is_empty() || bytes.last() == Some(&b'\n'),
            "DELEGATION_JOURNAL_INCOMPLETE"
        );
        let base = journal.sequence;
        let mut end = ParseEnd {
            head_seen: head.sequence == journal.sequence && head.digest == journal.digest,
            last_record_offset: offset,
        };
        let mut stale: Option<(u64, String)> = None;
        let mut stale_complete = false;
        let mut position = offset;
        let records = bytes.strip_suffix(b"\n").unwrap_or(&[]);
        for line in records
            .split(|value| *value == b'\n')
            .filter(|_| !bytes.is_empty())
        {
            end.last_record_offset = position;
            position += line.len() as u64 + 1;
            ensure!(
                line.len() <= MAX_RECORD_BYTES && journal.records < MAX_RECORDS,
                "DELEGATION_JOURNAL_TOO_LARGE"
            );
            let entry: Entry =
                serde_json::from_slice(line).map_err(coded("DELEGATION_JOURNAL_INVALID"))?;
            journal.records += 1;
            if checkpointed && !stale_complete && entry.sequence <= base {
                if let Some((sequence, previous)) = &stale {
                    ensure!(
                        entry.sequence == sequence + 1 && &entry.previous_digest == previous,
                        "DELEGATION_JOURNAL_CHAIN_INVALID"
                    );
                }
                let line_digest = digest(line);
                if entry.sequence == base {
                    ensure!(
                        line_digest == journal.digest,
                        "DELEGATION_CHECKPOINT_CHAIN_INVALID"
                    );
                    stale_complete = true;
                }
                stale = Some((entry.sequence, line_digest));
                continue;
            }
            ensure!(
                stale.is_none() || stale_complete,
                "DELEGATION_CHECKPOINT_CHAIN_INVALID"
            );
            stale_complete = true;
            ensure!(
                entry.sequence == journal.sequence + 1 && entry.previous_digest == journal.digest,
                "DELEGATION_JOURNAL_CHAIN_INVALID"
            );
            let revocation = matches!(
                entry.event,
                Event::Revoked { .. }
                    | Event::NativeCodeRevoked { .. }
                    | Event::IdentityRevoked { .. }
            );
            self.apply_event(journal, entry.event)?;
            if revocation {
                journal.revocations.push(
                    String::from_utf8(line.to_vec())
                        .map_err(coded("DELEGATION_JOURNAL_INVALID"))?,
                );
            }
            journal.sequence = entry.sequence;
            journal.digest = digest(line);
            if journal.sequence == head.sequence && journal.digest == head.digest {
                end.head_seen = true;
            }
        }
        ensure!(
            stale.is_none() || stale_complete,
            "DELEGATION_CHECKPOINT_CHAIN_INVALID"
        );
        Ok(end)
    }

    fn read_journal_range(&self, file: &mut File, start: u64, end: u64) -> Result<Vec<u8>> {
        let size = usize::try_from(end - start)?;
        let mut bytes = vec![0; size];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut bytes)?;
        #[cfg(test)]
        TestCounters::add(&self.counters.journal_bytes_read, size);
        Ok(bytes)
    }

    fn open_checkpoint(&self) -> Result<Option<(File, CheckpointObservation)>> {
        let file = match self
            .directory
            .open_single_link_regular_file(OsStr::new(CHECKPOINT_FILE))
        {
            Ok(file) => file,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let observation = CheckpointObservation {
            identity: self.directory.portable_regular_handle_identity(&file)?,
            length: file.metadata()?.len(),
        };
        Ok(Some((file, observation)))
    }
}
