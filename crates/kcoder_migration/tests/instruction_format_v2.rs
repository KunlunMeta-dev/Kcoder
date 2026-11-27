//! Explicit format-v2 interprets owned static files without altering sealed version-one recipes.
use kcoder_config::{PrivateDirectory, imported_context::ImportedContextStore};
use kcoder_migration::{
    asset_sources::AssetBundleBinding,
    assets::{AssetResolution, AssetTarget},
    batch::{BatchResolution, BatchSource},
    instruction_sources::{
        InstructionDestination, InstructionDisposition, InstructionResolution,
        InstructionSourceGrant, InstructionSourcePolicy, InstructionSourceSnapshot,
    },
    mcp::McpTarget,
    providers::ProviderTarget,
    store::{BatchTargets, MigrationStore},
};
use kcoder_types::migration::{MigrationJobStatus, MigrationSourceKind as Kind};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, sync::Arc};
struct Fixture {
    root: tempfile::TempDir,
    profile: PathBuf,
    source: PathBuf,
    target: PathBuf,
    kind: Kind,
}
impl Fixture {
    fn new(kind: Kind) -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let source = root.path().join("source");
        let target = root.path().join("target");
        PrivateDirectory::open_or_create(&profile).unwrap();
        fs::write(profile.join("settings.json"), "{}").unwrap();
        fs::create_dir_all(source.join(".git")).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(
            profile.join("trusted-folders.json"),
            serde_json::json!({"trusted":[source,target],"never":[]}).to_string(),
        )
        .unwrap();
        Self {
            root,
            profile,
            source,
            target,
            kind,
        }
    }
    fn name(&self) -> &'static str {
        if self.kind == Kind::Codex {
            "AGENTS.md"
        } else {
            "CLAUDE.md"
        }
    }
    fn write(&self, body: &str) {
        fs::write(self.source.join(self.name()), body).unwrap();
    }
    fn grant(&self) -> InstructionSourceGrant {
        InstructionSourceGrant::capture(&self.profile, &self.source, &self.source, self.kind)
            .unwrap()
    }
    fn v2(&self) -> InstructionSourceSnapshot {
        self.grant()
            .capture_static_sources(&InstructionSourcePolicy::default(), true, |_| true)
            .unwrap()
    }
    fn records(
        &self,
        snapshot: &InstructionSourceSnapshot,
    ) -> anyhow::Result<Vec<kcoder_config::imported_context::ImportedContext>> {
        let destination = InstructionDestination::capture(&self.profile, &self.target)?;
        snapshot.prepare_records(
            &destination,
            &[InstructionResolution {
                id: snapshot.summaries()[0].id.clone(),
                name: "Reviewed static guide".into(),
                target_relative_scope: String::new(),
                enabled: true,
            }],
            "format-v2-owned-source",
        )
    }
}
#[test]
fn codex_plain_markdown_has_no_skill_metadata_or_import_dsl_and_old_v1_stays_unchanged() {
    let f = Fixture::new(Kind::Codex);
    let body = "---\nname: Plain Markdown heading\npermissions: source text, never native authority\n---\n@literal-not-an-import.md\nEmail user@example.invalid\n";
    f.write(body);
    let old = f
        .grant()
        .capture_sources(&InstructionSourcePolicy::default(), |_| true)
        .unwrap();
    let sealed = serde_json::to_vec(&old).unwrap();
    assert_eq!(
        old.summaries()[0].disposition,
        InstructionDisposition::RequiresReview
    );
    assert!(f.records(&old).is_err());
    let new = f.v2();
    assert_eq!(new.format_revision(), "scoped-instructions/v2");
    assert_ne!(
        new.semantic_revision().unwrap(),
        old.semantic_revision().unwrap()
    );
    assert_eq!(
        new.summaries()[0].disposition,
        InstructionDisposition::Selected
    );
    let record = f.records(&new).unwrap().remove(0);
    assert_eq!(record.content, body);
    assert!(
        record
            .instruction_provenance
            .unwrap()
            .source_file_identity
            .is_some()
    );
    let reopened: InstructionSourceSnapshot = serde_json::from_slice(&sealed).unwrap();
    assert_eq!(serde_json::to_vec(&reopened).unwrap(), sealed);
    assert!(f.records(&reopened).is_err());
    assert_eq!(
        *new.original_bytes(&new.summaries()[0].id).unwrap(),
        body.as_bytes()
    );
}

