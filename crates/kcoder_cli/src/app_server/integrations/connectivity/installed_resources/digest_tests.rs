//! Launch digest integrity and the separate live-owner verification boundary.
use super::*;
use std::io::{Seek, SeekFrom, Write};
use std::time::Instant;

#[test]
fn hardware_digest_matches_sha2_at_empty_block_chunk_and_large_boundaries() -> Result<()> {
    for length in [0, 1, 63, 64, 65, 65535, 65536, 65537, 4 * 1024 * 1024 + 17] {
        let bytes: Vec<u8> = (0..length)
            .map(|index| ((index * 31 + 7) % 251) as u8)
            .collect();
        let mut file = tempfile::tempfile()?;
        file.write_all(&bytes)?;
        file.seek(SeekFrom::Start(0))?;
        assert_eq!(
            digest(&mut file, length as u64, &CancellationToken::new(), None)?,
            format!("{:x}", Sha256::digest(&bytes)),
            "length={length}"
        );
        let mut split = ring::digest::Context::new(&ring::digest::SHA256);
        for part in bytes.chunks(17) {
            split.update(part);
        }
        assert_eq!(split.finish().as_ref(), Sha256::digest(&bytes).as_slice());
    }
    Ok(())
}
#[test]
fn digest_preserves_cancel_size_and_cross_chunk_runtime_fuse_denials() -> Result<()> {
    let mut file = tempfile::tempfile()?;
    file.write_all(b"original")?;
    file.seek(SeekFrom::Start(0))?;
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(digest(&mut file, 8, &cancel, None).is_err());
    file.seek(SeekFrom::Start(0))?;
    assert!(digest(&mut file, 9, &CancellationToken::new(), None).is_err());
    let mut bytes = vec![0; 65530];
    bytes.extend_from_slice(b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
    bytes.extend_from_slice(&[1, 1, 49, 0]);
    let mut file = tempfile::tempfile()?;
    file.write_all(&bytes)?;
    file.seek(SeekFrom::Start(0))?;
    assert!(
        digest(
            &mut file,
            bytes.len() as u64,
            &CancellationToken::new(),
            Some("standalone_node")
        )
        .is_err()
    );
    file.seek(SeekFrom::Start(0))?;
    assert_eq!(
        digest(
            &mut file,
            bytes.len() as u64,
            &CancellationToken::new(),
            Some("electron_as_node")
        )?,
        format!("{:x}", Sha256::digest(&bytes))
    );
    Ok(())
}

pub(crate) fn benchmark_node_digest(node: &Path) -> Result<()> {
    let size = std::fs::metadata(node)?.len();
    let mut file = File::open(node)?;
    let start = Instant::now();
    let mut reference = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        reference.update(&buffer[..count]);
    }
    let old = start.elapsed();
    let expected = format!("{:x}", reference.finalize());
    let mut file = File::open(node)?;
    let start = Instant::now();
    let actual = digest(&mut file, size, &CancellationToken::new(), None)?;
    let new = start.elapsed();
    ensure!(actual == expected, "ACTUAL_NODE_FULL_DIGEST_CHANGED");
    eprintln!(
        "actual Node bytewise SHA256 equivalence: bytes={size} sha2_ms={} ring_ms={} every_byte_each_use=true",
        old.as_millis(),
        new.as_millis()
    );
    Ok(())
}

