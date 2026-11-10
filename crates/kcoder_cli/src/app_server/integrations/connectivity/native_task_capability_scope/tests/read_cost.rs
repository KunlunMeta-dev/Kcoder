use super::*;

#[tokio::test]
async fn initial_registration_and_binding_share_one_source_observation() -> Result<()> {
    let f = Fixture::new().await?;
    f.facts.configs.lock().unwrap().push(config("source-C"));
    let before = f.facts.source_reads.load(Ordering::SeqCst);
    let binding = f
        .bind_registering(
            IntegrationTaskCapabilityScopeSelection {
                mode: IntegrationTaskCapabilityScopeMode::InheritCurrent,
                sources: vec![],
            },
            Some("initial-shared-observation"),
        )
        .await?;
    assert_eq!(f.facts.source_reads.load(Ordering::SeqCst) - before, 1);
    assert_eq!(
        binding
            .child_tool_snapshot(&f.context)?
            .effective_sources
            .len(),
        3
    );
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn no_sources_binding_does_not_discover_connectors_even_with_registration() -> Result<()> {
    let f = Fixture::new().await?;
    f.facts.source_unavailable.store(true, Ordering::SeqCst);
    let before = f.facts.source_reads.load(Ordering::SeqCst);
    let binding = f
        .bind_registering(none(), Some("no-sources-registration"))
        .await?;
    assert_eq!(f.facts.source_reads.load(Ordering::SeqCst), before);
    assert!(
        binding
            .child_tool_snapshot(&f.context)?
            .effective_sources
            .is_empty()
    );
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn registration_does_not_bypass_revocation_during_source_observation() -> Result<()> {
    let f = Fixture::new().await?;
    f.facts.pause_sources.store(true, Ordering::SeqCst);
    let registering = f.bind_registering(
        IntegrationTaskCapabilityScopeSelection {
            mode: IntegrationTaskCapabilityScopeMode::InheritCurrent,
            sources: vec![],
        },
        Some("revoked-registration"),
    );
    let revoking = async {
        f.facts.entered.notified().await;
        f.facts.management.store(false, Ordering::SeqCst);
        f.facts.release.notify_one();
    };
    let (result, ()) = tokio::join!(registering, revoking);
    assert!(result.is_err());
    let page = f.store.read_saved_directory(
        &f.context,
        &IntegrationTaskCapabilityScopeDirectoryReadParams {
            thread_id: None,
            cursor: None,
        },
    )?;
    assert!(
        page.entries.is_empty(),
        "revocation cannot commit a binding"
    );
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn warm_record_reads_one_current_index_and_rejects_later_corruption() -> Result<()> {
    let f = Fixture::new().await?;
    let binding = f.bind(none()).await?;
    let before = super::super::storage::index_reads();
    binding.child_tool_snapshot(&f.context)?;
    assert_eq!(super::super::storage::index_reads() - before, 1);
    let profile = f.context.profile()?;
    let domain = NativeDomainGuard::observe(
        profile,
        f.context.scope(),
        NativeDomain::ConnectivityTaskCapabilityScope,
    )?
    .unwrap();
    let directory = domain.directory(profile)?;
    directory.atomic_replace(OsStr::new("task-sources-index.json"), b"{")?;
    assert!(binding.child_tool_snapshot(&f.context).is_err());
    assert!(NativeTaskCapabilityScopeBindingStore::observe(&f.context).is_err());
    f.shutdown().await;
    Ok(())
}
