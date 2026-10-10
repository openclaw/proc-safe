#[cfg(target_os = "macos")]
mod darwin;
#[cfg(target_os = "linux")]
mod diagnostics;
mod error;
mod identity;
#[cfg(target_os = "linux")]
mod reaper;
#[cfg(target_os = "linux")]
mod systemd;
#[cfg(any(target_os = "linux", target_os = "windows"))]
mod test_support;
