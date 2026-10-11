//! Build/deployment check. Digest must come from trusted release metadata.
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 3 {
        eprintln!("usage: verify_runtime ROOT INVENTORY_SHA256");
        std::process::exit(2);
    }
    match kcoder_computer_use::runtime::VerifiedRuntime::verify(
        std::path::Path::new(&args[1]),
        &args[2].to_string_lossy(),
    ) {
        Ok(runtime) => println!("verified interpreter: {}", runtime.python().display()),
        Err(error) => {
            eprintln!("runtime rejected: {error:#}");
            std::process::exit(1);
        }
    }
}
