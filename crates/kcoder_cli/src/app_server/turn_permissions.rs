use kcoder_config::PermissionMode;
use kcoder_engine::QueryEngine;

/// A UI-selected mode applies to one turn and is restored on success, error, or abort.
pub(super) struct TurnPermissions {
    engine: QueryEngine,
    previous: Option<(PermissionMode, PermissionMode)>,
}

impl TurnPermissions {
    pub(super) fn new(engine: QueryEngine, mode: Option<PermissionMode>) -> Self {
        let previous = mode.map(|mode| {
            let mut settings = engine.settings.write().unwrap_or_else(|e| e.into_inner());
            let mut permissions = engine
                .permissions
                .write()
                .unwrap_or_else(|e| e.into_inner());
            let previous = (settings.permission_mode, permissions.mode);
            settings.permission_mode = mode;
            permissions.mode = mode;
            previous
        });
        Self { engine, previous }
    }
}

impl Drop for TurnPermissions {
    fn drop(&mut self) {
        if let Some((settings_mode, engine_mode)) = self.previous {
            self.engine
                .settings
                .write()
                .unwrap_or_else(|e| e.into_inner())
                .permission_mode = settings_mode;
            self.engine
                .permissions
                .write()
                .unwrap_or_else(|e| e.into_inner())
                .mode = engine_mode;
        }
    }
}
