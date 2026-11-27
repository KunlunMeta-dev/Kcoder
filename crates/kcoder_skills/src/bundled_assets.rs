use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::{SkillPackage, SkillPackageFile};

include!(concat!(env!("OUT_DIR"), "/bundled_skills.rs"));

pub(crate) fn packages() -> Vec<SkillPackage> {
    let mut packages = BTreeMap::<String, Vec<SkillPackageFile>>::new();
    for &(name, relative_path, content, executable) in BUNDLED_SKILL_FILES {
        packages
            .entry(name.to_string())
            .or_default()
            .push(SkillPackageFile {
                relative_path: PathBuf::from(relative_path),
                content: content.to_vec(),
                executable,
            });
    }
    packages
        .into_iter()
        .map(|(name, files)| SkillPackage { name, files })
        .collect()
}

pub(crate) fn names() -> std::collections::BTreeSet<&'static str> {
    BUNDLED_SKILL_FILES
        .iter()
        .map(|&(name, _, _, _)| name)
        .collect()
}

/// One embedded bundled file; no filesystem access.
pub(crate) fn file(name: &str, relative_path: &str) -> Option<&'static [u8]> {
    BUNDLED_SKILL_FILES
        .iter()
        .find(|&&(skill, path, _, _)| skill == name && path == relative_path)
        .map(|&(_, _, content, _)| content)
}
