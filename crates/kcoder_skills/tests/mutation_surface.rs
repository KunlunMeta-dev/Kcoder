use std::fs;
use std::path::PathBuf;

fn workspace_root() -> PathBuf {
    PathBuf::from(
        std::env::var_os("KCODER_WORKSPACE_ROOT").expect("Cargo 应提供当前 KCoder 工作区根目录"),
    )
}

fn production_source(relative: &str) -> String {
    let source = fs::read_to_string(workspace_root().join(relative)).unwrap();
    source
        .rfind("#[cfg(test)]\nmod tests")
        .map(|index| source[..index].to_string())
        .unwrap_or(source)
}

#[test]
fn native_skill_writers_do_not_bypass_skill_store() {
    let fully_managed = [
        "crates/kcoder_tools/src/skill_manage.rs",
        "crates/kcoder_tools/src/skill_hub.rs",
        "crates/kcoder_tools/src/bundled_skills.rs",
        "crates/kcoder_skills/src/builtin.rs",
        "crates/kcoder_engine/src/skill_maintenance_runtime.rs",
    ];
    let forbidden = [
        "std::fs::rename(",
        "std::fs::remove_file(",
        "std::fs::remove_dir_all(",
        "std::fs::write(",
        "fs::rename(",
        "fs::remove_file(",
        "fs::remove_dir_all(",
        "fn atomic_write(",
    ];
    for relative in fully_managed {
        let source = production_source(relative);
        for needle in forbidden {
            assert!(
                !source.contains(needle),
                "native Skill writer {relative} bypasses SkillStore with {needle}"
            );
        }
    }

    let curator = production_source("crates/kcoder_tools/src/skill_curator.rs");
    for needle in [
        "std::fs::rename(",
        "fs::rename(",
        "root.join(\".curator.log\")",
        "save_store(root, &usage)",
    ] {
        assert!(
            !curator.contains(needle),
            "curator live mutation bypasses SkillStore with {needle}"
        );
    }

    let specs = production_source("crates/kcoder_specs/src/lib.rs");
    for needle in [
        "fs::write(&skill_path",
        "fs::create_dir_all(&skill_dir)",
        "write_bundled_skill_asset",
    ] {
        assert!(
            !specs.contains(needle),
            "spec-derived Skill mutation bypasses SkillStore with {needle}"
        );
    }
    let spec_tools = production_source("crates/kcoder_tools/src/specs.rs");
    assert!(!spec_tools.contains("fn atomic_write("));
}
