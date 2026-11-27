//! One canonical package byte proof shared by inspection and streamed containers.
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::path::Path;

pub(crate) fn new_hash() -> Sha256 {
    let mut hash = Sha256::new();
    hash.update(b"kcoder.plugin.package/1\0");
    hash
}
fn path(hash: &mut Sha256, path: &Path) -> Result<()> {
    hash.update(
        path.to_str()
            .context("plugin_migration_unsafe_tree")?
            .replace('\\', "/")
            .as_bytes(),
    );
    hash.update([0]);
    Ok(())
}
pub(crate) fn directory(hash: &mut Sha256, relative: &Path) -> Result<()> {
    path(hash, relative)?;
    hash.update(b"d\0");
    Ok(())
}
pub(crate) fn file(hash: &mut Sha256, relative: &Path, bytes: u64, executable: bool) -> Result<()> {
    path(hash, relative)?;
    hash.update(b"f\0");
    hash.update(bytes.to_le_bytes());
    hash.update([u8::from(executable)]);
    Ok(())
}
