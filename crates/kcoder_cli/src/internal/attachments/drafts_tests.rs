use super::*;

fn setup() -> (
    tempfile::TempDir,
    PathBuf,
    AttachmentDirectories,
    AttachmentDraftRetainParams,
) {
    let temporary = tempfile::tempdir().unwrap();
    let session = temporary.path().join("session");
    PrivateDirectory::open_or_create(&session).unwrap();
    let mut staged = AttachmentDirectories::default();
    let original = attachment_save(
        "thread-a",
        &AttachmentSaveParams {
            filename: "draft.txt".into(),
            content_base64: "aGVsbG8=".into(),
            retention: None,
        },
        &mut staged,
    )
    .unwrap();
    let params = AttachmentDraftRetainParams {
        thread_id: "thread-a".into(),
        owner_scope: "a".repeat(64),
        paths: vec![original.path],
        recover_only: false,
    };
    (temporary, session, staged, params)
}

#[test]
fn sealed_bytes_and_owner_recover_after_connection_exit_without_copying_again() {
    let (_temporary, session, mut staged, mut params) = setup();
    let first = retain_draft_attachments(&session, &params, &mut staged).unwrap();
    let path = first.drafts[0].path.clone();
    assert_ne!(path, params.paths[0]);
    let record_path = Path::new(&path)
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(RECORD);
    let stamp = std::fs::metadata(&record_path).unwrap().modified().unwrap();
    assert_eq!(
        retain_draft_attachments(&session, &params, &mut staged).unwrap(),
        first
    );
    assert_eq!(
        std::fs::metadata(&record_path).unwrap().modified().unwrap(),
        stamp
    );
    drop(staged);
    assert!(Path::new(&path).is_file());
    assert!(!Path::new(&params.paths[0]).exists());
    let mut restarted = AttachmentDirectories::default();
    params.paths = vec![path.clone()];
    params.recover_only = true;
    retain_draft_attachments(&session, &params, &mut restarted).unwrap();
    let read = attachment_read(
        &session.join("attachments"),
        &AttachmentReadParams {
            thread_id: "thread-a".into(),
            path: path.clone(),
        },
        &restarted,
    )
    .unwrap();
    assert_eq!(read.content_base64, "aGVsbG8=");
    assert!(
        attachment_read(
            &session.join("other-thread").join("attachments"),
            &AttachmentReadParams {
                thread_id: "other-thread".into(),
                path
            },
            &restarted
        )
        .is_err()
    );
}

#[test]
fn unknown_source_replay_uses_original_receipt_but_cannot_adopt_another_upload() {
    let (_temporary, session, mut staged, mut params) = setup();
    let original = params.paths[0].clone();
    let first = retain_draft_attachments(&session, &params, &mut staged).unwrap();
    drop(staged);
    assert!(!Path::new(&original).exists());
    let mut restarted = AttachmentDirectories::default();
    params.recover_only = true;
    assert_eq!(
        retain_draft_attachments(&session, &params, &mut restarted).unwrap(),
        first
    );
    params.paths = vec!["/unowned/staged/other.txt".into()];
    assert!(retain_draft_attachments(&session, &params, &mut restarted).is_err());
}

#[test]
fn another_authority_thread_or_live_connection_cannot_claim_a_draft() {
    let (_temporary, session, mut staged, mut params) = setup();
    params.paths = vec![
        retain_draft_attachments(&session, &params, &mut staged)
            .unwrap()
            .drafts[0]
            .path
            .clone(),
    ];
    params.recover_only = true;
    let mut other = AttachmentDirectories::default();
    assert!(retain_draft_attachments(&session, &params, &mut other).is_err());
    drop(staged);
    let mut foreign = params.clone();
    foreign.owner_scope = "b".repeat(64);
    assert!(retain_draft_attachments(&session, &foreign, &mut other).is_err());
    foreign = params.clone();
    foreign.thread_id = "thread-b".into();
    assert!(retain_draft_attachments(&session, &foreign, &mut other).is_err());
    retain_draft_attachments(&session, &params, &mut other).unwrap();
}

