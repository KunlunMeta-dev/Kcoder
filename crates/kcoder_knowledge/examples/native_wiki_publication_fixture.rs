//! Model-independent Wiki material for the registered owned Studio acceptance run.
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope};
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, io::Read, path::Path};

const SUITE: &str = "apps/kcoder-studio/e2e/suites/browser/memory-native-management.e2e.mjs";
const MATERIAL: &str = "Deterministic Wiki page fixture. No model generated this material.";
const BUSINESS_SUITE: &str =
    "apps/kcoder-studio/e2e/suites/model/real-model-business-templates.e2e.mjs";
const BUSINESS_TEST: &str = "native-six-business-templates-live-model-current-sources";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Corpus {
    version: String,
    pages: Vec<CorpusPage>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CorpusPage {
    id: String,
    title: String,
    markdown: String,
}

fn read_json(directory: &PrivateDirectory, name: &str) -> Result<Value> {
    let mut bytes = Vec::new();
    directory
        .open_single_link_regular_file(OsStr::new(name))?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 64 * 1024, "fixture metadata is too large");
    Ok(serde_json::from_slice(&bytes)?)
}

fn seed_owned_run(run_root: &Path) -> Result<Value> {
    let run_root = run_root.canonicalize()?;
    let run = PrivateDirectory::open_existing(&run_root)?;
    let manifest = read_json(&run, "manifest.json")?;
    let business = manifest["source"] == BUSINESS_SUITE
        && manifest["testId"] == BUSINESS_TEST
        && manifest["modelPolicy"] == "real-model-required";
    ensure!(
        ((manifest["source"] == SUITE
            && manifest["testId"] == "native-memory-review-through-authenticated-studio")
            || business)
            && manifest["status"] == "running"
            && manifest["seed"]
                .as_str()
                .is_some_and(|seed| seed.len() == 16)
            && manifest["temporaryDirectories"]
                .as_array()
                .is_some_and(|paths| paths.iter().any(|path| path == "state")),
        "fixture requires its active registered RunContext"
    );
    let state = run.open_child(OsStr::new("state"), false)?;
    let profile_name = if business {
        "real-model-config"
    } else {
        "profile"
    };
    let profile = state.open_child(OsStr::new(profile_name), false)?;
    let settings = read_json(&profile, "settings.json")?;
    ensure!(
        settings["providers"]
            .as_object()
            .is_some_and(|map| map.is_empty())
            && settings["knowledge"]["enabled"] == true
            && settings["integrations"]["knowledge"]["publications_enabled"] == true,
        "fixture requires its model-independent isolated settings"
    );
    ensure!(
        profile
            .entry_metadata(OsStr::new("knowledge"))
            .is_err_and(|error| {
                error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            }),
        "fixture refuses an existing Wiki namespace"
    );
    let knowledge = profile.create_private_child(OsStr::new("knowledge"))?;
    let profile_path = run_root.join("state").join(profile_name);
    ensure!(
        PrivateDirectory::open_existing(&profile_path)?.directory_identity()?
            == profile.directory_identity()?,
        "fixture profile identity changed"
    );
    let scope = KnowledgeScope::from_authenticated_host(
        &format!("profile:{}", profile_path.display()),
        "execution-host",
    )?;
    let mut store = KnowledgeCatalog::open(&profile_path.join("knowledge/state.sqlite"))?;
    let library = store.create(
        &scope,
        "owned-fixture-library",
        if business {
            "Native business quality corpus"
        } else {
            "Native publication fixture"
        },
        "",
    )?;
    if business {
        let corpus: Corpus =
            serde_json::from_str(include_str!("fixtures/business-template-corpus.json"))?;
        ensure!(
            corpus.version == "business-template-corpus-v1" && corpus.pages.len() == 9,
            "invalid business corpus version"
        );
        let mut ids = std::collections::HashSet::new();
        let mut committed = Vec::new();
        for page in corpus.pages {
            ensure!(
                !page.id.is_empty()
                    && page.id.len() <= 64
                    && page
                        .id
                        .bytes()
                        .all(|value| value.is_ascii_lowercase() || value == b'-')
                    && ids.insert(page.id.clone())
                    && !page.title.is_empty()
                    && page.title.len() <= 256
                    && !page.markdown.is_empty()
                    && page.markdown.len() <= 8192,
                "invalid business corpus page"
            );
            let source = store.import_text(
                &scope,
                &library.id,
                &format!("owned-source-{}", page.id),
                &format!("{}.md", page.id),
                &page.markdown,
            )?;
            let pages = store.commit_generated_pages(
                &scope,
                &library.id,
                &format!("owned-page-{}", page.id),
                vec![KnowledgePageDraft {
                    page_id: uuid::Uuid::new_v4().to_string(),
                    expected_revision: None,
                    kind: KnowledgePageKind::Concept,
                    title: page.title.clone(),
                    markdown: page.markdown.clone(),
                    citations: vec![KnowledgeCitation {
                        source_id: source.source_id,
                        revision_id: source.revision_id,
                        chunk_id: "chunk-1".into(),
                        quote: page.markdown.clone(),
                    }],
                    related_page_ids: vec![],
                }],
            )?;
            committed.push(json!({"id":page.id,"title":page.title,"pageId":pages[0].page_id,"pageRevision":pages[0].revision_id,
                "markdownSha256":format!("{:x}",Sha256::digest(page.markdown.as_bytes()))}));
        }
        knowledge.verify_private_directory()?;
        profile.verify_private_directory()?;
        return Ok(
            json!({"fixtureOnly":true,"modelCalls":0,"corpusVersion":corpus.version,"libraryId":library.id,"pages":committed}),
        );
    }
    let source = store.import_text(
        &scope,
        &library.id,
        "owned-fixture-source",
        "Fixture evidence.md",
        MATERIAL,
    )?;
    let pages = store.commit_generated_pages(
        &scope,
        &library.id,
        "owned-fixture-page",
        vec![KnowledgePageDraft {
            page_id: uuid::Uuid::new_v4().to_string(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "Native publication evidence page".into(),
            markdown: MATERIAL.into(),
            citations: vec![KnowledgeCitation {
                source_id: source.source_id,
                revision_id: source.revision_id,
                chunk_id: "chunk-1".into(),
                quote: MATERIAL.into(),
            }],
            related_page_ids: vec![],
        }],
    )?;
    knowledge.verify_private_directory()?;
    profile.verify_private_directory()?;
    Ok(
        json!({"fixtureOnly":true,"modelCalls":0,"libraryId":library.id,
        "pageId":pages[0].page_id,"pageRevision":pages[0].revision_id}),
    )
}

fn main() -> Result<()> {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    ensure!(
        arguments.len() == 2 && arguments[0] == "--run-root",
        "use --run-root <active-owned-run>"
    );
    println!("{}", seed_owned_run(Path::new(&arguments[1]))?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owned_run() -> Result<tempfile::TempDir> {
        let temporary = tempfile::tempdir()?;
        let root = PrivateDirectory::open_existing(temporary.path())?;
        root.atomic_replace(
            OsStr::new("manifest.json"),
            &serde_json::to_vec(&json!({
                "source":SUITE,"testId":"native-memory-review-through-authenticated-studio",
                "status":"running","seed":"0123456789abcdef","temporaryDirectories":["state"]
            }))?,
        )?;
        let state = root.create_private_child(OsStr::new("state"))?;
        let profile = state.create_private_child(OsStr::new("profile"))?;
        profile.atomic_replace(OsStr::new("settings.json"), br#"{"providers":{},"knowledge":{"enabled":true},"integrations":{"knowledge":{"publications_enabled":true}}}"#)?;
        Ok(temporary)
    }
    #[test]
    fn registered_owned_run_gets_a_real_immutable_page_and_cannot_overwrite_existing_wiki()
    -> Result<()> {
        let root = owned_run()?;
        let result = seed_owned_run(root.path())?;
        assert_eq!(result["fixtureOnly"], true);
        assert_eq!(result["modelCalls"], 0);
        assert!(
            result["pageRevision"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );
        let path = root.path().join("state/profile/knowledge/state.sqlite");
        let scope = KnowledgeScope::from_authenticated_host(
            &format!("profile:{}", root.path().join("state/profile").display()),
            "execution-host",
        )?;
        let store = KnowledgeCatalog::open(&path)?;
        let page = store.read_page(
            &scope,
            result["libraryId"].as_str().unwrap(),
            result["pageId"].as_str().unwrap(),
            result["pageRevision"].as_str(),
        )?;
        assert_eq!(page.draft.markdown, MATERIAL);
        assert_eq!(page.draft.citations.len(), 1);
        assert_eq!(page.draft.citations[0].quote, MATERIAL);
        drop(store);
        let before = std::fs::read(&path)?;
        assert!(seed_owned_run(root.path()).is_err());
        assert_eq!(std::fs::read(path)?, before);
        Ok(())
    }
    #[test]
    fn registered_business_run_commits_nine_fixed_pages_without_reading_credentials() -> Result<()>
    {
        let root = owned_run()?;
        std::fs::rename(
            root.path().join("state/profile"),
            root.path().join("state/real-model-config"),
        )?;
        let directory = PrivateDirectory::open_existing(root.path())?;
        let mut manifest = read_json(&directory, "manifest.json")?;
        manifest["source"] = json!(BUSINESS_SUITE);
        manifest["testId"] = json!(BUSINESS_TEST);
        manifest["modelPolicy"] = json!("real-model-required");
        directory.atomic_replace(OsStr::new("manifest.json"), &serde_json::to_vec(&manifest)?)?;
        let profile = root.path().join("state/real-model-config");
        let credential = profile.join("credentials.json");
        std::fs::write(&credential, "PRIVATE_FIXTURE_CREDENTIAL_CANARY")?;
        let committed = seed_owned_run(root.path())?;
        assert_eq!(committed["modelCalls"], 0);
        assert_eq!(committed["pages"].as_array().unwrap().len(), 9);
        assert!(
            !committed
                .to_string()
                .contains("PRIVATE_FIXTURE_CREDENTIAL_CANARY")
        );
        assert_eq!(
            std::fs::read_to_string(credential)?,
            "PRIVATE_FIXTURE_CREDENTIAL_CANARY"
        );
        let corpus: Corpus =
            serde_json::from_str(include_str!("fixtures/business-template-corpus.json"))?;
        let scope = KnowledgeScope::from_authenticated_host(
            &format!("profile:{}", profile.display()),
            "execution-host",
        )?;
        let store = KnowledgeCatalog::open(&profile.join("knowledge/state.sqlite"))?;
        for expected in corpus.pages {
            let reference = committed["pages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|page| page["id"] == expected.id)
                .unwrap();
            let page = store.read_page(
                &scope,
                committed["libraryId"].as_str().unwrap(),
                reference["pageId"].as_str().unwrap(),
                reference["pageRevision"].as_str(),
            )?;
            assert_eq!(page.draft.markdown, expected.markdown);
            assert_eq!(
                reference["markdownSha256"],
                format!("{:x}", Sha256::digest(page.draft.markdown.as_bytes()))
            );
            assert_eq!(page.draft.citations[0].quote, expected.markdown);
        }
        assert!(seed_owned_run(root.path()).is_err());
        Ok(())
    }
    #[test]
    fn missing_or_terminal_run_context_never_initializes_a_profile() -> Result<()> {
        let missing = tempfile::tempdir()?;
        assert!(seed_owned_run(missing.path()).is_err());
        assert!(!missing.path().join("state").exists());
        let root = owned_run()?;
        let directory = PrivateDirectory::open_existing(root.path())?;
        let mut manifest = read_json(&directory, "manifest.json")?;
        manifest["status"] = json!("passed");
        directory.atomic_replace(OsStr::new("manifest.json"), &serde_json::to_vec(&manifest)?)?;
        assert!(seed_owned_run(root.path()).is_err());
        assert!(!root.path().join("state/profile/knowledge").exists());
        manifest["status"] = json!("running");
        manifest["source"] = json!("unrelated-suite.mjs");
        directory.atomic_replace(OsStr::new("manifest.json"), &serde_json::to_vec(&manifest)?)?;
        assert!(seed_owned_run(root.path()).is_err());
        assert!(!root.path().join("state/profile/knowledge").exists());
        Ok(())
    }
}
