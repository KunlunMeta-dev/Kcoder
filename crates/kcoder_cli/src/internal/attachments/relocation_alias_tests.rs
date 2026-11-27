use super::*;

#[test]
fn relocating_existing_files_keeps_birth_addresses_without_adding_intermediate_roots() {
    let owned = tempfile::tempdir().unwrap();
    let initial = owned.path().join("initial/data/session-a");
    let attachments =
        PrivateDirectory::open_or_create(&initial.join("attachments/turn-a")).unwrap();
    attachments
        .atomic_replace(OsStr::new("original.txt"), b"original attachment")
        .unwrap();
    drop(attachments);
    let original_address = initial.join("attachments/turn-a/original.txt");
    let original_alias = original_address.canonicalize().unwrap();
    let mut source = initial;
    let mut later_address: Option<PathBuf> = None;
    for round in 1..=3 {
        let target = owned.path().join(format!("round-{round}/data/session-a"));
        std::fs::create_dir_all(target.parent().unwrap().parent().unwrap()).unwrap();
        let snapshot = relocation_snapshot(&source, "thread-a").unwrap();
        let operation = format!("owned-address-move-{round}");
        let (mut coordinator, published) = tests::publish(
            source.parent().unwrap(),
            target.parent().unwrap(),
            &operation,
        );
        relocate(&source, &target, &operation, &snapshot, &published).unwrap();
        let receipt: RelocationReceipt =
            serde_json::from_slice(&receipt_bytes(&target).unwrap().unwrap()).unwrap();
        assert_eq!(receipt.aliases.len(), if round == 1 { 1 } else { 2 });
        assert_eq!(
            receipt.aliases.get(&original_alias),
            Some(&PathBuf::from("attachments/turn-a/original.txt"))
        );
        if round > 1 {
            assert!(
                alias_destination(
                    &receipt.aliases,
                    &source.join("attachments/turn-a/original.txt")
                )
                .is_none(),
                "moving an unchanged attachment must not generate another stored address"
            );
            assert!(alias_destination(&receipt.aliases, later_address.as_ref().unwrap()).is_some());
        }
        assert_eq!(
            resolve_session_path(&target, &original_address).unwrap(),
            Some(
                target
                    .join("attachments/turn-a/original.txt")
                    .canonicalize()
                    .unwrap()
            )
        );
        for (before, after) in [
            (
                kcoder_types::StorageMigrationPhase::Copying,
                kcoder_types::StorageMigrationPhase::Verifying,
            ),
            (
                kcoder_types::StorageMigrationPhase::Verifying,
                kcoder_types::StorageMigrationPhase::Prepared,
            ),
        ] {
            coordinator.advance(&operation, before, after).unwrap();
        }
        coordinator.commit(&operation).unwrap();
        coordinator.complete(&operation).unwrap();
        drop(coordinator);
        drop(published);
        std::fs::remove_dir_all(source.parent().unwrap()).unwrap();
        assert!(!source.exists());
        // Old roots are unavailable: every historical address must resolve
        // solely through this session's bounded receipt and current file guard.
        for (address, bytes) in
            std::iter::once((&original_address, b"original attachment".as_slice())).chain(
                later_address
                    .as_ref()
                    .map(|address| (address, b"new business data after first move".as_slice())),
            )
        {
            RECEIPT_READS.set(0);
            let read = attachment_read(
                &target.join("attachments"),
                &AttachmentReadParams {
                    thread_id: "thread-a".into(),
                    path: address.to_string_lossy().into_owned(),
                },
                &AttachmentDirectories::default(),
            )
            .unwrap();
            assert_eq!(RECEIPT_READS.get(), 1, "one read per attachment request");
            assert_eq!(
                base64::engine::general_purpose::STANDARD
                    .decode(read.content_base64)
                    .unwrap(),
                bytes
            );
            RECEIPT_READS.set(0);
            let chunk = attachment_read_chunk(
                &target.join("attachments"),
                &AttachmentReadChunkParams {
                    thread_id: "thread-a".into(),
                    path: address.to_string_lossy().into_owned(),
                    offset: 0,
                    length: bytes.len() as u32,
                },
                &AttachmentDirectories::default(),
            )
            .unwrap();
            assert_eq!(RECEIPT_READS.get(), 1, "one read per download chunk");
            assert_eq!(
                base64::engine::general_purpose::STANDARD
                    .decode(chunk.content_base64)
                    .unwrap(),
                bytes
            );
        }
        let upload_address = owned.path().join("consumed-upload.txt");
        let mut staged = AttachmentDirectories::default();
        staged
            .persisted_aliases
            .insert(upload_address.clone(), original_address.clone());
        RECEIPT_READS.set(0);
        let read = attachment_read(
            &target.join("attachments"),
            &AttachmentReadParams {
                thread_id: "thread-a".into(),
                path: upload_address.to_string_lossy().into_owned(),
            },
            &staged,
        )
        .unwrap();
        assert_eq!(
            RECEIPT_READS.get(),
            2,
            "a different staged alias still resolves"
        );
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(read.content_base64)
                .unwrap(),
            b"original attachment"
        );
        if round == 1 {
            let birth = target.join("attachments/turn-b");
            let directory = PrivateDirectory::open_or_create(&birth).unwrap();
            directory
                .atomic_replace(OsStr::new("new.txt"), b"new business data after first move")
                .unwrap();
            later_address = Some(birth.join("new.txt"));
        }
        source = target;
    }
}

