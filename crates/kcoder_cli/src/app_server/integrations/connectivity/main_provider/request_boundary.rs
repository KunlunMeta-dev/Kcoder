//! One reverse request's identity and configuration boundary.
//!
//! Security argument (see also docs/development.md, 校验生命周期与性能边界):
//!
//! * `open` performs the request's single full identity verification
//!   (`NativeConnectivityParent::verify`: organization/personal launch check,
//!   profile and workspace re-resolved by path and compared
//!   with the held handles, current identity snapshot enabled with the captured
//!   generation, lifecycle revision) and the request's single settings load.
//! * Between `open` and `close`, callers use `check_held`, which only compares
//!   the SAME borrowed context and parent objects: captured scope labels and
//!   the held parent process handle (pidfd/Job/process handle, never a PID
//!   lookup). It never re-resolves a path, so it cannot be redirected to a
//!   replacement directory or process.
//! * `close` performs the second full verification after all IPC and effects
//!   of this request, so a revocation, a replaced profile/workspace, a changed
//!   lifecycle revision or an exited parent observed at any point up to the
//!   reply still fails the request closed.
//!
//! The removed intermediate full verifications (application resource host,
//! repeated settings reads) ran synchronously inside the same request with no
//! new caller input between them. A full check at time T only proves state at
//! T; effects later in the request are guarded by their own authoritative
//! checks (task, source and runtime admission), which this module does not
//! replace. The removed checks therefore only narrowed a concurrent-revocation
//! race window that `close` and those effect checks already bound.
//!
//! The credential store mode is linearized at `open`. A trailing re-read could
//! not undo credential reads or effects already made with the original vault;
//! it only suppressed the reply. The mode is a configuration selection, not an
//! authorization or revocation verdict, and the next request reloads it.
use super::super::super::core::NativeIntegrationContext;
use super::super::NativeConnectivityParent;
use anyhow::{Result, ensure};
use kcoder_config::{CredentialStoreMode, Settings};
use kcoder_types::integrations::core::IntegrationScope;

pub(super) struct ReverseRequestBoundary<'a> {
    context: &'a NativeIntegrationContext,
    parent: &'a NativeConnectivityParent,
    settings: Settings,
}

impl<'a> ReverseRequestBoundary<'a> {
    pub(super) fn open(
        context: &'a NativeIntegrationContext,
        parent: &'a NativeConnectivityParent,
        captured: &IntegrationScope,
        mode: CredentialStoreMode,
        load_settings: impl FnOnce() -> Result<Settings>,
    ) -> Result<Self> {
        context.check_captured_scope(captured)?;
        parent.verify(context)?;
        let settings = load_settings()?;
        ensure!(
            settings.credential_store == mode,
            "CONNECTIVITY_CREDENTIAL_CONFIGURATION_CHANGED"
        );
        Ok(Self {
            context,
            parent,
            settings,
        })
    }

    /// The settings loaded once at `open`; valid only for this request.
    pub(super) fn settings(&self) -> &Settings {
        &self.settings
    }

    /// Cheap in-request check against the same held objects verified at `open`.
    pub(super) fn check_held(
        &self,
        context: &NativeIntegrationContext,
        parent: &NativeConnectivityParent,
    ) -> Result<()> {
        ensure!(
            std::ptr::eq(context, self.context) && std::ptr::eq(parent, self.parent),
            "CONNECTIVITY_MAIN_OWNER_CHANGED"
        );
        parent.check_process_for_captured_scope(context)
    }

    pub(super) fn close(self) -> Result<()> {
        self.parent.verify(self.context)
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::lease::test_support::{fixture, owned_parent};
    use super::*;
    use std::cell::Cell;

    fn settings() -> Settings {
        Settings::default()
    }

    #[tokio::test]
    async fn one_request_verifies_identity_twice_and_loads_settings_once() -> Result<()> {
        let (_temp, context) = fixture()?;
        let (mut child, parent) = owned_parent(&context).await?;
        let mode = settings().credential_store;
        let loads = Cell::new(0);
        let before = context.identity_checks();
        let boundary =
            ReverseRequestBoundary::open(&context, &parent, context.scope(), mode, || {
                loads.set(loads.get() + 1);
                Ok(settings())
            })?;
        for _ in 0..8 {
            boundary.check_held(&context, &parent)?;
            assert_eq!(boundary.settings().credential_store, mode);
        }
        boundary.close()?;
        assert_eq!(context.identity_checks() - before, 2);
        assert_eq!(loads.get(), 1);
        child.kill().await?;
        Ok(())
    }

    #[tokio::test]
    async fn revocation_between_requests_and_mid_request_fails_closed() -> Result<()> {
        let (temp, context) = fixture()?;
        let (mut child, parent) = owned_parent(&context).await?;
        let mode = settings().credential_store;
        let boundary =
            ReverseRequestBoundary::open(&context, &parent, context.scope(), mode, || {
                Ok(settings())
            })?;
        // Replace the profile directory while the request is in flight: the
        // cheap check is not an allow verdict, and `close` must reject.
        let profile = temp.path().join("profile");
        std::fs::rename(&profile, temp.path().join("old-profile"))?;
        kcoder_config::PrivateDirectory::open_existing(temp.path())?
            .create_private_child(std::ffi::OsStr::new("profile"))?;
        assert!(boundary.close().is_err());
        assert!(
            ReverseRequestBoundary::open(&context, &parent, context.scope(), mode, || Ok(
                settings()
            ))
            .is_err(),
            "the next request must not reuse an earlier verification"
        );
        child.kill().await?;
        Ok(())
    }

    #[tokio::test]
    async fn exited_parent_is_rejected_by_the_cheap_check_and_at_close() -> Result<()> {
        let (_temp, context) = fixture()?;
        let (mut child, parent) = owned_parent(&context).await?;
        let mode = settings().credential_store;
        let boundary =
            ReverseRequestBoundary::open(&context, &parent, context.scope(), mode, || {
                Ok(settings())
            })?;
        child.kill().await?;
        child.wait().await?;
        assert!(boundary.check_held(&context, &parent).is_err());
        assert!(boundary.close().is_err());
        assert!(
            ReverseRequestBoundary::open(&context, &parent, context.scope(), mode, || Ok(
                settings()
            ))
            .is_err()
        );
        Ok(())
    }

    #[tokio::test]
    async fn changed_credential_mode_or_foreign_objects_are_rejected() -> Result<()> {
        let (_temp, context) = fixture()?;
        let (mut child, parent) = owned_parent(&context).await?;
        let (_other_temp, other) = fixture()?;
        let (mut other_child, other_parent) = owned_parent(&other).await?;
        let mut changed = settings();
        changed.credential_store = match changed.credential_store {
            CredentialStoreMode::Auto => CredentialStoreMode::File,
            _ => CredentialStoreMode::Auto,
        };
        assert_eq!(
            ReverseRequestBoundary::open(
                &context,
                &parent,
                context.scope(),
                settings().credential_store,
                || Ok(changed.clone())
            )
            .err()
            .map(|error| error.to_string())
            .as_deref(),
            Some("CONNECTIVITY_CREDENTIAL_CONFIGURATION_CHANGED")
        );
        let boundary = ReverseRequestBoundary::open(
            &context,
            &parent,
            context.scope(),
            settings().credential_store,
            || Ok(settings()),
        )?;
        // The cheap check only accepts the exact objects verified at open.
        assert!(boundary.check_held(&other, &parent).is_err());
        assert!(boundary.check_held(&context, &other_parent).is_err());
        boundary.close()?;
        child.kill().await?;
        other_child.kill().await?;
        Ok(())
    }
}
