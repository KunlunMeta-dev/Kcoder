use super::*;
use sha2::{Digest, Sha256};

#[test]
fn expert_resources_load_entry_without_inlining_references_and_reject_changed_entry() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("references")).unwrap();
    let entry = root.path().join("SKILL.md");
    let body = "---\nname: resource-demo\ndescription: Read references when needed\n---\nRead references/routing.md";
    std::fs::write(&entry, body).unwrap();
    std::fs::write(
        root.path().join("references/routing.md"),
        "REFERENCE_BODY_ONLY_AFTER_READ",
    )
    .unwrap();
    let hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    let parsed = parse_pinned_skill_file(&entry, &hash).unwrap();
    assert!(parsed.references.is_empty());
    assert!(parsed.prompt_text().contains("Read references/routing.md"));
    assert!(
        !parsed
            .prompt_text()
            .contains("REFERENCE_BODY_ONLY_AFTER_READ")
    );
    assert_eq!(
        parse_skill_file(&entry).unwrap().references,
        ["REFERENCE_BODY_ONLY_AFTER_READ"]
    );
    std::fs::write(&entry, "Changed entry").unwrap();
    assert!(parse_pinned_skill_file(&entry, &hash).is_err());
}

#[test]
fn expert_resources_registry_refresh_and_removal_preserve_unrelated_skills() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join(".kcoder/skills/user");
    std::fs::create_dir_all(&folder).unwrap();
    let entry = folder.join("SKILL.md");
    std::fs::write(
        &entry,
        "---\nname: expert:user-owned\ndescription: User skill\n---\nUser rules",
    )
    .unwrap();
    let mut registry = SkillRegistry::load_project_only(root.path()).unwrap();
    let mut runtime = parse_skill_file_lazy(&entry).unwrap();
    runtime.name = "expert:runtime-snapshot".into();
    registry.insert_runtime_skill(runtime).unwrap();
    let mut refreshed = registry
        .reload_with_external_dirs(root.path(), std::iter::empty::<PathBuf>())
        .unwrap();
    assert!(refreshed.get("expert:runtime-snapshot").is_some());
    refreshed.clear_runtime_expert_skills();
    assert!(refreshed.get("expert:runtime-snapshot").is_none());
    assert!(refreshed.get("expert:user-owned").is_some());
    assert!(registry.get("expert:runtime-snapshot").is_some());
}
