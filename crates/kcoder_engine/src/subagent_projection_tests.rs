use super::*;
use std::time::Duration;

fn checkpoint(path: &Path, text: &str) -> Vec<Message> {
    let messages = vec![Message::user_text(text)];
    let directory = directory(path, true).unwrap();
    directory
        .atomic_replace(
            path.file_name().unwrap(),
            &serde_json::to_vec(&messages).unwrap(),
        )
        .unwrap();
    messages
}

fn projection(messages: &[Message]) -> Vec<u8> {
    crate::subagent_boundary_runtime::public_subagent_transcript(messages).unwrap()
}

#[test]
fn staged_receipt_preserves_current_progress_when_public_replacement_fails() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("transcript.json");
    let mut messages = checkpoint(&path, "checkpoint");
    messages.push(Message::user_text("newer visible safe-boundary progress"));
    let current = projection(&messages);
    publish(&path, &current).unwrap();
    messages.push(Message::user_text("not yet published"));
    with_segment(&path, || {
        let directory = directory(&path, false)?;
        publish_locked(
            &directory,
            &path,
            &projection(&messages),
            private_baseline(&directory, &path)?,
            || anyhow::bail!("injected public replacement failure"),
        )
    })
    .unwrap_err();
    ensure(&path, false, false).unwrap();
    assert_eq!(
        std::fs::read(path.with_extension("public.txt")).unwrap(),
        current
    );
    let directory = directory(&path, false).unwrap();
    assert_eq!(load_receipts(&directory, &path).unwrap().records.len(), 2);
    // Publication needs no trailing receipt commit: the already-staged next
    // receipt immediately recognizes a successfully replaced public file.
    let next = projection(&messages);
    directory
        .atomic_replace(
            path.with_extension("public.txt").file_name().unwrap(),
            &next,
        )
        .unwrap();
    ensure(&path, false, false).unwrap();
    assert_eq!(
        std::fs::read(path.with_extension("public.txt")).unwrap(),
        next
    );
}

#[test]
fn receipt_publication_failure_keeps_last_public_file() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("transcript.json");
    let messages = checkpoint(&path, "checkpoint");
    let previous = projection(&messages);
    publish(&path, &previous).unwrap();
    std::fs::remove_file(receipt_path(&path)).unwrap();
    std::fs::create_dir(receipt_path(&path)).unwrap();
    let mut newer = messages;
    newer.push(Message::user_text("unpublished progress"));
    assert!(publish(&path, &projection(&newer)).is_err());
    assert_eq!(
        std::fs::read(path.with_extension("public.txt")).unwrap(),
        previous
    );
}

#[test]
fn unknown_receipts_preserve_active_progress_and_recover_terminal_checkpoint() {
    for damage in 0..4 {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("transcript.json");
        let messages = checkpoint(&path, "checkpoint");
        let expected = projection(&messages);
        let mut live = messages;
        live.push(Message::user_text("unknown legacy live progress"));
        let public = projection(&live);
        std::fs::write(path.with_extension("public.txt"), &public).unwrap();
        let damaged = match damage {
            0 => None,
            1 => Some(b"invalid JSON".to_vec()),
            2 => Some(vec![b'x'; MAX_RECEIPT_BYTES as usize + 1]),
            _ => Some(
                serde_json::to_vec(&serde_json::json!({
                    "version": 1,
                    "records": [{
                        "public_sha256": format!("{:x}", Sha256::digest(&public)),
                        "private_baseline": { "kind": "Bytes", "sha256": "not a digest" }
                    }]
                }))
                .unwrap(),
            ),
        };
        if let Some(damaged) = damaged {
            std::fs::write(receipt_path(&path), damaged).unwrap();
        }
        ensure(&path, true, true).unwrap();
        assert_eq!(
            std::fs::read(path.with_extension("public.txt")).unwrap(),
            public
        );
        ensure(&path, false, false).unwrap();
        assert_eq!(
            std::fs::read(path.with_extension("public.txt")).unwrap(),
            expected
        );
    }
}

#[test]
fn retained_public_output_survives_private_removal_and_never_contains_private_hash() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("transcript.json");
    let mut messages = checkpoint(&path, "visible");
    messages.push(Message::Assistant {
        usage: None,
        content: vec![kcoder_types::ContentBlock::Thinking {
            thinking: "PRIVATE projection review thought".into(),
            signature: "PRIVATE signature".into(),
        }],
    });
    let bytes = serde_json::to_vec(&messages).unwrap();
    let private_hash = format!("{:x}", Sha256::digest(&bytes));
    std::fs::write(&path, bytes).unwrap();
    let public = projection(&messages);
    publish(&path, &public).unwrap();
    let public_text = String::from_utf8(public.clone()).unwrap();
    assert!(!public_text.contains(&private_hash));
    assert!(!public_text.contains("PRIVATE"));
    assert!(
        std::fs::read_to_string(receipt_path(&path))
            .unwrap()
            .contains(&private_hash)
    );
    std::fs::remove_file(&path).unwrap();
    ensure(&path, false, false).unwrap();
    assert_eq!(
        std::fs::read(path.with_extension("public.txt")).unwrap(),
        public
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_private_publication_recovers_after_worker_success() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("transcript.json");
    let previous = checkpoint(&path, "old checkpoint");
    publish(&path, &projection(&previous)).unwrap();
    let newer = vec![Message::user_text("new successfully published checkpoint")];
    let expected = projection(&newer);
    let bytes = serde_json::to_vec(&newer).unwrap();
    let barrier = Arc::new((Mutex::new((false, false)), std::sync::Condvar::new()));
    let worker_barrier = barrier.clone();
    let worker_path = path.clone();
    let waiter = tokio::spawn(async move {
        crate::managed_artifacts::write_with(&worker_path, bytes, move |path, bytes| {
            with_segment(path, || {
                directory(path, false)?.atomic_replace(path.file_name().unwrap(), bytes)
            })?;
            let (lock, changed) = &*worker_barrier;
            let mut state = lock.lock().unwrap();
            state.0 = true;
            changed.notify_all();
            while !state.1 {
                state = changed.wait(state).unwrap();
            }
            Ok(())
        })
        .await
    });
    let started = tokio::time::timeout(Duration::from_secs(2), async {
        while !barrier.0.lock().unwrap().0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await;
    waiter.abort();
    let _ = waiter.await;
    let repaired = ensure(&path, false, false);
    barrier.0.lock().unwrap().1 = true;
    barrier.1.notify_all();
    // Fence the detached blocking worker before removing its owned test dir.
    drop(
        crate::managed_artifacts::write_with(&path, Vec::new(), |_, _| Ok(()))
            .await
            .unwrap(),
    );
    started.unwrap();
    repaired.unwrap();
    assert_eq!(
        std::fs::read(path.with_extension("public.txt")).unwrap(),
        expected
    );
}
