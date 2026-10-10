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

fn clock_nanos(clock: libc::clockid_t) -> Result<i128> {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    if unsafe { libc::clock_gettime(clock, &mut time) } != 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    if time.tv_sec < 0 || !(0..1_000_000_000).contains(&time.tv_nsec) {
        return Err(failure("layout-mismatch", "invalid process clock value"));
    }
    Ok(i128::from(time.tv_sec) * 1_000_000_000 + i128::from(time.tv_nsec))
}

fn boot_epoch_bounds() -> Result<(i128, i128)> {
    let before = clock_nanos(libc::CLOCK_BOOTTIME)?;
    let realtime = clock_nanos(libc::CLOCK_REALTIME)?;
    let after = clock_nanos(libc::CLOCK_BOOTTIME)?;
    clock_sample_bounds(before, realtime, after)
}

fn clock_sample_bounds(before: i128, realtime: i128, after: i128) -> Result<(i128, i128)> {
    if after < before {
        return Err(failure(
            "incomplete",
            "boot clock changed during process observation",
        ));
    }
    // Measure the uncertainty with the non-jumping clock. Realtime endpoints
    // could hide a long deschedule if a backward wall-clock step cancels it.
    Ok((realtime - after, realtime - before))
}

fn boot_epoch_lower(before: (i128, i128), after: (i128, i128), hz: i128) -> Result<i128> {
    // Check each bracket, not just their intersection: a wide final bracket
    // could otherwise hide a wall-clock step by containing the earlier one.
    let tick = 1_000_000_000 / hz;
    if before.1 - before.0 > tick || after.1 - after.0 > tick {
        return Err(failure(
            "incomplete",
            "process clock sampling exceeded one tick",
        ));
    }
    let lower = before.0.max(after.0);
    if lower > before.1.min(after.1) {
        return Err(failure(
            "incomplete",
            "boot time changed during process observation",
        ));
    }
    Ok(lower)
}

pub fn read(pid: u32) -> Result<Option<ProcessIdentity>> {
    let permissive = visibility_permissive();
    let before = boot_epoch_bounds()?;
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
    let after = boot_epoch_bounds()?;
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
    let lower = boot_epoch_lower(before, after, i128::from(hz))?;
    // /proc btime truncates a whole second in addition to the birth tick.
    let micros = lower.div_euclid(1000) + since_boot as i128;
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

#[cfg(test)]
mod tests {
    use super::{boot_epoch_lower, clock_sample_bounds};

    #[test]
    fn intersects_tight_clock_brackets() {
        assert_eq!(boot_epoch_lower((100, 200), (150, 250), 100).unwrap(), 150);
        assert!(boot_epoch_lower((100, 200), (201, 300), 100).is_err());
    }

    #[test]
    fn rejects_a_clock_step_hidden_by_the_intersection() {
        let tight = (100, 200);
        let stepped = (100, 1_000_000_100);
        assert!(boot_epoch_lower(tight, stepped, 100).is_err());
        assert!(boot_epoch_lower(stepped, tight, 100).is_err());
    }

    #[test]
    fn rejects_a_backward_step_cancelling_elapsed_realtime() {
        let first = clock_sample_bounds(0, 1_000_000_100, 200).unwrap();
        // A 1 s pause with a 1 s backward realtime step must still measure
        // as a wide sample, even though realtime barely advanced.
        let paused = clock_sample_bounds(300, 1_000_000_101, 1_000_000_300).unwrap();
        assert!(boot_epoch_lower(first, paused, 100).is_err());
        assert!(clock_sample_bounds(200, 1_000_000_100, 100).is_err());
    }
}
