use crate::matrix::{Suite, TestMatrix};
use anyhow::Result;
use std::collections::{BTreeMap, BTreeSet};

pub struct Selection {
    tier: String,
    suites: BTreeSet<String>,
}

impl Selection {
    pub fn new(tier: &str, suites: &[String]) -> Self {
        Self {
            tier: tier.to_string(),
            suites: suites.iter().cloned().collect(),
        }
    }

    pub fn select<'a>(&self, matrix: &'a TestMatrix) -> Result<Vec<&'a Suite>> {
        const TIERS: &[&str] = &["pr", "full", "platform", "external-provider", "real-model"];
        anyhow::ensure!(
            TIERS.contains(&self.tier.as_str()),
            "未知 tier: {}",
            self.tier
        );
        if !self.suites.is_empty() {
            let known = matrix
                .suite
                .iter()
                .map(|suite| suite.id.as_str())
                .collect::<BTreeSet<_>>();
            let unknown = self
                .suites
                .iter()
                .filter(|id| !known.contains(id.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            anyhow::ensure!(unknown.is_empty(), "未知 suite: {}", unknown.join(", "));
            let mismatched = matrix
                .suite
                .iter()
                .filter(|suite| self.suites.contains(&suite.id))
                .filter(|suite| !suite.tiers.iter().any(|tier| tier == &self.tier))
                .map(|suite| suite.id.clone())
                .collect::<Vec<_>>();
            anyhow::ensure!(
                mismatched.is_empty(),
                "suite 不属于 tier {}: {}",
                self.tier,
                mismatched.join(", ")
            );
        }
        let requested = matrix
            .suite
            .iter()
            .filter(|suite| {
                if self.suites.is_empty() {
                    suite.tiers.iter().any(|tier| tier == &self.tier)
                } else {
                    self.suites.contains(&suite.id)
                }
            })
            .map(|suite| suite.id.as_str())
            .collect::<Vec<_>>();
        anyhow::ensure!(!requested.is_empty(), "选择结果为空");

        let suites = matrix
            .suite
            .iter()
            .map(|suite| (suite.id.as_str(), suite))
            .collect::<BTreeMap<_, _>>();
        let mut selected = Vec::new();
        let mut visited = BTreeSet::new();
        for id in requested {
            select_with_dependencies(id, &suites, &mut visited, &mut selected)?;
        }
        Ok(selected)
    }
}

fn select_with_dependencies<'a>(
    id: &str,
    suites: &BTreeMap<&str, &'a Suite>,
    visited: &mut BTreeSet<String>,
    selected: &mut Vec<&'a Suite>,
) -> Result<()> {
    if !visited.insert(id.to_string()) {
        return Ok(());
    }
    let suite = suites
        .get(id)
        .copied()
        .ok_or_else(|| anyhow::anyhow!("未知依赖 suite: {id}"))?;
    for dependency in &suite.depends_on {
        select_with_dependencies(dependency, suites, visited, selected)?;
    }
    selected.push(suite);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matrix() -> TestMatrix {
        toml::from_str(
            "schema_version=2\n[[suite]]\nid='fast'\ntiers=['pr']\ncommand=['true']\n[[suite]]\nid='slow'\ntiers=['full']\ncommand=['true']",
        )
        .unwrap()
    }

    #[test]
    fn explicit_suite_selection_requires_matching_tier_and_rejects_unknown_ids() {
        let matrix = matrix();
        let selected = Selection::new("full", &["slow".to_string()])
            .select(&matrix)
            .unwrap();
        assert_eq!(selected[0].id, "slow");
        assert!(
            Selection::new("pr", &["slow".to_string()])
                .select(&matrix)
                .is_err()
        );
        assert!(
            Selection::new("pr", &["missing".to_string()])
                .select(&matrix)
                .is_err()
        );
        assert!(Selection::new("unknown", &[]).select(&matrix).is_err());
    }

    #[test]
    fn dependencies_are_automatically_selected_once_in_topological_order() {
        let matrix = toml::from_str(
            "schema_version=2\n[[suite]]\nid='build'\ntiers=['full']\ncommand=['true']\nsetup=true\n[[suite]]\nid='first'\ntiers=['full']\ncommand=['true']\ndepends_on=['build']\n[[suite]]\nid='second'\ntiers=['full']\ncommand=['true']\ndepends_on=['build']",
        )
        .unwrap();

        let selected = Selection::new("full", &["first".to_string(), "second".to_string()])
            .select(&matrix)
            .unwrap();
        assert_eq!(
            selected
                .iter()
                .map(|suite| suite.id.as_str())
                .collect::<Vec<_>>(),
            vec!["build", "first", "second"]
        );
    }
}
