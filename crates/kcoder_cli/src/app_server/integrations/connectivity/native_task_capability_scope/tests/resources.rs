use super::*;

#[tokio::test]
async fn explicit_empty_resource_ceiling_survives_legacy_selection_changes_and_replay() -> Result<()>
{
    let f = Fixture::new().await?;
    let choices = f.choices().await?;
    let binding = f.bind(selected(choices.clone())).await?;
    let guard = f.guard()?;
    guard.bind(binding.clone()).await?;
    assert!(
        binding
            .snapshot(&f.context, f.facts.as_ref())
            .await?
            .effective_resource_bindings
            .is_none()
    );
    assert!(
        f.check(
            &guard,
            external("source-A", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_ok()
    );
    f.facts.management.store(false, Ordering::SeqCst);
    assert!(
        binding
            .stage_selection_with_resources(
                &f.context,
                "no-owner-resource",
                1,
                selected(choices.clone()),
                Some(vec![]),
                &f.catalog,
                f.facts.as_ref()
            )
            .await
            .is_err()
    );
    f.facts.management.store(true, Ordering::SeqCst);
    let staged = binding
        .stage_selection_with_resources(
            &f.context,
            "empty-resource",
            1,
            selected(choices.clone()),
            Some(vec![]),
            &f.catalog,
            f.facts.as_ref(),
        )
        .await?;
    assert_eq!(staged.resource_bindings, Some(vec![]));
    assert!(staged.effective_resource_bindings.is_none());
    let applied = f
        .commit(&binding, "apply-empty-resource", staged.revision)
        .await?;
    assert_eq!(applied.effective_resource_bindings, Some(vec![]));
    assert!(
        f.check(
            &guard,
            external("source-A", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_err()
    );
    let later = binding
        .stage_selection(
            &f.context,
            "legacy-selection-only",
            applied.revision,
            selected(choices.clone()),
            &f.catalog,
            f.facts.as_ref(),
        )
        .await?;
    let retained = f
        .commit(&binding, "apply-legacy-selection", later.revision)
        .await?;
    assert_eq!(retained.resource_bindings, Some(vec![]));
    assert_eq!(retained.effective_resource_bindings, Some(vec![]));
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
        binding
            .stage_selection(
                &f.context,
                "empty-resource",
                1,
                selected(choices),
                &f.catalog,
                f.facts.as_ref()
            )
            .await
            .is_err()
    );
    f.shutdown().await;
    Ok(())
}
