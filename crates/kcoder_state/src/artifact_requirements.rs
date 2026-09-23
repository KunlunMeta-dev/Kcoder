use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactValidationRun {
    pub run_id: String,
    pub declarations_sha256: String,
    pub delivery_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactValidationStatus {
    Unchanged,
    Passed,
    SkippedMissing,
    Missing,
    Denied,
    InvalidPath,
    NotRegular,
    TooSmall,
    ForbiddenContent,
    TooLarge,
    ReadLimit,
    Duplicate,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactValidationEntry {
    pub index: usize,
    pub path: String,
    pub status: ArtifactValidationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactBaselineState {
    Preparing,
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "ArtifactBaselineWire")]
pub struct ArtifactBaseline {
    pub run: ArtifactValidationRun,
    pub state: ArtifactBaselineState,
    pub entries: Vec<ArtifactValidationEntry>,
}

#[derive(Deserialize)]
struct ArtifactBaselineWire {
    run: ArtifactValidationRun,
    state: ArtifactBaselineState,
    entries: Vec<ArtifactValidationEntry>,
}

impl TryFrom<ArtifactBaselineWire> for ArtifactBaseline {
    type Error = String;

    fn try_from(value: ArtifactBaselineWire) -> Result<Self, Self::Error> {
        if value.entries.len() > 32
            || (value.state == ArtifactBaselineState::Preparing && !value.entries.is_empty())
        {
            return Err("invalid artifact baseline entries".into());
        }
        Ok(Self {
            run: value.run,
            state: value.state,
            entries: value.entries,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactValidationReport {
    pub run: ArtifactValidationRun,
    pub observed_at_ms: u64,
    pub entries: Vec<ArtifactValidationEntry>,
}

impl ArtifactValidationReport {
    pub fn failure_count(&self) -> usize {
        self.entries
            .iter()
            .filter(|entry| {
                !matches!(
                    entry.status,
                    ArtifactValidationStatus::Passed
                        | ArtifactValidationStatus::SkippedMissing
                        | ArtifactValidationStatus::Unavailable
                )
            })
            .count()
    }

    pub fn unavailable_count(&self) -> usize {
        self.entries
            .iter()
            .filter(|entry| entry.status == ArtifactValidationStatus::Unavailable)
            .count()
    }
}

pub fn artifact_declarations_sha256(requirements: &[ArtifactRequirement]) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(requirements).expect("artifact declarations serialize"))
    )
}

/// An explicit file requirement, separate from free-form deliverable descriptions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRequirement {
    pub path: String,
    #[serde(default = "default_min_bytes")]
    pub min_bytes: u64,
    #[serde(default = "default_required")]
    pub required: bool,
    #[serde(default)]
    pub unique_content: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub require_changed: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub forbidden_literals: Vec<String>,
}

fn default_min_bytes() -> u64 {
    1
}
fn is_false(value: &bool) -> bool {
    !value
}
fn default_required() -> bool {
    true
}

/// Validate declarations only; this does not inspect files or grant access.
pub fn validate_artifact_requirements(requirements: &[ArtifactRequirement]) -> Result<(), String> {
    if requirements.len() > 32 {
        return Err("artifact_requirements must contain at most 32 entries".into());
    }
    for requirement in requirements {
        if requirement.path.is_empty()
            || requirement.path.contains('\0')
            || requirement.path.len() > 4096
        {
            return Err("artifact_requirements path must be nonempty, contain no NUL, and be at most 4096 bytes".into());
        }
        if requirement.min_bytes > 16 * 1024 * 1024 {
            return Err("artifact_requirements min_bytes must be at most 16777216".into());
        }
        if requirement.forbidden_literals.len() > 16
            || requirement
                .forbidden_literals
                .iter()
                .any(|literal| literal.is_empty() || literal.len() > 256)
            || requirement
                .forbidden_literals
                .iter()
                .map(String::len)
                .sum::<usize>()
                > 4096
        {
            return Err("artifact_requirements forbidden_literals must contain at most 16 nonempty strings, each at most 256 UTF-8 bytes and at most 4096 bytes total".into());
        }
    }
    Ok(())
}

pub fn deserialize_artifact_requirements<'de, D>(
    deserializer: D,
) -> Result<Vec<ArtifactRequirement>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let requirements = Vec::<ArtifactRequirement>::deserialize(deserializer)?;
    validate_artifact_requirements(&requirements).map_err(serde::de::Error::custom)?;
    Ok(requirements)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_freshness_windows_declarations_preserve_legacy_identity() {
        for path in [
            r"C:\项目\report.md",
            r"\\server\share\report.md",
            r"\\?\C:\项目\report.md",
            r"\\?\UNC\server\share\report.md",
        ] {
            let legacy = serde_json::json!([{"path":path}]);
            let declarations: Vec<ArtifactRequirement> =
                serde_json::from_value(legacy.clone()).unwrap();
            let old_hash = artifact_declarations_sha256(&declarations);
            for enabled in [false, true] {
                let mut value = legacy.clone();
                value[0]["require_changed"] = serde_json::json!(enabled);
                let mut task =
                    serde_json::to_value(crate::Task::new("windows", "restore")).unwrap();
                task["artifact_requirements"] = value;
                let restored: crate::Task = serde_json::from_value(task).unwrap();
                assert_eq!(restored.artifact_requirements[0].path, path);
                assert_eq!(restored.artifact_requirements[0].require_changed, enabled);
                assert_eq!(
                    artifact_declarations_sha256(&restored.artifact_requirements) == old_hash,
                    !enabled
                );
                let serialized = serde_json::to_value(&restored.artifact_requirements).unwrap();
                assert_eq!(serialized[0].get("require_changed").is_some(), enabled);
            }
        }
    }

    #[test]
    fn artifact_freshness_declaration_and_baseline_roundtrip() {
        let legacy: ArtifactRequirement =
            serde_json::from_value(serde_json::json!({"path":"x"})).unwrap();
        let explicit_false: ArtifactRequirement =
            serde_json::from_value(serde_json::json!({"path":"x","require_changed":false}))
                .unwrap();
        assert_eq!(
            artifact_declarations_sha256(&[legacy.clone()]),
            artifact_declarations_sha256(&[explicit_false])
        );
        assert!(
            serde_json::to_value(&legacy)
                .unwrap()
                .get("require_changed")
                .is_none()
        );
        let changed: ArtifactRequirement =
            serde_json::from_value(serde_json::json!({"path":"x","require_changed":true})).unwrap();
        assert_ne!(
            artifact_declarations_sha256(&[legacy]),
            artifact_declarations_sha256(&[changed])
        );
        let mut task = serde_json::to_value(crate::Task::new("x", "x")).unwrap();
        let baseline = serde_json::json!({"run":{"run_id":"r","declarations_sha256":"s","delivery_key":null},"state":"ready","entries":[{"index":0,"path":"x","status":"unchanged","size_bytes":3,"sha256":"hash"}]});
        task["artifact_baseline"] = baseline.clone();
        let restored: crate::Task = serde_json::from_value(task).unwrap();
        assert_eq!(
            serde_json::to_value(restored).unwrap()["artifact_baseline"],
            baseline
        );
    }

    #[test]
    fn artifact_baseline_rejects_invalid_persisted_shape() {
        let mut baseline = serde_json::json!({"run":{"run_id":"r","declarations_sha256":"s","delivery_key":null},"state":"preparing","entries":[{"index":0,"path":"x","status":"passed"}]});
        assert!(serde_json::from_value::<ArtifactBaseline>(baseline.clone()).is_err());
        baseline["state"] = serde_json::json!("ready");
        baseline["entries"] = serde_json::json!(vec![baseline["entries"][0].clone(); 33]);
        assert!(serde_json::from_value::<ArtifactBaseline>(baseline).is_err());
    }

    #[test]
    fn forbidden_literals_legacy_fingerprint_and_task_validation() {
        let legacy =
            serde_json::json!([{"path":"a","min_bytes":1,"required":true,"unique_content":false}]);
        let requirements: Vec<ArtifactRequirement> =
            serde_json::from_value(legacy.clone()).unwrap();
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(
                br#"[{"path":"a","min_bytes":1,"required":true,"unique_content":false}]"#
            )
        );
        assert_eq!(artifact_declarations_sha256(&requirements), fingerprint);
        let mut explicit_empty = legacy.clone();
        explicit_empty[0]["forbidden_literals"] = serde_json::json!([]);
        let empty: Vec<ArtifactRequirement> = serde_json::from_value(explicit_empty).unwrap();
        assert_eq!(artifact_declarations_sha256(&empty), fingerprint);
        let mut task = serde_json::to_value(crate::Task::new("old", "restore")).unwrap();
        task["artifact_requirements"] = legacy.clone();
        let restored: crate::Task = serde_json::from_value(task.clone()).unwrap();
        assert_eq!(
            artifact_declarations_sha256(&restored.artifact_requirements),
            fingerprint
        );
        for (literals, accepted) in [
            (serde_json::json!([""]), false),
            (serde_json::json!(["界".repeat(86)]), false),
            (serde_json::json!(["界".repeat(85)]), true),
            (serde_json::json!(["x".repeat(257)]), false),
            (serde_json::json!(vec!["x"; 17]), false),
            (serde_json::json!(vec!["x".repeat(256); 16]), true),
        ] {
            task["artifact_requirements"][0]["forbidden_literals"] = literals;
            let result = serde_json::from_value::<crate::Task>(task.clone());
            assert_eq!(result.is_ok(), accepted);
            if let Ok(restored) = result {
                assert_ne!(
                    artifact_declarations_sha256(&restored.artifact_requirements),
                    fingerprint
                );
            }
        }
    }

    #[test]
    fn artifact_validation_report_survives_task_roundtrip() {
        let task = crate::Task::new("artifact", "inspect");
        let mut json = serde_json::to_value(task).unwrap();
        let run =
            serde_json::json!({"run_id":"run-1","declarations_sha256":"abc","delivery_key":null});
        let report = serde_json::json!({"run":run,"observed_at_ms":123,"entries":[{"index":0,"path":"report.md","status":"passed","size_bytes":4,"sha256":"hash"}]});
        json["artifact_validation_run"] = run;
        json["artifact_validation_report"] = report.clone();
        let restored: crate::Task = serde_json::from_value(json).unwrap();
        assert_eq!(
            serde_json::to_value(restored).unwrap()["artifact_validation_report"],
            report
        );
    }

    #[test]
    fn defaults_and_unknown_fields_are_explicit() {
        let value: ArtifactRequirement = serde_json::from_str(r#"{"path":"report.md"}"#).unwrap();
        assert_eq!(value.min_bytes, 1);
        assert!(value.required);
        assert!(!value.unique_content);
        assert!(
            serde_json::from_str::<ArtifactRequirement>(r#"{"path":"x","extra":true}"#).is_err()
        );
    }

    #[test]
    fn rejects_invalid_declarations_without_normalizing_paths() {
        let mut value: ArtifactRequirement =
            serde_json::from_str(r#"{"path":"../REPORT.md"}"#).unwrap();
        assert!(validate_artifact_requirements(&[value.clone()]).is_ok());
        for path in [String::new(), "a\0b".into(), "x".repeat(4097)] {
            value.path = path;
            assert!(validate_artifact_requirements(&[value.clone()]).is_err());
        }
        value.path = "x".into();
        value.min_bytes = 16 * 1024 * 1024 + 1;
        assert!(validate_artifact_requirements(&[value.clone()]).is_err());
        value.min_bytes = 1;
        assert!(validate_artifact_requirements(&vec![value; 33]).is_err());
    }

    #[test]
    fn task_roundtrip_and_legacy_default_preserve_requirements() {
        let mut task = crate::Task::new("agent-test", "test");
        let legacy = serde_json::to_value(&task).unwrap();
        assert!(legacy.get("artifact_requirements").is_none());
        assert!(
            serde_json::from_value::<crate::Task>(legacy.clone())
                .unwrap()
                .artifact_requirements
                .is_empty()
        );
        task.artifact_requirements = vec![
            serde_json::from_str(
                r#"{"path":"../REPORT.md","min_bytes":0,"required":false,"unique_content":true}"#,
            )
            .unwrap(),
        ];
        let restored: crate::Task =
            serde_json::from_value(serde_json::to_value(&task).unwrap()).unwrap();
        assert_eq!(restored.artifact_requirements, task.artifact_requirements);
        for requirements in [
            serde_json::json!([{"path":""}]),
            serde_json::json!([{"path":"x","extra":1}]),
            serde_json::json!(vec![serde_json::json!({"path":"x"}); 33]),
        ] {
            let mut malformed = legacy.clone();
            malformed["artifact_requirements"] = requirements;
            assert!(serde_json::from_value::<crate::Task>(malformed).is_err());
        }
    }

    #[test]
    fn task_roundtrip_preserves_windows_path_declarations_verbatim() {
        for path in [
            r"C:\Reports\Report.md",
            r"\\server\share\报告.md",
            r"\\?\C:\Reports\Report.md",
            r"\\?\UNC\server\share\report.md",
        ] {
            let mut task = crate::Task::new("windows-declaration", "string-only roundtrip");
            task.artifact_requirements = vec![ArtifactRequirement {
                path: path.into(),
                min_bytes: 1,
                required: true,
                unique_content: false,
                require_changed: false,
                forbidden_literals: Vec::new(),
            }];
            let restored: crate::Task =
                serde_json::from_value(serde_json::to_value(&task).unwrap()).unwrap();
            assert_eq!(restored.artifact_requirements[0].path, path);
        }
    }
}
