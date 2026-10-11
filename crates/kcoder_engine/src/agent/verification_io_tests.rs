use super::super::MAX_VERIFIER_BASELINE_BUNDLE_BYTES;
use super::super::verification_workspace::read_bounded_verifier_bundle;
#[cfg(unix)]
use super::super::verification_workspace::verifier_git_output;
use std::time::Duration;

#[tokio::test]
async fn verifier_rejects_oversized_sparse_bundle_before_reading_it() {
    let tmp = kcoder_config::create_private_temp_dir("kcoder-test-bundle-limit").unwrap();
    let path = tmp.path().join("baseline.bundle");
    std::fs::File::create(&path)
        .unwrap()
        .set_len((MAX_VERIFIER_BASELINE_BUNDLE_BYTES + 1) as u64)
        .unwrap();
    let start = std::time::Instant::now();
    let error = read_bounded_verifier_bundle(&path).await.unwrap_err();
    assert!(error.to_string().contains("256 MiB limit"));
    assert!(start.elapsed() < Duration::from_secs(1));
}

#[cfg(unix)]
#[tokio::test]
async fn verifier_stdout_budget_is_checked_during_git_output() {
    let tmp = tempfile::tempdir().unwrap();
    let error = verifier_git_output(
        tmp.path(),
        &["-c", "alias.flood=!head -c 67117056 /dev/zero", "flood"],
    )
    .await
    .unwrap_err();
    assert!(
        error.to_string().contains("67108864 byte budget"),
        "{error}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn verifier_git_error_does_not_collect_unbounded_stderr() {
    let tmp = tempfile::tempdir().unwrap();
    let error = verifier_git_output(
        tmp.path(),
        &[
            "-c",
            "alias.flood=!head -c 131072 /dev/zero | tr '\\000' x >&2; exit 1",
            "flood",
        ],
    )
    .await
    .unwrap_err();
    assert!(
        error.to_string().len() <= 8192,
        "Git stderr must be bounded during reading"
    );
}