#[cfg(windows)]
#[test]
fn windows_birth_addresses_find_canonical_dos_alias_without_reinterpreting_names() {
    let relative = PathBuf::from(r"attachments\turn-a\original.txt");
    for (recorded, requested) in [
        (
            r"\\?\C:\missing-source\session-a\attachments\turn-a\original.txt",
            r"C:\missing-source\session-a\attachments\turn-a\original.txt",
        ),
        (
            r"\\?\C:\missing-source\session-a\attachments\turn-a\original.txt",
            r"C:/missing-source/session-a/attachments/turn-a/original.txt",
        ),
    ] {
        let aliases = BTreeMap::from([(PathBuf::from(recorded), relative.clone())]);
        assert_eq!(
            alias_destination(&aliases, Path::new(requested)),
            Some(&relative)
        );
        assert_eq!(aliases.len(), 1, "lookup must not add an alias");
    }
    let aliases = BTreeMap::from([(
        PathBuf::from(r"\\?\C:\missing-source\session-a\attachments\turn-a\original.txt"),
        relative,
    )]);
    for foreign in [
        r"D:\missing-source\session-a\attachments\turn-a\original.txt",
        r"C:\missing-source-peer\session-a\attachments\turn-a\original.txt",
        r"\\server\other\missing-source\session-a\attachments\turn-a\original.txt",
        r"C:missing-source\session-a\attachments\turn-a\original.txt",
    ] {
        assert!(alias_destination(&aliases, Path::new(foreign)).is_none());
    }
    let long = format!(r"C:\missing-source\{}\original.txt", r"part\".repeat(80));
    let destination = PathBuf::from(r"attachments\turn-a\long.txt");
    let aliases = BTreeMap::from([(PathBuf::from(format!(r"\\?\{long}")), destination.clone())]);
    assert_eq!(
        alias_destination(&aliases, Path::new(&long)),
        Some(&destination)
    );
    for name in [
        "NUL.txt",
        "coM1.txt",
        "LPT¹.log",
        "CON .txt",
        "CONIN$",
        "trailing.",
        "trailing ",
        "original.txt:stream",
    ] {
        let ordinary = PathBuf::from(format!(r"C:\missing-source\{name}"));
        let canonical = PathBuf::from(format!(r"\\?\{}", ordinary.display()));
        let aliases = BTreeMap::from([(canonical.clone(), destination.clone())]);
        assert!(alias_destination(&aliases, &ordinary).is_none(), "{name}");
        assert_eq!(
            alias_destination(&aliases, &canonical),
            Some(&destination),
            "exact extended names retain their meaning"
        );
    }
}