#[test]
fn claude_actual_dependencies_and_comments_flow_through_normal_batch_preview_publish_and_owned_undo()
 {
    let f = Fixture::new(Kind::ClaudeCode);
    let body = "<!-- HIDDEN_MAINTAINER_NOTE @../outside.md -->\nSee @docs/guide.md\n\n`@literal.md`\n\n```md\n@code.md\n<!-- CODE_COMMENT_VISIBLE -->\n```\n";
    f.write(body);
    fs::create_dir(f.source.join("docs")).unwrap();
    fs::write(
        f.source.join("docs/guide.md"),
        "STATIC_DEPENDENCY_ONE\n@nested.md\n",
    )
    .unwrap();
    fs::write(f.source.join("docs/nested.md"), "STATIC_DEPENDENCY_TWO\n").unwrap();
    fs::write(
        f.root.path().join("outside.md"),
        "OUTSIDE_SECRET_MUST_NOT_BE_READ",
    )
    .unwrap();
    let snapshot = Arc::new(f.v2());
    let compiled_preview = snapshot.compiled_text(&snapshot.summaries()[0].id).unwrap();
    assert!(
        compiled_preview.contains("STATIC_DEPENDENCY_TWO")
            && !compiled_preview.contains("HIDDEN_MAINTAINER_NOTE")
    );
    assert_eq!(
        snapshot.summaries()[0].disposition,
        InstructionDisposition::Selected
    );
    let document = serde_json::to_value(snapshot.as_ref()).unwrap();
    assert_eq!(document["sources"].as_array().unwrap().len(), 3);
    assert!(
        !document["observations"]
            .as_object()
            .unwrap()
            .keys()
            .any(|path| path.contains("outside") || path.contains("literal") || path == "code.md")
    );
    let binding = AssetBundleBinding::capture_scoped_instructions(
        &f.profile,
        &f.target,
        snapshot.clone(),
        &[(snapshot.summaries()[0].id.clone(), String::new())],
        false,
    )
    .unwrap();
    assert_eq!(
        binding.inventory().unwrap().adapter_revision,
        "scoped-instructions/v2"
    );
    let store = MigrationStore::open_or_create(&f.profile).unwrap();
    let job = store
        .create_batch_scan(vec![BatchSource::Assets(binding)])
        .unwrap();
    let item = &job.inventory.items[0];
    let providers = ProviderTarget::open(&f.profile).unwrap();
    let mcp = McpTarget::open(&f.profile).unwrap();
    let assets = AssetTarget::open(&f.profile).unwrap();
    let targets = BatchTargets {
        provider: &providers,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
        history: None,
    };
    let planned = store
        .prepare_batch(
            &job.job_id,
            job.sequence,
            &[BatchResolution::Asset(AssetResolution {
                agent_adaptation: None,
                item_id: item.preview.id.clone(),
                target_name: "Scoped expanded guide".into(),
                enable_after_import: true,
                memory_scope: None,
            })],
            &targets,
        )
        .unwrap();
    let plan = planned.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
    let applied = store
        .run_batch(
            &job.job_id,
            plan,
            "v2-static-import",
            planned.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(applied.status, MigrationJobStatus::Completed);
    let record = ImportedContextStore::open(&f.profile)
        .unwrap()
        .list()
        .unwrap()
        .remove(0);
    assert_eq!(record.content, compiled_preview);
    assert_eq!(
        store
            .instruction_compiled_snapshot(&job.job_id, &item.preview.id)
            .unwrap()
            .unwrap(),
        compiled_preview
    );
    assert!(
        record.content.contains("STATIC_DEPENDENCY_ONE")
            && record.content.contains("STATIC_DEPENDENCY_TWO")
    );
    assert!(
        record.content.contains("`@literal.md`")
            && record.content.contains("@code.md")
            && record.content.contains("CODE_COMMENT_VISIBLE")
    );
    assert!(
        !record.content.contains("HIDDEN_MAINTAINER_NOTE")
            && !record.content.contains("OUTSIDE_SECRET")
    );
    let origin = record.instruction_provenance.as_ref().unwrap();
    assert!(
        origin.source_file_identity.is_none(),
        "raw-file evidence must not deduplicate transformed context"
    );
    assert_eq!(
        origin.source_sha256,
        format!("{:x}", Sha256::digest(body.as_bytes()))
    );
    let context = ImportedContextStore::open(&f.profile)
        .unwrap()
        .instruction_session(&f.target, true, Some("Native guide boundary".into()), &[])
        .unwrap()
        .unwrap();
    assert!(
        context
            .before_native
            .unwrap()
            .contains("STATIC_DEPENDENCY_TWO")
    );
    assert_eq!(
        store
            .instruction_source_snapshot(&job.job_id, &item.preview.id)
            .unwrap()
            .unwrap(),
        body.as_bytes()
    );
    fs::rename(&f.source, f.source.with_extension("withheld")).unwrap();
    let reopened = MigrationStore::open_existing(&f.profile).unwrap();
    assert_eq!(
        reopened
            .instruction_compiled_snapshot(&job.job_id, &item.preview.id)
            .unwrap()
            .unwrap(),
        compiled_preview
    );
    assert_eq!(
        reopened
            .instruction_source_snapshot(&job.job_id, &item.preview.id)
            .unwrap()
            .unwrap(),
        body.as_bytes()
    );
    let undone = reopened
        .run_batch(
            &job.job_id,
            plan,
            "v2-static-undo",
            applied.sequence,
            true,
            &targets,
        )
        .unwrap();
    assert_eq!(undone.status, MigrationJobStatus::RolledBack);
    assert!(
        ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        "{}"
    );
}

#[test]
fn missing_external_private_and_recursive_imports_remain_pending_without_reading_unauthorized_paths()
 {
    for (body, extra) in [
        ("Use @missing.md", None),
        ("Use @../outside.md", None),
        ("Use @auth.json", None),
        ("Use @${ROOT}/dynamic.md", None),
        ("Use @a.md", Some(("a.md", "Again @CLAUDE.md"))),
    ] {
        let f = Fixture::new(Kind::ClaudeCode);
        f.write(body);
        fs::write(f.root.path().join("outside.md"), "OUTSIDE_SECRET").unwrap();
        fs::write(f.source.join("auth.json"), "AUTH_SECRET").unwrap();
        fs::create_dir(f.source.join("${ROOT}")).unwrap();
        fs::write(
            f.source.join("${ROOT}/dynamic.md"),
            "DYNAMIC_PROPOSAL_MUST_NOT_BE_READ",
        )
        .unwrap();
        if let Some((name, body)) = extra {
            fs::write(f.source.join(name), body).unwrap();
        }
        let snapshot = f.v2();
        assert_eq!(
            snapshot.summaries()[0].disposition,
            InstructionDisposition::RequiresReview
        );
        assert!(
            snapshot.summaries()[0]
                .reason_code
                .as_ref()
                .is_some_and(|code| code.starts_with("migration_instruction_"))
        );
        assert!(f.records(&snapshot).is_err());
        let value = serde_json::to_value(&snapshot).unwrap();
        assert!(
            !value["observations"]
                .as_object()
                .unwrap()
                .keys()
                .any(|key| key.contains("outside")
                    || key == "auth.json"
                    || key.contains("${ROOT}"))
        );
        if body.contains("missing") {
            fs::write(
                f.source.join("missing.md"),
                "New file must not refresh the original capture.",
            )
            .unwrap();
            assert!(snapshot.verify_source(|_| true).is_err());
        }
    }
}

#[test]
fn codex_ignored_ancestor_does_not_block_the_authorized_project_chain_in_new_format() {
    let f = Fixture::new(Kind::Codex);
    fs::write(f.source.join("AGENTS.md"), [0xff, 0xfe]).unwrap();
    let project = f.source.join("nested-project");
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::write(project.join("AGENTS.md"), "Known nearest project guide.").unwrap();
    let grant =
        InstructionSourceGrant::capture(&f.profile, &f.source, &project, Kind::Codex).unwrap();
    let old = grant
        .capture_sources(&InstructionSourcePolicy::default(), |_| true)
        .unwrap();
    assert!(!old.complete_launch_chain());
    let new = grant
        .capture_static_sources(&InstructionSourcePolicy::default(), true, |_| true)
        .unwrap();
    assert!(new.complete_launch_chain());
    assert_eq!(
        new.summaries()[0].disposition,
        InstructionDisposition::Shadowed
    );
    let selected = new
        .summaries()
        .into_iter()
        .find(|row| row.disposition == InstructionDisposition::Selected)
        .unwrap();
    assert_eq!(selected.relative_path, "nested-project/AGENTS.md");
    let destination = InstructionDestination::capture(&f.profile, &f.target).unwrap();
    let records = new
        .prepare_records(
            &destination,
            &[InstructionResolution {
                id: selected.id,
                name: "Nearest project guide".into(),
                target_relative_scope: String::new(),
                enabled: false,
            }],
            "new-format-project-chain",
        )
        .unwrap();
    assert_eq!(records[0].content, "Known nearest project guide.");
}

#[test]
fn four_hops_are_bounded_and_appearance_or_change_never_refreshes_a_captured_dependency() {
    let f = Fixture::new(Kind::ClaudeCode);
    f.write("@a.md");
    for (name, body) in [
        ("a.md", "@b.md"),
        ("b.md", "@c.md"),
        ("c.md", "@d.md"),
        ("d.md", "Fourth hop content."),
    ] {
        fs::write(f.source.join(name), body).unwrap();
    }
    let valid = f.v2();
    assert_eq!(
        valid.summaries()[0].disposition,
        InstructionDisposition::Selected
    );
    assert_eq!(f.records(&valid).unwrap()[0].content, "Fourth hop content.");
    fs::write(f.source.join("d.md"), "@e.md").unwrap();
    fs::write(f.source.join("e.md"), "Fifth hop must not be read.").unwrap();
    assert!(valid.verify_source(|_| true).is_err());
    let limited = f.v2();
    assert_eq!(
        limited.summaries()[0].disposition,
        InstructionDisposition::RequiresReview
    );
    let value = serde_json::to_value(limited).unwrap();
    assert!(
        !value["observations"]
            .as_object()
            .unwrap()
            .contains_key("e.md")
    );
}

#[test]
fn explicit_static_subset_consent_and_cancellation_precede_any_target_publication() {
    let f = Fixture::new(Kind::ClaudeCode);
    f.write("Ordinary guide.");
    let grant = f.grant();
    let mut called = false;
    assert!(
        grant
            .capture_static_sources(&InstructionSourcePolicy::default(), false, |_| {
                called = true;
                true
            })
            .is_err()
    );
    assert!(!called);
    assert!(
        grant
            .capture_static_sources(&InstructionSourcePolicy::default(), true, |_| false)
            .is_err()
    );
    assert!(
        ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    assert!(!f.profile.join("migrations").exists());
}

#[test]
fn repeated_shared_imports_cannot_amplify_the_compiled_bundle_beyond_the_original_byte_budget() {
    let f = Fixture::new(Kind::ClaudeCode);
    f.write("@shared.md");
    fs::write(f.source.join("shared.md"), "Z".repeat(4 * 1024 * 1024)).unwrap();
    for n in 0..4 {
        let child = f.source.join(format!("child{n}"));
        fs::create_dir(&child).unwrap();
        fs::write(child.join("CLAUDE.md"), "@../shared.md").unwrap();
    }
    let snapshot = f
        .grant()
        .capture_static_sources(
            &InstructionSourcePolicy {
                include_descendants: true,
                ..Default::default()
            },
            true,
            |_| true,
        )
        .unwrap();
    assert!(
        snapshot
            .summaries()
            .iter()
            .all(|row| row.disposition == InstructionDisposition::Selected)
    );
    let choices = snapshot
        .summaries()
        .into_iter()
        .enumerate()
        .map(|(n, row)| InstructionResolution {
            id: row.id,
            name: format!("Expanded guide {n}"),
            target_relative_scope: String::new(),
            enabled: false,
        })
        .collect::<Vec<_>>();
    let destination = InstructionDestination::capture(&f.profile, &f.target).unwrap();
    let error = snapshot
        .prepare_records(&destination, &choices, "bounded-static-expansion")
        .expect_err("5 repeated 4MiB contexts must not allocate an unbounded bundle");
    assert_eq!(
        error.to_string(),
        "migration_instruction_selection_budget_exceeded"
    );
    assert!(
        ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}
