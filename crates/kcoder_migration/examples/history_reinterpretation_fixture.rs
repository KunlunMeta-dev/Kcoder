//! Owned development fixture for real-terminal acceptance, not a shipped migration command.
#[path = "../tests/fixtures/reinterpretation.rs"]
mod fixture;
#[path = "history_reinterpretation_fixture/owned.rs"]
mod owned;

fn main() {
    let mut arguments = std::env::args_os().skip(1);
    let first = arguments
        .next()
        .expect("owned profile directory or fixture mode");
    if first == "--from-owned-job" {
        let profile = std::path::PathBuf::from(arguments.next().expect("owned profile directory"));
        let source = arguments
            .next()
            .expect("owned source job ID")
            .into_string()
            .expect("job UUID");
        assert!(
            arguments.next().is_none(),
            "expected owned profile and source job only"
        );
        let job = owned::from_job(&profile, &source).expect("create isolated legacy fixture");
        println!("{}", serde_json::json!({"job":job}));
        return;
    }
    let profile = std::path::PathBuf::from(first);
    let source = std::path::PathBuf::from(arguments.next().expect("owned source directory"));
    assert!(
        arguments.next().is_none(),
        "expected profile and source only"
    );
    assert!(source.is_absolute() && profile.is_absolute());
    assert!(
        !source.exists(),
        "fixture source must be a new owned directory"
    );
    let (job, _, source_path) = fixture::legacy(
        &profile,
        &source,
        kcoder_types::migration::MigrationSourceKind::ClaudeCode,
        false,
    );
    assert_eq!(fixture::snapshot(&source).len(), 1);
    println!(
        "{}",
        serde_json::json!({"job":job,"sourcePath":source_path})
    );
}
