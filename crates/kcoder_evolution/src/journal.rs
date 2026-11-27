//! Append-only JSONL journals (`usages.jsonl`, `outcomes.jsonl`).
//!
//! Writers append one validated JSON object per line under the scope lock,
//! with file and directory fsync. Readers need no lock: they tolerate a
//! torn final line (a crash or a concurrent append), skip lines written by
//! a newer format version, count invalid lines instead of failing, and keep
//! the first record for each id so retried appends never double count.

use crate::error::{EvolutionError, Result};
use kcoder_config::PrivateDirectory;
use kcoder_types::evolution::{
    EVOLUTION_RECORD_MAX_BYTES, EVOLUTION_RECORD_VERSION, EvolutionContractError,
    OutcomeObservation, UsageAmendment, UsageRecord,
};
use serde::{Serialize, de::DeserializeOwned};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};

pub(crate) const USAGES_FILE: &str = "usages.jsonl";
pub(crate) const OUTCOMES_FILE: &str = "outcomes.jsonl";
pub(crate) const AMENDMENTS_FILE: &str = "usage-amendments.jsonl";

/// Counters from one journal read.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct JournalStats {
    pub records: u64,
    pub duplicates: u64,
    pub invalid: u64,
    pub future: u64,
    pub torn_tail: bool,
}

/// Deduplicated records in append order plus read counters.
#[derive(Debug, Clone, PartialEq)]
pub struct JournalRead<T> {
    pub records: Vec<T>,
    pub stats: JournalStats,
}

impl<T> Default for JournalRead<T> {
    fn default() -> Self {
        Self {
            records: Vec::new(),
            stats: JournalStats::default(),
        }
    }
}

pub(crate) trait JournalRecord: Serialize + DeserializeOwned {
    fn record_id(&self) -> &str;
    fn check(&self) -> std::result::Result<(), EvolutionContractError>;
}

impl JournalRecord for UsageRecord {
    fn record_id(&self) -> &str {
        &self.usage_id
    }

    fn check(&self) -> std::result::Result<(), EvolutionContractError> {
        self.validate()
    }
}

impl JournalRecord for UsageAmendment {
    fn record_id(&self) -> &str {
        &self.amendment_id
    }

    fn check(&self) -> std::result::Result<(), EvolutionContractError> {
        self.validate()
    }
}

impl JournalRecord for OutcomeObservation {
    fn record_id(&self) -> &str {
        &self.observation_id
    }

    fn check(&self) -> std::result::Result<(), EvolutionContractError> {
        self.validate()
    }
}

pub(crate) fn is_not_found(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
    })
}

/// Append one record. The caller must hold the scope lock so the torn-tail
/// repair below cannot race another writer.
pub(crate) fn append<T: JournalRecord>(
    directory: &PrivateDirectory,
    name: &str,
    record: &T,
) -> Result<()> {
    append_encoded(directory, name, encode_line(record)?)
}

pub(crate) fn encode_line<T: JournalRecord>(record: &T) -> Result<Vec<u8>> {
    record.check()?;
    let mut line = serde_json::to_vec(record)?;
    if line.len() > EVOLUTION_RECORD_MAX_BYTES {
        return Err(EvolutionError::RecordTooLarge {
            limit: EVOLUTION_RECORD_MAX_BYTES,
            actual: line.len(),
        });
    }
    line.push(b'\n');
    Ok(line)
}

/// Append already validated, newline-terminated bytes under the scope lock.
pub(crate) fn append_encoded(
    directory: &PrivateDirectory,
    name: &str,
    mut line: Vec<u8>,
) -> Result<()> {
    // A previous append may have been cut before its newline; terminate it
    // so the new record starts on its own line.
    if !ends_with_newline(directory, name)? {
        line.insert(0, b'\n');
    }
    directory.append(OsStr::new(name), &line)?;
    Ok(())
}

fn ends_with_newline(directory: &PrivateDirectory, name: &str) -> Result<bool> {
    let mut file = match directory.open_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if is_not_found(&error) => return Ok(true),
        Err(error) => return Err(error.into()),
    };
    if file.metadata()?.len() == 0 {
        return Ok(true);
    }
    file.seek(SeekFrom::End(-1))?;
    let mut last = [0_u8; 1];
    file.read_exact(&mut last)?;
    Ok(last[0] == b'\n')
}

/// Read and deduplicate one journal.
pub(crate) fn read<T: JournalRecord>(
    directory: &PrivateDirectory,
    name: &str,
) -> Result<JournalRead<T>> {
    let file = match directory.open_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if is_not_found(&error) => return Ok(JournalRead::default()),
        Err(error) => return Err(error.into()),
    };
    let mut reader = BufReader::new(file);
    let mut result = JournalRead::default();
    let mut seen = HashSet::new();
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let read = reader
            .by_ref()
            .take(EVOLUTION_RECORD_MAX_BYTES as u64 + 2)
            .read_until(b'\n', &mut buffer)?;
        if read == 0 {
            break;
        }
        let terminated = buffer.last() == Some(&b'\n');
        if !terminated && read as u64 > EVOLUTION_RECORD_MAX_BYTES as u64 {
            // Oversized line: skip the rest of it.
            result.stats.invalid += 1;
            let mut rest = Vec::new();
            reader.read_until(b'\n', &mut rest)?;
            continue;
        }
        let line = trim_line(&buffer);
        if line.is_empty() {
            continue;
        }
        match parse_line::<T>(line) {
            LineOutcome::Record(record) => {
                if seen.insert(record.record_id().to_string()) {
                    result.records.push(record);
                    result.stats.records += 1;
                } else {
                    result.stats.duplicates += 1;
                }
            }
            LineOutcome::Future => result.stats.future += 1,
            LineOutcome::Invalid if !terminated => result.stats.torn_tail = true,
            LineOutcome::Invalid => result.stats.invalid += 1,
        }
    }
    Ok(result)
}

fn trim_line(buffer: &[u8]) -> &[u8] {
    let mut line = buffer;
    while let Some((last, rest)) = line.split_last() {
        if matches!(last, b'\n' | b'\r') {
            line = rest;
        } else {
            break;
        }
    }
    line
}

pub(crate) enum LineOutcome<T> {
    Record(T),
    Future,
    Invalid,
}

pub(crate) fn parse_line<T: JournalRecord>(line: &[u8]) -> LineOutcome<T> {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
        return LineOutcome::Invalid;
    };
    let version = value.get("version").and_then(serde_json::Value::as_u64);
    match version {
        Some(version) if version > u64::from(EVOLUTION_RECORD_VERSION) => LineOutcome::Future,
        Some(_) => match serde_json::from_value::<T>(value) {
            Ok(record) if record.check().is_ok() => LineOutcome::Record(record),
            _ => LineOutcome::Invalid,
        },
        None => LineOutcome::Invalid,
    }
}

/// Length and identity of a journal; changes whenever it is appended to or
/// replaced. `None` when the file does not exist.
pub(crate) fn fingerprint(directory: &PrivateDirectory, name: &str) -> Result<Option<String>> {
    let file = match directory.open_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if is_not_found(&error) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let length = file.metadata()?.len();
    let identity = PrivateDirectory::identity_of_file(&file)?;
    Ok(Some(format!("{identity}:{length}")))
}