#[tokio::test]
async fn complete_resource_guard_rejects_changed_bytes_atomic_source_and_runtime_replacement()
-> Result<()> {
    let native =
        crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
    let parent = native.profile.parent().unwrap();
    let component = parent.join("sealed-resource-negative-fixture");
    std::fs::create_dir(&component)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&component, std::fs::Permissions::from_mode(0o700))?;
    }
    let source_root = component.join("src");
    let source = source_root.join("applications");
    let licenses = component.join("licenses");
    std::fs::create_dir(&source_root)?;
    std::fs::create_dir(&source)?;
    std::fs::create_dir(&licenses)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for directory in [&source_root, &source, &licenses] {
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    let entries = [
        ("package.json", b"declared package fixture".as_slice()),
        ("package-lock.json", b"declared lock fixture".as_slice()),
        (
            "src/applications/stdio.mjs",
            b"original source bytes".as_slice(),
        ),
        ("licenses/LICENSE.txt", b"declared legal fixture".as_slice()),
    ];
    let mut files = Vec::new();
    let mut total = 0;
    for (path, bytes) in entries {
        std::fs::write(component.join(path), bytes)?;
        files.push(serde_json::json!({"path":path,"bytes":bytes.len(),"sha256":hex(bytes)}));
        total += bytes.len();
    }
    let manifest = serde_json::to_vec(
        &serde_json::json!({"schemaVersion":1,"name":"@kunlunmeta/kcoder-channel-host","version":"0.1.0",
        "nodeMinimumMajor":22,"entry":"src/applications/stdio.mjs","lockSha256":hex(b"declared lock fixture"),"files":files,"totalBytes":total}),
    )?;
    std::fs::write(component.join(MANIFEST), &manifest)?;
    // An unexecuted byte fixture isolates identity checks; it is not a Node runtime acceptance.
    let node = parent.join("unexecuted-runtime-bytes");
    let node_bytes = b"original unexecuted runtime bytes";
    std::fs::write(&node, node_bytes)?;
    let root = PrivateDirectory::open_existing(&component)?;
    let lease = NativeConnectivityResourceLease {
        context: native.context.recapture_for_owned_service()?,
        root_identity: root.directory_identity()?,
        root,
        root_path: component.clone(),
        manifest_sha: hex(&manifest),
        node: node.clone(),
        node_sha: hex(node_bytes),
        node_mode: "standalone_node".into(),
        node_version: None,
        electron_version: None,
        launch_verified: AtomicBool::new(false),
        member_identity_readback: AtomicBool::new(false),
    };
    let cancel = CancellationToken::new();
    assert!(lease.verify_runtime_owner(&cancel).is_err());
    lease.verify_for_launch(&cancel)?;
    lease.verify_runtime_owner(&cancel)?;
    let launch_fingerprint = lease.service_fingerprint(&cancel)?;
    // Reusing another service's registered immutable bytes must not rewrite them.
    let retained_path = parent.join("retained-channel-component");
    let retained = PrivateDirectory::open_or_create(&retained_path)?;
    let descriptor = lease.retain_service_resources(&retained, &retained_path, &cancel)?;
    let original_identity = retained.portable_retention_regular_identity(OsStr::new(MANIFEST))?;
    let copied_source = retained_path.join("src/applications/stdio.mjs");
    let original_modified = std::fs::metadata(&copied_source)?.modified()?;
    for _ in 0..3 {
        assert_eq!(
            lease.reuse_service_resources(&retained, &retained_path, &cancel)?,
            descriptor
        );
    }
    assert_eq!(
        retained.portable_retention_regular_identity(OsStr::new(MANIFEST))?,
        original_identity
    );
    assert_eq!(
        std::fs::metadata(&copied_source)?.modified()?,
        original_modified
    );
    std::fs::write(&copied_source, b"corrupt retained bytes")?;
    assert!(
        lease
            .reuse_service_resources(&retained, &retained_path, &cancel)
            .is_err()
    );
    std::fs::write(&copied_source, b"original source bytes")?;
    std::fs::write(
        retained_path.join("unexpected-file"),
        b"not in the sealed manifest",
    )?;
    assert!(
        lease
            .reuse_service_resources(&retained, &retained_path, &cancel)
            .is_err()
    );
    std::fs::remove_file(retained_path.join("unexpected-file"))?;
    let cancelled_copy = CancellationToken::new();
    cancelled_copy.cancel();
    assert!(
        lease
            .reuse_service_resources(&retained, &retained_path, &cancelled_copy)
            .is_err()
    );

    let startup = NativeConnectivityStartupBinding {
        value: Startup {
            schema_version: 1,
            component_root: component.clone(),
            manifest_sha256: hex(&manifest),
            node_program: node.clone(),
            node_sha256: hex(node_bytes),
            node_mode: "standalone_node".into(),
            node_version: None,
            electron_version: None,
        },
        profile_identity: native.context.profile()?.directory_identity()?,
        workspace_identity: native.context.workspace_directory_identity()?,
        resolved: Default::default(),
    };
    let installed = startup.resolve(&native.context, &cancel).await?;
    let other_revision = NativeIntegrationContext::capture(
        &native.profile,
        &native.workspace,
        "other-connection",
        "other-configuration",
    )?;
    let other_model = startup.resolve(&other_revision, &cancel).await?;
    assert!(Arc::ptr_eq(&installed.verifier, &other_model.verifier));
    let original = b"original source bytes";
    let changed = b"modified source bytes";
    assert_eq!(original.len(), changed.len());
    std::fs::write(source.join("stdio.mjs"), changed)?;
    // An existing owner does not reload changed disk code. Starting another
    // process must reject it before any new code is loaded.
    lease.verify_runtime_owner(&cancel)?;
    assert_eq!(lease.service_fingerprint(&cancel)?, launch_fingerprint);
    let reused = startup.resolve(&native.context, &cancel).await?;
    assert!(Arc::ptr_eq(&installed.verifier, &reused.verifier));
    assert_eq!(
        reused
            .scope_host_resources(&cancel)?
            .component_manifest_sha256,
        hex(&manifest)
    );
    assert!(reused.verifier.verify_for_launch(&cancel).is_err());
    assert!(lease.verify_for_launch(&CancellationToken::new()).is_err());
    std::fs::write(source.join("stdio.mjs"), original)?;
    lease.verify_for_launch(&CancellationToken::new())?;
    std::fs::write(source.join("replacement.mjs"), changed)?;
    std::fs::rename(source.join("replacement.mjs"), source.join("stdio.mjs"))?;
    assert!(lease.verify_for_launch(&CancellationToken::new()).is_err());
    std::fs::write(source.join("stdio.mjs"), original)?;
    std::fs::write(&node, vec![b'x'; node_bytes.len()])?;
    lease.verify_runtime_owner(&cancel)?;
    assert!(lease.verify_for_launch(&CancellationToken::new()).is_err());
    std::fs::write(&node, node_bytes)?;
    lease.verify_for_launch(&CancellationToken::new())?;
    #[cfg(unix)]
    {
        std::fs::remove_file(source.join("stdio.mjs"))?;
        std::os::unix::fs::symlink(&node, source.join("stdio.mjs"))?;
        assert!(lease.verify_for_launch(&CancellationToken::new()).is_err());
        std::fs::remove_file(source.join("stdio.mjs"))?;
        std::fs::write(source.join("stdio.mjs"), original)?;
    }
    std::fs::rename(&component, parent.join("original-resource-root"))?;
    std::fs::create_dir(&component)?;
    assert!(lease.verify_for_launch(&CancellationToken::new()).is_err());
    // Moving a bundle cannot change an already-loaded process. Cancellation
    // and the original native profile identity still invalidate its owner.
    lease.verify_runtime_owner(&cancel)?;
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(lease.verify_runtime_owner(&cancelled).is_err());
    std::fs::rename(&native.profile, parent.join("retired-profile"))?;
    std::fs::create_dir(&native.profile)?;
    assert!(lease.verify_runtime_owner(&cancel).is_err());
    Ok(())
}

#[test]
fn older_component_manifests_do_not_advertise_task_first_configuration_support() -> Result<()> {
    let legacy: DeclaredFeatures = serde_json::from_str("{}")?;
    assert!(!legacy.task_first_routing_v1);
    assert!(!legacy.member_identity_readback_v1);
    let current: DeclaredFeatures = serde_json::from_str(r#"{"taskFirstRoutingV1":true}"#)?;
    assert!(current.task_first_routing_v1);
    assert!(!current.member_identity_readback_v1);
    let identity: DeclaredFeatures =
        serde_json::from_str(r#"{"taskFirstRoutingV1":true,"memberIdentityReadbackV1":true}"#)?;
    assert!(identity.task_first_routing_v1 && identity.member_identity_readback_v1);
    assert!(
        serde_json::from_str::<DeclaredFeatures>(r#"{"taskFirstRoutingV1":true,"approved":true}"#)
            .is_err()
    );
    Ok(())
}
