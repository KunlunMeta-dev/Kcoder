//! Complete private artifact replacement, ordered per path within this process.

use anyhow::{Context, Result};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

type PublicationGates = Mutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>;
static GATES: OnceLock<PublicationGates> = OnceLock::new();

fn gate(path: &Path) -> Arc<AsyncMutex<()>> {
    let mut gates = GATES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    gates.retain(|_, weak| weak.strong_count() > 0);
    if let Some(gate) = gates.get(path).and_then(Weak::upgrade) {
        return gate;
    }
    let gate = Arc::new(AsyncMutex::new(()));
    gates.insert(path.to_path_buf(), Arc::downgrade(&gate));
    gate
}

/// Hold the returned gate while publishing a checkpoint's dependent projection.
/// The blocking publication owns it even if its async waiter is cancelled.
pub(crate) async fn write(path: &Path, bytes: Vec<u8>) -> Result<OwnedMutexGuard<()>> {
    write_with(path, bytes, |path, bytes| {
        crate::subagent_projection::with_segment(path, || {
            let parent = path.parent().context("managed artifact has no directory")?;
            let name = path
                .file_name()
                .context("managed artifact has no file name")?;
            let directory = kcoder_config::PrivateDirectory::open_or_create(parent)?;
            directory.atomic_replace(name, bytes)
        })
    })
    .await
}

pub(crate) async fn write_with(
    path: &Path,
    bytes: Vec<u8>,
    publish: impl FnOnce(&Path, &[u8]) -> Result<()> + Send + 'static,
) -> Result<OwnedMutexGuard<()>> {
    let path = std::path::absolute(path).context("resolve managed artifact path")?;
    let guard = gate(&path).lock_owned().await;
    tokio::task::spawn_blocking(move || {
        publish(&path, &bytes)?;
        Ok(guard)
    })
    .await
    .context("managed artifact publication worker stopped")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn publication_holds_only_its_path_until_dependent_work_finishes() {
        let root = tempfile::tempdir().unwrap();
        let first_path = root.path().join("first.txt");
        let second_path = root.path().join("second.txt");
        let first = write(&first_path, b"first complete snapshot".to_vec())
            .await
            .unwrap();
        let next_path = first_path.clone();
        let mut next =
            tokio::spawn(async move { write(&next_path, b"new snapshot".to_vec()).await });
        let blocked = tokio::time::timeout(Duration::from_millis(30), &mut next)
            .await
            .is_err();
        let different = tokio::time::timeout(
            Duration::from_secs(2),
            write(&second_path, b"independent".to_vec()),
        )
        .await
        .unwrap()
        .unwrap();
        drop(different);
        assert_eq!(
            std::fs::read(&first_path).unwrap(),
            b"first complete snapshot"
        );
        drop(first);
        if blocked {
            drop(next.await.unwrap().unwrap());
        }
        assert!(
            blocked,
            "a checkpoint projection must remain ordered with the next replacement"
        );
        assert_eq!(std::fs::read(first_path).unwrap(), b"new snapshot");
    }

    #[tokio::test]
    async fn cancelled_waiter_does_not_release_an_inflight_publication() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("output.txt");
        let barrier = Arc::new((Mutex::new((false, false)), std::sync::Condvar::new()));
        let blocker = barrier.clone();
        let old_path = path.clone();
        let old = tokio::spawn(async move {
            write_with(&old_path, b"old".to_vec(), move |path, bytes| {
                let (lock, changed) = &*blocker;
                let mut state = lock.lock().unwrap();
                state.0 = true;
                while !state.1 {
                    state = changed.wait(state).unwrap();
                }
                drop(state);
                kcoder_config::PrivateDirectory::open_or_create(path.parent().unwrap())?
                    .atomic_replace(path.file_name().unwrap(), bytes)
            })
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !barrier.0.lock().unwrap().0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        old.abort();
        let _ = old.await;
        let newer_path = path.clone();
        let mut newer = tokio::spawn(async move { write(&newer_path, b"newer".to_vec()).await });
        let blocked = tokio::time::timeout(Duration::from_millis(30), &mut newer)
            .await
            .is_err();
        // Release the owned worker even when an assertion would fail.
        barrier.0.lock().unwrap().1 = true;
        barrier.1.notify_all();
        if blocked {
            drop(newer.await.unwrap().unwrap());
        }
        assert!(
            blocked,
            "the blocking writer must retain the gate after its waiter is cancelled"
        );
        assert_eq!(std::fs::read(path).unwrap(), b"newer");
    }

    #[tokio::test]
    async fn failed_publication_keeps_last_file_and_releases_its_gate() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("output.txt");
        drop(write(&path, b"last valid snapshot".to_vec()).await.unwrap());
        let failed = write_with(&path, b"failed new snapshot".to_vec(), |_, _| {
            anyhow::bail!("owned publication failure")
        })
        .await;
        assert!(failed.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"last valid snapshot");
        drop(
            tokio::time::timeout(
                Duration::from_secs(2),
                write(&path, b"successful retry".to_vec()),
            )
            .await
            .unwrap()
            .unwrap(),
        );
        assert_eq!(std::fs::read(path).unwrap(), b"successful retry");
    }
}
