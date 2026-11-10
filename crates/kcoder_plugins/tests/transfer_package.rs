use kcoder_config::PrivateDirectory;
use kcoder_plugins::{
    InstallLimits, PluginCancellationToken,
    migration::{
        estimate_transfer_package, materialize_transfer_package, package_revision,
        write_transfer_package,
    },
};
use std::{
    io::{Cursor, Write},
    path::Path,
};
fn source(root: &Path) {
    std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
    std::fs::create_dir(root.join("empty")).unwrap();
    std::fs::write(
        root.join(".claude-plugin/plugin.json"),
        r#"{"name":"sample","version":"1.0.0"}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("原文.txt"),
        "Source notes, never runtime commands.",
    )
    .unwrap();
    std::fs::write(root.join("data.bin"), vec![42; 256 * 1024]).unwrap();
}
fn empty(root: &Path) {
    PrivateDirectory::open_or_create(root).unwrap();
}
fn archive(entries: &[(&str, tar::EntryType, &[u8])]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (path, kind, bytes) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o600);
        header.set_entry_type(*kind);
        if kind.is_symlink() || kind.is_hard_link() {
            header.set_link_name("outside").unwrap();
        }
        if path.starts_with("../") || path.contains('\\') {
            let name = &mut header.as_mut_bytes()[..100];
            name[..path.len()].copy_from_slice(path.as_bytes());
        } else {
            header.set_path(path).unwrap();
        }
        header.set_cksum();
        builder.append(&header, *bytes).unwrap();
    }
    builder.into_inner().unwrap()
}
#[test]
fn bounded_static_package_roundtrip_preserves_bytes_empty_directories_and_executable_provenance() {
    let temp = tempfile::tempdir().unwrap();
    let src = temp.path().join("source");
    let dst = temp.path().join("owned");
    source(&src);
    empty(&dst);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(src.join("data.bin"), std::fs::Permissions::from_mode(0o700))
            .unwrap();
    }
    std::fs::write(
        src.join("long-name-".to_owned() + &"a".repeat(180)),
        "bounded GNU metadata",
    )
    .unwrap();
    let token = PluginCancellationToken::default();
    let limits = InstallLimits::default();
    let mut bytes = Vec::new();
    let original = write_transfer_package(&src, &mut bytes, limits, &token).unwrap();
    let materialized =
        materialize_transfer_package(&mut Cursor::new(&bytes), &dst, limits, &token).unwrap();
    assert!(original == materialized);
    assert!(dst.join("empty").is_dir());
    assert_eq!(
        std::fs::read(src.join("data.bin")).unwrap(),
        std::fs::read(dst.join("data.bin")).unwrap()
    );
    assert!(package_revision(&src, limits, &token).unwrap() == original);
}
#[test]
fn transfer_container_rejects_links_escapes_private_components_duplicates_and_trailing_payload() {
    for (label, bytes) in [
        (
            "symlink",
            archive(&[("link", tar::EntryType::Symlink, &[])]),
        ),
        ("hardlink", archive(&[("link", tar::EntryType::Link, &[])])),
        (
            "backslash-wire-path",
            archive(&[(
                r"skills\inspect\SKILL.md",
                tar::EntryType::Regular,
                b"blocked",
            )]),
        ),
        (
            "escape",
            archive(&[("../outside", tar::EntryType::Regular, b"blocked")]),
        ),
        (
            "private",
            archive(&[("auth.json", tar::EntryType::Regular, b"private")]),
        ),
        (
            "drive",
            archive(&[("C:outside", tar::EntryType::Regular, b"blocked")]),
        ),
        (
            "duplicate",
            archive(&[
                ("a", tar::EntryType::Regular, b"first"),
                ("a", tar::EntryType::Regular, b"second"),
            ]),
        ),
        (
            "case-alias",
            archive(&[
                ("A", tar::EntryType::Regular, b"first"),
                ("a", tar::EntryType::Regular, b"second"),
            ]),
        ),
        ("trailing", {
            let mut value = archive(&[("a", tar::EntryType::Regular, b"valid")]);
            value.extend_from_slice(b"unexpected");
            value
        }),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let dst = temp.path().join("owned");
        empty(&dst);
        std::fs::write(temp.path().join("outside"), b"peer").unwrap();
        assert!(
            materialize_transfer_package(
                &mut Cursor::new(bytes),
                &dst,
                InstallLimits::default(),
                &PluginCancellationToken::default()
            )
            .is_err(),
            "{label}"
        );
        assert_eq!(std::fs::read(temp.path().join("outside")).unwrap(), b"peer");
    }
}
#[test]
fn package_writes_never_consume_private_source_files_or_reuse_existing_destination() {
    let temp = tempfile::tempdir().unwrap();
    let src = temp.path().join("source");
    source(&src);
    std::fs::write(src.join(".env.secret"), b"owned synthetic secret").unwrap();
    let mut output = Vec::new();
    assert!(
        write_transfer_package(
            &src,
            &mut output,
            InstallLimits::default(),
            &PluginCancellationToken::default()
        )
        .is_err()
    );
    assert!(output.is_empty());
    let dst = temp.path().join("owned");
    empty(&dst);
    std::fs::write(dst.join("peer"), b"preserve").unwrap();
    assert!(
        materialize_transfer_package(
            &mut Cursor::new(archive(&[("a", tar::EntryType::Regular, b"bytes")])),
            &dst,
            InstallLimits::default(),
            &PluginCancellationToken::default()
        )
        .is_err()
    );
    assert_eq!(std::fs::read(dst.join("peer")).unwrap(), b"preserve");
}
#[test]
fn cancellation_and_byte_limits_never_produce_a_success_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let src = temp.path().join("source");
    let dst = temp.path().join("owned");
    source(&src);
    empty(&dst);
    let token = PluginCancellationToken::default();
    token.cancel();
    let mut bytes = Vec::new();
    assert!(write_transfer_package(&src, &mut bytes, InstallLimits::default(), &token).is_err());
    assert!(bytes.is_empty());
    let limits = InstallLimits {
        max_file_bytes: 3,
        ..Default::default()
    };
    assert!(
        materialize_transfer_package(
            &mut Cursor::new(archive(&[("a", tar::EntryType::Regular, b"too large")])),
            &dst,
            limits,
            &PluginCancellationToken::default()
        )
        .is_err()
    );
    assert!(!dst.join("a").exists());
    struct CancelWriter<'a> {
        token: &'a PluginCancellationToken,
    }
    impl Write for CancelWriter<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.token.cancel();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let token = PluginCancellationToken::default();
    assert!(
        write_transfer_package(
            &src,
            &mut CancelWriter { token: &token },
            InstallLimits::default(),
            &token
        )
        .is_err()
    );
}

