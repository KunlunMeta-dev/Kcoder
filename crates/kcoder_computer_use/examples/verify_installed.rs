//! Read-only diagnostics for an explicitly supplied installation; no worker starts.
fn main() {
    let executable = std::env::args_os()
        .nth(1)
        .expect("installed CLI path required");
    let result =
        kcoder_computer_use::packaged::installed_runtime(std::path::Path::new(&executable));
    match result {
        Ok(_) => println!("{}", serde_json::json!({"verified":true})),
        Err(error) => {
            println!(
                "{}",
                serde_json::json!({"verified":false,"error":format!("{error:#}")})
            );
            std::process::exit(1);
        }
    }
}
