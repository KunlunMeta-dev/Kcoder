//! Filling reviewed Provider fields is distinct from approving unsupported source semantics.
use kcoder_types::migration::{MigrationIssueCode as Code, MigrationItemPreview};

pub(super) fn can_configure(item: &MigrationItemPreview, typed_provider: bool) -> bool {
    item.issues.iter().all(|issue| {
        !issue.blocks_import()
            || typed_provider
                && matches!(
                    (issue.code, issue.field.as_deref()),
                    (Code::MissingModel, Some("model"))
                        | (Code::MissingModelLimits, Some("model_limits"))
                        | (Code::RequiresReview, Some("endpoint"))
                )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::migration::{
        MigrationCategory, MigrationIssue, MigrationIssuePhase, MigrationIssueSeverity,
        MigrationItemStatus,
    };
    #[test]
    fn only_known_fields_of_a_typed_provider_enter_the_editor_and_all_other_import_blockers_remain()
    {
        let issue = |code, field: &str| MigrationIssue {
            code,
            field: Some(field.into()),
            severity: MigrationIssueSeverity::Blocking,
            phase: MigrationIssuePhase::Import,
        };
        let mut item = MigrationItemPreview {
            id: "owned".into(),
            category: MigrationCategory::Provider,
            source_name: "Office".into(),
            status: MigrationItemStatus::RequiresAction,
            selected_by_default: false,
            issues: vec![
                issue(Code::MissingModel, "model"),
                issue(Code::MissingModelLimits, "model_limits"),
                issue(Code::RequiresReview, "endpoint"),
            ],
        };
        assert!(can_configure(&item, true));
        assert!(
            !can_configure(&item, false),
            "a category label alone cannot authorize a Provider editor"
        );
        for blocker in [
            issue(Code::UnsupportedField, "model"),
            issue(Code::UnsafePath, "endpoint"),
            issue(Code::SourceChanged, "source"),
            issue(Code::RequiresReview, "permissions"),
        ] {
            item.issues.push(blocker);
            assert!(!can_configure(&item, true));
            item.issues.pop();
        }
        item.issues.push(MigrationIssue {
            code: Code::CredentialResolutionRequired,
            field: Some("credentials".into()),
            severity: MigrationIssueSeverity::Blocking,
            phase: MigrationIssuePhase::Activation,
        });
        assert!(
            can_configure(&item, true),
            "activation remains independently subject to Native plan/credential validation"
        );
    }
}
