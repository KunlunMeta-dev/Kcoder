//! Load-boundary regression; rejects before starting any external worker.
use super::*;

#[tokio::test]
async fn deferred_office_load_checks_resources_once_and_rejects_before_spawn() {
    struct RejectingVerifier(std::sync::atomic::AtomicUsize);
    #[async_trait]
    impl NativeOfficeResourceVerifier for RejectingVerifier {
        async fn verify_owner(&self, _: &CancellationToken) -> Result<()> {
            Ok(())
        }
        async fn verify(&self, _: &CancellationToken) -> Result<()> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            anyhow::bail!("controlled resource rejection before worker load")
        }
    }
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("src")).unwrap();
    std::fs::write(
        root.path().join("src/cli.mjs"),
        "throw new Error('must not run')",
    )
    .unwrap();
    let verifier = Arc::new(RejectingVerifier(std::sync::atomic::AtomicUsize::new(0)));
    // Neither launch path can run. If verification moves after spawn, the
    // process error replaces the controlled rejection and this test fails.
    let node = root.path().join("non-executable-node-placeholder");
    std::fs::write(&node, b"not an executable image").unwrap();
    let owner = root.path().join("missing-command-owner");
    let generator = OfficeNodeGenerator::from_verified_native_launch(
        &node,
        root.path(),
        NativeOfficeNodeLaunch {
            mode: OfficeNodeRuntimeMode::StandaloneNode,
            owner_program: owner.clone(),
            verify: verifier.clone(),
        },
    )
    .unwrap();
    for _ in 0..20 {
        generator
            .verify_native_owner(&CancellationToken::new())
            .await
            .unwrap();
    }
    assert_eq!(
        verifier.0.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "authority observation must not repeatedly hash worker bytes"
    );
    assert_eq!(verifier.0.load(std::sync::atomic::Ordering::SeqCst), 0);
    let error = generator
        .generate(&json!({}), 1000, &CancellationToken::new())
        .await
        .err()
        .expect("the resource verifier must reject generation");
    assert!(error.to_string().contains("controlled resource rejection"));
    assert_eq!(verifier.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    for expected in 2..=3 {
        let error = generator
            .readiness(&CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("controlled resource rejection"));
        assert_eq!(
            verifier.0.load(std::sync::atomic::Ordering::SeqCst),
            expected
        );
    }
}
