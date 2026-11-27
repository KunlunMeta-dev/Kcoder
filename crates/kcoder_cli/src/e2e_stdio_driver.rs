#[cfg(debug_assertions)]
fn main() -> anyhow::Result<()> {
    kcoder_cli_runtime::enable_e2e_http_transport_for_test_driver();
    kcoder_cli_runtime::initialize_release_metadata(None, env!("CARGO_PKG_VERSION"))
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

#[cfg(not(debug_assertions))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("the app-server E2E driver requires a debug test build")
}
