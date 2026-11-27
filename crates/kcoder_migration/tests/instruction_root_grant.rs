//! The Native instruction producer accepts only explicit source and target authority.
use instruction_sources::InstructionSourceGrant;
use kcoder_config::{FolderTrustStore, PrivateDirectory};
use kcoder_migration::instruction_sources;
use kcoder_types::migration::MigrationSourceKind;
use std::{fs, path::PathBuf};
struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    project: PathBuf,
    cwd: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let project = root.path().join("project");
        let cwd = project.join("sub");
        PrivateDirectory::open_or_create(&profile).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        FolderTrustStore::load(&profile).trust(&project).unwrap();
        Self {
            _root: root,
            profile,
            project,
            cwd,
        }
    }
    fn capture(&self) -> InstructionSourceGrant {
        InstructionSourceGrant::capture(
            &self.profile,
            &self.project,
            &self.cwd,
            MigrationSourceKind::Codex,
        )
        .unwrap()
    }
}
#[test]
fn explicit_trusted_root_is_separate_from_cwd_and_does_not_grant_its_parent() {
    let f = Fixture::new();
    let grant = f.capture();
    grant.verify().unwrap();

    assert!(
        InstructionSourceGrant::capture(
            &f.profile,
            f._root.path(),
            &f.cwd,
            MigrationSourceKind::Codex
        )
        .is_err(),
        "trusted child does not grant the containing directory"
    );
    assert!(
        InstructionSourceGrant::capture(
            &f.profile,
            &f.project,
            &f.profile,
            MigrationSourceKind::Codex
        )
        .is_err()
    );
}
#[test]
fn revoke_and_same_path_root_replacement_cannot_refresh_source_authority() {
    for replace in [false, true] {
        let f = Fixture::new();
        let grant = f.capture();
        if replace {
            let old = f.project.with_extension("original");
            fs::rename(&f.project, &old).unwrap();
            fs::create_dir(&f.project).unwrap();
            fs::rename(old.join("sub"), &f.cwd).unwrap();
        } else {
            FolderTrustStore::load(&f.profile)
                .revoke(&f.project)
                .unwrap();
        }
        assert!(grant.verify().is_err());
    }
}
#[test]
fn a_new_profile_at_the_same_spelling_cannot_inherit_the_old_grant() {
    let f = Fixture::new();
    let grant = f.capture();
    let old = f.profile.with_extension("original");
    fs::rename(&f.profile, &old).unwrap();
    PrivateDirectory::open_or_create(&f.profile).unwrap();
    for entry in fs::read_dir(old).unwrap() {
        let entry = entry.unwrap();
        fs::rename(entry.path(), f.profile.join(entry.file_name())).unwrap();
    }
    assert!(grant.verify().is_err());
}

use instruction_sources::{
    InstructionDisposition, InstructionRole, InstructionSourcePolicy, InstructionSourceSnapshot,
    InstructionSourceSummary, InstructionTrigger,
};
fn source(f: &Fixture, relative: &str, content: &str) {
    let path = f.project.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}