#[test]
fn corruption_is_rejected_on_cold_claim_and_before_materialization() {
    let (_temporary, session, mut staged, mut params) = setup();
    params.paths = vec![
        retain_draft_attachments(&session, &params, &mut staged)
            .unwrap()
            .drafts[0]
            .path
            .clone(),
    ];
    std::fs::write(&params.paths[0], b"other").unwrap();
    let prompt = format!(
        "<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
        serde_json::json!({"filename":"draft.txt","path":params.paths[0]})
    );
    assert!(
        materialize_turn_attachments(
            &session.join("attachments"),
            "thread-a",
            "turn-a",
            &prompt,
            &mut staged
        )
        .is_err()
    );
    drop(staged);
    assert!(
        retain_draft_attachments(&session, &params, &mut AttachmentDirectories::default()).is_err()
    );
}

#[test]
fn only_committed_acceptance_removes_the_draft_copy_and_never_history() {
    let (_temporary, session, mut staged, mut params) = setup();
    params.paths = vec![
        retain_draft_attachments(&session, &params, &mut staged)
            .unwrap()
            .drafts[0]
            .path
            .clone(),
    ];
    let prompt = format!(
        "<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
        serde_json::json!({"filename":"draft.txt","path":params.paths[0]})
    );
    assert!(
        materialize_turn_attachments(
            &session.join("other-thread").join("attachments"),
            "thread-b",
            "turn-a",
            &prompt,
            &mut staged
        )
        .is_err()
    );
    let rewritten = materialize_turn_attachments(
        &session.join("attachments"),
        "thread-a",
        "turn-a",
        &prompt,
        &mut staged,
    )
    .unwrap();
    assert!(staged.delete(Path::new(&params.paths[0])).is_err());
    assert!(Path::new(&params.paths[0]).exists());
    staged.commit_draft_turn("thread-a", "wrong-turn").unwrap();
    assert!(Path::new(&params.paths[0]).exists());
    staged.commit_draft_turn("thread-a", "turn-a").unwrap();
    assert!(!Path::new(&params.paths[0]).exists());
    let record: Value = serde_json::from_str(rewritten.lines().nth(1).unwrap()).unwrap();
    assert_eq!(
        std::fs::read(record["path"].as_str().unwrap()).unwrap(),
        b"hello"
    );
    assert_eq!(
        attachment_read(
            &session.join("attachments"),
            &AttachmentReadParams {
                thread_id: "thread-a".into(),
                path: params.paths[0].clone(),
            },
            &staged
        )
        .unwrap()
        .content_base64,
        "aGVsbG8="
    );
}

#[cfg(unix)]
#[test]
fn linked_payloads_and_replaced_content_directories_fail_closed() {
    let (_temporary, session, mut staged, mut params) = setup();
    params.paths = vec![
        retain_draft_attachments(&session, &params, &mut staged)
            .unwrap()
            .drafts[0]
            .path
            .clone(),
    ];
    drop(staged);
    let path = PathBuf::from(&params.paths[0]);
    let external = session.join("elsewhere.txt");
    std::fs::write(&external, b"hello").unwrap();
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&external, &path).unwrap();
    assert!(
        retain_draft_attachments(&session, &params, &mut AttachmentDirectories::default()).is_err()
    );
    std::fs::remove_file(&path).unwrap();
    std::fs::hard_link(&external, &path).unwrap();
    assert!(
        retain_draft_attachments(&session, &params, &mut AttachmentDirectories::default()).is_err()
    );
}

#[test]
fn a_crashed_unpublished_write_is_removed_without_expiring_confirmed_drafts() {
    let (_temporary, session, mut staged, params) = setup();
    let first = retain_draft_attachments(&session, &params, &mut staged).unwrap();
    let root = PrivateDirectory::open_existing(&session.join("draft-attachments")).unwrap();
    let partial = format!("preparing-{}", "f".repeat(64));
    root.create_private_child(OsStr::new(&partial)).unwrap();
    assert_eq!(
        retain_draft_attachments(&session, &params, &mut staged).unwrap(),
        first
    );
    assert!(!session.join("draft-attachments").join(partial).exists());
    assert!(Path::new(&first.drafts[0].path).is_file());
}

