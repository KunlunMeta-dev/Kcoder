//! Explicit native-host acceptance only; never reads an ordinary credential account.
#[cfg(windows)]
#[path = "windows_migration_security/implementation.rs"]
mod windows;

#[cfg(windows)]
fn main() {
    if let Err(error) = windows::entry() {
        // Errors contain only owned paths or static stage identifiers; no secret values.
        eprintln!(
            "native_security_helper_failed: {}",
            error.to_string().chars().take(240).collect::<String>()
        );
        std::process::exit(2);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("native_security_helper_requires_windows");
    std::process::exit(2);
}
