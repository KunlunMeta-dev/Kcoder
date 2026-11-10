use super::*;

#[tokio::test]
async fn same_native_server_name_with_different_emitting_configuration_cannot_impersonate_selected_source()
-> Result<()> {
    let f = Fixture::new().await?;
    let guard = f.guard()?;
    guard
        .bind(f.bind(selected(f.choices().await?)).await?)
        .await?;
    assert!(
        f.check(
            &guard,
            external("source-A", "read"),
            NativeToolAuthorizationPhase::Admission
        )
        .await
        .is_ok()
    );
    let mut different = config("source-A");
    different.command = "different-owned-native-connection".into();
    let actual = NativeMcpSourceFact::from_resolved(
        &f.context,
        &f.facts.settings.lock().unwrap(),
        &different,
        None,
        &EmptyBackend,
    )?;
    f.facts
        .emitter_sources
        .lock()
        .unwrap()
        .insert("source-A".into(), Arc::new(actual));
    assert!(
        f.check(
            &guard,
            external("source-A", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_err()
    );
    f.facts.emitter_sources.lock().unwrap().remove("source-A");
    assert!(
        f.check(
            &guard,
            external("source-A", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_err()
    );
    assert!(
        f.check(
            &guard,
            external("source-B", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_ok()
    );
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn source_callback_requires_actual_connection_stamp_even_with_real_root_execution_witness()
-> Result<()> {
    let f = Fixture::new().await?;
    let choices = f.choices().await?;
    let selector =
        f.catalog
            .resolve_choice(&f.context, &choices[0], &f.facts.sources(&f.context).await?)?;
    let guard = f.guard()?;
    guard
        .bind(f.bind(selected(vec![choices[0].clone()])).await?)
        .await?;
    let witness = f.facts.engine.native_tool_execution_witness();
    let callback = NativeTaskCapabilityScopeCallback {
        session_id: witness.session_id(),
        native_witness: &witness,
    };
    assert!(
        guard
            .authorize_resource_source(&callback, &selector)
            .await
            .is_err()
    );
    assert!(
        guard
            .authorize_app_source(&callback, &selector)
            .await
            .is_err()
    );
    f.shutdown().await;
    Ok(())
}