#[test]
fn committed_removal_is_idempotent_and_does_not_recreate_a_deleted_receipt() {
    let (_temporary, session, mut staged, mut params) = setup();
    let first = retain_draft_attachments(&session, &params, &mut staged).unwrap();
    let path = PathBuf::from(&first.drafts[0].path);
    staged.delete(&path).unwrap();
    staged.delete(&path).unwrap();
    assert!(!path.exists());
    params.recover_only = true;
    assert!(retain_draft_attachments(&session, &params, &mut staged).is_err());
}

#[cfg(unix)]
#[test]
fn warm_reads_reject_replaced_ancestor_directories_without_exposing_external_bytes() {
    let (_temporary, session, mut staged, params) = setup();
    let path = PathBuf::from(
        &retain_draft_attachments(&session, &params, &mut staged)
            .unwrap()
            .drafts[0]
            .path,
    );
    let external = session.join("external");
    PrivateDirectory::open_or_create(&external).unwrap();
    std::fs::write(external.join("draft.txt"), b"other").unwrap();
    let content = path.parent().unwrap();
    std::fs::rename(content, content.with_extension("original")).unwrap();
    std::os::unix::fs::symlink(&external, content).unwrap();
    assert!(
        attachment_read(
            &session.join("attachments"),
            &AttachmentReadParams {
                thread_id: "thread-a".into(),
                path: path.to_string_lossy().into_owned(),
            },
            &staged
        )
        .is_err()
    );
    assert!(
        attachment_read_chunk(
            &session.join("attachments"),
            &AttachmentReadChunkParams {
                thread_id: "thread-a".into(),
                path: path.to_string_lossy().into_owned(),
                offset: 0,
                length: 1,
            },
            &staged
        )
        .is_err()
    );
}

#[test]
fn rejected_or_dropped_steer_preserves_durable_draft_for_original_fallback() {
    for dropped_after_acceptance in [false, true] {
        let (_temporary, session, mut staged, mut params) = setup();
        let retained = retain_draft_attachments(&session, &params, &mut staged).unwrap();
        params.paths = vec![retained.drafts[0].path.clone()];
        params.recover_only = true;
        let prompt = format!(
            "<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
            serde_json::json!({"filename":"draft.txt","path":params.paths[0]})
        );
        let (_, mut lease) = prepare_steer_model_input(
            &session.join("attachments"),
            "thread-a",
            "source-turn",
            &prompt,
            &mut staged,
            false,
        )
        .unwrap();
        let copy = lease.directory.clone().unwrap();
        assert!(
            retain_draft_attachments(&session, &params, &mut staged).is_err(),
            "an in-flight steer reserves its draft"
        );
        assert!(
            prepare_steer_model_input(
                &session.join("attachments"),
                "thread-a",
                "peer-steer",
                &prompt,
                &mut staged,
                false
            )
            .is_err(),
            "another input cannot consume the same reserved draft"
        );
        if dropped_after_acceptance {
            lease.commit_staged(&mut staged).unwrap();
        }
        lease.settle(false).unwrap();
        assert!(!copy.exists());
        assert!(Path::new(&params.paths[0]).exists());
        retain_draft_attachments(&session, &params, &mut staged).unwrap();
        materialize_model_input(
            &session.join("attachments"),
            "thread-a",
            "fallback-turn",
            &prompt,
            &mut staged,
            false,
        )
        .unwrap();
        staged
            .commit_draft_turn("thread-a", "fallback-turn")
            .unwrap();
        assert!(!Path::new(&params.paths[0]).exists());
    }
}

