//! A single-threaded boundary before the application runtime starts.
//! The caller owns policy, inherited descriptors, and process supervision.

#[cfg(target_os = "linux")]
#[path = "../filesystem_launch.rs"]
mod filesystem_launch;

fn main() {
    #[cfg(target_os = "linux")]
    let result = filesystem_launch::run();
    #[cfg(not(target_os = "linux"))]
    let result: std::io::Result<()> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "filesystem-restricted launch requires Linux",
    ));

    if let Err(error) = result {
        eprintln!("proc-safe filesystem launch: {error}");
        std::process::exit(126);
    }
}
