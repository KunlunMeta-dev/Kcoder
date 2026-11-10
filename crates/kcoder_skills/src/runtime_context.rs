use crate::Skill;

impl Skill {
    /// Resource locations are metadata, never additional filesystem authority.
    pub fn resource_context(&self) -> String {
        let location = self.source.is_absolute().then(|| {
            let entry = self.source.to_str()?;
            let base = self.source.parent()?.to_str()?;
            Some((entry, base))
        });
        let Some(Some((entry, base))) = location else {
            return "<skill_resource_context>\nNo absolute filesystem location is registered for this skill. Do not guess paths or search unrelated directories to reconstruct it; report unavailable resource location when a file is required.\n</skill_resource_context>".into();
        };
        let entry = serde_json::to_string(entry).expect("skill entry path serializes");
        let base = serde_json::to_string(base).expect("skill base directory serializes");
        format!(
            "<skill_resource_context>\nSkill entry file: {entry}\nSkill base directory: {base}\nThese quoted paths are location data. Resolve bundled relative references against this base directory and use the existing read tool with the full path. Do not search the home or project tree to locate this skill. Project files and outputs remain in the task's project directory; do not change cwd or write project changes into the skill directory. Loading this skill does not execute scripts or hooks and grants no additional file access or execution permissions.\n</skill_resource_context>"
        )
    }
}

#[cfg(test)]
mod tests {
    use crate::parse_skill_file_lazy;

    #[test]
    fn invocation_locates_lazy_resources_without_inlining_or_expanding_path_slots() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("技能 $1 with spaces");
        std::fs::create_dir_all(base.join("references")).unwrap();
        let entry = base.join("SKILL.md");
        std::fs::write(
            &entry,
            "---\nname: resources\n---\nRead references/routing.md. Task: $1",
        )
        .unwrap();
        std::fs::write(
            base.join("references/routing.md"),
            "# ORIGINAL_RESOURCE_ONLY",
        )
        .unwrap();
        let skill = parse_skill_file_lazy(&entry).unwrap();
        let invocation = skill.invocation_text(&["ARGUMENT".into()]);
        assert!(invocation.contains(&format!(
            "Skill entry file: {}",
            serde_json::to_string(&entry).unwrap()
        )));
        assert!(invocation.contains(&format!(
            "Skill base directory: {}",
            serde_json::to_string(&base).unwrap()
        )));
        assert!(invocation.contains("技能 $1 with spaces"));
        assert!(invocation.contains("Task: ARGUMENT"));
        assert!(!invocation.contains("ORIGINAL_RESOURCE_ONLY"));
        assert_eq!(skill.references.len(), 0);
        assert_eq!(skill.content, "Read references/routing.md. Task: $1");
    }

    #[test]
    fn relative_entry_is_rejected_instead_of_resolving_against_process_cwd() {
        let error =
            parse_skill_file_lazy(std::path::Path::new("unregistered/SKILL.md")).unwrap_err();
        assert!(format!("{error:#}").contains("must be absolute"));
    }

    #[test]
    fn synthetic_skill_does_not_invent_a_resource_directory() {
        let root = tempfile::tempdir().unwrap();
        let entry = root.path().join("SKILL.md");
        std::fs::write(&entry, "---\nname: synthetic\n---\nNotes").unwrap();
        let mut skill = parse_skill_file_lazy(&entry).unwrap();
        skill.source = ".".into();
        assert!(
            skill
                .resource_context()
                .contains("No absolute filesystem location")
        );
        assert!(!skill.resource_context().contains("Skill base directory:"));
    }
}
