use super::schema::Suite;
use anyhow::Result;
use std::collections::BTreeMap;

pub(super) fn ensure_acyclic(suites: &BTreeMap<&str, &Suite>) -> Result<()> {
    fn visit<'a>(
        id: &'a str,
        suites: &BTreeMap<&'a str, &'a Suite>,
        visiting: &mut std::collections::BTreeSet<&'a str>,
        visited: &mut std::collections::BTreeSet<&'a str>,
    ) -> Result<()> {
        if visited.contains(id) {
            return Ok(());
        }
        anyhow::ensure!(visiting.insert(id), "测试矩阵依赖存在环: {id}");
        for dependency in &suites[id].depends_on {
            visit(dependency, suites, visiting, visited)?;
        }
        visiting.remove(id);
        visited.insert(id);
        Ok(())
    }

    let mut visiting = std::collections::BTreeSet::new();
    let mut visited = std::collections::BTreeSet::new();
    for id in suites.keys() {
        visit(id, suites, &mut visiting, &mut visited)?;
    }
    Ok(())
}
