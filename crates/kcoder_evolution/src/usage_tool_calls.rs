//! Call attribution for usage rows whose original v1 shape must stay readable.

use crate::{
    compaction::JOURNAL_COMPACT_MAX_BYTES,
    error::{EvolutionError, Result},
    journal::{self, JournalRecord, LineOutcome, USAGES_FILE, is_not_found},
    store::read_bytes_in,
};
use kcoder_config::PrivateDirectory;
use kcoder_types::evolution::{
    EVOLUTION_RECORD_MAX_BYTES, EVOLUTION_RECORD_VERSION, EvolutionContractError, UsageRecord,
    validate_evolution_id,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;

pub(crate) const USAGE_TOOL_CALLS_FILE: &str = "usage-tool-calls.jsonl";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UsageToolCall {
    version: u32,
    pub(crate) usage_id: String,
    pub(crate) usage_sha256: String,
    tool_call_id: String,
}

impl JournalRecord for UsageToolCall {
    fn record_id(&self) -> &str {
        &self.usage_sha256
    }

    fn check(&self) -> std::result::Result<(), EvolutionContractError> {
        validate_evolution_id("usageId", &self.usage_id)?;
        validate_evolution_id("toolCallId", &self.tool_call_id)?;
        if self.usage_sha256.len() != 64
            || !self
                .usage_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(EvolutionContractError::InvalidValue {
                field: "usageSha256",
                reason: "expected a lowercase SHA-256 digest of the usage row",
            });
        }
        Ok(())
    }
}

fn line_sha256(line: &[u8]) -> String {
    format!("{:x}", Sha256::digest(line))
}

pub(crate) fn usage_sha256(usage: &UsageRecord) -> Result<String> {
    debug_assert!(
        usage.tool_call_id.is_none(),
        "digest covers the base v1 row"
    );
    Ok(line_sha256(&journal::encode_line(usage)?))
}

fn encode_usage(mut usage: UsageRecord) -> Result<(Vec<u8>, Option<UsageToolCall>)> {
    let tool_call = usage.tool_call_id.take();
    let line = journal::encode_line(&usage)?;
    let link = tool_call.map(|tool_call_id| UsageToolCall {
        version: EVOLUTION_RECORD_VERSION,
        usage_id: usage.usage_id,
        usage_sha256: line_sha256(&line),
        tool_call_id,
    });
    Ok((line, link))
}

pub(crate) fn append_usage(directory: &PrivateDirectory, record: &UsageRecord) -> Result<()> {
    if record.tool_call_id.is_none() {
        return journal::append(directory, USAGES_FILE, record);
    }
    let (line, tool_call) = encode_usage(record.clone())?;
    if let Some(link) = tool_call {
        // A crash or rejected base-row append can leave an orphan link. It
        // confers no visibility without an exact, committed v1 row.
        journal::append(directory, USAGE_TOOL_CALLS_FILE, &link)?;
    }
    journal::append_encoded(directory, USAGES_FILE, line)
}

/// Normalize known inline rows under the scope lock. Keep unknown, invalid,
/// future-version, and already compatible rows byte-for-byte.
pub(crate) fn normalize_inline_usages(directory: &PrivateDirectory) -> Result<()> {
    for name in [USAGES_FILE, USAGE_TOOL_CALLS_FILE] {
        match directory.entry_metadata(OsStr::new(name)) {
            Ok(metadata) => check_size(metadata.len())?,
            Err(error) if is_not_found(&error) => {}
            Err(error) => return Err(error.into()),
        }
    }
    let Some(original) = read_bytes_in(directory, USAGES_FILE, JOURNAL_COMPACT_MAX_BYTES)? else {
        return Ok(());
    };
    let mut first_usage_ids = HashSet::new();
    let mut normalized = None::<Vec<u8>>;
    let mut links = Vec::new();
    let mut start = 0usize;
    for raw in original.split_inclusive(|byte| *byte == b'\n') {
        let end = start + raw.len();
        let line = raw.strip_suffix(b"\n").unwrap_or(raw);
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.len() <= EVOLUTION_RECORD_MAX_BYTES
            && let LineOutcome::Record(usage) = journal::parse_line::<UsageRecord>(line)
        {
            let authoritative = first_usage_ids.insert(usage.usage_id.clone());
            if usage.tool_call_id.is_some() {
                let (compatible, link) = encode_usage(usage)?;
                let output = normalized.get_or_insert_with(|| original[..start].to_vec());
                output.extend_from_slice(&compatible);
                links.extend(link.filter(|_| authoritative));
                start = end;
                continue;
            }
        }
        if let Some(bytes) = &mut normalized {
            bytes.extend_from_slice(raw);
        }
        start = end;
    }
    if let Some(bytes) = normalized {
        check_size(bytes.len() as u64)?;
        if !links.is_empty() {
            install_inline_links(directory, links)?;
        }
        directory.atomic_replace(OsStr::new(USAGES_FILE), &bytes)?;
    }
    Ok(())
}

fn install_inline_links(directory: &PrivateDirectory, links: Vec<UsageToolCall>) -> Result<()> {
    let existing = read_bytes_in(directory, USAGE_TOOL_CALLS_FILE, JOURNAL_COMPACT_MAX_BYTES)?
        .unwrap_or_default();
    let mut bytes = Vec::new();
    for link in &links {
        bytes.extend(journal::encode_line(link)?);
    }
    let authoritative: HashSet<_> = links
        .iter()
        .map(|link| link.usage_sha256.as_str())
        .collect();
    for raw in existing.split_inclusive(|byte| *byte == b'\n') {
        // Inline fields are authoritative until replacement. Drop only an
        // understood same-row link, retaining future records and torn bytes.
        if let LineOutcome::Record(link) = journal::parse_line::<UsageToolCall>(raw)
            && authoritative.contains(link.usage_sha256.as_str())
        {
            continue;
        }
        bytes.extend_from_slice(raw);
    }
    check_size(bytes.len() as u64)?;
    if bytes != existing {
        directory.atomic_replace(OsStr::new(USAGE_TOOL_CALLS_FILE), &bytes)?;
    }
    Ok(())
}

fn check_size(bytes: u64) -> Result<()> {
    if bytes > JOURNAL_COMPACT_MAX_BYTES {
        return Err(EvolutionError::RecordTooLarge {
            limit: JOURNAL_COMPACT_MAX_BYTES as usize,
            actual: usize::try_from(bytes).unwrap_or(usize::MAX),
        });
    }
    Ok(())
}

pub(crate) fn restore_tool_calls(
    directory: &PrivateDirectory,
    usages: &mut [UsageRecord],
) -> Result<()> {
    if usages.iter().all(|usage| usage.tool_call_id.is_some()) {
        return Ok(());
    }
    let mut links_by_usage = HashMap::<String, Vec<UsageToolCall>>::new();
    for link in journal::read::<UsageToolCall>(directory, USAGE_TOOL_CALLS_FILE)?.records {
        links_by_usage
            .entry(link.usage_id.clone())
            .or_default()
            .push(link);
    }
    for usage in usages
        .iter_mut()
        .filter(|usage| usage.tool_call_id.is_none())
    {
        let Some(links) = links_by_usage.remove(&usage.usage_id) else {
            continue;
        };
        let sha256 = usage_sha256(usage)?;
        if let Some(link) = links.into_iter().find(|link| link.usage_sha256 == sha256) {
            usage.tool_call_id = Some(link.tool_call_id);
        }
    }
    Ok(())
}
