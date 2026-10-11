mod workspace_revision_tests {
    use super::*;
    use base64::Engine as _;
    use kcoder_app_protocol::{WORKSPACE_FILE_CHANGED, WorkspaceFileChunkResult};
    use std::io::{Seek, SeekFrom, Write};

    fn request(
        parent: &Path,
        name: &str,
        offset: u64,
        expected: Option<&str>,
    ) -> DeviceExecuteParams {
        let mut wire = json!({
            "command_key": "workspace_read_file_chunk",
            "path": parent,
            "args": [name, offset.to_string()],
        });
        if let Some(expected) = expected {
            wire["expected_revision"] = json!(expected);
        }
        serde_json::from_value(wire).unwrap()
    }

    async fn chunk(
        root: &Path,
        parent: &Path,
        name: &str,
        offset: u64,
        expected: Option<&str>,
    ) -> anyhow::Result<WorkspaceFileChunkResult> {
        let response = device_execute(root, &request(parent, name, offset, expected)).await?;
        assert!(response.success, "{}", response.stderr);
        Ok(serde_json::from_value(response.stdout)?)
    }

    fn bytes(chunk: &WorkspaceFileChunkResult) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(&chunk.content_base64)
            .unwrap()
    }

    async fn assert_changed(root: &Path, name: &str, offset: u64, old_revision: &str) {
        let error = chunk(root, root, name, offset, Some(old_revision))
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains(WORKSPACE_FILE_CHANGED),
            "{error:#}"
        );
    }

    #[tokio::test]
    async fn stable_file_two_chunks_keep_revision_and_accept_legacy_request() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path();
        let original: Vec<_> = (0..(1024 * 1024 + 37))
            .map(|index| (index % 251) as u8)
            .collect();
        std::fs::write(root.join("large.bin"), &original).unwrap();
        assert!(
            request(root, "large.bin", 0, None)
                .expected_revision
                .is_none()
        );
        let first = chunk(root, root, "large.bin", 0, None).await.unwrap();
        assert_eq!(first.offset, 0);
        assert!(!first.eof);
        assert_eq!(first.size, original.len() as u64);
        assert!(first.revision.starts_with("file-v1:"));
        #[cfg(unix)]
        {
            use sha2::Digest as _;
            use std::os::unix::fs::MetadataExt;
            let metadata = std::fs::metadata(root.join("large.bin")).unwrap();
            let old_stamp = format!(
                "{}:{}:{}:{}:{}:{}",
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
                metadata
                    .modified()
                    .unwrap()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                metadata.len(),
            );
            assert_eq!(
                first.revision,
                format!("file-v1:{:x}", sha2::Sha256::digest(old_stamp.as_bytes())),
                "normal positive-time revisions must stay byte-for-byte compatible"
            );
        }
        let mut combined = bytes(&first);
        let second = chunk(
            root,
            root,
            "large.bin",
            combined.len() as u64,
            Some(&first.revision),
        )
        .await
        .unwrap();
        assert_eq!(second.offset, combined.len() as u64);
        assert_eq!(second.revision, first.revision);
        assert_eq!(second.size, first.size);
        assert_eq!(second.modified_at, first.modified_at);
        assert!(second.eof);
        combined.extend(bytes(&second));
        assert_eq!(combined, original);
        assert_changed(root, "large.bin", 0, "file-v1:wrong").await;
    }

    #[tokio::test]
    async fn preepoch_mtime_supports_two_chunks_with_a_stable_revision() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path();
        let path = root.join("historic.bin");
        let mut original = vec![0; 1024 * 1024 + 8];
        original[1024 * 1024..].copy_from_slice(b"historic");
        std::fs::write(&path, &original).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH - Duration::new(60, 987_654_300))
            .unwrap();
        assert!(std::fs::metadata(&path).unwrap().modified().unwrap() < std::time::UNIX_EPOCH);

        let first = chunk(root, root, "historic.bin", 0, None).await.unwrap();
        assert!(!first.eof);
        assert_eq!(
            first.modified_at, None,
            "legacy optional mtime stays unchanged"
        );
        let mut combined = bytes(&first);
        let second = chunk(
            root,
            root,
            "historic.bin",
            combined.len() as u64,
            Some(&first.revision),
        )
        .await
        .unwrap();
        assert_eq!(second.revision, first.revision);
        assert_eq!(second.modified_at, None);
        assert!(second.eof);
        combined.extend(bytes(&second));
        assert_eq!(combined, original);
    }

    #[tokio::test]
    async fn preepoch_mtime_restore_after_same_size_edit_still_rejects_old_revision() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path();
        let path = root.join("historic-edited.bin");
        let mut original = vec![0; 1024 * 1024 + 8];
        original[1024 * 1024..].copy_from_slice(b"original");
        std::fs::write(&path, &original).unwrap();
        let mut file = std::fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(std::time::UNIX_EPOCH - Duration::new(60, 987_654_300))
            .unwrap();
        let historic_mtime = file.metadata().unwrap().modified().unwrap();
        assert!(historic_mtime < std::time::UNIX_EPOCH);
        let first = chunk(root, root, "historic-edited.bin", 0, None)
            .await
            .unwrap();
        assert!(!first.eof);
        let offset = bytes(&first).len() as u64;
        std::thread::sleep(Duration::from_millis(2));
        file.seek(SeekFrom::Start(offset)).unwrap();
        file.write_all(b"modified").unwrap();
        file.sync_all().unwrap();
        file.set_modified(historic_mtime).unwrap();
        assert_eq!(file.metadata().unwrap().modified().unwrap(), historic_mtime);
        drop(file);

        assert_changed(root, "historic-edited.bin", offset, &first.revision).await;
        let fresh = chunk(root, root, "historic-edited.bin", offset, None)
            .await
            .unwrap();
        assert_eq!(fresh.size, first.size);
        assert_eq!(first.modified_at, None);
        assert_eq!(fresh.modified_at, None);
        assert_ne!(fresh.revision, first.revision);
        assert_eq!(bytes(&fresh), b"modified");
    }

    #[tokio::test]
    async fn same_size_in_place_edit_with_restored_mtime_rejects_old_revision() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path();
        let path = root.join("in-place.bin");
        let mut initial = vec![0; 1024 * 1024 + 8];
        initial[1024 * 1024..].copy_from_slice(b"original");
        std::fs::write(&path, &initial).unwrap();
        let original = std::fs::metadata(&path).unwrap();
        let before = chunk(root, root, "in-place.bin", 0, None).await.unwrap();
        assert!(!before.eof);
        let next_offset = bytes(&before).len() as u64;
        std::thread::sleep(Duration::from_millis(2));
        let mut file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start(next_offset)).unwrap();
        file.write_all(b"modified").unwrap();
        file.sync_all().unwrap();
        file.set_modified(original.modified().unwrap()).unwrap();
        drop(file);

        let after = chunk(root, root, "in-place.bin", next_offset, None)
            .await
            .unwrap();
        // The old preview identity (size + millisecond mtime) cannot distinguish these files.
        assert_eq!(after.size, before.size);
        assert_eq!(after.modified_at, before.modified_at);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            original.modified().unwrap()
        );
        assert_ne!(after.revision, before.revision);
        assert_eq!(bytes(&after), b"modified");
        assert_changed(root, "in-place.bin", next_offset, &before.revision).await;
    }

    #[tokio::test]
    async fn atomic_replacement_with_same_size_and_mtime_rejects_old_revision() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path();
        let path = root.join("replaced.bin");
        let mut initial = vec![0; 1024 * 1024 + 8];
        initial[1024 * 1024..].copy_from_slice(b"original");
        std::fs::write(&path, &initial).unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let before = chunk(root, root, "replaced.bin", 0, None).await.unwrap();
        assert!(!before.eof);
        let next_offset = bytes(&before).len() as u64;
        let mut replacement = tempfile::NamedTempFile::new_in(root).unwrap();
        initial[1024 * 1024..].copy_from_slice(b"replaced");
        replacement.write_all(&initial).unwrap();
        replacement.as_file().sync_all().unwrap();
        replacement.as_file().set_modified(modified).unwrap();
        replacement.persist(&path).unwrap();

        let after = chunk(root, root, "replaced.bin", next_offset, None)
            .await
            .unwrap();
        assert_eq!(after.size, before.size);
        assert_eq!(after.modified_at, before.modified_at);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            modified
        );
        assert_ne!(after.revision, before.revision);
        assert_eq!(bytes(&after), b"replaced");
        assert_changed(root, "replaced.bin", next_offset, &before.revision).await;
    }

    #[tokio::test]
    async fn regular_hard_links_remain_readable_with_the_same_file_revision() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path();
        std::fs::write(root.join("original.bin"), [0, 255, 32, 128]).unwrap();
        std::fs::hard_link(root.join("original.bin"), root.join("alias.bin")).unwrap();
        let original = chunk(root, root, "original.bin", 0, None).await.unwrap();
        let alias = chunk(root, root, "alias.bin", 0, Some(&original.revision))
            .await
            .unwrap();
        assert_eq!(alias.name, "alias.bin");
        assert_eq!(alias.revision, original.revision);
        assert_eq!(bytes(&alias), bytes(&original));
    }

    #[tokio::test]
    async fn file_revision_does_not_bypass_workspace_and_filename_boundaries() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = workspace.path();
        std::fs::write(root.join("inside.bin"), b"inside").unwrap();
        std::fs::write(outside.path().join("outside.bin"), b"outside").unwrap();
        let inside = chunk(root, root, "inside.bin", 0, None).await.unwrap();
        let error = chunk(
            root,
            outside.path(),
            "outside.bin",
            0,
            Some(&inside.revision),
        )
        .await
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("outside the configured workspace")
        );
        let error = chunk(root, root, "../outside.bin", 0, Some(&inside.revision))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("filename is invalid"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_stay_within_workspace_even_with_a_file_revision() {
        use std::os::unix::fs::symlink;
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = workspace.path();
        std::fs::write(root.join("inside.bin"), b"inside").unwrap();
        std::fs::write(outside.path().join("outside.bin"), b"outside").unwrap();
        symlink(root.join("inside.bin"), root.join("inside-link.bin")).unwrap();
        symlink(
            outside.path().join("outside.bin"),
            root.join("outside-link.bin"),
        )
        .unwrap();
        symlink(outside.path(), root.join("outside-dir")).unwrap();
        let inside = chunk(root, root, "inside.bin", 0, None).await.unwrap();
        let linked = chunk(root, root, "inside-link.bin", 0, Some(&inside.revision))
            .await
            .unwrap();
        assert_eq!(bytes(&linked), b"inside");
        assert_eq!(linked.revision, inside.revision);
        for (parent, name) in [
            (root.to_path_buf(), "outside-link.bin"),
            (root.join("outside-dir"), "outside.bin"),
        ] {
            let error = chunk(root, &parent, name, 0, Some(&inside.revision))
                .await
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("outside the configured workspace")
            );
        }
    }
}
