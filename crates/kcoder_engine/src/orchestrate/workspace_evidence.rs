//! Bounded evidence snapshots shared by recording and completion validation.
//! This is content provenance, never an authorization or executable-image cache.

use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

const SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;

pub(crate) async fn digest(root: &Path) -> Result<String> {
    tokio::time::timeout(Duration::from_secs(60), snapshot(root))
        .await
        .context("workspace evidence snapshot timed out")?
}

// The completion policy is synchronous. Keep its bounded subprocess work on an
// owned thread rather than nesting a runtime on the caller's Tokio thread.
// Call only for workspace-bound evidence, once per completion evaluation.
pub(crate) fn digest_sync(root: &Path) -> Result<String> {
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?
                    .block_on(digest(root))
            })
            .join()
            .map_err(|_| anyhow::anyhow!("workspace evidence worker panicked"))?
    })
}

fn frame(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

async fn git(root: &Path, args: &[&str], limit: usize) -> Result<Vec<u8>> {
    let mut command = tokio::process::Command::new("git");
    #[cfg(windows)]
    command
        .args(["-c", "core.longpaths=true"])
        .creation_flags(0x0800_0000);
    command
        .args(["--no-pager", "-c", "core.fsmonitor=false"])
        .args(args)
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let result = kcoder_tools::owned_process::output(
        &mut command,
        None,
        limit,
        4096,
        Duration::from_secs(30),
        None,
    )
    .await?;
    ensure!(
        result.status.success(),
        "workspace evidence Git command failed: {}",
        String::from_utf8_lossy(&result.stderr).trim()
    );
    Ok(result.stdout)
}

async fn snapshot(root: &Path) -> Result<String> {
    let root = tokio::fs::canonicalize(root).await?;
    let head = git(&root, &["rev-parse", "--verify", "HEAD"], 4096).await?;
    let diff = git(
        &root,
        &[
            "diff",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
            "HEAD",
            "--",
            ".",
            ":(exclude).kcoder/orchestrate/**",
        ],
        SNAPSHOT_BYTES.saturating_sub(head.len()),
    )
    .await?;
    let untracked = git(
        &root,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".",
            ":(exclude).kcoder/orchestrate/**",
        ],
        SNAPSHOT_BYTES
            .saturating_sub(head.len())
            .saturating_sub(diff.len()),
    )
    .await?;
    let mut total = head
        .len()
        .saturating_add(diff.len())
        .saturating_add(untracked.len());
    ensure!(
        total <= SNAPSHOT_BYTES,
        "workspace evidence exceeds the 64 MiB limit"
    );
    let mut hasher = Sha256::new();
    // A clean diff alone cannot identify a commit; untracked names alone cannot
    // identify file contents. Version the format so legacy incomplete proofs
    // require fresh verification instead of silently remaining valid.
    frame(&mut hasher, b"kcoder-orchestrate-evidence-v2");
    frame(&mut hasher, root.as_os_str().as_encoded_bytes());
    frame(&mut hasher, &head);
    frame(&mut hasher, &diff);
    for raw in untracked
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        #[cfg(unix)]
        let relative = {
            use std::os::unix::ffi::OsStrExt;
            Path::new(std::ffi::OsStr::from_bytes(raw))
        };
        #[cfg(not(unix))]
        let relative = Path::new(std::str::from_utf8(raw).context("untracked path is not UTF-8")?);
        ensure!(
            !relative.is_absolute()
                && relative
                    .components()
                    .all(|component| matches!(component, std::path::Component::Normal(_))),
            "invalid untracked path"
        );
        let path = root.join(relative);
        let metadata = tokio::fs::symlink_metadata(&path).await?;
        frame(&mut hasher, raw);
        let bytes = if metadata.file_type().is_symlink() {
            frame(&mut hasher, b"symlink");
            tokio::fs::read_link(&path)
                .await?
                .as_os_str()
                .as_encoded_bytes()
                .to_vec()
        } else {
            ensure!(metadata.is_file(), "unsupported untracked evidence entry");
            ensure!(
                metadata.len() <= (SNAPSHOT_BYTES - total) as u64,
                "workspace evidence exceeds the 64 MiB limit"
            );
            frame(&mut hasher, b"file");
            let mut bytes = Vec::new();
            tokio::fs::File::open(&path)
                .await?
                .take((SNAPSHOT_BYTES - total + 1) as u64)
                .read_to_end(&mut bytes)
                .await?;
            // The bound applies to bytes actually read, including concurrent growth.
            bytes
        };
        total = total.saturating_add(bytes.len());
        ensure!(
            total <= SNAPSHOT_BYTES,
            "workspace evidence exceeds the 64 MiB limit"
        );
        frame(&mut hasher, &bytes);
    }
    ensure!(
        head == git(&root, &["rev-parse", "--verify", "HEAD"], 4096).await?,
        "workspace HEAD changed during evidence capture"
    );
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repository() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(root.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet"]);
        git(&[
            "-c",
            "user.name=Evidence Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "first",
        ]);
        root
    }
    #[tokio::test]
    async fn commit_identity_and_untracked_contents_invalidate_evidence() {
        let root = repository();
        let original = digest(root.path()).await.unwrap();
        assert_eq!(
            original,
            digest_sync(root.path()).unwrap(),
            "producer and synchronous policy agree"
        );
        let output = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=Evidence Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "second",
            ])
            .current_dir(root.path())
            .output()
            .unwrap();
        assert!(output.status.success());
        let commit = digest(root.path()).await.unwrap();
        assert_ne!(
            original, commit,
            "two clean commits are different evidence bases"
        );
        std::fs::write(root.path().join("untracked"), "first").unwrap();
        let untracked = digest(root.path()).await.unwrap();
        std::fs::write(root.path().join("untracked"), "other").unwrap();
        assert_ne!(untracked, digest(root.path()).await.unwrap());
        std::fs::create_dir_all(root.path().join(".kcoder/orchestrate")).unwrap();
        let before = digest(root.path()).await.unwrap();
        std::fs::write(root.path().join(".kcoder/orchestrate/ledger"), "updated").unwrap();
        assert_eq!(
            before,
            digest(root.path()).await.unwrap(),
            "evidence output cannot invalidate itself"
        );
    }
    #[tokio::test]
    async fn missing_git_and_oversize_content_are_errors_not_stable_proofs() {
        let missing = tempfile::tempdir().unwrap();
        assert!(digest(missing.path()).await.is_err());
        let root = repository();
        std::fs::File::create(root.path().join("large"))
            .unwrap()
            .set_len(SNAPSHOT_BYTES as u64 + 1)
            .unwrap();
        assert!(
            digest(root.path())
                .await
                .unwrap_err()
                .to_string()
                .contains("64 MiB")
        );
    }
}