#[test]
fn applied_steer_releases_only_its_draft_and_preserves_history_after_disconnect() {
    let (_temporary, session, mut staged, params) = setup();
    let retained = retain_draft_attachments(&session, &params, &mut staged).unwrap();
    let path = &retained.drafts[0].path;
    let prompt = format!(
        "<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
        serde_json::json!({"filename":"draft.txt","path":path})
    );
    let (_, mut lease) = prepare_steer_model_input(
        &session.join("attachments"),
        "thread-a",
        "turn-a",
        &prompt,
        &mut staged,
        false,
    )
    .unwrap();
    let copy = lease.directory.clone().unwrap();
    lease.commit_staged(&mut staged).unwrap();
    assert!(!Path::new(&params.paths[0]).exists());
    assert!(Path::new(path).exists());
    lease.settle(true).unwrap();
    assert!(!Path::new(path).exists());
    let read = AttachmentReadParams {
        thread_id: "thread-a".into(),
        path: path.clone(),
    };
    assert_eq!(
        attachment_read(&session.join("attachments"), &read, &staged)
            .unwrap()
            .content_base64,
        "aGVsbG8="
    );
    assert!(attachment_read(&session.join("other-thread/attachments"), &read, &staged).is_err());
    drop(staged);
    assert_eq!(std::fs::read(copy.join("00-draft.txt")).unwrap(), b"hello");
}

