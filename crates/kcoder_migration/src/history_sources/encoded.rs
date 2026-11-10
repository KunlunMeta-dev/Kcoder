use super::*;
use std::{
    cell::{Cell, RefCell},
    ffi::OsStr,
};

pub(super) fn is_zstd(path: &Path) -> bool {
    path.extension() == Some(OsStr::new("zst"))
        && path
            .file_stem()
            .is_some_and(|stem| Path::new(stem).extension() == Some(OsStr::new("jsonl")))
}

struct Captured<'a, R, C> {
    source: R,
    maximum: u64,
    bytes: &'a Cell<u64>,
    hash: Sha256,
    check: &'a RefCell<&'a mut C>,
}
impl<R: Read, C: FnMut(u64, u64) -> bool> Read for Captured<'_, R, C> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if !(self.check.borrow_mut())(self.bytes.get(), self.maximum) {
            return Err(std::io::Error::other("migration_history_cancelled"));
        }
        if self.bytes.get() == self.maximum {
            return Ok(0);
        }
        let count = output
            .len()
            .min(64 * 1024)
            .min((self.maximum - self.bytes.get()) as usize);
        let read = self.source.read(&mut output[..count])?;
        if read == 0 {
            return Err(std::io::Error::other("migration_history_source_changed"));
        }
        self.bytes.set(self.bytes.get() + read as u64);
        self.hash.update(&output[..read]);
        Ok(read)
    }
}

pub(super) fn capture(
    file: &mut File,
    maximum: u64,
    check: &mut impl FnMut(u64, u64) -> bool,
) -> Result<(u64, String, Option<ExternalHistoryEncodedSource>)> {
    ensure!(maximum > 0, "migration_history_invalid_compressed_source");
    let shared = RefCell::new(check);
    let bytes = Cell::new(0);
    let mut captured = Captured {
        source: file,
        maximum,
        bytes: &bytes,
        hash: Sha256::new(),
        check: &shared,
    };
    let mut decoder = kcoder_state::external_history::codec::zstd_decoder(&mut captured)?;
    let mut hash = Sha256::new();
    let mut logical = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        ensure!(
            (shared.borrow_mut())(bytes.get(), maximum),
            "migration_history_cancelled"
        );
        let read = decoder.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        logical += read as u64;
        ensure!(
            logical <= EXTERNAL_HISTORY_MAX_BYTES,
            "migration_history_decoded_budget_exceeded"
        );
        hash.update(&buffer[..read]);
    }
    let buffered = decoder.finish();
    ensure!(
        buffered.buffer().is_empty() && bytes.get() == maximum,
        "migration_history_compressed_source_incomplete"
    );
    drop(buffered);
    Ok((
        logical,
        format!("{:x}", hash.finalize()),
        Some(ExternalHistoryEncodedSource {
            encoding: ExternalHistoryEncoding::Zstd,
            bytes: maximum,
            sha256: format!("{:x}", captured.hash.finalize()),
        }),
    ))
}
