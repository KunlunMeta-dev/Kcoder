use super::*;
#[path = "../../../kcoder_migration/tests/fixtures/reinterpretation.rs"]
mod legacy;
use kcoder_migration::history_normalization::{
    HISTORY_NORMALIZATION_REVISION, LEGACY_HISTORY_NORMALIZATION_REVISION,
};
use kcoder_types::migration::MigrationSourceKind;

#[test]
fn terminal_reinterpretation_requires_confirmation_and_reads_fixed_dense_results_from_the_archive()
{
    let f = Fixture::new();
    let (old, _, source) =
        legacy::legacy(&f.profile, &f.source, MigrationSourceKind::ClaudeCode, true);
    fs::remove_file(source).unwrap();
    let key = uuid::Uuid::new_v4().to_string();
    let preview = f.call(&["reinterpret", "preview", "--source-job-id", &old.job_id]);
    assert_eq!(preview["canCreate"], true);
    assert_eq!(
        preview["sourceRevision"],
        LEGACY_HISTORY_NORMALIZATION_REVISION
    );
    let args = [
        "reinterpret",
        "create",
        "--source-job-id",
        &old.job_id,
        "--expected-source-sequence",
        &old.sequence.to_string(),
        "--request-id",
        &key,
    ];
    assert!(!f.invoke(&args).status.success());
    assert!(
        !f.profile
            .join("migrations/history")
            .join(format!("{key}.json"))
            .exists()
    );
    let confirmed = args.into_iter().chain(["--confirm"]).collect::<Vec<_>>();
    let created = f.call(&confirmed);
    assert_eq!(created["stage"], "normalizing");
    assert!(created["normalization"].is_null());
    assert_eq!(f.call(&confirmed), created);
    let done = f.call(&["run", "--job-id", &key, "--expected-sequence", "0"]);
    assert_eq!(done["normalization"]["recordsWithDiagnostics"], 0);
    assert_eq!(
        f.call(&["page", "--job-id", &key])["adapterRevision"],
        HISTORY_NORMALIZATION_REVISION
    );
    assert_eq!(
        f.call(&["page", "--job-id", &old.job_id])["adapterRevision"],
        LEGACY_HISTORY_NORMALIZATION_REVISION
    );
    assert_eq!(
        f.call(&["read", "--job-id", &old.job_id])["normalization"]["recordsWithDiagnostics"],
        1
    );
    let found = f.call(&[
        "search",
        "--job-id",
        &key,
        "--query",
        "Reinterpret dense result 0",
    ]);
    assert!(!found["items"].as_array().unwrap().is_empty());
    assert!(!f.workspace.join("NEVER_REPLAY_REINTERPRETATION").exists());
    assert!(!legacy::snapshot(&f.profile).is_empty());
}

#[test]
fn terminal_new_interpretation_continues_safely_without_redirecting_a_published_legacy_source() {
    let f = Fixture::new();
    let (old, _, path) = legacy::legacy(
        &f.profile,
        &f.source,
        MigrationSourceKind::ClaudeCode,
        false,
    );
    let old_branch = f.call(&["branch", "--job-id", &old.job_id]);
    let old_view = old_branch["progress"]["viewId"].as_str().unwrap();
    let old_operation = uuid::Uuid::new_v4().to_string();
    let imported = f.call(&[
        "continue",
        "--job-id",
        &old.job_id,
        "--view-id",
        old_view,
        "--request-id",
        &old_operation,
    ]);
    let old_thread = imported["job"]["threadId"].as_str().unwrap();
    let old_source = f.call(&["source", "--thread-id", old_thread]);
    fs::remove_file(path).unwrap();
    let key = uuid::Uuid::new_v4().to_string();
    f.call(&[
        "reinterpret",
        "create",
        "--source-job-id",
        &old.job_id,
        "--expected-source-sequence",
        &old.sequence.to_string(),
        "--request-id",
        &key,
        "--confirm",
    ]);
    f.call(&["run", "--job-id", &key, "--expected-sequence", "0"]);
    let new_branch = f.call(&["branch", "--job-id", &key]);
    let new_view = new_branch["progress"]["viewId"].as_str().unwrap();
    assert_ne!(old_view, new_view);
    assert_eq!(
        f.call(&["check", "--job-id", &key, "--view-id", new_view])["report"]["contextCompiled"],
        true
    );
    let new_operation = uuid::Uuid::new_v4().to_string();
    let new = f.call(&[
        "continue",
        "--job-id",
        &key,
        "--view-id",
        new_view,
        "--request-id",
        &new_operation,
    ]);
    assert_eq!(new["job"]["stage"], "imported");
    assert_ne!(new["job"]["threadId"], old_thread);
    assert_eq!(f.call(&["source", "--thread-id", old_thread]), old_source);
    assert_eq!(
        f.call(&["continuation-read", "--job-id", &old_operation])["job"],
        imported["job"]
    );
    assert!(!f.workspace.join("NEVER_REPLAY_REINTERPRETATION").exists());
}
