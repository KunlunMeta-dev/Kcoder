use super::*;
use std::process::Command;

const TEST_NAME: &str =
    "cron::idle_tests::no_store_idle_fences_first_publication_without_project_metadata";
const ROLE: &str = "KCODER_CRON_IDLE_TEST_ROLE";
const WORKSPACE: &str = "KCODER_CRON_IDLE_TEST_WORKSPACE";

fn child(role: &str, workspace: &Path, profile: &Path) {
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST_NAME, "--nocapture"])
        .env(ROLE, role)
        .env(WORKSPACE, workspace)
        .env("KCODER_CONFIG_DIR", profile)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "cron child {role} failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn no_store_idle_fences_first_publication_without_project_metadata() {
    let Ok(role) = std::env::var(ROLE) else {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        child("coordinator", &workspace, &temp.path().join("profile"));
        return;
    };
    let workspace = PathBuf::from(std::env::var_os(WORKSPACE).unwrap());
    let profile = PathBuf::from(std::env::var_os("KCODER_CONFIG_DIR").unwrap());
    let scheduler = CronScheduler::load(&workspace);
    if role == "coordinator" {
        let reservation = scheduler.try_reserve_idle().unwrap().unwrap();
        assert!(!workspace.join(".kcoder").exists());
        child("blocked", &workspace, &profile);
        assert!(!workspace.join(".kcoder").exists());
        drop(reservation);
        child("publish", &workspace, &profile);
        // A stale, initially empty scheduler must see the other process's job.
        assert!(scheduler.try_reserve_idle().unwrap().is_none());
        assert_eq!(scheduler.list().len(), 1);
        // Existing stores retain their original workspace lock even if the
        // private admission directory cannot be opened in this profile.
        let unavailable = workspace.parent().unwrap().join("profile-file");
        fs::write(&unavailable, "owned blocker").unwrap();
        child("existing", &workspace, &unavailable);
        assert_eq!(scheduler.list().len(), 2);
        return;
    }
    if role == "blocked" {
        assert!(scheduler.try_reserve_idle().is_err());
        let result = scheduler.create(
            "owned blocked fixture".into(),
            CronSchedule::Every {
                every_seconds: 3600,
            },
            Some(0),
        );
        assert!(result.unwrap_err().contains("cron store is busy"));
        assert!(!workspace.join(".kcoder").exists());
        return;
    }
    assert!(role == "publish" || role == "existing");
    scheduler
        .create(
            format!("owned {role} fixture"),
            CronSchedule::Every {
                every_seconds: 3600,
            },
            Some(0),
        )
        .unwrap();
    assert!(scheduler.try_reserve_idle().unwrap().is_none());
}
