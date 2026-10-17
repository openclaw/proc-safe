use super::{ProcessSnapshot, macos};
use crate::{
    error::{failure, io},
    identity::read_process_identity,
};
use napi::Result;
use std::{
    collections::HashSet,
    mem::{size_of, zeroed},
    time::Instant,
};

struct Budget {
    started: Instant,
    timeout_ms: f64,
}

impl Budget {
    fn check(&self) -> Result<()> {
        if self.started.elapsed().as_secs_f64() * 1000.0 >= self.timeout_ms {
            return Err(failure("timeout", "process census exceeded timeoutMs"));
        }
        Ok(())
    }
}

fn empty_row(pid: u32) -> ProcessSnapshot {
    ProcessSnapshot {
        pid,
        parent_pid: None,
        process_group_id: None,
        state: None,
        identity: None,
        owner: "unknown".into(),
        command: None,
    }
}

fn state(value: u32) -> &'static str {
    match value {
        libc::SIDL => "idle",
        libc::SRUN => "running",
        libc::SSLEEP => "sleeping",
        libc::SSTOP => "stopped",
        libc::SZOMB => "zombie",
        _ => "unknown",
    }
}

fn topology(pid: u32, caller_uid: u32) -> Result<Option<ProcessSnapshot>> {
    let mut info: libc::proc_bsdshortinfo = unsafe { zeroed() };
    let size = size_of::<libc::proc_bsdshortinfo>();
    if size != 64 {
        return Err(failure(
            "layout-mismatch",
            "unexpected Darwin short process record size",
        ));
    }
    let actual = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDT_SHORTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdshortinfo).cast(),
            size as i32,
        )
    };
    let mut row = empty_row(pid);
    let (parent_pid, group, uid, status) = if actual <= 0 {
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => {
                // libproc hides zombies. Only the kernel record plus the existing
                // absence check may distinguish a retained zombie from a gone PID.
                let Some(kernel) = crate::identity::macos::read_kernel_info(pid)? else {
                    return Ok(None);
                };
                if kernel.state != libc::SZOMB {
                    return Ok(Some(row));
                }
                (
                    kernel.parent_pid,
                    kernel.process_group_id,
                    kernel.uid,
                    kernel.state,
                )
            }
            Some(libc::EPERM | libc::EACCES) => return Ok(Some(row)),
            _ => return Err(io(error)),
        }
    } else {
        if actual as usize != size || info.pbsi_pid != pid {
            return Err(failure(
                "layout-mismatch",
                "invalid Darwin short process record",
            ));
        }
        (
            info.pbsi_ppid,
            info.pbsi_pgid,
            info.pbsi_uid,
            info.pbsi_status,
        )
    };
    if parent_pid > i32::MAX as u32 || group > i32::MAX as u32 {
        return Err(failure(
            "layout-mismatch",
            "invalid Darwin process topology",
        ));
    }
    row.parent_pid = Some(parent_pid);
    row.process_group_id = Some(group);
    row.state = Some(state(status).into());
    row.owner = if uid == caller_uid {
        "same"
    } else {
        "different"
    }
    .into();
    Ok(Some(row))
}

pub fn list(
    timeout_ms: f64,
    include_command: bool,
    selected: Option<Vec<u32>>,
) -> Result<Vec<ProcessSnapshot>> {
    let budget = Budget {
        started: Instant::now(),
        timeout_ms,
    };
    if !timeout_ms.is_finite() || timeout_ms <= 0.0 {
        return Err(failure(
            "invalid-argument",
            "timeoutMs must be positive and finite",
        ));
    }
    budget.check()?;
    if include_command && !macos::supported()? {
        return Err(failure(
            "unsupported-platform",
            "process command inspection under Rosetta is unsupported; use native arm64 Node.js or Bun",
        ));
    }
    const PID_CAP: usize = 65_536;
    let mut pids = vec![0i32; PID_CAP];
    let actual = unsafe {
        libc::proc_listallpids(
            pids.as_mut_ptr().cast(),
            (PID_CAP * size_of::<i32>()) as i32,
        )
    };
    budget.check()?;
    if actual <= 0 || actual as usize >= PID_CAP {
        return Err(failure(
            "incomplete",
            "Darwin process enumeration failed or filled its PID buffer",
        ));
    }
    pids.truncate(actual as usize);
    let mut seen = HashSet::with_capacity(pids.len());
    if !pids.contains(&(std::process::id() as i32))
        || pids.iter().any(|&pid| pid < 0 || !seen.insert(pid))
    {
        return Err(failure(
            "incomplete",
            "Darwin process enumeration has invalid, duplicate, or missing caller PIDs",
        ));
    }
    let selected: Option<HashSet<_>> = selected.map(|pids| pids.into_iter().collect());
    let caller_uid = unsafe { libc::geteuid() };
    let mut rows = Vec::new();
    for pid in pids.into_iter().filter(|&pid| pid > 0) {
        budget.check()?;
        let pid = pid as u32;
        if selected
            .as_ref()
            .is_some_and(|selected| !selected.contains(&pid))
        {
            continue;
        }
        let before = read_process_identity(pid).ok().flatten();
        budget.check()?;
        let Some(mut row) = topology(pid, caller_uid)? else {
            continue;
        };
        budget.check()?;
        if let Some(before) = before {
            if include_command {
                row.command = macos::read(pid, &[]).ok().flatten();
                budget.check()?;
            }
            let after = read_process_identity(pid).ok().flatten();
            budget.check()?;
            // Darwin has no retained process handle. Bracket all combined facts
            // with birth identity; otherwise retain only the single topology read.
            if let Some(after) = after.filter(|after| {
                before.start_time_micros == after.start_time_micros
                    && before.parent_pid == after.parent_pid
                    && row.parent_pid == Some(after.parent_pid)
            }) {
                row.identity = Some(after);
            } else {
                row.command = None;
            }
        }
        rows.push(row);
    }
    budget.check()?;
    Ok(rows)
}
