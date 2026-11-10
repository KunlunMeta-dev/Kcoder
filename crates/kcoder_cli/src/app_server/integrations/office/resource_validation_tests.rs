//! Resource inventory, owner checks and sealed scope copy regressions.

use super::*;
use serde_json::json;
#[path = "resource_test_context.rs"]
mod resource_test_context;
use resource_test_context::native_context;

#[tokio::test]
async fn office_owner_observation_does_not_hash_code_but_new_load_still_rejects_corruption() {
    let (root, lease) = scope_copy_source();
    lease.verify_sync(&CancellationToken::new()).unwrap();
    std::fs::write(
        root.path().join("components/src/cli.mjs"),
        b"changed worker code",
    )
    .unwrap();
    lease.verify_owner(&CancellationToken::new()).await.unwrap();
    assert!(lease.verify(&CancellationToken::new()).await.is_err());
    let ended = CancellationToken::new();
    ended.cancel();
    assert!(lease.verify_owner(&ended).await.is_err());
}

fn manifest(files: Vec<ResourceFile>) -> ResourceManifest {
    ResourceManifest {
        schema_version: 1,
        component_name: "@kcoder/office-components".into(),
        component_version: "0.1.0".into(),
        node_minimum_major: 22,
        package_root: "components".into(),
        entry: "components/src/cli.mjs".into(),
        lock_sha256: hex(b"{}"),
        generator: OfficeGeneratorIdentity {
            component: "@kcoder/office-components".into(),
            version: "0.1.0".into(),
            schema_revision: "office-generation/v1".into(),
            implementation_sha256: "a".repeat(64),
            dependency_lock_sha256: hex(b"{}"),
        },
        dependencies: vec![],
        total_bytes: files.iter().map(|file| file.bytes).sum(),
        files,
    }
}
fn tiny_bundle() -> (tempfile::TempDir, PrivateDirectory, ResourceManifest) {
    let temp = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    std::fs::create_dir_all(temp.path().join("components/src")).unwrap();
    std::fs::create_dir(temp.path().join("licenses")).unwrap();
    let entries = [
        (
            "components/src/cli.mjs",
            b"// controlled resource identity fixture".as_slice(),
        ),
        ("components/package.json", b"{}".as_slice()),
        ("components/package-lock.json", b"{}".as_slice()),
        (
            "licenses/kcoder-office/LICENSE.txt",
            b"controlled fixture license".as_slice(),
        ),
        (
            "licenses/saxes/LICENSE.txt",
            b"controlled fixture license".as_slice(),
        ),
        (
            "licenses/electron-fuses/LICENSE.txt",
            b"controlled fixture license".as_slice(),
        ),
        (
            "licenses/PROVENANCE.md",
            b"controlled fixture provenance".as_slice(),
        ),
    ];
    let mut files = vec![];
    for (path, bytes) in entries {
        std::fs::create_dir_all(temp.path().join(path).parent().unwrap()).unwrap();
        std::fs::write(temp.path().join(path), bytes).unwrap();
        files.push(ResourceFile {
            path: path.into(),
            bytes: bytes.len() as u64,
            sha256: hex(bytes),
            legal: path.starts_with("licenses/"),
        });
    }
    let directory = PrivateDirectory::open_existing(temp.path()).unwrap();
    (temp, directory, manifest(files))
}
#[test]
fn exact_handle_inventory_rejects_changed_missing_extra_or_linked_files() {
    for change in ["changed", "missing", "extra"] {
        let (temp, root, manifest) = tiny_bundle();
        manifest.validate().unwrap();
        verify_tree(&root, &manifest, &CancellationToken::new()).unwrap();
        match change {
            "changed" => std::fs::write(
                temp.path().join("components/src/cli.mjs"),
                b"different resource",
            )
            .unwrap(),
            "missing" => std::fs::remove_file(temp.path().join("components/src/cli.mjs")).unwrap(),
            "extra" => {
                std::fs::write(temp.path().join("components/unlisted.js"), b"not sealed").unwrap()
            }
            _ => unreachable!(),
        };
        assert!(verify_tree(&root, &manifest, &CancellationToken::new()).is_err());
    }
    #[cfg(unix)]
    {
        for hard in [true, false] {
            let (temp, root, manifest) = tiny_bundle();
            let original = temp.path().join("components/src/cli.mjs");
            let outside = temp.path().join("held-source");
            std::fs::rename(&original, &outside).unwrap();
            if hard {
                std::fs::hard_link(&outside, &original).unwrap()
            } else {
                std::os::unix::fs::symlink(&outside, &original).unwrap()
            };
            assert!(verify_tree(&root, &manifest, &CancellationToken::new()).is_err());
        }
    }
}
#[test]
fn manifest_and_cancellation_never_guess_paths_or_accept_partial_inventory() {
    let (_temp, root, mut manifest) = tiny_bundle();
    manifest.validate().unwrap();
    let token = CancellationToken::new();
    token.cancel();
    assert!(verify_tree(&root, &manifest, &token).is_err());
    for path in [
        "../outside",
        "/absolute",
        "C:/outside",
        "components/../outside",
        "components\\outside",
    ] {
        let original = manifest.files[0].path.clone();
        manifest.files[0].path = path.into();
        assert!(manifest.validate().is_err());
        manifest.files[0].path = original;
    }
    manifest.files.push(manifest.files[0].clone());
    assert!(manifest.validate().is_err());
}
#[tokio::test]
async fn deferred_office_preparation_checks_changed_resources_before_use() {
    let (_owner, context, _, _) = native_context();
    let (bundle, _, manifest) = tiny_bundle();
    let files: Vec<_> = manifest
        .files
        .iter()
        .map(|file| {
            json!({
                "path": file.path, "bytes": file.bytes, "sha256": file.sha256, "legal": file.legal,
            })
        })
        .collect();
    let body = json!({
        "schemaVersion": manifest.schema_version,
        "componentName": manifest.component_name,
        "componentVersion": manifest.component_version,
        "nodeMinimumMajor": manifest.node_minimum_major,
        "packageRoot": manifest.package_root,
        "entry": manifest.entry,
        "lockSha256": manifest.lock_sha256,
        "generator": manifest.generator,
        "dependencies": [], "files": files, "totalBytes": manifest.total_bytes,
    });
    let bytes = serde_json::to_vec(&body).unwrap();
    std::fs::write(bundle.path().join(MANIFEST), &bytes).unwrap();
    let runtime_file = _owner.path().join("node");
    std::fs::write(&runtime_file, b"placeholder").unwrap();
    let runtime = NativeOfficeRuntimeAuthority::from_native_launcher(
        &runtime_file,
        &"a".repeat(64),
        OfficeNodeRuntimeMode::StandaloneNode,
        "22.0.0",
        None,
    )
    .unwrap();
    let installed = NativeOfficeLaunchAuthority::from_native_launch(
        &context,
        bundle.path(),
        &hex(&bytes),
        runtime,
    )
    .unwrap()
    .prepare_deferred()
    .unwrap();
    std::fs::write(bundle.path().join("components/src/cli.mjs"), b"changed").unwrap();
    installed
        .verify_current_resources(&context, &CancellationToken::new())
        .await
        .expect("warm owner check must stay independent of component hashing");
    let error = installed
        .readiness(&context, &CancellationToken::new())
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("OFFICE_COMPONENT_IDENTITY_CHANGED")
    );
}
// These are pure copy/inventory checks. Synthetic bytes are never executed and
// do not prove a Native producer, Core transfer, Node runtime or tool grant.
fn scope_copy_source() -> (tempfile::TempDir, Arc<ResourceLease>) {
    let (temp, root, mut manifest) = tiny_bundle();
    let mut packages = serde_json::Map::new();
    for (name, version) in [
        ("docx", "9.5.1"),
        ("exceljs", "4.4.0"),
        ("pptxgenjs", "4.0.1"),
        ("fflate", "0.8.3"),
        ("saxes", "6.0.0"),
    ] {
        let dependency = format!("node_modules/{name}");
        packages.insert(dependency.clone(), json!({"version":version}));
        let relative = format!("components/{dependency}/package.json");
        let bytes = serde_json::to_vec(&json!({"name":name,"version":version})).unwrap();
        let path = temp.path().join(&relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        manifest.files.push(ResourceFile {
            path: relative,
            bytes: bytes.len() as u64,
            sha256: hex(&bytes),
            legal: false,
        });
        manifest.dependencies.push(Dependency {
            path: dependency,
            version: version.into(),
            integrity: None,
            license: "controlled data fixture".into(),
        });
    }
    let lock = serde_json::to_vec(&json!({"packages":packages})).unwrap();
    std::fs::write(temp.path().join("components/package-lock.json"), &lock).unwrap();
    let locked = manifest
        .files
        .iter_mut()
        .find(|entry| entry.path == "components/package-lock.json")
        .unwrap();
    locked.bytes = lock.len() as u64;
    locked.sha256 = hex(&lock);
    manifest.lock_sha256 = hex(&lock);
    manifest.generator.dependency_lock_sha256 = hex(&lock);
    manifest.total_bytes = manifest.files.iter().map(|entry| entry.bytes).sum();
    root.create_private_child(OsStr::new("runtime")).unwrap();
    let bytes = b"opaque scope copy inventory bytes";
    let program = temp.path().join("runtime/node");
    std::fs::write(&program, bytes).unwrap();
    manifest.files.push(ResourceFile {
        path: "runtime/node".into(),
        bytes: bytes.len() as u64,
        sha256: hex(bytes),
        legal: false,
    });
    manifest.total_bytes += bytes.len() as u64;
    let body = json!({"schemaVersion":manifest.schema_version,"componentName":manifest.component_name,
        "componentVersion":manifest.component_version,"nodeMinimumMajor":manifest.node_minimum_major,
        "packageRoot":manifest.package_root,"entry":manifest.entry,"lockSha256":manifest.lock_sha256,
        "generator":manifest.generator,"dependencies":manifest.dependencies.iter().map(|entry|json!({"path":entry.path,"version":entry.version,"integrity":entry.integrity,"license":entry.license})).collect::<Vec<_>>(),
        "files":manifest.files.iter().map(|entry|json!({"path":entry.path,"bytes":entry.bytes,"sha256":entry.sha256,"legal":entry.legal})).collect::<Vec<_>>(),
        "totalBytes":manifest.total_bytes});
    let encoded = serde_json::to_vec(&body).unwrap();
    root.atomic_replace(OsStr::new(MANIFEST), &encoded).unwrap();
    let lease = Arc::new(ResourceLease {
        root_identity: root.directory_identity().unwrap(),
        root: Arc::new(root),
        root_path: temp.path().into(),
        manifest_sha256: hex(&encoded),
        runtime: NativeOfficeRuntimeAuthority::from_native_launcher(
            &program,
            &hex(bytes),
            OfficeNodeRuntimeMode::StandaloneNode,
            "22.0.0",
            None,
        )
        .unwrap(),
        manifest: Arc::new(manifest),
        runtime_mode_verified: Arc::new(AtomicBool::new(false)),
    });
    (temp, lease)
}
fn private_scope_copy_target() -> (tempfile::TempDir, PrivateDirectory, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_existing(directory.path()).unwrap();
    let target = parent
        .create_private_child(OsStr::new("scope-owner"))
        .unwrap();
    let path = directory.path().join("scope-owner");
    (directory, target, path)
}
#[test]
fn scope_copy_retains_complete_inventory_after_its_source_is_removed() {
    let (source, lease) = scope_copy_source();
    let (_destination, target, target_path) = private_scope_copy_target();
    let copied =
        scope_retention::retain(&lease, &target, &target_path, &CancellationToken::new()).unwrap();
    assert!(copied.runtime_program.starts_with(&copied.component_root));
    let office = PrivateDirectory::open_existing(&copied.component_root).unwrap();
    let mut runtime = lease.runtime.clone();
    runtime.program = copied.runtime_program;
    let retained = ResourceLease {
        root_identity: office.directory_identity().unwrap(),
        root: Arc::new(office),
        root_path: copied.component_root,
        manifest_sha256: lease.manifest_sha256.clone(),
        runtime,
        manifest: lease.manifest.clone(),
        runtime_mode_verified: Arc::new(AtomicBool::new(false)),
    };
    drop(lease);
    drop(source);
    retained.verify_sync(&CancellationToken::new()).unwrap();
}
#[test]
fn scope_copy_observes_conflict_and_partial_output_without_repair() {
    let (_source, lease) = scope_copy_source();
    for partial in [false, true] {
        let (_destination, target, target_path) = private_scope_copy_target();
        let path = if partial {
            let office = target.open_child(OsStr::new("office"), true).unwrap();
            office
                .atomic_replace(OsStr::new("unconfirmed"), b"original partial data")
                .unwrap();
            target_path.join("office/unconfirmed")
        } else {
            let copied =
                scope_retention::retain(&lease, &target, &target_path, &CancellationToken::new())
                    .unwrap();
            let path = copied.component_root.join("components/src/cli.mjs");
            std::fs::write(&path, b"original conflicting bytes").unwrap();
            path
        };
        let before = std::fs::read(&path).unwrap();
        assert!(
            scope_retention::retain(&lease, &target, &target_path, &CancellationToken::new())
                .is_err()
        );
        assert_eq!(std::fs::read(path).unwrap(), before);
    }
}
#[test]
fn scope_copy_cancellation_does_not_create_an_office_copy() {
    let (_source, lease) = scope_copy_source();
    let (_destination, target, target_path) = private_scope_copy_target();
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(scope_retention::retain(&lease, &target, &target_path, &cancelled).is_err());
    assert!(!target_path.join("office").exists());
}
