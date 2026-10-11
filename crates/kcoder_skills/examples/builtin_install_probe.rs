fn main() -> anyhow::Result<()> {
    let root = std::path::PathBuf::from(
        std::env::args_os()
            .nth(1)
            .expect("probe directory required"),
    );
    anyhow::ensure!(!root.exists(), "probe directory must not exist");
    let result = (|| -> anyhow::Result<()> {
        kcoder_skills::ensure_builtin_skills(&root)?;
        kcoder_skills::ensure_builtin_skills(&root)?;
        let skill = root.join("executable-probe");
        std::fs::create_dir_all(&skill)?;
        let text = b"---\nname: executable-probe\ndescription: fixture\n---\nfixture";
        std::fs::write(skill.join("SKILL.md"), text)?;
        std::fs::write(skill.join("run.py"), b"print('fixture')")?;
        let package = kcoder_skills::SkillPackage {
            name: "executable-probe".into(),
            files: vec![
                kcoder_skills::SkillPackageFile {
                    relative_path: "SKILL.md".into(),
                    content: text.to_vec(),
                    executable: false,
                },
                kcoder_skills::SkillPackageFile {
                    relative_path: "run.py".into(),
                    content: b"print('fixture')".to_vec(),
                    executable: true,
                },
            ],
        };
        let expected = kcoder_skills::canonical_package_revision(&package)?;
        let actual = kcoder_skills::skill_revision(&skill)?.unwrap();
        anyhow::ensure!(
            actual == expected,
            "Windows materialized executable-bit revision mismatch"
        );
        println!("PASS: builtin installation, revalidation and executable-bit normalization");
        Ok(())
    })();
    if root.exists() {
        std::fs::remove_dir_all(&root)?;
    }
    result
}
