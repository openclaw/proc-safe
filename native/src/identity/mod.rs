use crate::error::failure;
use napi::Result;
use napi_derive::napi;

#[cfg(any(target_os = "linux", target_os = "freebsd"))]
mod visibility;

#[cfg(target_os = "freebsd")]
mod freebsd;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
pub(crate) mod windows;

#[napi(object)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub parent_pid: u32,
    pub start_time_micros: f64,
    pub start_time_resolution_micros: f64,
    pub start_time_since_boot_micros: Option<f64>,
    pub exited: bool,
}

pub fn identity(
    pid: u32,
    parent_pid: u32,
    micros: u64,
    resolution: f64,
    since_boot: Option<u64>,
    exited: bool,
) -> Result<ProcessIdentity> {
    if micros > 9_007_199_254_740_991
        || since_boot.is_some_and(|value| value > 9_007_199_254_740_991)
        || parent_pid > i32::MAX as u32 && !cfg!(windows)
    {
        return Err(failure(
            "layout-mismatch",
            "process identity is outside the exact numeric range",
        ));
    }
    Ok(ProcessIdentity {
        pid,
        parent_pid,
        start_time_micros: micros as f64,
        start_time_resolution_micros: resolution,
        start_time_since_boot_micros: since_boot.map(|value| value as f64),
        exited,
    })
}

#[napi]
pub fn read_process_identity(pid: u32) -> Result<Option<ProcessIdentity>> {
    if pid == 0 || (!cfg!(windows) && pid > i32::MAX as u32) {
        return Err(failure("invalid-argument", "invalid process ID"));
    }
    #[cfg(target_os = "linux")]
    return linux::read(pid);
    #[cfg(target_os = "macos")]
    return macos::read(pid);
    #[cfg(windows)]
    return windows::read(pid);
    #[cfg(target_os = "freebsd")]
    return freebsd::read(pid);
}