#[test]
fn oversized_tar_metadata_is_rejected_before_reading_or_allocating_its_body() {
    use std::io::Read;
    for kind in [tar::EntryType::GNULongName, tar::EntryType::XHeader] {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("owned");
        empty(&destination);
        let mut header = tar::Header::new_gnu();
        header.set_path("metadata").unwrap();
        header.set_entry_type(kind);
        header.set_size(512 * 1024 * 1024);
        header.set_mode(0o600);
        header.set_cksum();
        struct HeaderOnly<'a> {
            bytes: Cursor<&'a [u8]>,
            touched_body: bool,
        }
        impl Read for HeaderOnly<'_> {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                if self.bytes.position() == 512 {
                    self.touched_body = true;
                    return Err(std::io::Error::other("body must not be accessed"));
                }
                self.bytes.read(out)
            }
        }
        let mut input = HeaderOnly {
            bytes: Cursor::new(&header.as_bytes()[..]),
            touched_body: false,
        };
        assert!(
            materialize_transfer_package(
                &mut input,
                &destination,
                InstallLimits::default(),
                &PluginCancellationToken::default()
            )
            .is_err()
        );
        assert!(!input.touched_body);
    }
}

#[test]
fn transient_source_changes_cannot_publish_different_archive_bytes_under_the_original_revision() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    source(&root);
    let token = PluginCancellationToken::default();
    let limits = InstallLimits::default();
    let original = package_revision(&root, limits, &token).unwrap();
    struct ChangeAndRestore {
        path: std::path::PathBuf,
        changed: bool,
        restored: bool,
    }
    impl Write for ChangeAndRestore {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if !self.changed && bytes.len() == 512 && bytes.starts_with(b"data.bin\0") {
                std::fs::write(&self.path, vec![43; 256 * 1024])?;
                self.changed = true;
            } else if self.changed && !self.restored {
                std::fs::write(&self.path, vec![42; 256 * 1024])?;
                self.restored = true;
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = ChangeAndRestore {
        path: root.join("data.bin"),
        changed: false,
        restored: false,
    };
    let result = write_transfer_package(&root, &mut writer, limits, &token);
    assert!(writer.changed && writer.restored);
    assert!(
        package_revision(&root, limits, &token).unwrap() == original,
        "the original source bytes were restored before the final source check"
    );
    assert!(
        result.is_err(),
        "the streamed package proof must cover actual emitted bytes, not just before/after source snapshots"
    );
}

#[test]
fn package_revision_framing_remains_compatible_with_existing_receipts() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("a"), b"x").unwrap();
    std::fs::create_dir(temp.path().join("z")).unwrap();
    let revision = package_revision(
        temp.path(),
        InstallLimits::default(),
        &PluginCancellationToken::default(),
    )
    .unwrap();
    assert_eq!(
        revision.sha256,
        "2191f9abb01bcc60c62e9c11157c3b3d17c0a02a0b2f8600df6afedcae270b3a"
    );
}

