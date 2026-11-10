use kcoder_config::{PrivateDirectory, ProfileSettingsFile};
use kcoder_migration::{
    assets::AssetTarget,
    batch::{
        BatchActionKind, BatchPlanPolicy, BatchSource, default_resolution,
        execution::{BatchExecution, BatchRunEvent, BatchRunMode},
    },
    discovery::ConfigurationBinding,
    mcp::McpTarget,
    plugin_migration::{
        PluginBatchSource, PluginMigrationStage as PluginStage, PluginMigrationStore, discover,
    },
    providers::ProviderTarget,
    store::{BatchTargets, MigrationJob, MigrationStore},
};
use kcoder_plugins::{PluginCancellationToken, PluginStore};
use kcoder_types::migration::{
    MigrationItemStatus as ItemStatus, MigrationJobStatus as Status, MigrationSourceKind as Kind,
};
use serde_json::json;
use std::{fs, path::PathBuf};

struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    source: PathBuf,
    child: String,
    binding: PluginBatchSource,
    kind: Kind,
}
impl Fixture {
    fn new(kind: Kind) -> Self {
        Self::with_payload(kind, false)
    }
    fn with_payload(kind: Kind, large: bool) -> Self {
        Self::with_flags(kind, large, false)
    }
    fn with_flags(kind: Kind, large: bool, runtime_required: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        PrivateDirectory::open_or_create(&profile).unwrap();
        let source = root.path().join("source");
        PrivateDirectory::open_or_create(&source).unwrap();
        let package = source.join("plugins/cache/market/sample/1.0.0");
        let format = if kind == Kind::ClaudeCode {
            ".claude-plugin"
        } else {
            ".codex-plugin"
        };
        fs::create_dir_all(package.join(format)).unwrap();
        fs::create_dir_all(package.join("skills/check")).unwrap();
        let mut manifest = json!({"name":"sample","version":"1.0.0"});
        if kind == Kind::ClaudeCode {
            fs::create_dir_all(package.join("commands")).unwrap();
            fs::write(package.join("commands/check.md"),
                "---\ndescription: Review the supplied evidence\n---\nCheck $ARGUMENTS without assumptions.").unwrap();
            manifest["mcpServers"] = json!({"docs":{"command":"never-execute-plugin-mcp-fixture"}});
            if runtime_required {
                manifest["mcpServers"]["docs"]["env"] =
                    json!({"REQUIRED_TOKEN":"${REQUIRED_TOKEN}"});
            }
            manifest["hooks"] = json!({"SessionStart":[{"hooks":[{"type":"command", "command":
                format!("touch '{}'", root.path().join("must-not-execute").display())}]}]});
        }
        fs::write(
            package.join(format).join("plugin.json"),
            manifest.to_string(),
        )
        .unwrap();
        if large {
            for index in 0..3 {
                fs::File::create(package.join(format!("resource-{index}.bin")))
                    .unwrap()
                    .set_len(24 * 1024 * 1024)
                    .unwrap();
            }
        }
        fs::write(package.join("skills/check/SKILL.md"),
            "---\nname: check\ndescription: Check the supplied evidence\n---\nReport supported facts.").unwrap();
        if kind == Kind::ClaudeCode {
            fs::write(source.join("plugins/installed_plugins.json"), json!({"version":2,
                "plugins":{"sample@market":[{"scope":"user","installPath":package,"version":"1.0.0"}]}}).to_string()).unwrap();
            fs::write(
                source.join("settings.json"),
                r#"{"enabledPlugins":{"sample@market":true}}"#,
            )
            .unwrap();
        } else {
            fs::write(
                source.join("config.toml"),
                "[plugins.\"sample@market\"]\nenabled=true\n",
            )
            .unwrap();
        }
        let store = PluginMigrationStore::open(&profile).unwrap();
        let candidate = discover(&source, kind, &PluginCancellationToken::default())
            .unwrap()
            .candidates
            .remove(0);
        let child = uuid::Uuid::new_v4().to_string();
        let ready = store
            .plan(&child, &candidate, &PluginCancellationToken::default())
            .unwrap();
        assert_eq!(ready.stage, PluginStage::Ready);
        let binding = store.batch_source(&child, ready.sequence).unwrap();
        Self {
            _root: root,
            profile,
            source,
            child,
            binding,
            kind,
        }
    }
    fn native(&self) -> PluginMigrationStore {
        PluginMigrationStore::open_existing(&self.profile)
            .unwrap()
            .unwrap()
    }
    fn journal(&self) -> MigrationStore {
        MigrationStore::open_or_create(&self.profile).unwrap()
    }
    fn input(&self) -> BatchSource {
        BatchSource::Plugin(Box::new(self.binding.clone()))
    }
    fn with_targets<T>(&self, work: impl FnOnce(&BatchTargets<'_>) -> T) -> T {
        let provider = ProviderTarget::open(&self.profile).unwrap();
        let mcp = McpTarget::open(&self.profile).unwrap();
        let assets = AssetTarget::open(&self.profile).unwrap();
        work(&BatchTargets {
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            history: None,
            credentials: None,
        })
    }
    fn prepare(
        &self,
        store: &MigrationStore,
        inputs: Vec<BatchSource>,
        reuse: bool,
        targets: &BatchTargets<'_>,
    ) -> MigrationJob {
        let job = store.create_batch_scan(inputs).unwrap();
        let choices = job
            .inventory
            .items
            .iter()
            .filter_map(|item| default_resolution(&job, item))
            .collect::<Vec<_>>();
        assert!(job.inventory.items.iter().all(|item| {
            choices
                .iter()
                .any(|choice| choice.item_id() == item.preview.id)
                || item
                    .preview
                    .issues
                    .iter()
                    .any(|issue| issue.blocks_import())
        }));
        store
            .prepare_batch_with_policy(
                &job.job_id,
                job.sequence,
                &choices,
                targets,
                &BatchPlanPolicy {
                    reuse_existing: reuse,
                    ..Default::default()
                },
            )
            .unwrap()
    }
    fn run(
        &self,
        store: &MigrationStore,
        job: &MigrationJob,
        request: &str,
        rollback: bool,
        targets: &BatchTargets<'_>,
    ) -> MigrationJob {
        store
            .run_batch(
                &job.job_id,
                job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                request,
                job.sequence,
                rollback,
                targets,
            )
            .unwrap()
    }
}
fn plugin(job: &MigrationJob) -> &kcoder_migration::batch::BatchAction {
    job.batch
        .as_ref()
        .unwrap()
        .actions
        .iter()
        .find(|action| matches!(action.action, BatchActionKind::Plugin { .. }))
        .unwrap()
}
fn target(job: &MigrationJob) -> &str {
    job.receipts
        .iter()
        .find(|receipt| receipt.operation_id == plugin(job).action_id)
        .unwrap()
        .target_id
        .as_str()
}

#[test]
fn configuration_and_both_source_plugin_formats_share_native_batch_publication_and_owned_undo() {
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        let fixture = Fixture::new(kind);
        fixture.with_targets(|targets| {
            let path = fixture._root.path().join(if kind == Kind::ClaudeCode { "settings.json" } else { "config.toml" });
            fs::write(&path, if kind == Kind::ClaudeCode {
                r#"{"mcpServers":{"documents":{"command":"never-execute-batch-plugin-fixture"}}}"#
            } else { "[mcp_servers.documents]\ncommand='never-execute-batch-plugin-fixture'\n" }).unwrap();
            let config = BatchSource::Configuration(ConfigurationBinding::capture_selected(&path, kind).unwrap());
            let journal = fixture.journal();
            let job = fixture.prepare(&journal, vec![config, fixture.input()], false, targets);
            assert_eq!(job.selected_item_ids.len(), 2);
            assert_eq!(job.inventory.items.len(), if kind == Kind::ClaudeCode { 2 } else { 3 });
            assert!(matches!(&plugin(&job).action, BatchActionKind::Plugin {plan} if plan.reference.is_none()));
            assert!(!fixture.profile.join("plugin_store").exists());
            let done = fixture.run(&journal, &job, "apply-mixed", false, targets);
            assert_eq!(done.status, Status::CompletedWithIssues);
            assert!(done.batch.as_ref().unwrap().actions.iter().all(|action|
                action.status == ItemStatus::Committed && action.error.is_none()));
            assert!(done.inventory.items.iter().any(|item| item.preview.issues.iter().any(|issue|
                issue.code == kcoder_types::migration::MigrationIssueCode::RequiresReview
                && issue.phase == kcoder_types::migration::MigrationIssuePhase::Activation)));
            let store = PluginStore::open(&fixture.profile.join("plugin_store")).unwrap();
            let record = store.read(&target(&done).parse().unwrap()).unwrap().unwrap();
            assert!(!record.enabled_by_default);
            assert!(record.root(store.root()).join("skills/check/SKILL.md").is_file());
            assert!(!fixture._root.path().join("must-not-execute").exists());
            if kind == Kind::ClaudeCode {
                assert!(record.root(store.root()).join("commands/check.md").is_file());
            }
            let original = fs::read(fixture.source.join("plugins/cache/market/sample/1.0.0/skills/check/SKILL.md")).unwrap();
            assert_eq!(original, fs::read(record.root(store.root()).join("skills/check/SKILL.md")).unwrap());
            fs::remove_dir_all(&fixture.source).unwrap();
            let reopened = MigrationStore::open_existing(&fixture.profile).unwrap();
            let rolled = fixture.run(&reopened, &done, "undo-mixed", true, targets);
            assert_eq!(rolled.status, Status::RolledBack);
            assert!(store.read(&record.plugin_id).unwrap().is_none());
            let child = fixture.native().read(&fixture.child, &PluginCancellationToken::default()).unwrap();
            assert_eq!(child.stage, PluginStage::Undone);
            assert!(child.imported);
            assert!(fixture.profile.join("plugin-migrations-v1").join(&fixture.child).exists());
        });
    }
}

