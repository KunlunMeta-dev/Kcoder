fn main() -> anyhow::Result<()> {
    let root = std::path::PathBuf::from(
        std::env::args_os()
            .nth(1)
            .expect("probe directory required"),
    );
    anyhow::ensure!(!root.exists(), "probe directory must not exist");
    let result = (|| -> anyhow::Result<()> {
        let directory = kcoder_config::PrivateDirectory::open_or_create(&root)?;
        directory.atomic_replace(std::ffi::OsStr::new("source.json"), br#"{"version":1}"#)?;
        directory.atomic_replace(std::ffi::OsStr::new("source.json"), br#"{"version":2}"#)?;
        let child = directory.open_child(std::ffi::OsStr::new("session.hctl"), true)?;
        child.atomic_replace(std::ffi::OsStr::new("source.json"), b"first")?;
        child.atomic_replace(std::ffi::OsStr::new("source.json"), b"second")?;
        println!(
            "PASS: newly-created root and child held open while source.json is created/replaced"
        );
        Ok(())
    })();
    if root.exists() {
        std::fs::remove_dir_all(&root)?;
    }
    result
}
