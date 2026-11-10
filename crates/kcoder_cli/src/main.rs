fn main() -> anyhow::Result<()> {
    kcoder_cli_runtime::initialize_build_identity(kcoder_cli_runtime::BuildIdentity {
        version: env!("CARGO_PKG_VERSION"),
        commit: env!("KCODER_BUILD_COMMIT"),
        dirty: env!("KCODER_BUILD_DIRTY"),
        time_unix: env!("KCODER_BUILD_TIME_UNIX"),
    })
    .map_err(anyhow::Error::msg)?;
    kcoder_cli_runtime::run_cli(kcoder_cli_runtime::CliRunners {
        repl: |engine, notice| Box::pin(kcoder_repl::run_repl_with_engine(engine, notice)),
        headless: |engine, prompt, permissions, json, events| {
            Box::pin(kcoder_cli_headless::run(
                engine,
                prompt,
                permissions,
                json,
                events,
            ))
        },
    })
}
