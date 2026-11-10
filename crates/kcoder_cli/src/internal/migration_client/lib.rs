//! Migration command adapter, independent of Engine, REPL and app-server wiring.
#[path = "cli_args.rs"]
pub mod cli_args;
#[path = "migration_cli.rs"]
pub mod migration_cli;
#[path = "../../migration_input.rs"]
pub mod migration_input;
#[path = "../../migration_view.rs"]
pub mod migration_view;
