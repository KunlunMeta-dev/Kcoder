//! Immutable UTF-8 revision objects. Database records reference durable files.
//! A crash before the DB commit can leave an unreferenced object, never a partial revision.
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(crate) struct ObjectStore {
    root: PathBuf,
}
impl ObjectStore {
    pub fn open(root: PathBuf) -> Result<Self> {
        private_dir(&root)?;
        let root = fs::canonicalize(root)?;
        // Schema-current opens may do no SQLite write to confirm this entry.
        // Existing roots can also be visible leftovers of a failed confirmation.
        sync_object_directory(
            root.parent()
                .context("knowledge object root has no parent")?,
        )?;
        Ok(Self { root })
    }
    fn directory(&self, library: &str) -> Result<PathBuf> {
        let id = uuid::Uuid::parse_str(library).context("invalid library id")?;
        let path = self.root.join(id.to_string());
        private_dir(&path)?;
        // The library entry belongs to root, not to the library's own directory.
        // Retry confirmation even when a failed mkdir publication left it visible.
        sync_object_directory(&self.root)?;
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
            // An earlier publish may have created this leaf but failed its
            // directory sync. A valid hash alone is not a durable publication.
            sync_object_directory(&dir)?;
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
        sync_object_directory(&dir)?;
        Ok(hash)
    }
    pub fn read(&self, library: &str, hash: &str) -> Result<String> {
        String::from_utf8(self.read_bytes(library, hash)?).context("invalid UTF-8 revision")
    }
    pub fn read_bytes(&self, library: &str, hash: &str) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        self.copy_object_to(library, hash, &mut bytes)?;
        Ok(bytes)
    }

    pub(crate) fn object_len(&self, library: &str, hash: &str) -> Result<u64> {
        Ok(self.open_object(library, hash)?.metadata()?.len())
    }

    pub(crate) fn copy_object_to(
        &self,
        library: &str,
        hash: &str,
        writer: &mut impl Write,
    ) -> Result<u64> {
        let mut file = self.open_object(library, hash)?;
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0; 64 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            total += count as u64;
            ensure!(total <= 32 * 1024 * 1024, "revision object too large");
            hasher.update(&buffer[..count]);
            writer.write_all(&buffer[..count])?;
        }
        ensure!(
            format!("{:x}", hasher.finalize()) == hash,
            "revision object integrity failure"
        );
        Ok(total)
    }

    /// A bounded stream is hashed before atomic immutable publication.
    pub(crate) fn put_object_reader(
        &self,
        library: &str,
        reader: &mut impl Read,
        length: u64,
        expected_hash: &str,
    ) -> Result<()> {
        ensure!(length <= 32 * 1024 * 1024, "revision object too large");
        validate_hash(expected_hash)?;
        let dir = self.directory(library)?;
        let mut temporary = tempfile::NamedTempFile::new_in(&dir)?;
        let mut hasher = Sha256::new();
        let mut remaining = length;
        let mut buffer = [0; 64 * 1024];
        while remaining > 0 {
            let size = remaining.min(buffer.len() as u64) as usize;
            reader
                .read_exact(&mut buffer[..size])
                .context("incomplete revision object")?;
            hasher.update(&buffer[..size]);
            temporary.write_all(&buffer[..size])?;
            remaining -= size as u64;
        }
        ensure!(
            format!("{:x}", hasher.finalize()) == expected_hash,
            "revision object integrity failure"
        );
        temporary.as_file().sync_all()?;
        let path = dir.join(format!("{expected_hash}.md"));
        match temporary.persist_noclobber(&path) {
            Ok(_) => {}
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                ensure!(
                    self.object_len(library, expected_hash)? == length,
                    "revision object integrity failure"
                );
                self.copy_object_to(library, expected_hash, &mut std::io::sink())?;
            }
            Err(error) => return Err(error.error.into()),
        }
        sync_object_directory(&dir)?;
        Ok(())
    }

    fn open_object(&self, library: &str, hash: &str) -> Result<fs::File> {
        validate_hash(hash)?;
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
        let file = fs::File::open(path)?;
        let opened = file.metadata()?;
        ensure!(
            opened.is_file() && opened.len() <= 32 * 1024 * 1024,
            "invalid revision object"
        );
        Ok(file)
    }
}

fn sync_object_directory(_directory: &Path) -> Result<()> {
    #[cfg(all(test, unix))]
    tests::before_directory_sync(_directory)?;
    #[cfg(unix)]
    fs::File::open(_directory)?.sync_all()?;
    Ok(())
}

#[cfg(all(test, unix))]
#[path = "objects_tests.rs"]
mod tests;
pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn validate_hash(hash: &str) -> Result<()> {
    ensure!(
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "invalid object hash"
    );
    Ok(())
}
fn private_dir(path: &Path) -> Result<()> {
    if !path.try_exists()? {
        let builder = fs::DirBuilder::new();
        #[cfg(unix)]
        let mut builder = builder;
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
