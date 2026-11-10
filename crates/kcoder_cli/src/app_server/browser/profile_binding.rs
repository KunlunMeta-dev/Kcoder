//! Retain the authenticated owner and exclusive Cookie directory through process cleanup.
use crate::profile_catalog;
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::browser_profiles::BrowserProfileSelection;
use kcoder_config::PrivateDirectory;
use kcoder_native_scope::{NativeDomainGuard, NativeIntegrationContext};
use kcoder_state::browser_profiles::{BrowserProfileStore, BrowserProfileUse};
use kcoder_types::browser_profiles::BrowserAccountProfile;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

pub(super) struct BrowserProfileBinding {
    native: NativeIntegrationContext,
    guard: NativeDomainGuard,
    store: BrowserProfileStore,
    usage: BrowserProfileUse,
    directory: PrivateDirectory,
    path: PathBuf,
    profile: BrowserAccountProfile,
    started: bool,
    released: bool,
    cleanup_receipt: Option<std::fs::File>,
}

impl BrowserProfileBinding {
    pub(super) fn capture(
        native: &NativeIntegrationContext,
        selection: &BrowserProfileSelection,
        intent_sha256: &str,
    ) -> Result<Self> {
        native.validate_scope(&selection.scope)?;
        let native = native.recapture_for_owned_service()?;
        let (guard, store) =
            profile_catalog::load(&native)?.context("BROWSER_PROFILE_NOT_FOUND")?;
        store.reconcile_cleanup_receipts()?;
        let mut page = store.list(None, false)?;
        let profile = loop {
            if let Some(profile) = page
                .items
                .into_iter()
                .find(|p| p.draft.id == selection.profile_id)
            {
                break profile;
            }
            let Some(cursor) = page.next_cursor else {
                anyhow::bail!("BROWSER_PROFILE_NOT_FOUND");
            };
            page = store.list(Some(&cursor), false)?;
        };
        ensure!(
            profile.revision == selection.expected_revision,
            "BROWSER_PROFILE_REVISION_CONFLICT"
        );
        let usage = store.begin_use_operation(
            &selection.profile_id,
            selection.expected_revision,
            &selection.operation_id,
            intent_sha256,
        )?;
        let prepared = (|| -> Result<_> {
            let cleanup_receipt = store.prepare_cleanup_receipt(&usage)?;
            let directory = store.user_data_directory(&usage)?;
            let path = native
                .profile_path()?
                .join(guard.namespace_id())
                .join("catalog")
                .join(store.user_data_name(&usage)?);
            let actual = PrivateDirectory::open_existing(&path)?;
            actual.verify_private_directory()?;
            ensure!(
                actual.directory_identity()? == directory.directory_identity()?,
                "BROWSER_PROFILE_DATA_DIRECTORY_CHANGED"
            );
            Ok((directory, path, cleanup_receipt))
        })();
        let (directory, path, cleanup_receipt) = match prepared {
            Ok(result) => result,
            Err(error) => {
                // No process has been launched; this owned reservation may be released.
                let _ = store.finish_use_after_owned_cleanup(&usage);
                return Err(error);
            }
        };
        let binding = Self {
            native,
            guard,
            store,
            usage,
            directory,
            path,
            profile,
            started: false,
            released: false,
            cleanup_receipt: Some(cleanup_receipt),
        };
        binding.verify()?;
        Ok(binding)
    }

    pub(super) fn verify(&self) -> Result<()> {
        self.native.verify()?;
        let domain = self.guard.directory(self.native.profile()?)?;
        let catalog = domain
            .open_entry_handle(OsStr::new("catalog"))?
            .open_child_directory()?;
        let current = catalog
            .open_entry_handle(&self.store.user_data_name(&self.usage)?)?
            .open_child_directory()?;
        self.store
            .verify_user_data_directory(&self.usage, &current)?;
        ensure!(
            current.directory_identity()? == self.directory.directory_identity()?,
            "BROWSER_PROFILE_DATA_DIRECTORY_CHANGED"
        );
        let actual = PrivateDirectory::open_existing(&self.path)?;
        actual.verify_private_directory()?;
        ensure!(
            actual.directory_identity()? == self.directory.directory_identity()?,
            "BROWSER_PROFILE_DATA_DIRECTORY_CHANGED"
        );
        Ok(())
    }
    pub(super) fn path(&self) -> &Path {
        &self.path
    }
    pub(super) fn profile(&self) -> &BrowserAccountProfile {
        &self.profile
    }
    pub(super) fn mark_started(&mut self) {
        self.started = true;
    }
    pub(super) fn take_cleanup_receipt(&mut self) -> Result<std::fs::File> {
        self.cleanup_receipt
            .take()
            .context("BROWSER_PROFILE_CLEANUP_RECEIPT_MISSING")
    }
    pub(super) fn finish_after_termination(&mut self) -> Result<()> {
        if self.released {
            return Ok(());
        }
        #[cfg(windows)]
        ensure!(
            self.cleanup_confirmed()?,
            "BROWSER_PROFILE_CLEANUP_UNCONFIRMED"
        );
        // Account revocation cannot prevent cleanup of this exact original reservation.
        self.store.finish_use_after_owned_cleanup(&self.usage)?;
        self.released = true;
        Ok(())
    }

