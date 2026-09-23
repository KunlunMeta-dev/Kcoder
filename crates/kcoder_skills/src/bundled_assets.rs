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
