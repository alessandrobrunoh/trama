fn main() {
    // The target triple names the release asset `trama update` downloads.
    println!("cargo:rustc-env=TRAMA_TARGET={}", std::env::var("TARGET").unwrap_or_default());
    println!("cargo:rerun-if-changed=build.rs");
}
