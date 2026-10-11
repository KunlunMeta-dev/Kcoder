use std::io::{IsTerminal, Read};
use std::time::{Duration, Instant};

fn main() {
    let (ready, started) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        ready.send(()).unwrap();
        let mut byte = [0_u8; 1];
        let _ = std::io::stdin().read_exact(&mut byte);
    });
    started.recv().unwrap();
    std::thread::sleep(Duration::from_millis(100));
    eprintln!("terminal-query-start");
    let started = Instant::now();
    let terminal = std::io::stdin().is_terminal();
    eprintln!(
        "terminal-query-finished terminal={terminal} elapsed_ms={}",
        started.elapsed().as_millis()
    );
}
