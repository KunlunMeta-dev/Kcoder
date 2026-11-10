//! Runtime-only evidence comes from the descriptor that supplied the successful read bytes.
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Clone, PartialEq, Eq)]
pub struct SuccessfulFileRead {
    path: PathBuf,
    parent_identity: Option<String>,
    identity: Option<PortableLeaseIdentity>,
    cache: Option<ReadCacheBinding>,
    bytes: u64,
    sha256: String,
}
#[derive(Clone, PartialEq, Eq)]
struct ReadCacheBinding {
    path: PathBuf,
    offset: Option<usize>,
    limit: Option<usize>,
    covers_entire_file: bool,
}
impl std::fmt::Debug for SuccessfulFileRead {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SuccessfulFileRead").finish_non_exhaustive()
    }
}
impl SuccessfulFileRead {
    pub fn path(&self) -> &Path {
        &self.path
    }
    /// Complete actual read bytes, independent of display truncation. This
    /// observation is not new permission and is invalid after file replacement.
    pub fn full_content_observation(&self) -> Option<(u64, &str)> {
        self.still_matches()
            .then_some((self.bytes, self.sha256.as_str()))
    }
    /// Cache coordinates are visibility bookkeeping, never scope or path authority.
    pub fn unpublished_cache_binding(&self) -> Option<(&Path, Option<usize>, Option<usize>, bool)> {
        self.cache.as_ref().map(|cache| {
            (
                cache.path.as_path(),
                cache.offset,
                cache.limit,
                cache.covers_entire_file,
            )
        })
    }
    /// Evidence is not new read permission. Replacements invalidate activation even if a previous read succeeded.
    pub fn still_matches(&self) -> bool {
        let check = || -> anyhow::Result<bool> {
            let Some(identity) = &self.identity else {
                return Ok(false);
            };
            if self.path.canonicalize()? != self.path {
                return Ok(false);
            }
            let parent = PrivateDirectory::open_existing(
                self.path
                    .parent()
                    .ok_or_else(|| anyhow::anyhow!("file has no parent"))?,
            )?;
            let file = parent.open_regular_file(
                self.path
                    .file_name()
                    .ok_or_else(|| anyhow::anyhow!("file has no name"))?,
            )?;
            Ok(Some(parent.directory_identity()?) == self.parent_identity
                && PortableLeaseIdentity::from_regular_handle(&file)? == *identity)
        };
        check().unwrap_or(false)
    }
}

pub(crate) async fn read_actual(
    path: &Path,
    max: u64,
) -> std::io::Result<(Vec<u8>, Option<SuccessfulFileRead>)> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || read_actual_sync(&path, max))
        .await
        .map_err(std::io::Error::other)?
}
fn read_actual_sync(
    path: &Path,
    max: u64,
) -> std::io::Result<(Vec<u8>, Option<SuccessfulFileRead>)> {
    let resolved = path.canonicalize()?;
    let parent = PrivateDirectory::open_existing(
        resolved
            .parent()
            .ok_or_else(|| std::io::Error::other("file has no parent"))?,
    )
    .map_err(std::io::Error::other)?;
    let file = parent
        .open_regular_file(
            resolved
                .file_name()
                .ok_or_else(|| std::io::Error::other("file has no name"))?,
        )
        .map_err(std::io::Error::other)?;
    let before = file.metadata()?;
    if !before.is_file() || before.len() > max {
        return Err(std::io::Error::other(
            "read source is not a bounded regular file",
        ));
    }
    let identity = PortableLeaseIdentity::from_regular_handle(&file).ok();
    let mut bytes = Vec::new();
    (&file).take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(std::io::Error::other("read source exceeds byte budget"));
    }
    let after = file.metadata()?;
    let stable = before.len() == after.len() && before.modified().ok() == after.modified().ok();
    let evidence = SuccessfulFileRead {
        path: resolved,
        parent_identity: parent.directory_identity().ok(),
        identity: if stable { identity } else { None },
        cache: None,
        bytes: bytes.len() as u64,
        sha256: {
            use sha2::Digest;
            format!("{:x}", sha2::Sha256::digest(&bytes))
        },
    };
    Ok((bytes, Some(evidence)))
}

pub(crate) fn attach_cached(
    output: crate::ToolOutput,
    mut evidence: Option<SuccessfulFileRead>,
    path: &Path,
    offset: Option<usize>,
    limit: Option<usize>,
    covers_entire_file: bool,
) -> crate::ToolOutput {
    if let Some(evidence) = &mut evidence {
        evidence.cache = Some(ReadCacheBinding {
            path: path.into(),
            offset,
            limit,
            covers_entire_file,
        });
    }
    attach(output, evidence)
}

pub(crate) fn attach(
    mut output: crate::ToolOutput,
    evidence: Option<SuccessfulFileRead>,
) -> crate::ToolOutput {
    if !output.is_error
        && let Some(evidence) = evidence
    {
        output
            .execution_metadata
            .push(crate::ToolExecutionMetadata::FileRead(evidence));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_read_evidence_cannot_survive_replaced_file_or_parent() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("worktree");
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("file.txt");
        std::fs::write(&path, b"body").unwrap();
        let (body, evidence) = read_actual_sync(&path, 4).unwrap();
        assert_eq!(body, b"body");
        let evidence = evidence.unwrap();
        assert!(evidence.still_matches());
        std::fs::rename(&directory, root.path().join("old")).unwrap();
        std::fs::create_dir(&directory).unwrap();
        std::fs::rename(root.path().join("old/file.txt"), &path).unwrap();
        assert!(
            !evidence.still_matches(),
            "same file under a replaced parent cannot authorize scoped activation"
        );
    }
    #[test]
    fn failed_or_oversized_reads_and_hardlinks_do_not_produce_activation_authority() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("file.txt");
        std::fs::write(&path, b"body").unwrap();
        assert!(read_actual_sync(&path, 3).is_err());
        assert!(read_actual_sync(&root.path().join("missing"), 4).is_err());
        std::fs::hard_link(&path, root.path().join("alias.txt")).unwrap();
        let (_, evidence) = read_actual_sync(&path, 4).unwrap();
        assert!(!evidence.unwrap().still_matches());
    }
}

#[cfg(test)]
mod full_observation_tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn full_hash_comes_from_actual_bytes_not_the_display_excerpt_and_replacement_revokes_it() {
        let temp = tempfile::tempdir().unwrap();
        let directory = PrivateDirectory::open_existing(temp.path()).unwrap();
        let bytes = "complete native file body ".repeat(1000).into_bytes();
        directory
            .atomic_replace(std::ffi::OsStr::new("source.txt"), &bytes)
            .unwrap();
        let path = temp.path().join("source.txt");
        let (actual, evidence) = read_actual_sync(&path, 1024 * 1024).unwrap();
        assert_eq!(actual, bytes);
        let output = attach_cached(
            crate::ToolOutput::text("display excerpt"),
            evidence,
            &path,
            None,
            None,
            true,
        );
        let evidence = output
            .execution_metadata
            .iter()
            .find_map(|meta| match meta {
                crate::ToolExecutionMetadata::FileRead(value) => Some(value),
                _ => None,
            })
            .unwrap();
        let (size, hash) = evidence.full_content_observation().unwrap();
        assert_eq!(size, bytes.len() as u64);
        assert_eq!(hash, format!("{:x}", Sha256::digest(&bytes)));
        assert_ne!(hash, format!("{:x}", Sha256::digest(b"display excerpt")));
        directory
            .atomic_replace(std::ffi::OsStr::new("source.txt"), &bytes)
            .unwrap();
        assert!(evidence.full_content_observation().is_none());
    }
}
