//! Immutable UTF-8 revision objects. Database records reference durable files.
//! A crash before the DB commit can leave an unreferenced object, never a partial revision.
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) struct ObjectStore {
    root: PathBuf,
}
impl ObjectStore {
    pub fn open(root: PathBuf) -> Result<Self> {
        private_dir(&root)?;
        Ok(Self {
            root: fs::canonicalize(root)?,
        })
    }
    fn directory(&self, library: &str) -> Result<PathBuf> {
        let id = uuid::Uuid::parse_str(library).context("invalid library id")?;
        let path = self.root.join(id.to_string());
        private_dir(&path)?;
        Ok(path)
    }
    /// Only for a newly allocated unpublished import library owned by the caller.
    pub(crate) fn remove_library_unpublished(&self, library: &str) -> Result<()> {
        let id = uuid::Uuid::parse_str(library).context("invalid library id")?;
        let path = self.root.join(id.to_string());
        let metadata = match fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "invalid unpublished object directory"
        );
        fs::remove_dir_all(path).context("remove unpublished objects")
    }
    pub fn put(&self, library: &str, content: &str) -> Result<String> {
        self.put_bytes(library, content.as_bytes())
    }
    pub fn put_bytes(&self, library: &str, content: &[u8]) -> Result<String> {
        let hash = digest(content);
        let dir = self.directory(library)?;
        let path = dir.join(format!("{hash}.md"));
        if path.try_exists()? {
            ensure!(
                self.read_bytes(library, &hash)? == content,
                "revision object integrity failure"
            );
            return Ok(hash);
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&dir)?;
        temporary.write_all(content)?;
        temporary.as_file().sync_all()?;
        match temporary.persist_noclobber(&path) {
            Ok(_) => {}
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                ensure!(
                    self.read_bytes(library, &hash)? == content,
                    "revision object integrity failure"
                );
            }
            Err(error) => return Err(error.error.into()),
        }
        #[cfg(unix)]
        fs::File::open(&dir)?.sync_all()?;
        Ok(hash)
    }
    pub fn read(&self, library: &str, hash: &str) -> Result<String> {
        String::from_utf8(self.read_bytes(library, hash)?).context("invalid UTF-8 revision")
    }
    pub fn read_bytes(&self, library: &str, hash: &str) -> Result<Vec<u8>> {
        ensure!(
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
            "invalid object hash"
        );
        let id = uuid::Uuid::parse_str(library).context("invalid library id")?;
        let dir = self.root.join(id.to_string());
        let meta = fs::symlink_metadata(&dir)?;
        ensure!(
            meta.is_dir() && !meta.file_type().is_symlink(),
            "invalid object directory"
        );
        let path = dir.join(format!("{hash}.md"));
        let metadata = fs::symlink_metadata(&path)?;
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "invalid revision object"
        );
        ensure!(
            metadata.len() <= 32 * 1024 * 1024,
            "revision object too large"
        );
        let content = fs::read(path)?;
        ensure!(
            digest(&content) == hash,
            "revision object integrity failure"
        );
        Ok(content)
    }
}
pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn private_dir(path: &Path) -> Result<()> {
    if !path.try_exists()? {
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "knowledge object directory must not be a symlink"
    );
    Ok(())
}