#[test]
fn durable_parent_action_recovers_both_a_lost_claim_and_a_lost_child_publication_receipt() {
    for published in [false, true] {
        let fixture = Fixture::new(Kind::ClaudeCode);
        fixture.with_targets(|targets| {
            let journal = fixture.journal();
            let job = fixture.prepare(&journal, vec![fixture.input()], false, targets);
            let native = fixture.native();
            let consumer = native.batch_consumer(&job.job_id, &plugin(&job).action_id).unwrap();
            let reference = native.pin_for_batch(&fixture.binding, &consumer, "sample").unwrap();
            if published {
                native.apply_reference(&reference, &PluginCancellationToken::default()).unwrap();
                fs::remove_dir_all(&fixture.source).unwrap();
            }
            assert!(matches!(&plugin(&job).action, BatchActionKind::Plugin {plan} if plan.reference.is_none()));
            let journal = MigrationStore::open_existing(&fixture.profile).unwrap();
            let done = fixture.run(&journal, &journal.read(&job.job_id).unwrap(), "recover-same-parent", false, targets);
            assert_eq!(done.status, Status::Completed);
            assert!(matches!(&plugin(&done).action, BatchActionKind::Plugin {plan} if plan.reference.as_ref()==Some(&reference)));
            assert_eq!(done.receipts.len(), 1);
            assert!(native.apply(&fixture.child, reference.sequence(), &PluginCancellationToken::default()).is_err());
            assert!(native.undo(&fixture.child, native.read_reference(&reference).unwrap().sequence,
                &PluginCancellationToken::default()).is_err());
        });
    }
}

