    use super::*;

    fn test_workspace_root() -> PathBuf {
        PathBuf::from(
            std::env::var_os("KCODER_WORKSPACE_ROOT")
                .expect("Cargo 应提供当前 KCoder 工作区根目录"),
        )
    }

    #[test]
    fn cargo_test_listing_parser_accepts_current_and_legacy_formats() {
        let output = "tests::returns_the_answer: test\n\
test legacy_ok ... ok\n\
test legacy_failed ... FAILED\n\
test legacy_ignored ... ignored\n\
test result: ok. 4 passed; 0 failed\n\
: test\n\
test  ... ok\n\
test missing_status\n\
test bad_status ... maybe\n\
benchmark_name: benchmark\n";

        assert_eq!(
            parse_cargo_test_names(output),
            [
                "tests::returns_the_answer",
                "legacy_ok",
                "legacy_failed",
                "legacy_ignored"
            ]
        );
    }
    use std::io::Write;

    fn tmp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn init_force_update_overwrites_skills() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let skill_path = dir.path().join(".kcoder/skills/brainstorming/SKILL.md");
        fs::write(&skill_path, "stale").unwrap();

        init_with_force(dir.path(), false).unwrap();
        assert_eq!(fs::read_to_string(&skill_path).unwrap(), "stale");

        init_with_force(dir.path(), true).unwrap();
        assert!(
            fs::read_to_string(&skill_path)
                .unwrap()
                .contains("brainstorming")
        );
    }

    #[test]
    fn init_force_update_preserves_project_config_and_authoritative_spec() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let specs_dir = dir.path().join(SPECS_DIR);
        config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
        config::config_set(&specs_dir, "context", "Keep this project context.").unwrap();
        let config_path = specs_dir.join(config::CONFIG_FILE);
        let spec_path = specs_dir.join("specs/core/spec.md");
        fs::write(&spec_path, "# Project-owned authoritative spec\n").unwrap();
        let config_before = fs::read_to_string(&config_path).unwrap();

        init_with_force(dir.path(), true).unwrap();

        assert_eq!(fs::read_to_string(&config_path).unwrap(), config_before);
        assert_eq!(
            fs::read_to_string(&spec_path).unwrap(),
            "# Project-owned authoritative spec\n"
        );
        let using_specs = fs::read_to_string(dir.path().join(SPEC_SKILL_DIR).join("SKILL.md")).unwrap();
        assert!(using_specs.contains("spec-driven-superpowers"));
        assert!(using_specs.contains("Keep this project context."));
    }

    #[test]
    fn init_rejects_malformed_existing_config_without_overwriting_it() {
        let dir = tmp_dir();
        let specs_dir = dir.path().join(SPECS_DIR);
        fs::create_dir_all(&specs_dir).unwrap();
        let config_path = specs_dir.join(config::CONFIG_FILE);
        let malformed = "schema: [unterminated\n";
        fs::write(&config_path, malformed).unwrap();

        let error = init(dir.path()).expect_err("malformed config should fail initialization");

        assert!(error.to_string().contains("failed to parse"));
        assert_eq!(fs::read_to_string(config_path).unwrap(), malformed);
    }

    #[test]
    fn init_rejects_unsupported_existing_schema_without_overwriting_it() {
        let dir = tmp_dir();
        let specs_dir = dir.path().join(SPECS_DIR);
        fs::create_dir_all(&specs_dir).unwrap();
        let config_path = specs_dir.join(config::CONFIG_FILE);
        let unsupported = "schema: future-unregistered-schema\n";
        fs::write(&config_path, unsupported).unwrap();

        let error = init(dir.path()).expect_err("unsupported schema should fail initialization");

        assert!(error.to_string().contains("unsupported schema"));
        assert_eq!(fs::read_to_string(config_path).unwrap(), unsupported);
    }

    #[test]
    fn init_installs_referenced_bundled_skill_assets() {
        let dir = tmp_dir();

        init(dir.path()).unwrap();

        for asset in SUPERPOWER_SKILL_ASSETS {
            let relative = Path::new(asset.skill).join(asset.relative_path);
            let installed = dir.path().join(".kcoder/skills").join(&relative);
            assert!(
                installed.is_file(),
                "bundled skill asset {relative:?} should be installed"
            );
            assert_eq!(
                fs::read_to_string(installed).unwrap(),
                asset.content,
                "bundled skill asset {relative:?} should match its embedded source"
            );
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let script = dir
                .path()
                .join(".kcoder/skills/systematic-debugging/find-polluter.sh");
            assert_ne!(
                fs::metadata(script).unwrap().permissions().mode() & 0o111,
                0,
                "bundled helper scripts should remain executable"
            );
        }
    }

    #[test]
    fn bundled_skill_asset_manifest_covers_every_non_skill_source_file() {
        fn collect_files(root: &Path, current: &Path, files: &mut Vec<PathBuf>) {
            for entry in fs::read_dir(current).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    collect_files(root, &path, files);
                } else if path.file_name().and_then(|name| name.to_str()) != Some("SKILL.md") {
                    files.push(path.strip_prefix(root).unwrap().to_path_buf());
                }
            }
        }

        let source_root = test_workspace_root().join("crates/kcoder_specs/src/skills");
        let mut source_files = Vec::new();
        collect_files(&source_root, &source_root, &mut source_files);
        source_files.sort();
        let mut embedded = SUPERPOWER_SKILL_ASSETS
            .iter()
            .map(|asset| Path::new(asset.skill).join(asset.relative_path))
            .collect::<Vec<_>>();
        embedded.sort();

        assert_eq!(embedded, source_files);
    }

    #[test]
    fn init_preserves_modified_bundled_skill_asset_unless_forced() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let asset = dir
            .path()
            .join(".kcoder/skills/systematic-debugging/root-cause-tracing.md");
        fs::write(&asset, "local asset override").unwrap();

        init_with_force(dir.path(), false).unwrap();
        assert_eq!(fs::read_to_string(&asset).unwrap(), "local asset override");

        init_with_force(dir.path(), true).unwrap();
        assert_eq!(
            fs::read_to_string(&asset).unwrap(),
            include_str!("skills/systematic-debugging/root-cause-tracing.md")
        );
    }

    #[test]
    fn init_creates_layout_and_skill() {
        let dir = tmp_dir();
        let specs = init(dir.path()).unwrap();
        assert!(specs.join("specs/core/spec.md").exists());
        assert!(specs.join("changes/archive").exists());
        assert!(specs.join(config::CONFIG_FILE).exists());
        assert!(dir.path().join(SPEC_SKILL_DIR).join("SKILL.md").exists());

        for (name, _) in SUPERPOWER_SKILLS {
            assert!(
                dir.path()
                    .join(".kcoder")
                    .join("skills")
                    .join(name)
                    .join("SKILL.md")
                    .exists(),
                "skill {name} should be installed"
            );
        }
    }

    #[test]
    fn new_change_creates_artifacts() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let change = new_change(dir.path(), "add-dark-mode", Some("Add dark mode".into())).unwrap();
        assert!(change.join(".spec.yaml").exists());
        assert!(change.join("proposal.md").exists());
        assert!(change.join("design.md").exists());
        assert!(change.join("tasks.md").exists());
        assert!(change.join("specs/core/spec.md").exists());

        let meta = read_metadata(&change.join(".spec.yaml")).unwrap();
        assert_eq!(meta.name, "add-dark-mode");
        assert_eq!(meta.title.as_deref(), Some("Add dark mode"));
    }

    #[test]
    fn new_change_creates_superpowers_artifacts_when_schema_is_enabled() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let specs_dir = dir.path().join(SPECS_DIR);
        config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();

        let change = new_change(dir.path(), "safer-refactor", None).unwrap();

        assert!(change.join("proposal.md").exists());
        assert!(change.join("design.md").exists());
        assert!(change.join("review.md").exists());
        assert!(change.join("tasks.md").exists());
        assert!(change.join("plan.md").exists());
        let meta = read_metadata(&change.join(".spec.yaml")).unwrap();
        assert_eq!(meta.schema.as_deref(), Some("spec-driven-superpowers"));
    }

    #[test]
    fn status_reports_missing_artifacts() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "x", None).unwrap();
        let summary = status(dir.path(), "x").unwrap();
        assert!(
            summary
                .artifacts
                .iter()
                .any(|a| a.name == "proposal.md" && a.present)
        );
        assert!(!summary.tasks_complete);
    }

    #[test]
    fn status_reports_superpowers_schema_artifacts() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let specs_dir = dir.path().join(SPECS_DIR);
        config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
        new_change(dir.path(), "x", None).unwrap();

        let summary = status(dir.path(), "x").unwrap();

        assert_eq!(summary.schema, "spec-driven-superpowers");
        assert!(
            summary
                .artifacts
                .iter()
                .any(|a| a.name == "review.md" && a.present)
        );
        assert!(
            summary
                .artifacts
                .iter()
                .any(|a| a.name == "plan.md" && a.present)
        );
    }

    #[test]
    fn status_reports_superpowers_apply_blockers() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let specs_dir = dir.path().join(SPECS_DIR);
        config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
        let change = new_change(dir.path(), "x", None).unwrap();
        fs::write(
            change.join("review.md"),
            "# Review\n\n## Readiness Decision\n\nblocked\n\n## Blocked By\n\nrisk not resolved\n",
        )
        .unwrap();

        let summary = status(dir.path(), "x").unwrap();

        assert!(
            summary
                .apply_blockers
                .iter()
                .any(|blocker| blocker.contains("Readiness Decision"))
        );
        assert!(
            summary
                .apply_blockers
                .iter()
                .any(|blocker| blocker.contains("Blocked By"))
        );
    }

    #[test]
    fn apply_preflight_blocks_uncovered_open_tasks() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let specs_dir = dir.path().join(SPECS_DIR);
        config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
        let change = new_change(dir.path(), "x", None).unwrap();
        fs::write(
            change.join("tasks.md"),
            "# Tasks\n\n- [ ] 1.1 Implement behavior\n- [ ] 1.2 Add tests\n",
        )
        .unwrap();
        fs::write(
            change.join("plan.md"),
            "# Plan\n\n## Covers\n\n- 1.1\n\n## Validation Per Step\n\n1. Run focused tests.\n",
        )
        .unwrap();

        let report = apply_preflight(dir.path(), "x").unwrap();

        assert!(!report.ok);
        assert_eq!(report.task_coverage.open_task_ids, vec!["1.1", "1.2"]);
        assert_eq!(report.task_coverage.covered_task_ids, vec!["1.1"]);
        assert_eq!(report.task_coverage.uncovered_task_ids, vec!["1.2"]);
        assert!(
            report
                .blockers
                .iter()
                .any(|blocker| blocker.contains("1.2"))
        );
    }

    #[test]
    fn apply_preflight_passes_when_open_tasks_are_covered() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let specs_dir = dir.path().join(SPECS_DIR);
        config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
        let change = new_change(dir.path(), "x", None).unwrap();
        fs::write(
            change.join("tasks.md"),
            "# Tasks\n\n- [ ] 1.1 Implement behavior\n- [x] 1.2 Existing proof\n",
        )
        .unwrap();
        fs::write(
            change.join("plan.md"),
            "# Plan\n\n## Covers\n\n- 1.1\n\n## Validation Per Step\n\n1. Run focused tests.\n",
        )
        .unwrap();

        let report = apply_preflight(dir.path(), "x").unwrap();

        assert!(report.ok, "unexpected blockers: {:?}", report.blockers);
        assert_eq!(report.task_coverage.open_task_ids, vec!["1.1"]);
        assert_eq!(
            report.task_coverage.uncovered_task_ids,
            Vec::<String>::new()
        );
    }

    #[test]
    fn apply_preflight_blocks_unmapped_high_priority_validation_focus() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let specs_dir = dir.path().join(SPECS_DIR);
        config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
        let change = new_change(dir.path(), "x", None).unwrap();
        fs::write(
            change.join("review.md"),
            "# Review\n\n## Readiness Decision\n\nready\n\n## Blocked By\n\nnone\n\n## Validation Focus\n\n- REQUIRED: exercise auth refresh regression\n",
        )
        .unwrap();
        fs::write(change.join("tasks.md"), "# Tasks\n\n- [ ] 1.1 Implement\n").unwrap();
        fs::write(
            change.join("plan.md"),
            "# Plan\n\n## Covers\n\n- 1.1\n\n## Validation Per Step\n\n1. Run generic tests.\n",
        )
        .unwrap();

        let report = apply_preflight(dir.path(), "x").unwrap();

        assert!(!report.ok);
        assert_eq!(
            report.unmapped_validation_focus,
            vec!["REQUIRED: exercise auth refresh regression"]
        );
        assert!(
            report
                .blockers
                .iter()
                .any(|blocker| blocker.contains("high-priority Validation Focus"))
        );
    }

    #[test]
    fn record_verification_writes_retained_evidence() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "x", None).unwrap();

        let path = record_verification(
            dir.path(),
            "x",
            SpecVerificationRecord {
                completion_decision: "complete".into(),
                commands_run: vec!["cargo test -p kcoder_specs: passed".into()],
                manual_checks: vec!["Reviewed SpecStatus output".into()],
                evidence: vec!["target/debug/deps/kcoder_specs-*".into()],
                residual_risks: vec!["none".into()],
            },
        )
        .unwrap();

        let content = fs::read_to_string(path).unwrap();
        assert!(content.contains("## Completion Decision"));
        assert!(content.contains("complete"));
        assert!(content.contains("cargo test -p kcoder_specs: passed"));
        assert_eq!(
            verification_status(&dir.path().join(SPECS_DIR).join("changes/x"))
                .completion_decision
                .as_deref(),
            Some("complete")
        );
    }

    #[test]
    fn record_verification_preserves_previous_iterations() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let change = new_change(dir.path(), "x", None).unwrap();
        fs::write(
            change.join("verification.md"),
            "# Verification\n\n## Previous Iterations\n\n- earlier failed run\n\n## Manual Adjustments\n\nkeep this note\n",
        )
        .unwrap();

        let path = record_verification(
            dir.path(),
            "x",
            SpecVerificationRecord {
                completion_decision: "complete".into(),
                commands_run: vec!["cargo test: passed".into()],
                ..SpecVerificationRecord::default()
            },
        )
        .unwrap();

        let content = fs::read_to_string(path).unwrap();
        assert!(content.contains("## Previous Iterations"));
        assert!(content.contains("earlier failed run"));
        assert!(content.contains("## Manual Adjustments"));
        assert!(content.contains("keep this note"));
    }

    #[test]
    fn apply_preflight_blocks_accepted_review_findings_without_writeback() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let specs_dir = dir.path().join(SPECS_DIR);
        config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
        let change = new_change(dir.path(), "x", None).unwrap();
        fs::write(
            change.join("review.md"),
            "# Review\n\n## Readiness Decision\n\nready\n\n## Review Status\n\nfindings-received\n\n## Blocked By\n\nnone\n\n## Findings Summary\n\n- accepted: add regression coverage\n",
        )
        .unwrap();
        fs::write(change.join("tasks.md"), "# Tasks\n\n- [x] 1.1 Done\n").unwrap();
        fs::write(
            change.join("plan.md"),
            "# Plan\n\n## Covers\n\n- 1.1\n\n## Validation Per Step\n\n1. Run focused tests.\n",
        )
        .unwrap();

        let report = apply_preflight(dir.path(), "x").unwrap();

        assert!(!report.ok);
        assert!(
            report
                .blockers
                .iter()
                .any(|blocker| blocker.contains("accepted review findings"))
        );
    }

    #[test]
    fn review_writeback_records_findings_and_followups() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let specs_dir = dir.path().join(SPECS_DIR);
        config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
        let change = new_change(dir.path(), "x", None).unwrap();
        fs::write(
            change.join("review.md"),
            "# Review\n\n## Review Status\n\nrequested\n\n## Findings Summary\n\nnone\n\n## Manual Adjustments\n\npreserve review note\n",
        )
        .unwrap();
        fs::write(
            change.join("verification.md"),
            "# Verification\n\n## Previous Iterations\n\n- first review pending\n\n## Manual Adjustments\n\npreserve verification note\n",
        )
        .unwrap();

        let report = review_writeback(
            dir.path(),
            "x",
            SpecReviewWritebackRecord {
                review_status: "findings-received".into(),
                findings_summary: vec!["accepted: add regression coverage".into()],
                accepted_followups: vec!["Add regression coverage for the review finding".into()],
                verification_notes: vec!["Retain evidence for the accepted review finding".into()],
            },
        )
        .unwrap();

        assert!(report.tasks_updated);
        assert!(report.plan_updated);
        assert!(report.verification_updated);
        let review = fs::read_to_string(change.join("review.md")).unwrap();
        assert!(review.contains("## Review Status\n\nfindings-received"));
        assert!(review.contains("accepted: add regression coverage"));
        assert!(review.contains("preserve review note"));
        let tasks = fs::read_to_string(change.join("tasks.md")).unwrap();
        assert!(tasks.contains("## 5. Review Follow-Up"));
        assert!(tasks.contains("- [ ] 5.1 Add regression coverage for the review finding"));
        let plan = fs::read_to_string(change.join("plan.md")).unwrap();
        assert!(plan.contains("## Review Follow-Up"));
        assert!(plan.contains("Add regression coverage for the review finding"));
        let verification = fs::read_to_string(change.join("verification.md")).unwrap();
        assert!(verification.contains("Retain evidence for the accepted review finding"));
        assert!(verification.contains("## Previous Iterations"));
        assert!(verification.contains("first review pending"));
        assert!(verification.contains("preserve verification note"));
    }

    #[test]
    fn status_reports_retained_required_completion_blocker_until_verified() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let specs_dir = dir.path().join(SPECS_DIR);
        config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
        let change = new_change(dir.path(), "x", None).unwrap();
        fs::write(
            change.join("review.md"),
            "# Review\n\n## Readiness Decision\n\nready\n\n## Verification Mode\n\nretained-required\n\n## Blocked By\n\nnone\n",
        )
        .unwrap();

        let summary = status(dir.path(), "x").unwrap();
        assert!(
            summary
                .completion_blockers
                .iter()
                .any(|blocker| blocker.contains("verification.md"))
        );

        record_verification(
            dir.path(),
            "x",
            SpecVerificationRecord {
                completion_decision: "complete".into(),
                ..SpecVerificationRecord::default()
            },
        )
        .unwrap();
        let summary = status(dir.path(), "x").unwrap();
        assert!(summary.completion_blockers.is_empty());
        assert!(summary.verification.present);
    }

    #[test]
    fn archive_moves_change_and_checks_tasks() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "x", None).unwrap();

        // Complete tasks so validation passes.
        let tasks_path = dir.path().join(SPECS_DIR).join("changes/x/tasks.md");
        let mut file = fs::File::create(&tasks_path).unwrap();
        writeln!(file, "- [x] done").unwrap();
        drop(file);

        let archived = archive(dir.path(), "x").unwrap();
        assert!(archived.exists());
        assert!(!dir.path().join(SPECS_DIR).join("changes/x").exists());
    }

    #[test]
    fn archive_rejects_incomplete_tasks_instead_of_warning_only() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "x", None).unwrap();

        let error = archive(dir.path(), "x").unwrap_err().to_string();
        assert!(error.contains("readiness blockers"));
        assert!(error.contains("incomplete tasks"));
        assert!(dir.path().join(SPECS_DIR).join("changes/x").exists());
    }

    #[test]
    fn validate_finds_missing_artifacts() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let change = new_change(dir.path(), "x", None).unwrap();
        fs::remove_file(change.join("design.md")).unwrap();
        let errors = validate(dir.path(), Some("x")).unwrap();
        assert!(errors.iter().any(|e| e.contains("design.md")));
    }

    #[test]
    fn validate_requires_superpowers_artifacts_when_schema_is_enabled() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let specs_dir = dir.path().join(SPECS_DIR);
        config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
        let change = new_change(dir.path(), "x", None).unwrap();
        fs::remove_file(change.join("review.md")).unwrap();
        fs::remove_file(change.join("plan.md")).unwrap();

        let errors = validate(dir.path(), Some("x")).unwrap();

        assert!(errors.iter().any(|e| e.contains("review.md")));
        assert!(errors.iter().any(|e| e.contains("plan.md")));
    }

    #[test]
    fn list_changes_returns_active_changes() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "b", None).unwrap();
        new_change(dir.path(), "a", None).unwrap();
        let names = list_changes(dir.path()).unwrap();
        assert_eq!(names, vec!["a", "b"]);
    }

    #[test]
    fn new_change_captures_base_snapshot() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "x", None).unwrap();
        assert!(
            dir.path()
                .join(SPECS_DIR)
                .join("changes/x/.base.json")
                .exists()
        );
    }

    #[test]
    fn apply_plan_writes_tasks_for_single_active_change() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "x", None).unwrap();

        let plan = "First task\nSecond task\n";
        let path = apply_plan(dir.path(), None, plan).unwrap();
        assert_eq!(path, dir.path().join(SPECS_DIR).join("changes/x/tasks.md"));

        let tasks = fs::read_to_string(&path).unwrap();
        assert!(tasks.contains("- [ ] First task"));
        assert!(tasks.contains("- [ ] Second task"));
    }

    #[test]
    fn apply_plan_writes_plan_for_superpowers_schema() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        let specs_dir = dir.path().join(SPECS_DIR);
        config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
        new_change(dir.path(), "x", None).unwrap();

        let plan = "## Scope\n\nImplementation details stay here.\n";
        let path = apply_plan(dir.path(), None, plan).unwrap();
        assert_eq!(path, dir.path().join(SPECS_DIR).join("changes/x/plan.md"));

        let written = fs::read_to_string(&path).unwrap();
        assert_eq!(written, plan);
        let tasks =
            fs::read_to_string(dir.path().join(SPECS_DIR).join("changes/x/tasks.md")).unwrap();
        assert!(tasks.contains("# Tasks"));
    }

    #[test]
    fn apply_plan_preserves_headings_and_checkboxes() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "x", None).unwrap();

        let plan = "# Plan\n\n- [x] Done\n- Existing bullet\n";
        apply_plan(dir.path(), Some("x"), plan).unwrap();
        let tasks =
            fs::read_to_string(dir.path().join(SPECS_DIR).join("changes/x/tasks.md")).unwrap();
        assert!(tasks.contains("# Plan"));
        assert!(tasks.contains("- [x] Done"));
        assert!(tasks.contains("- [ ] Existing bullet"));
    }

    #[test]
    fn apply_plan_preserves_indentation() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "x", None).unwrap();

        let plan = "- Top task\n  - Subtask one\n  - Subtask two\n";
        apply_plan(dir.path(), Some("x"), plan).unwrap();
        let tasks =
            fs::read_to_string(dir.path().join(SPECS_DIR).join("changes/x/tasks.md")).unwrap();
        assert!(tasks.contains("- [ ] Top task"));
        assert!(tasks.contains("  - [ ] Subtask one"));
        assert!(tasks.contains("  - [ ] Subtask two"));
    }

    #[test]
    fn apply_plan_requires_change_when_multiple_active() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "a", None).unwrap();
        new_change(dir.path(), "b", None).unwrap();

        let err = apply_plan(dir.path(), None, "task").unwrap_err();
        assert!(format!("{}", err).contains("multiple active spec changes"));
    }

    #[test]
    fn archive_blocks_drifted_delta() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "x", None).unwrap();

        // Mutate the starter spec after the change was created so the base
        // snapshot no longer matches the live spec.
        let core_spec = dir.path().join(SPECS_DIR).join("specs/core/spec.md");
        fs::write(
            &core_spec,
            "# Spec: core\n\n## Requirements\n\n### Requirement: example\nUpdated behavior.\n",
        )
        .unwrap();

        // Write a delta that modifies the now-drifted requirement.
        let delta_dir = dir.path().join(SPECS_DIR).join("changes/x/specs/core");
        fs::create_dir_all(&delta_dir).unwrap();
        fs::write(
            delta_dir.join("spec.md"),
            "## MODIFIED Requirements\n\n### Requirement: example\nNew behavior.\n",
        )
        .unwrap();

        // Complete tasks so the pre-existing check does not block.
        let tasks_path = dir.path().join(SPECS_DIR).join("changes/x/tasks.md");
        fs::write(&tasks_path, "- [x] done\n").unwrap();

        let err = archive(dir.path(), "x").unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("has changed") || msg.contains("drifted") || msg.contains("conflicts"),
            "unexpected error: {}",
            msg
        );
    }

    #[test]
    fn status_reports_drift_errors() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "x", None).unwrap();

        // The change touches the existing requirement.
        let delta_path = dir
            .path()
            .join(SPECS_DIR)
            .join("changes/x/specs/core/spec.md");
        fs::write(
            &delta_path,
            "# Delta: core\n\n## MODIFIED Requirements\n\n### Requirement: example\nNew behavior.\n",
        )
        .unwrap();

        // Mutate the authoritative spec after the change was created.
        let core_spec = dir.path().join(SPECS_DIR).join("specs/core/spec.md");
        fs::write(
            &core_spec,
            "# Spec: core\n\n## Requirements\n\n### Requirement: example\nUpdated behavior.\n",
        )
        .unwrap();

        let summary = status(dir.path(), "x").unwrap();
        assert!(
            !summary.drift_errors.is_empty(),
            "expected drift errors after live spec changed"
        );
    }

    #[test]
    fn archive_auto_syncs_unchanged_deltas() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "x", None).unwrap();

        // Mutate the authoritative spec after the change was created, but do
        // not touch the (empty) delta. Sync should fast-forward the base
        // snapshot so archive succeeds.
        let core_spec = dir.path().join(SPECS_DIR).join("specs/core/spec.md");
        fs::write(
            &core_spec,
            "# Spec: core\n\n## Requirements\n\n### Requirement: example\nUpdated behavior.\n",
        )
        .unwrap();

        let tasks_path = dir.path().join(SPECS_DIR).join("changes/x/tasks.md");
        fs::write(&tasks_path, "- [x] done\n").unwrap();

        let archived = archive(dir.path(), "x").unwrap();
        assert!(archived.exists());
        assert!(!dir.path().join(SPECS_DIR).join("changes/x").exists());
    }

    #[test]
    fn archive_blocks_when_precheck_fails() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "x", None).unwrap();

        let specs_dir = dir.path().join(SPECS_DIR);
        config::config_set(&specs_dir, "precheck", "exit 1").unwrap();

        let tasks_path = dir.path().join(SPECS_DIR).join("changes/x/tasks.md");
        fs::write(&tasks_path, "- [x] done\n").unwrap();

        let err = archive(dir.path(), "x").unwrap_err();
        let msg = err.root_cause().to_string();
        assert!(
            msg.contains("precheck command failed"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn validate_detects_unresolved_conflict_markers() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "x", None).unwrap();

        let delta_path = dir
            .path()
            .join(SPECS_DIR)
            .join("changes/x/specs/core/spec.md");
        fs::write(
            &delta_path,
            "## MODIFIED Requirements\n\n### Requirement: example\n<<<<<<< delta\nThe system SHALL do A.\n=======\nThe system SHALL do B.\n>>>>>>> live\n",
        )
        .unwrap();

        let errors = validate(dir.path(), Some("x")).unwrap();
        assert!(
            errors
                .iter()
                .any(|e| e.contains("unresolved conflict marker")),
            "expected conflict marker validation error: {:?}",
            errors
        );
    }

    #[test]
    fn validate_detects_delta_parse_errors() {
        let dir = tmp_dir();
        init(dir.path()).unwrap();
        new_change(dir.path(), "x", None).unwrap();

        // Overwrite the starter delta with malformed content (empty requirement name).
        let delta_path = dir
            .path()
            .join(SPECS_DIR)
            .join("changes/x/specs/core/spec.md");
        fs::write(
            &delta_path,
            "## MODIFIED Requirements\n\n### Requirement:\n",
        )
        .unwrap();

        let errors = validate(dir.path(), Some("x")).unwrap();
        assert!(
            errors.iter().any(|e| e.contains("failed to parse")),
            "expected parse error in validation errors: {:?}",
            errors
        );
    }
