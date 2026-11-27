//! Read-only deployment probe; never obtains control or sends input.
fn main() {
    match kcoder_computer_use::desktop::inspect_interactive_desktop() {
        Ok(desktop) => println!("interactive_session={}", desktop.session_id),
        Err(error) => {
            eprintln!("desktop_unavailable: {error:?}");
            std::process::exit(2);
        }
    }
}