#[test]
fn another_parent_cannot_take_installation_or_undo_authority_from_a_claimed_child() {
    let fixture = Fixture::new(Kind::Codex);
    fixture.with_targets(|targets| {
        let journal = fixture.journal();
        let first = fixture.prepare(&journal, vec![fixture.input()], false, targets);
        let second = fixture.prepare(&journal, vec![fixture.input()], false, targets);
        let done = fixture.run(&journal, &first, "first-parent", false, targets);
        let rejected = fixture.run(&journal, &second, "second-parent", false, targets);
        assert_eq!(rejected.status, Status::CompletedWithIssues);
        assert_eq!(
            plugin(&rejected).error.as_deref(),
            Some("migration_plugin_owned_by_another_batch")
        );
        assert!(rejected.receipts.is_empty());
        let native = fixture
            .native()
            .read(&fixture.child, &PluginCancellationToken::default())
            .unwrap();
        assert_eq!(native.batch_job_id.as_deref(), Some(first.job_id.as_str()));
        assert_eq!(native.stage, PluginStage::Imported);
        assert!(
            PluginStore::open(&fixture.profile.join("plugin_store"))
                .unwrap()
                .read(&target(&done).parse().unwrap())
                .unwrap()
                .is_some()
        );
    });
}

#[test]
fn a_second_capture_reuses_the_original_owner_and_blocks_its_undo_until_the_reference_retires() {
    let fixture = Fixture::new(Kind::ClaudeCode);
    fixture.with_targets(|targets| {
        let journal = fixture.journal();
        let first = fixture.prepare(&journal, vec![fixture.input()], false, targets);
        let first = fixture.run(&journal, &first, "first-apply", false, targets);
        let native = fixture.native();
        let candidate = discover(&fixture.source, fixture.kind, &PluginCancellationToken::default()).unwrap().candidates.remove(0);
        let second_child = uuid::Uuid::new_v4().to_string();
        let ready = native.plan(&second_child, &candidate, &PluginCancellationToken::default()).unwrap();
        let second_source = native.batch_source(&second_child, ready.sequence).unwrap();
        let second = fixture.prepare(&journal, vec![BatchSource::Plugin(Box::new(second_source))], true, targets);
        assert!(matches!(&second.batch.as_ref().unwrap().actions[0].action, BatchActionKind::Reuse {proof} if proof.job_id==first.job_id));
        let second = fixture.run(&journal, &second, "reuse", false, targets);
        assert_eq!(second.status, Status::Completed);
        assert_eq!(second.batch.as_ref().unwrap().actions[0].status, ItemStatus::Skipped);
        let untouched = native.read(&second_child, &PluginCancellationToken::default()).unwrap();
        assert!(!untouched.imported);
        assert!(untouched.batch_job_id.is_none());
        let blocked = fixture.run(&journal, &first, "owner-undo-blocked", true, targets);
        assert_eq!(blocked.status, Status::RollbackConflict);
        assert_eq!(plugin(&blocked).error.as_deref(), Some("migration_result_referenced"));
        assert_eq!(fixture.run(&journal, &second, "retire-reference", true, targets).status, Status::RolledBack);
        let last = fixture.run(&journal, &journal.read(&first.job_id).unwrap(), "owner-undo", true, targets);
        assert_eq!(last.status, Status::RolledBack);
    });
}

