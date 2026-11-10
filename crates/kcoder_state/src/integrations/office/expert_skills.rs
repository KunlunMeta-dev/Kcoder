//! Atomic expert skill snapshots and their complete inert source-file inventories.
use super::*;
use serde_json::json;

pub struct OfficeExpertSkillInstallation<'a> {
    pub skill: OfficeAssistantSkill,
    pub archive_sha256: &'a str,
    pub files: &'a [(String, Vec<u8>)],
}

impl OfficeStore {
    pub fn install_expert_skill(
        &self,
        operation: &str,
        id: &str,
        expected: u64,
        installation: OfficeExpertSkillInstallation<'_>,
        now: u64,
    ) -> Result<OfficeAssistantDraft> {
        let OfficeExpertSkillInstallation {
            skill,
            archive_sha256,
            files,
        } = installation;
        skill.validate()?;
        ensure!(
            files
                .iter()
                .find(|(path, _)| path == "SKILL.md")
                .is_some_and(|(_, bytes)| bytes == skill.content.as_bytes()),
            "OFFICE_CONTENT_CORRUPT"
        );
        ensure!(
            !skill.enabled
                && archive_sha256.len() == 64
                && archive_sha256.bytes().all(|b| b.is_ascii_hexdigit()),
            "OFFICE_INVALID_INPUT"
        );
        let mut prepared = files
            .iter()
            .map(|(path, bytes)| (format!("skills/{}/{path}", skill.slug), bytes.clone()))
            .collect::<Vec<_>>();
        let provenance = serde_json::to_vec(
            &json!({"source":"skillhub","slug":skill.slug,"archiveSha256":archive_sha256}),
        )?;
        prepared.push((format!("source/skills/{}.json", skill.slug), provenance));
        let entries = prepared
            .iter()
            .map(|(path, bytes)| OfficeExpertFile {
                path: path.clone(),
                sha256: digest(bytes),
                bytes: bytes.len() as u64,
            })
            .collect::<Vec<_>>();
        self.mutate(
            operation,
            "assistant.installSkill",
            &(id, expected, &skill, archive_sha256, &entries),
            |state| {
                let original = state.drafts.get(id).context("OFFICE_DRAFT_NOT_FOUND")?;
                ensure!(original.revision == expected, "OFFICE_REVISION_CONFLICT");
                ensure!(
                    original.definition.scope == OfficeAssistantScope::Personal
                        && !original
                            .definition
                            .skills
                            .iter()
                            .any(|value| value.slug == skill.slug),
                    "OFFICE_INVALID_INPUT"
                );
                let mut definition = original.definition.clone();
                definition.skills.push(skill.clone());
                definition.validate()?;
                let mut package =
                    state
                        .expert_packages
                        .get(id)
                        .cloned()
                        .unwrap_or(OfficeExpertPackage {
                            source: "skillhub".into(),
                            slug: id.into(),
                            package_sha256: archive_sha256.into(),
                            skill_slugs: vec![],
                            files: vec![],
                        });
                for entry in &entries {
                    if let Some(existing) =
                        package.files.iter().find(|file| file.path == entry.path)
                    {
                        ensure!(existing == entry, "OFFICE_REVISION_CONFLICT");
                    } else {
                        package.files.push(entry.clone());
                    }
                }
                if !package.skill_slugs.contains(&skill.slug) {
                    package.skill_slugs.push(skill.slug.clone());
                }
                super::experts::validate_package(&package)?;
                ensure!(
                    state.expert_packages.contains_key(id)
                        || state.expert_packages.len() < MAX_VERSIONS,
                    "OFFICE_STORAGE_LIMIT"
                );
                let retained: u64 = state
                    .expert_packages
                    .iter()
                    .filter(|(key, _)| *key != id)
                    .flat_map(|(_, p)| &p.files)
                    .map(|f| f.bytes)
                    .sum();
                ensure!(
                    retained.saturating_add(package.files.iter().map(|f| f.bytes).sum::<u64>())
                        <= 256 * 1024 * 1024,
                    "OFFICE_STORAGE_LIMIT"
                );
                for (entry, (_, bytes)) in entries.iter().zip(&prepared) {
                    self.directory.atomic_replace(
                        OsStr::new(&format!("expert-{}.blob", entry.sha256)),
                        bytes,
                    )?;
                }
                let draft = OfficeAssistantDraft {
                    owner: self.owner.clone(),
                    revision: original
                        .revision
                        .checked_add(1)
                        .context("OFFICE_STORAGE_LIMIT")?,
                    definition,
                    updated_at_ms: now,
                };
                state.expert_packages.insert(id.into(), package);
                state.drafts.insert(id.into(), draft.clone());
                Ok(draft)
            },
        )
    }
}
