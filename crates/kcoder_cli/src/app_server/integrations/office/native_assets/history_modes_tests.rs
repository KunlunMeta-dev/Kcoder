//! Normal factory and tool-result directory producers, without a private-storage override.
use super::*;
use crate::app_server::engine_factory::AppServerEngineFactory;
use std::{
    process::{Child, Command},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
const TEST: &str = "app_server::integrations::office::native_assets::history::tests::normal_factory_history_capture_preserves_path_identity";
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
struct NoModel(AtomicUsize);
impl kcoder_api::Provider for NoModel {
    fn name(&self) -> &'static str {
        "owned-history-no-model"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.0.fetch_add(1, Ordering::SeqCst);
        panic!("History metadata must not invoke a provider")
    }
}
#[tokio::test]
async fn normal_factory_history_capture_preserves_path_identity() -> Result<()> {
    if std::env::var("KCODER_TEST_NORMAL_HISTORY_CHILD").as_deref() != Ok("1") {
        let root = tempfile::tempdir()?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        parent.create_private_child(OsStr::new("profile"))?;
        parent.create_private_child(OsStr::new("workspace"))?;
        let mut child = OwnedChild(
            Command::new(std::env::current_exe()?)
                .args([TEST, "--exact", "--nocapture", "--test-threads=1"])
                .env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap_or_default())
                .env("HOME", root.path())
                .env("KCODER_CONFIG_DIR", root.path().join("profile"))
                .env("KCODER_TEST_NORMAL_HISTORY_CHILD", "1")
                .env("RUST_MIN_STACK", "16777216")
                .current_dir(root.path().join("workspace"))
                .spawn()?,
        );
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(status) = child.0.try_wait()? {
                ensure!(status.success(), "normal factory history mode child failed");
                break;
            }
            ensure!(
                Instant::now() < deadline,
                "normal factory history mode child deadline"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        return Ok(());
    }
    let workspace = std::env::current_dir()?;
    let profile = PathBuf::from(std::env::var_os("KCODER_CONFIG_DIR").unwrap());
    let provider = Arc::new(NoModel(AtomicUsize::new(0)));
    let settings = kcoder_config::Settings {
        training_mode: true,
        history_enabled: true,
        ..Default::default()
    };
    let factory = AppServerEngineFactory::new(
        provider.clone(),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        workspace.clone(),
        Some(profile.join("history")),
        true,
        kcoder_engine::WorkspaceRuntimeServices::try_new_for_client(&workspace, "normal-history")?,
        Some(profile.join("settings.json")),
        profile.join("session-ids"),
    );
    let engine = factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
    engine.activate_client_session();
    engine.state.add_message(kcoder_types::Message::user_text(
        "Owned metadata-only normal history fixture.",
    ));
    engine.state.save_history()?;
    // The actual normal tool-result writer materializes the real factory path.
    kcoder_engine::context::ToolResultStorage::new(
        engine.session_storage_dir_for(&engine.session_id()),
    )
    .ensure_dir()
    .await?;
    let root = engine.client_storage_root();
    let session = engine.session_storage_dir_for(&engine.session_id());
    ensure!(
        root.is_dir() && session.is_dir(),
        "normal history was not written"
    );
    let captured = HistoryRoot::capture(&engine)?;
    ensure!(
        captured.directory.directory_identity()?
            == PrivateDirectory::open_existing(&root)?.directory_identity()?
    );
    let moved = root.with_extension("owned-replaced");
    std::fs::rename(&root, &moved)?;
    std::os::unix::fs::symlink(&moved, &root)?;
    ensure!(
        HistoryRoot::capture(&engine).is_err(),
        "symlink history must fail closed"
    );
    ensure!(
        captured.verify_owner(&engine).is_err(),
        "cached symlink replacement must fail closed"
    );
    std::fs::remove_file(&root)?;
    std::fs::rename(&moved, &root)?;
    let replaced = profile.with_extension("owned-profile-replaced");
    std::fs::rename(&profile, &replaced)?;
    PrivateDirectory::open_or_create(&profile)?;
    ensure!(
        captured.verify_owner(&engine).is_err(),
        "same-label profile replacement must not retain history authority"
    );
    ensure!(provider.0.load(Ordering::SeqCst) == 0);
    Ok(())
}
