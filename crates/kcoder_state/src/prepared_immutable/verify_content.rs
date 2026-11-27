//! Re-read the pinned original descriptor before entering the State transaction.
use super::*;
use std::io::{Seek, SeekFrom};

impl VerifiedImmutableRead {
    /// This bounded I/O runs outside the global State lock and compares every
    /// byte on the held descriptor, not just timestamps or a replacement path.
    /// It does not establish the object's origin or grant authority. A caller
    /// committing the original publication must also hold its exact operation
    /// lease, compare `bytes()` to the saved digest, and retain both the lease
    /// and this witness until the State receipt transaction finishes.
    pub(crate) fn verify_contents(&mut self) -> Result<()> {
        self.contents_verified = false;
        self.check_identity_and_stamp()?;
        let mut file = self.file.try_clone()?;
        file.seek(SeekFrom::Start(0))?;
        let mut offset = 0usize;
        let mut block = [0u8; 64 * 1024];
        while offset < self.bytes.len() {
            let want = (self.bytes.len() - offset).min(block.len());
            let read = file.read(&mut block[..want])?;
            ensure!(
                read > 0 && block[..read] == self.bytes[offset..offset + read],
                "immutable original contents changed"
            );
            offset += read;
        }
        ensure!(
            file.read(&mut block[..1])? == 0,
            "immutable original contents changed"
        );
        self.check_identity_and_stamp()?;
        self.contents_verified = true;
        Ok(())
    }
}
