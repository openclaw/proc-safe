use super::{ProcessIdentity, identity};
use crate::error::{failure, io};
use napi::Result;
use std::{fs, os::fd::AsRawFd, sync::OnceLock};

fn visibility_permissive() -> bool {
    static POLICY: OnceLock<bool> = OnceLock::new();
    *POLICY.get_or_init(|| {
        let Ok(mounts) = fs::read_to_string("/proc/self/mountinfo") else {
            return false;
        };
        let Ok(directory) = fs::File::open("/proc") else {
            return false;
        };
        let Ok(fdinfo) = fs::read_to_string(format!("/proc/self/fdinfo/{}", directory.as_raw_fd()))
        else {
            return false;
        };
        let Some(mount_id) = fdinfo.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            (key == "mnt_id").then(|| value.trim())
        }) else {
            return false;
        };
        let Some(fields) = mounts.lines().find_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            (fields.first() == Some(&mount_id)).then_some(fields)
        }) else {
            return false;
        };
        let Some(separator) = fields.iter().position(|field| *field == "-") else {
            return false;
        };
        if fields.get(separator + 1) != Some(&"proc") {
            return false;
        }
        let Some(super_options) = fields.get(separator + 3) else {
            return false;
        };
        let Some(mount_options) = fields.get(5) else {
            return false;
        };
        [mount_options, super_options].iter().all(|options| {
            options
                .split(',')
                .all(|option| match option.strip_prefix("hidepid=") {
                    Some(value) => matches!(value, "0" | "off"),
                    None => true,
                })
        })
    })
}

fn boot_time() -> Result<u64> {
    let stat = fs::read_to_string("/proc/stat").map_err(io)?;
    stat.lines()
        .find_map(|l| l.strip_prefix("btime "))
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| failure("layout-mismatch", "missing or invalid procfs boot time"))
}

pub fn read(pid: u32) -> Result<Option<ProcessIdentity>> {
    let permissive = visibility_permissive();
    let before = boot_time()?;
    let stat = match fs::read(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !permissive && pid != unsafe { libc::getpid() } as u32 {
                return Err(super::visibility::denied());
            }
            // Confirm absence if the procfs view and the signal namespace disagree.
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
    let since_boot = u128::from(ticks) * 1_000_000 / hz as u128;
    let micros = u128::from(before) * 1_000_000 + since_boot;
    let micros = u64::try_from(micros)
        .map_err(|_| failure("layout-mismatch", "process start time overflow"))?;
    let since_boot = u64::try_from(since_boot).map_err(|_| {
        failure(
            "layout-mismatch",
            "process boot-relative start time overflow",
        )
    })?;
    let state = fields
        .first()
        .filter(|value| value.len() == 1)
        .ok_or_else(|| failure("layout-mismatch", "invalid procfs process state"))?;
    identity(
        pid,
        parent,
        micros,
        1_000_000.0 / hz as f64,
        Some(since_boot),
        matches!(*state, "Z" | "X" | "x"),
    )
    .map(Some)
}
