use crate::summary::TestSummary;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct AggregateReport {
    pub schema_version: u32,
    pub tier: String,
    pub selected: Vec<String>,
    pub outcomes: Vec<SuiteOutcome>,
    pub execution_manifests: Vec<String>,
}

impl AggregateReport {
    pub fn new(tier: String, selected: Vec<String>) -> Self {
        Self {
            schema_version: 1,
            tier,
            selected,
            outcomes: Vec::new(),
            execution_manifests: Vec::new(),
        }
    }

    pub fn is_success(&self) -> bool {
        !self.selected.is_empty()
            && self.outcomes.len() == self.selected.len()
            && self
                .outcomes
                .iter()
                .all(|outcome| matches!(outcome, SuiteOutcome::Passed { .. }))
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum SuiteOutcome {
    Passed {
        id: String,
        duration_ms: u128,
        stdout: String,
        stderr: String,
        domain_artifacts: Option<String>,
        summary: TestSummary,
    },
    Failed {
        id: String,
        duration_ms: u128,
        exit_code: Option<i32>,
        stdout: String,
        stderr: String,
        domain_artifacts: Option<String>,
    },
    TimedOut {
        id: String,
        duration_ms: u128,
        stdout: String,
        stderr: String,
        domain_artifacts: Option<String>,
    },
    UnmetPrerequisite {
        id: String,
        reasons: Vec<String>,
    },
    RunnerError {
        id: String,
        error: String,
        started_at_ms: u64,
        duration_ms: u128,
        stage: String,
        executed: bool,
        cleanup: Vec<String>,
    },
    NotRun {
        id: String,
        reason: String,
    },
}

impl SuiteOutcome {
    pub fn status(&self) -> &'static str {
        match self {
            Self::Passed { .. } => "passed",
            Self::Failed { .. } => "failed",
            Self::TimedOut { .. } => "timed-out",
            Self::UnmetPrerequisite { .. } => "unmet-prerequisite",
            Self::RunnerError { .. } => "runner-error",
            Self::NotRun { .. } => "not-run",
        }
    }

    pub fn duration_ms(&self) -> Option<u128> {
        match self {
            Self::Passed { duration_ms, .. }
            | Self::Failed { duration_ms, .. }
            | Self::TimedOut { duration_ms, .. }
            | Self::RunnerError { duration_ms, .. } => Some(*duration_ms),
            Self::UnmetPrerequisite { .. } | Self::NotRun { .. } => None,
        }
    }

    pub fn domain_artifacts(&self) -> Option<&str> {
        match self {
            Self::Passed {
                domain_artifacts, ..
            }
            | Self::Failed {
                domain_artifacts, ..
            }
            | Self::TimedOut {
                domain_artifacts, ..
            } => domain_artifacts.as_deref(),
            Self::UnmetPrerequisite { .. } | Self::RunnerError { .. } | Self::NotRun { .. } => None,
        }
    }

    pub fn executed(&self) -> bool {
        match self {
            Self::RunnerError { executed, .. } => *executed,
            Self::UnmetPrerequisite { .. } | Self::NotRun { .. } => false,
            _ => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unmet_prerequisite_is_reported_but_never_counts_as_success() {
        let mut report = AggregateReport::new("pr".to_string(), vec!["missing-tool".to_string()]);
        report.outcomes.push(SuiteOutcome::UnmetPrerequisite {
            id: "missing-tool".to_string(),
            reasons: vec!["找不到命令".to_string()],
        });

        assert!(!report.is_success());
        let wire = serde_json::to_value(report).unwrap();
        assert_eq!(wire["outcomes"][0]["status"], "unmet-prerequisite");
    }
}
