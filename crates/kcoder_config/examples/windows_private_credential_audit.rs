//! Exact-reference OS-vault reads with owned proof metadata for the Windows fixture.
#[cfg(any(windows, test))]
#[path = "windows_private_credential_audit/audit.rs"]
mod audit;
#[cfg(any(windows, test))]
#[path = "windows_private_credential_audit/proof.rs"]
mod proof;

#[cfg(windows)]
fn main() {
    match audit::execute(std::env::args().collect()) {
        Ok(value) => println!("{value}"),
        // Backend errors, JSON, paths and source values never enter stderr.
        Err(_) => {
            eprintln!("private_keyring_audit_failed");
            std::process::exit(2);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("private_keyring_audit_requires_windows");
    std::process::exit(2);
}
