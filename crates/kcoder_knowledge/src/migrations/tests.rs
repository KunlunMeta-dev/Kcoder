use super::*;

#[test]
fn every_released_schema_upgrades_and_preserves_library_data() {
    for version in 0..=SCHEMA_VERSION {
        let mut db = Connection::open_in_memory().unwrap();
        for sql in STEPS.iter().take(version as usize) {
            db.execute_batch(sql).unwrap();
        }
        db.pragma_update(None, "user_version", version).unwrap();
        if version > 0 {
            db.execute("INSERT INTO libraries(id,principal,target,name,purpose,request_key) VALUES('kept','owner','target','name','purpose','request')", []).unwrap();
        }
        upgrade(&mut db).unwrap();
        let actual: i64 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(actual, SCHEMA_VERSION);
        if version > 0 {
            let name: String = db
                .query_row("SELECT name FROM libraries WHERE id='kept'", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(name, "name");
        }
        let schema: String = db
            .query_row(
                "SELECT group_concat(sql) FROM (SELECT sql FROM sqlite_schema ORDER BY name)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        upgrade(&mut db).unwrap();
        let reopened: String = db
            .query_row(
                "SELECT group_concat(sql) FROM (SELECT sql FROM sqlite_schema ORDER BY name)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(reopened, schema);
    }
}

#[test]
fn failed_upgrade_rolls_back_all_steps_and_can_be_retried() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(STEPS[0]).unwrap();
    db.pragma_update(None, "user_version", 1).unwrap();
    // Fail after v2 has created its virtual table, exercising multi-step rollback.
    db.execute_batch("CREATE TABLE knowledge_sources(block_upgrade INTEGER)")
        .unwrap();
    assert!(upgrade(&mut db).is_err());
    let version: i64 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 1);
    let fts_count: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='knowledge_fts'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(fts_count, 0);
    db.execute_batch("DROP TABLE knowledge_sources").unwrap();
    upgrade(&mut db).unwrap();
}

#[test]
fn future_version_is_not_changed() {
    let mut db = Connection::open_in_memory().unwrap();
    db.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .unwrap();
    assert!(upgrade(&mut db).is_err());
    let version: i64 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION + 1);
}

#[test]
fn file_contract_upgrade_keeps_legacy_jobs_and_null_checkpoints_unchanged() {
    let mut db = Connection::open_in_memory().unwrap();
    for sql in STEPS.iter().take(18) {
        db.execute_batch(sql).unwrap();
    }
    db.pragma_update(None, "user_version", 18).unwrap();
    db.execute("INSERT INTO libraries(id,principal,target,name,purpose,request_key) VALUES('l','owner','target','name','purpose','request')", []).unwrap();
    for (job, version, checkpoint) in [("v0", 0, None), ("v1", 1, Some("{}"))] {
        db.execute(
            "INSERT INTO knowledge_jobs(library_id,job_id,request_key,source_id,source_revision,recipe_key,language,status,pipeline_version,checkpoint_json) VALUES('l',?1,?1,'s','r','recipe','en','queued',?2,?3)",
            rusqlite::params![job, version, checkpoint],
        )
        .unwrap();
    }
    upgrade(&mut db).unwrap();
    type Row = (String, i64, Option<String>, Option<String>, Option<String>);
    let rows: Vec<Row> = db
        .prepare("SELECT job_id,pipeline_version,checkpoint_json,publication_json,notice_code FROM knowledge_jobs ORDER BY job_id")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![
            ("v0".into(), 0, None, None, None),
            ("v1".into(), 1, Some("{}".into()), None, None)
        ]
    );
    for table in [
        "knowledge_tool_loop_steps",
        "knowledge_page_findings",
        "knowledge_pending_units",
        "knowledge_finding_decisions",
        "knowledge_job_outcomes",
        "knowledge_revision_assessments",
    ] {
        let count: i64 = db
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}
