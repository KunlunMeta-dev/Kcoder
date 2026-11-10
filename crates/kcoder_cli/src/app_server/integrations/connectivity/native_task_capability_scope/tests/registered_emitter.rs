use super::*;

#[tokio::test]
async fn a_matching_source_name_cannot_attach_facts_to_an_unregistered_native_object() -> Result<()>
{
    let f = Fixture::new().await?;
    let guard = f.guard()?;
    guard
        .bind(f.bind(selected(f.choices().await?)).await?)
        .await?;
    f.facts
        .engine
        .state
        .history_attempt_scope(f.facts.initial.clone())?
        .run(async {
            let source = external("source-A", "read");
            let (engine, name) = emitter_engine(&f.facts.engine, &source);
            let emitter = engine.native_tool_emitter_witness(&name).unwrap();
            let input = json!({});
            let request = NativeToolAuthorizationRequest {
                execution: Some(emitter.execution()),
                emitter: Some(&emitter),
                session_id: emitter.execution().session_id(),
                tool_name: &name,
                source,
                input: &input,
                read_only: true,
                without_sandbox: false,
                phase: NativeToolAuthorizationPhase::Dispatch,
            };
            // The label and current catalog match, but the actual Arc has not been
            // associated with its original native source stamp by the factory.
            assert!(guard.authorize(&request).await.is_err());
            let fact = f.facts.emitter_sources.lock().unwrap()["source-A"].clone();
            f.facts
                .emitter_objects
                .lock()
                .unwrap()
                .push((emitter.tool().clone(), fact));
            assert!(guard.authorize(&request).await.is_ok());
            Ok::<_, anyhow::Error>(())
        })
        .await?;
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn source_name_tool_name_or_separately_captured_frame_cannot_replace_emitter_proof()
-> Result<()> {
    let f = Fixture::new().await?;
    let guard = f.guard()?;
    guard.bind(f.bind(none()).await?).await?;
    f.facts
        .engine
        .state
        .history_attempt_scope(f.facts.initial.clone())?
        .run(async {
            let source = external("source-A", "read");
            let (engine, name) = emitter_engine(&f.facts.engine, &source);
            let emitter = engine.native_tool_emitter_witness(&name).unwrap();
            let other_frame = engine.native_tool_execution_witness();
            let input = json!({});
            for (execution, name, source) in [
                (emitter.execution(), name.as_str(), ToolSource::Builtin),
                (emitter.execution(), "read", source.clone()),
                (&other_frame, name.as_str(), source.clone()),
            ] {
                assert!(
                    guard
                        .authorize(&NativeToolAuthorizationRequest {
                            execution: Some(execution),
                            emitter: Some(&emitter),
                            session_id: execution.session_id(),
                            tool_name: name,
                            source,
                            input: &input,
                            read_only: true,
                            without_sandbox: false,
                            phase: NativeToolAuthorizationPhase::Admission,
                        })
                        .await
                        .is_err()
                );
            }
            Ok::<_, anyhow::Error>(())
        })
        .await?;
    f.shutdown().await;
    Ok(())
}
