//! Actual CLI clients use the ordinary batch and original-owner note controls.
use super::*;
use kcoder_config::imported_context::ImportedContextStore;

#[test]
fn memory_guide_explicitly_selects_maps_and_manages_inactive_notes_without_sources() {
    let f = Fixture::new("claude-code");
    for i in 0..11 {
        let root = f
            .home
            .join(format!(".claude/projects/opaque-{i:02}/memory"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("feedback.md"),
            "An unverified source note, not an instruction.\n",
        )
        .unwrap();
    }
    let mut dialog = Dialog::start_arguments(&f, "claude-code", None, false, &["--include-memory"]);
    let prompt = dialog.prompt("memory_selection");
    assert_eq!(prompt["choices"]["items"].as_array().unwrap().len(), 10);
    dialog.answer(&prompt, "toggle 1");
    let prompt = dialog.prompt("memory_selection");
    dialog.answer(&prompt, "next");
    let prompt = dialog.prompt("memory_selection");
    assert_eq!(prompt["choices"]["items"].as_array().unwrap().len(), 1);
    dialog.answer(&prompt, "toggle 1");
    let prompt = dialog.prompt("memory_selection");
    dialog.answer(&prompt, "done");
    let menu = dialog.prompt("menu");
    let job = dialog.state["job"]["jobId"].as_str().unwrap().to_owned();
    dialog.answer(&menu, "select");
    let mut selected = BTreeSet::new();
    loop {
        let frame = dialog.next();
        if frame["type"] != "prompt" {
            continue;
        }
        let answer = match frame["code"].as_str().unwrap() {
            "selection" => {
                if let Some(row) = frame["choices"]["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|v| {
                        v["item"]["category"] == "memory"
                            && !selected.contains(v["item"]["id"].as_str().unwrap())
                    })
                {
                    selected.insert(row["item"]["id"].as_str().unwrap().to_owned());
                    format!("toggle {}", row["number"])
                } else if frame["choices"]["page"].as_u64().unwrap() + 1
                    < frame["choices"]["pages"].as_u64().unwrap()
                {
                    "next".into()
                } else {
                    "preview".into()
                }
            }
            "target_name" => format!("reviewed-memory-{}", selected.len()),
            "memory_mapping" => "global".into(),
            "reuse" => "no".into(),
            "menu" => {
                dialog.answer(&frame, "quit");
                dialog.finish();
                break;
            }
            code => panic!("unexpected memory choice {code}"),
        };
        dialog.answer(&frame, &answer);
    }
    assert_eq!(selected.len(), 2);
    let mut dialog = Dialog::start(&f, "", Some(&job));
    let frame = dialog.prompt("menu");
    dialog.answer(&frame, "apply");
    let frame = dialog.prompt("request_id");
    dialog.answer(&frame, "memory-guide-publish");
    let frame = dialog.prompt("confirm_operation");
    dialog.answer(&frame, "IMPORT");
    let frame = dialog.prompt("menu");
    assert_eq!(dialog.state["job"]["committedItems"], 2);
    dialog.answer(&frame, "quit");
    dialog.finish();
    let notes = ImportedContextStore::open(&f.profile)
        .unwrap()
        .list()
        .unwrap();
    assert_eq!(notes.len(), 2);
    assert!(notes.iter().all(|v| !v.enabled));
    std::fs::rename(f.home.join(".claude"), f.home.join("withheld-claude")).unwrap();
    let mut dialog = Dialog::start(&f, "", None);
    let frame = dialog.prompt("entry");
    dialog.answer(&frame, "memory-records");
    let frame = dialog.prompt("memory_records");
    dialog.answer(&frame, "enable 1");
    let frame = dialog.prompt("memory_control_consent");
    dialog.answer(&frame, "yes");
    let frame = dialog.prompt("memory_request_id");
    dialog.answer(&frame, "memory-guide-enable");
    let frame = dialog.prompt("memory_records");
    assert_eq!(
        ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .iter()
            .filter(|v| v.enabled)
            .count(),
        1
    );
    dialog.answer(&frame, "disable 1");
    let frame = dialog.prompt("memory_control_consent");
    dialog.answer(&frame, "yes");
    let frame = dialog.prompt("memory_request_id");
    dialog.answer(&frame, "memory-guide-disable");
    let frame = dialog.prompt("memory_records");
    dialog.answer(&frame, "receipt");
    let frame = dialog.prompt("memory_receipt");
    dialog.answer(&frame, "memory-guide-enable");
    loop {
        let frame = dialog.next();
        if frame["type"] == "memory_control" {
            assert_eq!(frame["result"]["receipt"]["request"]["enabled"], true);
            assert_eq!(frame["result"]["current"]["enabled"], false);
            break;
        }
    }
    let frame = dialog.prompt("memory_records");
    dialog.answer(&frame, "undo 1");
    let frame = dialog.prompt("memory_undo_original");
    dialog.answer(&frame, "yes");
    let frame = dialog.prompt("request_id");
    dialog.answer(&frame, "memory-guide-undo");
    let frame = dialog.prompt("confirm_operation");
    dialog.answer(&frame, "UNDO");
    let frame = dialog.prompt("memory_records");
    assert_eq!(frame["choices"]["totalRecords"], 0);
    dialog.answer(&frame, "back");
    let frame = dialog.prompt("entry");
    dialog.answer(&frame, "quit");
    dialog.finish();
    assert!(
        ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    assert!(!f.root.path().join("model-requests").exists());
}
