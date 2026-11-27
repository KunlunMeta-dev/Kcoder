mod release_metadata;

fn main() -> anyhow::Result<()> {
    let metadata = release_metadata::payload().map_err(anyhow::Error::msg)?;
    kcoder_cli_runtime::initialize_release_metadata(metadata.as_deref(), env!("CARGO_PKG_VERSION"))
        .map_err(anyhow::Error::msg)?;
    kcoder_cli_runtime::run_cli(kcoder_cli_runtime::CliRunners {
        repl: |engine, notice, command| {
            Box::pin(kcoder_repl::run_repl_with_startup_command(
                engine,
                notice,
                kcoder_cli_runtime::executable_version(),
                command,
            ))
        },
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