fn snapshot(
    f: &Fixture,
    kind: MigrationSourceKind,
    policy: InstructionSourcePolicy,
) -> InstructionSourceSnapshot {
    InstructionSourceGrant::capture(&f.profile, &f.project, &f.cwd, kind)
        .unwrap()
        .capture_sources(&policy, |_| true)
        .unwrap()
}
#[test]
fn codex_root_to_cwd_override_fallback_and_nonempty_precedence_are_explicit() {
    let f = Fixture::new();
    fs::create_dir(f.project.join(".git")).unwrap();
    source(&f, "AGENTS.md", "ancestor\n");
    source(&f, "sub/AGENTS.override.md", " \n");
    source(&f, "sub/AGENTS.md", "child\n");
    source(&f, "sub/TEAM.md", "fallback\n");
    let s = snapshot(
        &f,
        MigrationSourceKind::Codex,
        InstructionSourcePolicy {
            codex_fallback_names: vec!["TEAM.md".into()],
            ..Default::default()
        },
    );
    let rows: Vec<InstructionSourceSummary> = s.summaries();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0].relative_path, "AGENTS.md");
    assert_eq!(rows[0].relative_scope, "");
    assert_eq!(rows[0].role, InstructionRole::Ordinary);
    assert_eq!(rows[0].disposition, InstructionDisposition::Selected);
    assert_eq!(rows[1].disposition, InstructionDisposition::Empty);
    assert_eq!(rows[2].disposition, InstructionDisposition::Selected);
    assert_eq!(rows[3].disposition, InstructionDisposition::Shadowed);
    assert_eq!(rows[2].trigger, InstructionTrigger::Launch);
    assert_eq!(rows[2].bytes, 6);
    assert!(s.complete_launch_chain());
    assert!(!s.dynamic_scope_present());
    s.verify_source(|_| true).unwrap();
    assert_eq!(&*s.original_bytes(&rows[0].id).unwrap(), b"ancestor\n");
}
#[test]
fn missing_override_and_marker_are_bound_and_cannot_silently_change_precedence() {
    for add_override in [false, true] {
        let f = Fixture::new();
        fs::create_dir(f.project.join(".git")).unwrap();
        source(&f, "AGENTS.md", "ancestor\n");
        source(&f, "sub/AGENTS.md", "child\n");
        let s = snapshot(&f, MigrationSourceKind::Codex, Default::default());
        if add_override {
            source(&f, "sub/AGENTS.override.md", "replacement\n");
        } else {
            fs::create_dir(f.cwd.join(".git")).unwrap();
        }
        assert!(s.verify_source(|_| true).is_err());
        assert_eq!(
            &*s.original_bytes(&s.summaries()[0].id).unwrap(),
            b"ancestor\n"
        );
    }
}
#[test]
fn no_marker_means_cwd_only_and_descendant_activation_is_vendor_specific() {
    for kind in [MigrationSourceKind::Codex, MigrationSourceKind::ClaudeCode] {
        let f = Fixture::new();
        let name = if kind == MigrationSourceKind::Codex {
            "AGENTS.md"
        } else {
            "CLAUDE.md"
        };
        source(&f, name, "ancestor\n");
        source(&f, &format!("sub/{name}"), "cwd\n");
        source(&f, &format!("sub/child/{name}"), "descendant\n");
        let s = snapshot(
            &f,
            kind,
            InstructionSourcePolicy {
                include_descendants: true,
                ..Default::default()
            },
        );
        let rows = s.summaries();
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows[0].disposition,
            if kind == MigrationSourceKind::Codex {
                InstructionDisposition::Shadowed
            } else {
                InstructionDisposition::Selected
            }
        );
        assert_eq!(
            rows[2].trigger,
            if kind == MigrationSourceKind::Codex {
                InstructionTrigger::OnCwd
            } else {
                InstructionTrigger::OnRead
            }
        );
        assert!(s.dynamic_scope_present());
    }
}
#[test]
fn claude_local_order_ambiguity_and_raw_source_are_preserved_without_flattening() {
    let f = Fixture::new();
    source(&f, "CLAUDE.md", "shared\n");
    source(&f, ".claude/CLAUDE.md", "also shared\n");
    source(&f, "CLAUDE.local.md", "local\n");
    source(&f, "sub/CLAUDE.md", "cwd\n");
    let s = snapshot(&f, MigrationSourceKind::ClaudeCode, Default::default());
    let rows = s.summaries();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0].disposition, InstructionDisposition::RequiresReview);
    assert_eq!(rows[1].disposition, InstructionDisposition::RequiresReview);
    assert_eq!(rows[2].role, InstructionRole::Local);
    assert_eq!(rows[2].disposition, InstructionDisposition::Selected);
    assert!(!s.complete_launch_chain());
    let json = serde_json::to_vec(&s).unwrap();
    let reopened: InstructionSourceSnapshot = serde_json::from_slice(&json).unwrap();
    fs::remove_dir_all(&f.project).unwrap();
    assert!(reopened.verify_source(|_| true).is_err());
    assert_eq!(&*reopened.original_bytes(&rows[2].id).unwrap(), b"local\n");
}
#[test]
fn cancellation_and_byte_budget_do_not_return_partial_compatible_snapshots() {
    let f = Fixture::new();
    source(&f, "sub/AGENTS.md", "bounded\n");
    let grant = f.capture();
    assert!(
        grant
            .capture_sources(&Default::default(), |_| false)
            .is_err()
    );
    let s = grant
        .capture_sources(
            &InstructionSourcePolicy {
                codex_max_bytes: 1,
                ..Default::default()
            },
            |_| true,
        )
        .unwrap();
    assert!(!s.complete_launch_chain());
    assert!(
        grant
            .capture_sources(
                &InstructionSourcePolicy {
                    codex_fallback_names: vec![".env".into()],
                    ..Default::default()
                },
                |_| true
            )
            .is_err()
    );
}