#[test]
fn rollback_preserves_user_policy_body_edits_and_live_native_version_leases() {
    for change in ["policy", "body", "lease"] {
        let fixture = Fixture::new(Kind::Codex);
        fixture.with_targets(|targets| {
            let journal = fixture.journal();
            let job = fixture.prepare(&journal, vec![fixture.input()], false, targets);
            let done = fixture.run(&journal, &job, "install", false, targets);
            let store = PluginStore::open(&fixture.profile.join("plugin_store")).unwrap();
            let record = store
                .read(&target(&done).parse().unwrap())
                .unwrap()
                .unwrap();
            let mut leases = None;
            if change == "policy" {
                ProfileSettingsFile::new(
                    PrivateDirectory::open_existing(&fixture.profile).unwrap(),
                )
                .unwrap()
                .update(|document| {
                    document["plugins"] = json!({"installed":{target(&done):{"enabled":true}}});
                    Ok(())
                })
                .unwrap();
            } else if change == "body" {
                fs::write(
                    record.root(store.root()).join("skills/check/SKILL.md"),
                    "user changed this file",
                )
                .unwrap();
            } else {
                leases = Some(store.snapshot_with_leases().unwrap().1);
            }
            let result = fixture.run(&journal, &done, "guarded-undo", true, targets);
            assert_eq!(result.status, Status::RollbackConflict, "{change}");
            assert_eq!(
                plugin(&result).error.as_deref(),
                Some(match change {
                    "policy" => "migration_plugin_user_policy_changed",
                    "body" => "migration_plugin_target_changed",
                    _ => "migration_plugin_in_use",
                })
            );
            assert!(store.read(&record.plugin_id).unwrap().is_some());
            assert!(
                fixture
                    .native()
                    .read(&fixture.child, &PluginCancellationToken::default())
                    .unwrap()
                    .imported
            );
            drop(leases);
        });
    }
}

