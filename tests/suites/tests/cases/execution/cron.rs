use kcoder_tools::cron::{CronSchedule, CronScheduler};

#[test]
fn cron_public_api_persists_reloads_and_deletes_a_job() {
    let temporary = tempfile::tempdir().unwrap();
    let scheduler = CronScheduler::load(temporary.path());
    let created = scheduler
        .create(
            "后台检查项目状态".to_string(),
            CronSchedule::Every {
                every_seconds: 3600,
            },
            Some(0),
        )
        .unwrap();
    assert_eq!(scheduler.list().len(), 1);

    let persisted = temporary.path().join(".kcoder/cron/jobs.json");
    let document: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&persisted).unwrap()).unwrap();
    assert_eq!(document["jobs"][0]["id"], created.id);
    assert_eq!(document["jobs"][0]["prompt"], "后台检查项目状态");

    let reloaded = CronScheduler::load(temporary.path());
    assert_eq!(reloaded.list().len(), 1);
    assert!(reloaded.delete(&created.id).unwrap());
    assert!(CronScheduler::load(temporary.path()).list().is_empty());
}
