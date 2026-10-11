//! Real process/stdio smoke test; no desktop or personal application access.
#[cfg(windows)]
fn main() {
    use std::io::{BufRead, Write};
    if std::env::args().nth(1).as_deref() == Some("descendant") {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }
    if std::env::args().nth(1).as_deref() == Some("child") {
        let _descendant = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("descendant")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut input = String::new();
        std::io::stdin().lock().read_line(&mut input).unwrap();
        print!("echo:{input}");
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .arg("child")
        .current_dir(std::env::temp_dir())
        .env_clear();
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let reservation =
        kcoder_computer_use::windows_exclusive::DesktopReservation::acquire().unwrap();
    let mut child =
        kcoder_computer_use::windows_process::JobChild::spawn_for_desktop(&command, &reservation)
            .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all("中文 stdio\n".as_bytes())
        .unwrap();
    child.stdin.as_mut().unwrap().flush().unwrap();
    let mut line = String::new();
    std::io::BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(line, "echo:中文 stdio\n");
    drop(reservation);
    let next = kcoder_computer_use::windows_exclusive::DesktopReservation::acquire().unwrap();
    assert!(
        kcoder_computer_use::windows_process::JobChild::spawn_for_desktop(&command, &next).is_err()
    );
    child
        .terminate_and_wait(std::time::Duration::from_secs(5))
        .unwrap();
    // A terminated Windows Job cannot accept new processes. Retire the old
    // handle after the empty receipt before creating its next incarnation.
    drop(child);
    let mut replacement =
        kcoder_computer_use::windows_process::JobChild::spawn_for_desktop(&command, &next).unwrap();
    replacement
        .terminate_and_wait(std::time::Duration::from_secs(5))
        .unwrap();
    println!("PASS: Unicode stdio, old Job blocks replacement, empty Job permits replacement");
}
#[cfg(not(windows))]
fn main() {
    eprintln!("Windows-only probe");
    std::process::exit(2);
}