    #[cfg(windows)]
    pub(super) fn cleanup_confirmed(&self) -> Result<bool> {
        self.store.cleanup_receipt_confirmed(&self.usage)
    }
}
impl Drop for BrowserProfileBinding {
    fn drop(&mut self) {
        if !self.started
            && !self.released
            && self
                .store
                .finish_use_after_owned_cleanup(&self.usage)
                .is_err()
        {
            tracing::warn!("browser profile reservation cleanup remains unconfirmed");
        }
        // After launch, only actual owned process-tree termination releases use.
    }
}

pub(super) async fn close_owned_session(session: &mut super::BrowserSession) -> Result<()> {
    if session.process.profile_binding.is_some() {
        // Let Chromium flush this owner's persistent profile before bounded forced cleanup.
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            super::browser_cdp_command_raw(
                &mut session.socket,
                &mut session.next_command_id,
                None,
                "Browser.close",
                serde_json::json!({}),
            ),
        )
        .await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
        while session.process.child.try_wait()?.is_none() && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
    session.process.terminate().await
}

#[cfg(all(test, any(target_os = "linux", windows)))]
#[path = "profile_binding/tests.rs"]
mod tests;

pub(super) fn authorize_automation(session: Option<&super::BrowserSession>) -> Result<()> {
    if let Some(session) = session {
        session.process.verify_profile()?;
        ensure!(
            session.control_mode
                == kcoder_app_protocol::browser_profiles::BrowserControlMode::Automation,
            "BROWSER_PROFILE_HUMAN_CONTROL_ACTIVE"
        );
    }
    Ok(())
}

pub(super) fn authorize_human(
    session: Option<&super::BrowserSession>,
    expected: u64,
) -> Result<()> {
    let session = session.context("browser session not found")?;
    session.process.verify_profile()?;
    ensure!(
        session.process.profile_binding.is_some(),
        "BROWSER_PROFILE_SESSION_REQUIRED"
    );
    ensure!(
        session.control_revision == expected,
        "BROWSER_PROFILE_CONTROL_REVISION_CONFLICT"
    );
    ensure!(
        session.control_mode == kcoder_app_protocol::browser_profiles::BrowserControlMode::Human,
        "BROWSER_PROFILE_HUMAN_CONTROL_REQUIRED"
    );
    Ok(())
}

pub(super) async fn handoff(
    sessions: &mut std::collections::HashMap<String, super::BrowserSession>,
    params: kcoder_app_protocol::browser_profiles::BrowserHandoffParams,
) -> Result<kcoder_app_protocol::browser_profiles::BrowserHandoffState> {
    let session = sessions
        .get_mut(&params.session_id)
        .context("browser session not found")?;
    session.process.verify_profile()?;
    ensure!(
        session.process.profile_binding.is_some(),
        "BROWSER_PROFILE_SESSION_REQUIRED"
    );
    ensure!(
        session.control_revision == params.expected_revision,
        "BROWSER_PROFILE_CONTROL_REVISION_CONFLICT"
    );
    // Reobserve after human work. A failed observation keeps human control in place.
    super::browser_adopt_ready_popup(session).await?;
    let observed = super::browser_page_state(session).await?;
    super::validate_browser_url(&observed.url)?;
    session.process.verify_profile()?;
    session.control_revision = session
        .control_revision
        .checked_add(1)
        .context("BROWSER_PROFILE_CONTROL_REVISION_LIMIT")?;
    session.control_mode = params.mode;
    Ok(kcoder_app_protocol::browser_profiles::BrowserHandoffState {
        session_id: params.session_id,
        revision: session.control_revision,
        mode: session.control_mode,
        observed_url: observed.url,
    })
}

pub(super) async fn control_read(
    sessions: &mut std::collections::HashMap<String, super::BrowserSession>,
    params: kcoder_app_protocol::BrowserSessionParams,
) -> Result<kcoder_app_protocol::browser_profiles::BrowserHandoffState> {
    let session = sessions
        .get_mut(&params.session_id)
        .context("browser session not found")?;
    session.process.verify_profile()?;
    ensure!(
        session.process.profile_binding.is_some(),
        "BROWSER_PROFILE_SESSION_REQUIRED"
    );
    let observed = super::browser_page_state(session).await?;
    session.process.verify_profile()?;
    Ok(kcoder_app_protocol::browser_profiles::BrowserHandoffState {
        session_id: params.session_id,
        revision: session.control_revision,
        mode: session.control_mode,
        observed_url: observed.url,
    })
}
