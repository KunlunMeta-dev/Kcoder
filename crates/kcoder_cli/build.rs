fn main() {
    // Release facts are written after Cargo, never compiler inputs.
    println!("cargo:rerun-if-changed=build.rs");
    // Windows' default 2 MiB main-thread reserve is smaller than normal CLI
    // startup and app-server construction. Match the bounded native worker
    // stack; increasing Tokio worker stacks alone cannot protect the main thread.
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("windows-gnu") {
        println!("cargo:rustc-link-arg-bin=kcoder=-Wl,--stack,16777216");
    } else if target.contains("windows-msvc") {
        println!("cargo:rustc-link-arg-bin=kcoder=/STACK:16777216");
    } else if target.contains("linux-gnu") && std::env::var("PROFILE").as_deref() == Ok("debug") {
        // Keep all debug data while reducing the bytes in the verified image.
        println!("cargo:rustc-link-arg-bin=kcoder=-Wl,--compress-debug-sections=zlib");
    }
}
