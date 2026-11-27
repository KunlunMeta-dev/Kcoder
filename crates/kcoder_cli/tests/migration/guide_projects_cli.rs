//! Real prompt answers select project inventories and Native targets without hand-authored RPC.
use super::*;

fn source(f: &Fixture, kind: &str) -> PathBuf {
    let root = f
        .home
        .join(if kind == "codex" { ".codex" } else { ".claude" });
    let paths = (0..13)
        .map(|n| format!("Z:\\INERT_FOREIGN_ROOT\\project-{n:02}"))
        .collect::<Vec<_>>();
    if kind == "codex" {
        let db = rusqlite::Connection::open(root.join("state_5.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,metadata TEXT,position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL); CREATE TABLE project_roots(project_id TEXT NOT NULL,position INTEGER NOT NULL,path TEXT NOT NULL,PRIMARY KEY(project_id,position)); CREATE TABLE private_tokens(token TEXT);").unwrap();
        db.execute("INSERT INTO private_tokens VALUES(?1)", [KEY])
            .unwrap();
        for (n, path) in paths.iter().enumerate() {
            let id = format!("original-{n:02}");
            db.execute(
                "INSERT INTO projects VALUES(?1,?2,?3,?4,123,456)",
                rusqlite::params![id, format!("Project {n:02}"), KEY, n],
            )
            .unwrap();
            db.execute(
                "INSERT INTO project_roots VALUES(?1,0,?2)",
                rusqlite::params![id, path],
            )
            .unwrap();
        }
    } else {
        let projects = paths
            .into_iter()
            .map(|path| (path, json!({"token":KEY,"hasTrustDialogAccepted":true})))
            .collect::<serde_json::Map<_, _>>();
        std::fs::write(
            root.join(".claude.json"),
            json!({"oauthAccount":{"token":KEY},"projects":projects}).to_string(),
        )
        .unwrap();
    }
    std::fs::write(
        f.profile.join("trusted-folders.json"),
        json!({"trusted":[f.root.path().join("workspace")],"never":[]}).to_string(),
    )
    .unwrap();
    root
}
fn registry(f: &Fixture) -> PathBuf {
    let mut queue = vec![f.profile.clone()];
    let mut count = 0;
    while let Some(path) = queue.pop() {
        for row in std::fs::read_dir(path).unwrap() {
            let row = row.unwrap();
            count += 1;
            assert!(count < 4096);
            if row.file_type().unwrap().is_dir() {
                queue.push(row.path());
            } else if row.file_name() == "client-workspaces.json" {
                return row.path();
            }
        }
    }
    panic!("Native registry was not published")
}
fn associations(f: &Fixture) -> usize {
    let value: Value = serde_json::from_slice(
        &std::fs::read(
            f.profile
                .join("imported-project-associations/associations.json"),
        )
        .unwrap(),
    )
    .unwrap();
    value["records"].as_object().unwrap().len()
}

#[test]
fn guided_projects_two_products_keep_foreign_roots_inert_register_native_target_and_reopen_undo() {
    for kind in ["claude-code", "codex"] {
        let f = Fixture::new(kind);
        let root = source(&f, kind);
        let original = std::fs::read(f.profile.join("settings.json")).unwrap();
        let mut d = Dialog::start(&f, "", None);
        let p = d.prompt("entry");
        d.answer(&p, "projects");
        let p = d.prompt("source");
        d.answer(&p, kind);
        let p = d.prompt("project_source_directory");
        d.answer(&p, root.to_str().unwrap());
        let p = d.prompt("project_source_consent");
        d.answer(&p, "yes");
        let p = d.prompt("project_sources");
        assert_eq!(p["choices"]["items"].as_array().unwrap().len(), 10);
        d.answer(&p, "toggle 1");
        let p = d.prompt("project_sources");
        d.answer(&p, "next");
        let p = d.prompt("project_sources");
        assert_eq!(p["choices"]["items"].as_array().unwrap().len(), 3);
        d.answer(&p, "toggle 3");
        let p = d.prompt("project_sources");
        assert_eq!(p["choices"]["selected"], 2);
        d.answer(&p, "done");
        let menu = d.prompt("menu");
        let job = d.state["job"]["jobId"].as_str().unwrap().to_owned();
        d.answer(&menu, "select");
        let target = f.root.path().join("workspace/mapped");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("USER_FILE"), "KEEP").unwrap();
        let mut registry_bytes = Vec::new();
        for n in 1..=2 {
            let p = d.prompt("selection");
            assert_eq!(p["choices"]["items"][n - 1]["mappingKind"], "project");
            d.answer(&p, &format!("toggle {n}"));
            let mut p = d.prompt("project_target");
            if n == 1 {
                d.answer(&p, "register");
                let name_prompt = d.prompt("project_register_name");
                d.answer(&name_prompt, "Explicit Native target");
                let path_prompt = d.prompt("project_register_path");
                assert!(path_prompt["default"].is_null());
                d.answer(&path_prompt, target.to_str().unwrap());
                let confirmation = d.prompt("project_register_confirm");
                d.answer(&confirmation, "yes");
                p = d.prompt("project_target");
                registry_bytes = std::fs::read(registry(&f)).unwrap();
            }
            let number = p["choices"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["title"] == "Explicit Native target")
                .unwrap()["number"]
                .as_u64()
                .unwrap();
            d.answer(&p, &number.to_string());
            let p = d.prompt("project_target_root");
            assert!(
                p["choices"]["sourceRoot"]
                    .as_str()
                    .unwrap()
                    .starts_with("Z:")
            );
            let number = p["choices"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["path"] == target.to_str().unwrap())
                .unwrap()["number"]
                .as_u64()
                .unwrap();
            d.answer(&p, &number.to_string());
        }
        let p = d.prompt("selection");
        d.answer(&p, "preview");
        let p = d.prompt("reuse");
        d.answer(&p, "no");
        let menu = d.prompt("menu");
        d.answer(&menu, "apply");
        let p = d.prompt("request_id");
        d.answer(&p, "");
        let p = d.prompt("confirm_operation");
        d.answer(&p, "IMPORT");
        let menu = d.prompt("menu");
        assert_eq!(d.state["job"]["status"], "completed");
        assert_eq!(associations(&f), 2);
        d.answer(&menu, "quit");
        d.finish();
        std::fs::rename(&root, root.with_extension("withheld")).unwrap();
        let mut d = Dialog::start(&f, "", Some(&job));
        let p = d.prompt("menu");
        d.answer(&p, "projects");
        let p = d.prompt("project_saved");
        d.answer(&p, "1");
        let p = d.prompt("project_report");
        assert!(p["choices"]["fields"].as_array().unwrap().len() <= 10);
        d.answer(&p, "back");
        let p = d.prompt("project_saved");
        d.answer(&p, "back");
        let p = d.prompt("menu");
        d.answer(&p, "undo");
        let p = d.prompt("request_id");
        d.answer(&p, "");
        let p = d.prompt("confirm_operation");
        d.answer(&p, "UNDO");
        let p = d.prompt("menu");
        assert_eq!(d.state["job"]["status"], "rolled_back");
        d.answer(&p, "quit");
        d.finish();
        assert_eq!(associations(&f), 0);
        assert_eq!(std::fs::read(registry(&f)).unwrap(), registry_bytes);
        assert_eq!(std::fs::read(target.join("USER_FILE")).unwrap(), b"KEEP");
        assert_eq!(
            std::fs::read(f.profile.join("settings.json")).unwrap(),
            original
        );
    }
}
