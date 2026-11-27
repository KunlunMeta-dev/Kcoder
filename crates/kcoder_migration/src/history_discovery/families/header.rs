//! Read only the first bounded metadata record; this is not a history replay parser.
use super::super::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read};

const RECORD_LIMIT: usize = 64 * 1024;
const COMPRESSED_LIMIT: u64 = 256 * 1024;
#[derive(Deserialize)]
struct Record {
    #[serde(rename = "type")]
    kind: String,
    payload: Payload,
}
#[derive(Deserialize)]
struct Payload {
    id: String,
    source: Option<serde_json::Value>,
    parent_thread_id: Option<String>,
    forked_from_id: Option<String>,
}
pub(super) struct Header {
    pub digest: [u8; 32],
    pub parent: Option<Option<String>>,
}
struct Metered<'a, R, C> {
    reader: R,
    remaining: &'a mut u64,
    check: &'a mut C,
}
impl<R: Read, C: FnMut() -> bool> Read for Metered<'_, R, C> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if !(self.check)() {
            return Err(std::io::Error::other("history_discovery_cancelled"));
        }
        if *self.remaining == 0 {
            return Err(std::io::Error::other(
                "history_discovery_family_budget_exceeded",
            ));
        }
        let count = output.len().min((*self.remaining).min(16 * 1024) as usize);
        let read = self.reader.read(&mut output[..count])?;
        *self.remaining -= read as u64;
        Ok(read)
    }
}
pub(super) fn read(
    selected: &HistoryFileSelection,
    session: &str,
    remaining: &mut u64,
    check: &mut impl FnMut() -> bool,
) -> Result<Header> {
    ensure!(check(), "history_discovery_cancelled");
    let file = selected.open()?;
    let limit = if selected.compressed() {
        selected.bytes.min(COMPRESSED_LIMIT)
    } else {
        selected.bytes
    };
    let input = Metered {
        reader: file.take(limit),
        remaining,
        check,
    };
    let mut bytes = Vec::new();
    if selected.compressed() {
        let decoder = kcoder_state::external_history::codec::zstd_decoder(input)?;
        BufReader::with_capacity(512, decoder.take(RECORD_LIMIT as u64))
            .read_until(b'\n', &mut bytes)?;
    } else {
        BufReader::with_capacity(512, input.take(RECORD_LIMIT as u64))
            .read_until(b'\n', &mut bytes)?;
    }
    ensure!(check(), "history_discovery_cancelled");
    drop(selected.open()?);
    let digest = Sha256::digest(&bytes).into();
    let parent = if bytes.last() == Some(&b'\n') {
        serde_json::from_slice::<Record>(&bytes)
            .ok()
            .and_then(|value| relation(&value, session))
    } else {
        None
    };
    Ok(Header { digest, parent })
}
fn relation(value: &Record, session: &str) -> Option<Option<String>> {
    if value.kind != "session_meta" || canonical_uuid(&value.payload.id)?.as_str() != session {
        return None;
    }
    if value
        .payload
        .source
        .as_ref()
        .is_some_and(|source| !source.is_string())
    {
        return None;
    }
    let mut parent = None;
    for candidate in [
        &value.payload.parent_thread_id,
        &value.payload.forked_from_id,
    ]
    .into_iter()
    .flatten()
    {
        let candidate = canonical_uuid(candidate)?;
        if parent.as_ref().is_some_and(|old| old != &candidate) {
            return None;
        }
        parent = Some(candidate);
    }
    Some(parent)
}
