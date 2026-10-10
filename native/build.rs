fn main() {
    napi_build::setup();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/identity/macos-zombie.c")
            .compile("proc-safe-bsd-identity");
        println!("cargo:rerun-if-changed=src/identity/macos-zombie.c");
    }
}