#[test]
fn compatible_records_publish_to_the_original_scoped_store_and_undo_after_source_removal() {
    use instruction_sources::{InstructionDestination, InstructionResolution};
    use kcoder_config::imported_context::{ImportedContextStore, imported_context_prompt};
    let f = Fixture::new();
    fs::create_dir(f.project.join(".git")).unwrap();
    source(&f, "AGENTS.md", "PARENT_SCOPE_MARKER\n");
    source(&f, "sub/AGENTS.override.md", "CHILD_OVERRIDE_MARKER\n");
    let s = snapshot(&f, MigrationSourceKind::Codex, Default::default());
    let target = f._root.path().join("target");
    fs::create_dir_all(target.join("sub")).unwrap();
    FolderTrustStore::load(&f.profile).trust(&target).unwrap();
    let destination = InstructionDestination::capture(&f.profile, &target).unwrap();
    let choices = s
        .summaries()
        .iter()
        .map(|row| InstructionResolution {
            id: row.id.clone(),
            name: format!("Guide {}", row.relative_path),
            target_relative_scope: row.relative_scope.clone(),
            enabled: true,
        })
        .collect::<Vec<_>>();
    let records = s
        .prepare_records(&destination, &choices, "explicit-static-import")
        .unwrap();
    let store = ImportedContextStore::open(&f.profile).unwrap();
    store.check_additions(&records).unwrap();
    for record in &records {
        store.create(record.clone()).unwrap();
    }
    assert!(
        imported_context_prompt(&f.profile, &target, true)
            .unwrap()
            .is_none(),
        "scoped guides cannot silently reenter the legacy after-native slot"
    );
    let session = store
        .instruction_session(
            &target.join("sub"),
            true,
            Some("EXISTING_NATIVE_BOUNDARY".into()),
            &[],
        )
        .unwrap()
        .unwrap();
    let prompt = session.before_native.unwrap();
    assert!(
        prompt.find("PARENT_SCOPE_MARKER").unwrap() < prompt.find("CHILD_OVERRIDE_MARKER").unwrap()
    );
    assert_eq!(
        session.native_context.as_deref(),
        Some("EXISTING_NATIVE_BOUNDARY")
    );
    let parent = store
        .instruction_session(&target, true, None, &[])
        .unwrap()
        .unwrap()
        .before_native
        .unwrap();
    assert!(parent.contains("PARENT_SCOPE_MARKER") && !parent.contains("CHILD_OVERRIDE_MARKER"));
    fs::remove_dir_all(&f.project).unwrap();
    let reopened = ImportedContextStore::open(&f.profile).unwrap();
    for record in &records {
        reopened.remove_owned(record).unwrap();
    }
    assert!(reopened.list().unwrap().is_empty());
}

#[test]
fn target_replacement_or_revoked_trust_cannot_refresh_a_saved_guide_mapping() {
    use instruction_sources::{InstructionDestination, InstructionResolution};
    let f = Fixture::new();
    source(&f, "sub/AGENTS.md", "scoped\n");
    let s = snapshot(&f, MigrationSourceKind::Codex, Default::default());
    let target = f._root.path().join("target");
    fs::create_dir(&target).unwrap();
    FolderTrustStore::load(&f.profile).trust(&target).unwrap();
    let destination = InstructionDestination::capture(&f.profile, &target).unwrap();
    let row = s.summaries().remove(0);
    let choices = vec![InstructionResolution {
        id: row.id,
        name: "scoped".into(),
        target_relative_scope: "".into(),
        enabled: true,
    }];
    FolderTrustStore::load(&f.profile).revoke(&target).unwrap();
    assert!(
        s.prepare_records(&destination, &choices, "explicit-import")
            .is_err()
    );
    FolderTrustStore::load(&f.profile).trust(&target).unwrap();
    fs::rename(&target, target.with_extension("old")).unwrap();
    fs::create_dir(&target).unwrap();
    assert!(
        s.prepare_records(&destination, &choices, "explicit-import")
            .is_err()
    );
}