#[test]
fn parent_cancellation_requires_an_explicit_resume_and_reuses_its_original_claim() {
    let fixture = Fixture::new(Kind::ClaudeCode);
    fixture.with_targets(|targets| {
        let journal = fixture.journal();
        let job = fixture.prepare(&journal, vec![fixture.input()], false, targets);
        let result = journal
            .run_batch_controlled(
                BatchExecution {
                    job_id: &job.job_id,
                    plan_id: job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                    request_id: "apply-cancelled",
                    expected_sequence: job.sequence,
                    mode: BatchRunMode::Apply,
                },
                targets,
                &mut |event| {
                    if matches!(event, BatchRunEvent::Action { .. }) {
                        let current = journal.read(&job.job_id).unwrap();
                        journal.cancel(&job.job_id, current.sequence).unwrap();
                    }
                    true
                },
            )
            .unwrap();
        assert_eq!(result.status, Status::Cancelled);
        assert!(!fixture.profile.join("plugin_store").exists());
        let claimed = fixture
            .native()
            .read(&fixture.child, &PluginCancellationToken::default())
            .unwrap();
        assert_eq!(claimed.batch_job_id.as_deref(), Some(job.job_id.as_str()));
        let resumed = journal
            .resume_batch(
                &job.job_id,
                job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                "explicit-resume",
                result.sequence,
                targets,
            )
            .unwrap();
        assert_eq!(resumed.status, Status::Completed);
        assert_eq!(resumed.receipts.len(), 1);
        assert_eq!(
            fixture
                .native()
                .read(&fixture.child, &PluginCancellationToken::default())
                .unwrap()
                .batch_job_id,
            Some(job.job_id.clone())
        );
    });
}

#[test]
fn a_plugin_bound_to_another_profile_is_rejected_before_a_parent_plan_can_claim_it() {
    let fixture = Fixture::new(Kind::ClaudeCode);
    let other = tempfile::tempdir().unwrap();
    let journal = MigrationStore::open_or_create(other.path()).unwrap();
    assert!(journal.create_batch_scan(vec![fixture.input()]).is_err());
    assert!(
        fixture
            .native()
            .read(&fixture.child, &PluginCancellationToken::default())
            .unwrap()
            .batch_job_id
            .is_none()
    );
}

#[test]
fn cancellation_after_native_publication_retains_the_known_receipt_and_owned_output() {
    let fixture = Fixture::new(Kind::ClaudeCode);
    fixture.with_targets(|targets| {
        let journal = fixture.journal();
        let job = fixture.prepare(&journal, vec![fixture.input()], false, targets);
        let native = fixture.native();
        let consumer = native
            .batch_consumer(&job.job_id, &plugin(&job).action_id)
            .unwrap();
        let reference = native
            .pin_for_batch(&fixture.binding, &consumer, "sample")
            .unwrap();
        native
            .apply_reference(&reference, &PluginCancellationToken::default())
            .unwrap();
        let result = journal
            .run_batch_controlled(
                BatchExecution {
                    job_id: &job.job_id,
                    plan_id: job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                    request_id: "cancel-published",
                    expected_sequence: job.sequence,
                    mode: BatchRunMode::Apply,
                },
                targets,
                &mut |event| {
                    if matches!(event, BatchRunEvent::Action { .. }) {
                        let current = journal.read(&job.job_id).unwrap();
                        journal.cancel(&job.job_id, current.sequence).unwrap();
                    }
                    true
                },
            )
            .unwrap();
        assert_eq!(result.status, Status::Cancelled);
        assert_eq!(result.receipts.len(), 1);
        assert_eq!(plugin(&result).status, ItemStatus::Committed);
        assert_eq!(
            native.read_reference(&reference).unwrap().stage,
            PluginStage::Imported
        );
        assert!(
            PluginStore::open(&fixture.profile.join("plugin_store"))
                .unwrap()
                .read(&reference.target_id().parse().unwrap())
                .unwrap()
                .is_some()
        );
    });
}

