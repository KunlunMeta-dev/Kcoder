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

#[tokio::test]
async fn complete_resource_guard_rejects_changed_bytes_atomic_source_and_runtime_replacement()
-> Result<()> {
    let native =
        crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
    let parent = native.profile.parent().unwrap();
    let component = parent.join("sealed-resource-negative-fixture");
    std::fs::create_dir(&component)?;
    let source_root = component.join("src");
    let source = source_root.join("applications");
    let licenses = component.join("licenses");
    std::fs::create_dir(&source_root)?;
    std::fs::create_dir(&source)?;
    std::fs::create_dir(&licenses)?;
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
        node_sha: OnceLock::from(hex(node_bytes)),
        node_mode: "standalone_node".into(),
        launch_verified: AtomicBool::new(false),
        launch_proof: Mutex::new(None),
        full_verifications: AtomicUsize::new(0),
    };
    let cancel = CancellationToken::new();
    assert!(lease.verify_runtime_owner(&cancel).is_err());
    lease.verify_for_launch(&cancel)?;
    lease.verify_runtime_owner(&cancel)?;

    let startup = NativeConnectivityStartupBinding {
        value: Startup {
            schema_version: 1,
            component_root: component.clone(),
            manifest_sha256: hex(&manifest),
            node_program: node.clone(),
            node_sha256: Some(hex(node_bytes)),
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
    let reused = startup.resolve(&native.context, &cancel).await?;
    assert!(Arc::ptr_eq(&installed.verifier, &reused.verifier));
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
    let current: DeclaredFeatures = serde_json::from_str(r#"{"taskFirstRoutingV1":true}"#)?;
    assert!(current.task_first_routing_v1);
    let identity: DeclaredFeatures =
        serde_json::from_str(r#"{"taskFirstRoutingV1":true,"memberIdentityReadbackV1":true}"#)?;
    assert!(identity.task_first_routing_v1);
    assert!(
        serde_json::from_str::<DeclaredFeatures>(r#"{"taskFirstRoutingV1":true,"approved":true}"#)
            .is_err()
    );
    Ok(())
}

/// A private sealed component with the four required files. Its bytes are never executed.
fn sealed_component(parent: &Path, name: &str) -> Result<(PathBuf, Vec<u8>)> {
    let component = parent.join(name);
    for directory in [
        component.clone(),
        component.join("src"),
        component.join("src/applications"),
        component.join("licenses"),
    ] {
        std::fs::create_dir(&directory)?;
    }
    let mut files = Vec::new();
    let mut total = 0;
    for (path, bytes) in [
        ("package.json", b"declared package fixture".as_slice()),
        ("package-lock.json", b"declared lock fixture".as_slice()),
        ("src/applications/stdio.mjs", b"original source bytes"),
        ("licenses/LICENSE.txt", b"declared legal fixture"),
    ] {
        std::fs::write(component.join(path), bytes)?;
        files.push(serde_json::json!({"path":path,"bytes":bytes.len(),"sha256":hex(bytes)}));
        total += bytes.len();
    }
    let manifest = serde_json::to_vec(
        &serde_json::json!({"schemaVersion":1,"name":"@kunlunmeta/kcoder-channel-host","version":"0.1.0",
        "nodeMinimumMajor":22,"entry":"src/applications/stdio.mjs","lockSha256":hex(b"declared lock fixture"),"files":files,"totalBytes":total}),
    )?;
    std::fs::write(component.join(MANIFEST), &manifest)?;
    Ok((component, manifest))
}

#[tokio::test]
async fn one_complete_check_serves_only_the_next_launch_and_corruption_fails_closed() -> Result<()>
{
    let native =
        crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
    let parent = native.profile.parent().unwrap();
    let (component, manifest) = sealed_component(parent, "sealed-launch-proof-fixture")?;
    let node = parent.join("unexecuted-launch-proof-runtime");
    let node_bytes = b"launch proof runtime bytes";
    std::fs::write(&node, node_bytes)?;
    let binding = || -> Result<NativeConnectivityStartupBinding> {
        Ok(NativeConnectivityStartupBinding {
            value: Startup {
                schema_version: 1,
                component_root: component.clone(),
                manifest_sha256: hex(&manifest),
                node_program: node.clone(),
                // Electron/Gateway no longer hash the runtime; the app-server pins it.
                node_sha256: None,
                node_mode: "standalone_node".into(),
                node_version: None,
                electron_version: None,
            },
            profile_identity: native.context.profile()?.directory_identity()?,
            workspace_identity: native.context.workspace_directory_identity()?,
            resolved: Default::default(),
        })
    };
    let cancel = CancellationToken::new();
    let startup = binding()?;
    let installed = startup.resolve(&native.context, &cancel).await?;
    let lease = installed.verifier.clone();
    assert_eq!(lease.full_verification_count(), 1);
    assert_eq!(lease.pinned_node_sha()?, hex(node_bytes));
    // Warm path: cached resolution, pre-launch preparation and the following
    // launch reuse the single complete check without another digest.
    startup.resolve(&native.context, &cancel).await?;
    lease.prepare_next_launch(&cancel).await?;
    lease.verify_launch_consuming_proof(&cancel)?;
    assert_eq!(lease.full_verification_count(), 1);
    // The proof is single-use; the next launch hashes every byte again.
    lease.verify_launch_consuming_proof(&cancel)?;
    assert_eq!(lease.full_verification_count(), 2);
    // An expired proof is never reused.
    lease.prepare_next_launch(&cancel).await?;
    assert_eq!(lease.full_verification_count(), 3);
    *lease.launch_proof.lock().unwrap() =
        Instant::now().checked_sub(LAUNCH_PROOF_LIFETIME + std::time::Duration::from_secs(1));
    lease.verify_launch_consuming_proof(&cancel)?;
    assert_eq!(lease.full_verification_count(), 4);
    // A consumed proof still rejects a replaced sealed manifest.
    lease.prepare_next_launch(&cancel).await?;
    let mut changed_manifest = manifest.clone();
    changed_manifest.push(b'\n');
    std::fs::write(component.join(MANIFEST), &changed_manifest)?;
    assert!(lease.verify_launch_consuming_proof(&cancel).is_err());
    std::fs::write(component.join(MANIFEST), &manifest)?;
    assert_eq!(lease.full_verification_count(), 5);
    // Changed code fails the complete check and leaves no reusable proof.
    let source = component.join("src/applications/stdio.mjs");
    std::fs::write(&source, b"modified source bytes")?;
    assert!(lease.prepare_next_launch(&cancel).await.is_err());
    assert!(lease.verify_launch_consuming_proof(&cancel).is_err());
    assert_eq!(lease.full_verification_count(), 7);
    // A fresh generation over corrupted code never resolves or reaches a launch.
    assert!(binding()?.resolve(&native.context, &cancel).await.is_err());
    std::fs::write(&source, b"original source bytes")?;
    // The first complete check pinned the runtime image for later launches.
    std::fs::write(&node, b"launch proof RUNTIME bytes")?;
    assert!(lease.verify_launch_consuming_proof(&cancel).is_err());
    std::fs::write(&node, node_bytes)?;
    lease.verify_launch_consuming_proof(&cancel)?;
    Ok(())
}

/// Manual measurement on an explicitly staged component; not a CI assertion.
/// KCODER_CHANNEL_BENCH_COMPONENT=<root> KCODER_CHANNEL_BENCH_MANIFEST_SHA=<sha>
/// cargo test -p kcoder_cli_runtime --lib benchmark_channel_launch_verification -- --ignored --nocapture
#[tokio::test]
#[ignore = "manual measurement of an explicitly staged component"]
async fn benchmark_channel_launch_verification() -> Result<()> {
    let component = PathBuf::from(std::env::var("KCODER_CHANNEL_BENCH_COMPONENT")?);
    let manifest_sha = std::env::var("KCODER_CHANNEL_BENCH_MANIFEST_SHA")?;
    let node = which::which("node")?.canonicalize()?;
    let native =
        crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
    let startup = NativeConnectivityStartupBinding {
        value: Startup {
            schema_version: 1,
            component_root: component,
            manifest_sha256: manifest_sha,
            node_program: node,
            node_sha256: None,
            node_mode: "standalone_node".into(),
            node_version: None,
            electron_version: None,
        },
        profile_identity: native.context.profile()?.directory_identity()?,
        workspace_identity: native.context.workspace_directory_identity()?,
        resolved: Default::default(),
    };
    let cancel = CancellationToken::new();
    let start = Instant::now();
    let installed = startup.resolve(&native.context, &cancel).await?;
    let resolve = start.elapsed();
    let start = Instant::now();
    installed.verifier.verify_launch_consuming_proof(&cancel)?;
    let consumed = start.elapsed();
    let mut complete = Vec::new();
    for _ in 0..5 {
        let start = Instant::now();
        installed.verifier.verify_for_launch(&cancel)?;
        complete.push(start.elapsed().as_millis());
    }
    eprintln!(
        "channel launch verification: first_resolve_ms={} consumed_proof_ms={} complete_ms={complete:?} full_verifications={}",
        resolve.as_millis(),
        consumed.as_millis(),
        installed.verifier.full_verification_count()
    );
    Ok(())
}
