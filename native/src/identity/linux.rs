use super::{ProcessIdentity, identity};
use crate::error::{failure, io};
use napi::Result;
use std::fs;

fn boot_time() -> Result<u64> {
    let stat = fs::read_to_string("/proc/stat").map_err(io)?;
    stat.lines()
        .find_map(|l| l.strip_prefix("btime "))
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| failure("layout-mismatch", "missing or invalid procfs boot time"))
}

pub fn read(pid: u32) -> Result<Option<ProcessIdentity>> {
    let before = boot_time()?;
    let stat = match fs::read(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // hidepid can conceal a live process. ENOENT alone does not establish absence.
            if unsafe { libc::kill(pid as i32, 0) } == -1 {
                let probe = std::io::Error::last_os_error();
                if probe.raw_os_error() == Some(libc::ESRCH) {
                    return Ok(None);
                }
                return Err(io(probe));
            }
            return Err(failure(
                "incomplete",
                "live process has no readable procfs identity",
            ));
        }
        Err(error) => return Err(io(error)),
    };
    if before != boot_time()? {
        return Err(failure(
            "incomplete",
            "boot time changed during process observation",
        ));
    }
    let prefix = format!("{pid} (");
    let end = stat
        .iter()
        .rposition(|byte| *byte == b')')
        .ok_or_else(|| failure("layout-mismatch", "invalid procfs comm field"))?;
    if !stat.starts_with(prefix.as_bytes()) || end < prefix.len() - 1 {
        return Err(failure("layout-mismatch", "procfs PID does not match"));
    }
    let numeric = std::str::from_utf8(&stat[end + 1..])
        .map_err(|_| failure("layout-mismatch", "invalid procfs numeric fields"))?;
    let fields: Vec<_> = numeric.split_whitespace().collect();
    let parent: u32 = fields
        .get(1)
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| failure("layout-mismatch", "invalid procfs parent PID"))?;
    let ticks: u64 = fields
        .get(19)
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| failure("layout-mismatch", "invalid procfs start ticks"))?;
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if hz <= 0 {
        return Err(failure(
            "operation-failed",
            "clock tick frequency is unavailable",
        ));
    }
    let micros = u128::from(before) * 1_000_000 + u128::from(ticks) * 1_000_000 / hz as u128;
    let micros = u64::try_from(micros)
        .map_err(|_| failure("layout-mismatch", "process start time overflow"))?;
    identity(pid, parent, micros, 1_000_000.0 / hz as f64).map(Some)
}