#[test]
fn caller_cancellation_settles_its_real_native_worker_before_releasing_the_parent_runner() {
    let fixture = Fixture::with_payload(Kind::ClaudeCode, true);
    fixture.with_targets(|targets| {
        let journal = fixture.journal();
        let job = fixture.prepare(&journal, vec![fixture.input()], false, targets);
        let native = fixture.native();
        let mut stopped = false;
        let result = journal.run_batch_controlled(
            BatchExecution {
                job_id: &job.job_id,
                plan_id: job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                request_id: "caller-stopped",
                expected_sequence: job.sequence,
                mode: BatchRunMode::Apply,
            },
            targets,
            &mut |event| {
                if matches!(event, BatchRunEvent::Checkpoint)
                    && native.running(&fixture.child).unwrap()
                {
                    stopped = true;
                }
                !stopped
            },
        );
        assert!(
            stopped,
            "the fixture must observe its actual Native writer before cancellation"
        );
        assert_eq!(
            result.unwrap_err().to_string(),
            "migration_batch_worker_stopped"
        );
        assert!(!native.running(&fixture.child).unwrap());
        assert!(!journal.batch_execution_active(&job.job_id).unwrap());
        let current = journal.read(&job.job_id).unwrap();
        let child = native
            .read(&fixture.child, &PluginCancellationToken::default())
            .unwrap();
        assert_eq!(current.receipts.len(), usize::from(child.imported));
        let resumed = journal
            .resume_batch(
                &job.job_id,
                job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                "explicit-caller-resume",
                current.sequence,
                targets,
            )
            .unwrap();
        assert_eq!(resumed.status, Status::Completed);
        assert_eq!(resumed.receipts.len(), 1);
        assert_eq!(
            native
                .read(&fixture.child, &PluginCancellationToken::default())
                .unwrap()
                .batch_job_id,
            Some(job.job_id.clone())
        );
    });
}

#[test]
fn missing_runtime_environment_is_not_dropped_from_a_successfully_disabled_import() {
    let fixture = Fixture::with_flags(Kind::ClaudeCode, false, true);
    fixture.with_targets(|targets| {
        let journal = fixture.journal();
        let job = fixture.prepare(&journal, vec![fixture.input()], false, targets);
        let issue = &job.inventory.items[0].preview.issues[0];
        assert_eq!(
            issue.code,
            kcoder_types::migration::MigrationIssueCode::MissingDependency
        );
        assert_eq!(
            issue.phase,
            kcoder_types::migration::MigrationIssuePhase::Activation
        );
        assert!(!issue.blocks_import());
        let done = fixture.run(
            &journal,
            &job,
            "import-disabled-with-prerequisites",
            false,
            targets,
        );
        assert_eq!(done.status, Status::CompletedWithIssues);
        assert_eq!(plugin(&done).status, ItemStatus::Committed);
        let store = PluginStore::open(&fixture.profile.join("plugin_store")).unwrap();
        assert!(
            !store
                .read(&target(&done).parse().unwrap())
                .unwrap()
                .unwrap()
                .enabled_by_default
        );
        assert_eq!(
            fixture
                .native()
                .read(&fixture.child, &PluginCancellationToken::default())
                .unwrap()
                .readiness,
            vec!["plugin_environment_required"]
        );
        assert!(!fixture._root.path().join("must-not-execute").exists());
    });
}