#[test]
fn metadata_reservation_bounds_the_stream_without_reducing_the_store_depth_contract() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    source(&root);
    let limits = InstallLimits {
        max_depth: 1,
        ..Default::default()
    };
    let token = PluginCancellationToken::default();
    let estimate =
        kcoder_plugins::migration::estimate_transfer_package(&root, limits, &token).unwrap();
    let mut bytes = Vec::new();
    write_transfer_package(&root, &mut bytes, limits, &token).unwrap();
    assert!(bytes.len() as u64 <= estimate.bytes);
    let destination = temp.path().join("owned");
    empty(&destination);
    materialize_transfer_package(&mut Cursor::new(&bytes), &destination, limits, &token).unwrap();
    std::fs::write(root.join("new-file"), b"new").unwrap();
    let changed =
        kcoder_plugins::migration::estimate_transfer_package(&root, limits, &token).unwrap();
    assert_ne!(estimate.metadata_sha256, changed.metadata_sha256);
}

#[test]
fn nested_native_plugin_paths_can_be_estimated_packed_and_received() {
    let temp = tempfile::tempdir().unwrap();
    let src = temp.path().join("source");
    let dst = temp.path().join("received");
    source(&src);
    std::fs::create_dir_all(src.join("skills").join("inspect")).unwrap();
    std::fs::write(
        src.join("skills").join("inspect").join("SKILL.md"),
        "Static instructions.",
    )
    .unwrap();
    empty(&dst);
    let limits = InstallLimits::default();
    let token = PluginCancellationToken::default();
    let estimate = estimate_transfer_package(&src, limits, &token).unwrap();
    let mut bytes = Vec::new();
    let revision = write_transfer_package(&src, &mut bytes, limits, &token).unwrap();
    assert!(estimate.bytes >= bytes.len() as u64);
    let received =
        materialize_transfer_package(&mut Cursor::new(bytes), &dst, limits, &token).unwrap();
    assert!(revision == received);
    assert_eq!(
        std::fs::read(dst.join("skills").join("inspect").join("SKILL.md")).unwrap(),
        b"Static instructions."
    );
}