#[test]
fn invalid_steer_image_does_not_consume_draft_or_leave_a_prepared_copy() {
    let (_temporary, session, mut staged, mut params) = setup();
    let retained = retain_draft_attachments(&session, &params, &mut staged).unwrap();
    params.paths = vec![retained.drafts[0].path.clone()];
    params.recover_only = true;
    let prompt = format!(
        "<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
        serde_json::json!({"filename":"draft.txt","mimeType":"image/png","path":params.paths[0]})
    );
    assert!(
        prepare_steer_model_input(
            &session.join("attachments"),
            "thread-a",
            "turn-a",
            &prompt,
            &mut staged,
            true
        )
        .is_err()
    );
    retain_draft_attachments(&session, &params, &mut staged).unwrap();
    assert_eq!(
        std::fs::read_dir(session.join("attachments"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn unknown_steer_teardown_preserves_both_draft_and_possible_history_copy() {
    let (_temporary, session, mut staged, params) = setup();
    let retained = retain_draft_attachments(&session, &params, &mut staged).unwrap();
    let path = &retained.drafts[0].path;
    let prompt = format!(
        "<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
        serde_json::json!({"filename":"draft.txt","path":path})
    );
    let (_, lease) = prepare_steer_model_input(
        &session.join("attachments"),
        "thread-a",
        "turn-a",
        &prompt,
        &mut staged,
        false,
    )
    .unwrap();
    let copy = lease.directory.clone().unwrap();
    drop(lease);
    assert!(Path::new(path).exists());
    assert_eq!(std::fs::read(copy.join("00-draft.txt")).unwrap(), b"hello");
}

#[test]
fn late_steer_cleanup_is_idempotent_but_cannot_delete_a_replacement_draft() {
    let (_temporary, session, mut staged, params) = setup();
    let retained = retain_draft_attachments(&session, &params, &mut staged).unwrap();
    let path = PathBuf::from(&retained.drafts[0].path);
    let cleanup = Arc::clone(&staged.drafts[&path].storage);
    cleanup.lock().unwrap().remove().unwrap();
    cleanup.lock().unwrap().remove().unwrap();
    retain_draft_attachments(&session, &params, &mut staged).unwrap();
    assert!(cleanup.lock().unwrap().remove().is_err());
    assert!(
        path.exists(),
        "a late cleanup cannot release a fresh Native owner"
    );
}

#[test]
fn applied_steer_cleanup_survives_transaction_contention_and_disconnect() {
    for disconnected in [false, true] {
        let (_temporary, session, mut staged, params) = setup();
        let retained = retain_draft_attachments(&session, &params, &mut staged).unwrap();
        let path = PathBuf::from(&retained.drafts[0].path);
        let prompt = format!(
            "<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
            serde_json::json!({"filename":"draft.txt","path":path})
        );
        let (_, mut lease) = prepare_steer_model_input(
            &session.join("attachments"),
            "thread-a",
            "turn-a",
            &prompt,
            &mut staged,
            false,
        )
        .unwrap();
        let history = lease.directory.clone().unwrap();
        lease.commit_staged(&mut staged).unwrap();
        if disconnected {
            drop(staged);
            staged = AttachmentDirectories::default();
        }
        let root = PrivateDirectory::open_existing(&session.join("draft-attachments")).unwrap();
        let transaction = lock(&root, "transaction.lock").unwrap();
        assert!(lease.settle(true).is_err());
        drop(transaction);

        let next = attachment_save(
            "thread-a",
            &AttachmentSaveParams {
                filename: "next.txt".into(),
                content_base64: "aGVsbG8=".into(),
                retention: None,
            },
            &mut staged,
        )
        .unwrap();
        retain_draft_attachments(
            &session,
            &AttachmentDraftRetainParams {
                paths: vec![next.path],
                ..params
            },
            &mut staged,
        )
        .unwrap();
        assert!(
            !path.exists(),
            "the next writer must reclaim the released draft"
        );
        assert_eq!(
            std::fs::read(history.join("00-draft.txt")).unwrap(),
            b"hello"
        );
    }
}

#[test]
fn failed_confirmed_cleanup_does_not_skip_other_owned_attachments() {
    for steering in [false, true] {
        let (_temporary, session, mut staged, mut params) = setup();
        let next = attachment_save(
            "thread-a",
            &AttachmentSaveParams {
                filename: "second.txt".into(),
                content_base64: "aGVsbG8=".into(),
                retention: None,
            },
            &mut staged,
        )
        .unwrap();
        params.paths.push(next.path);
        let retained = retain_draft_attachments(&session, &params, &mut staged).unwrap();
        let records = retained.drafts.iter().map(|draft| {
            serde_json::json!({"filename":Path::new(&draft.path).file_name().unwrap().to_str().unwrap(),"path":draft.path}).to_string()
        }).collect::<Vec<_>>().join("\n");
        let prompt =
            format!("<kcoder_attachments version=\"1\">\n{records}\n</kcoder_attachments>");
        let lease = if steering {
            let (_, mut lease) = prepare_steer_model_input(
                &session.join("attachments"),
                "thread-a",
                "turn-a",
                &prompt,
                &mut staged,
                false,
            )
            .unwrap();
            lease.commit_staged(&mut staged).unwrap();
            Some(lease)
        } else {
            materialize_turn_attachments(
                &session.join("attachments"),
                "thread-a",
                "turn-a",
                &prompt,
                &mut staged,
            )
            .unwrap();
            None
        };
        let first = if steering {
            PathBuf::from(&retained.drafts[0].path)
        } else {
            staged.drafts.keys().next().unwrap().clone()
        };
        let second = retained
            .drafts
            .iter()
            .find(|draft| Path::new(&draft.path) != first)
            .unwrap();
        std::fs::write(
            first.parent().unwrap().parent().unwrap().join(RECORD),
            b"invalid",
        )
        .unwrap();
        let result = if let Some(lease) = lease {
            lease.settle(true)
        } else {
            staged.commit_draft_turn("thread-a", "turn-a")
        };
        assert!(result.is_err());
        assert!(first.exists(), "an invalid record must still fail closed");
        assert!(
            !Path::new(&second.path).exists(),
            "an independent draft must still be released"
        );
    }
}

#[test]
fn a_writer_skips_released_drafts_still_held_by_their_owner() {
    let (_temporary, session, mut staged, mut params) = setup();
    let retained = retain_draft_attachments(&session, &params, &mut staged).unwrap();
    let path = PathBuf::from(&retained.drafts[0].path);
    let directory =
        PrivateDirectory::open_existing(path.parent().unwrap().parent().unwrap()).unwrap();
    let mut record = read_record(&directory).unwrap();
    record.released = true;
    directory
        .atomic_replace(OsStr::new(RECORD), &serde_json::to_vec(&record).unwrap())
        .unwrap();
    drop(directory);
    let next = attachment_save(
        "thread-a",
        &AttachmentSaveParams {
            filename: "next.txt".into(),
            content_base64: "aGVsbG8=".into(),
            retention: None,
        },
        &mut staged,
    )
    .unwrap();
    params.paths = vec![next.path];
    retain_draft_attachments(&session, &params, &mut staged).unwrap();
    assert!(
        path.exists(),
        "a writer cannot bypass the active owner lease"
    );
    staged.drafts.get_mut(&path).unwrap().remove().unwrap();
    assert!(!path.exists());
}
