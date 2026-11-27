//! KCoder-owned offline evaluation catalog for shipped skills.
//!
//! Vendored skills keep their upstream layout, so their `evals.json` cases
//! cannot live in the skill directories. The catalog in
//! `skills/.evals/<skill-name>/evals.json` (skill-creator format) is embedded
//! at build time; `build.rs` only accepts names of shipped skills. The bytes
//! are returned unparsed: the evaluation runner owns parsing and rejects a
//! malformed entry without failing the evaluation.

include!(concat!(env!("OUT_DIR"), "/bundled_evals.rs"));

/// Embedded catalog `evals.json` of a shipped skill, if any. Callers must
/// apply it only to the bundled copy of that skill, never to a user, project,
/// Hub or plugin skill that happens to share the name.
pub fn bundled_eval_catalog(name: &str) -> Option<&'static [u8]> {
    BUNDLED_EVAL_CATALOG
        .iter()
        .find(|(skill, _)| *skill == name)
        .map(|(_, bytes)| *bytes)
}

/// Skill names that have a catalog entry, in sorted order.
pub fn bundled_eval_catalog_names() -> impl Iterator<Item = &'static str> {
    BUNDLED_EVAL_CATALOG.iter().map(|(name, _)| *name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const EXPECTED: &[&str] = &[
        "docx",
        "kcoder-settings",
        "lark-base",
        "lark-calendar",
        "lark-doc",
        "lark-im",
        "lark-sheets",
        "pdf",
        "pptx",
        "xlsx",
    ];

    #[test]
    fn catalog_covers_the_important_shipped_skills() {
        let names: Vec<&str> = bundled_eval_catalog_names().collect();
        assert_eq!(names, EXPECTED);
        let shipped: std::collections::BTreeSet<&str> = crate::bundled_assets::names()
            .into_iter()
            .chain(crate::builtin::skill_names())
            .collect();
        for name in &names {
            assert!(shipped.contains(name), "{name} is not a shipped skill");
        }
        assert!(bundled_eval_catalog("not-a-skill").is_none());
    }

    #[test]
    fn catalog_entries_are_workspace_independent_skill_creator_cases() {
        for name in bundled_eval_catalog_names() {
            let bytes = bundled_eval_catalog(name).unwrap();
            let document: Value = serde_json::from_slice(bytes)
                .unwrap_or_else(|error| panic!("{name}: invalid JSON: {error}"));
            assert_eq!(document["skill_name"], name, "{name}: skill_name");
            let evals = document["evals"].as_array().expect("evals array");
            assert!(
                (4..=6).contains(&evals.len()),
                "{name}: {} cases",
                evals.len()
            );
            let mut ids = std::collections::BTreeSet::new();
            for case in evals {
                let id = case["id"].as_u64().expect("integer id");
                assert!(ids.insert(id), "{name}: duplicate id {id}");
                let prompt = case["prompt"].as_str().unwrap_or_default();
                assert!(!prompt.trim().is_empty(), "{name}#{id}: empty prompt");
                assert!(
                    prompt.len() <= 8 * 1024,
                    "{name}#{id}: prompt exceeds the case budget"
                );
                // Catalog cases carry no input files: they must run without
                // a workspace and be judged on the generated text alone.
                assert!(case.get("files").is_none(), "{name}#{id}: files");
                assert!(
                    case["expected_output"]
                        .as_str()
                        .is_some_and(|text| !text.trim().is_empty()),
                    "{name}#{id}: expected_output"
                );
                let expectations = case["expectations"].as_array().expect("expectations");
                assert!(
                    !expectations.is_empty() && expectations.len() <= 16,
                    "{name}#{id}: expectations"
                );
                for assertion in case["assertions"].as_array().into_iter().flatten() {
                    let object = assertion.as_object().expect("assertion object");
                    assert_eq!(object.len(), 1, "{name}#{id}: one check per assertion");
                    let (kind, value) = object.iter().next().unwrap();
                    match kind.as_str() {
                        "contains" | "not_contains" => {
                            assert!(value.as_str().is_some_and(|text| !text.is_empty()))
                        }
                        "max_chars" | "min_chars" => assert!(value.as_u64().is_some()),
                        other => panic!("{name}#{id}: unknown assertion {other}"),
                    }
                }
                let text = serde_json::to_string(case).unwrap().to_lowercase();
                for secret in ["app_secret", "bearer ", "-----begin", "access_token="] {
                    assert!(!text.contains(secret), "{name}#{id}: secret-like {secret}");
                }
            }
        }
    }
}
