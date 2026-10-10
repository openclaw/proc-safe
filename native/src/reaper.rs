use crate::error::{failure, io};
use napi::Result;
use napi_derive::napi;

#[napi(object)]
pub struct ChildWaitState {
    pub kind: String,
    pub pid: Option<u32>,
}

#[napi(object)]
pub struct ChildExit {
    pub pid: u32,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

enum Observation {
    None,
    Running,
    Exited { pid: i32, signal: Option<i32> },
}

fn validate_pid(pid: i32) -> Result<()> {
    if pid <= 0 {
        return Err(failure("invalid-argument", "pid must be positive"));
    }
    Ok(())
}

fn observe(pid: Option<i32>) -> Result<Observation> {
    if let Some(pid) = pid {
        validate_pid(pid)?;
    }
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            if pid.is_some() {
                libc::P_PID
            } else {
                libc::P_ALL
            },
            pid.unwrap_or(0) as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOWAIT | libc::WNOHANG | libc::__WALL,
        )
    };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ECHILD) {
            Ok(Observation::None)
        } else {
            Err(io(error))
        };
    }
    let observed = unsafe { info.si_pid() };
    if observed == 0 {
        return Ok(Observation::Running);
    }
    if observed < 0 || pid.is_some_and(|pid| pid != observed) {
        return Err(failure("layout-mismatch", "unexpected child wait PID"));
    }
    let signal = match info.si_code {
        libc::CLD_EXITED => None,
        libc::CLD_KILLED | libc::CLD_DUMPED => Some(unsafe { info.si_status() }),
        _ => return Err(failure("layout-mismatch", "unexpected child wait state")),
    };
    Ok(Observation::Exited {
        pid: observed,
        signal,
    })
}

fn signal_name(signal: i32) -> Result<&'static str> {
    match signal {
        libc::SIGHUP => Ok("SIGHUP"),
        libc::SIGINT => Ok("SIGINT"),
        libc::SIGQUIT => Ok("SIGQUIT"),
        libc::SIGILL => Ok("SIGILL"),
        libc::SIGTRAP => Ok("SIGTRAP"),
        libc::SIGABRT => Ok("SIGABRT"),
        libc::SIGBUS => Ok("SIGBUS"),
        libc::SIGFPE => Ok("SIGFPE"),
        libc::SIGKILL => Ok("SIGKILL"),
        libc::SIGUSR1 => Ok("SIGUSR1"),
        libc::SIGSEGV => Ok("SIGSEGV"),
        libc::SIGUSR2 => Ok("SIGUSR2"),
        libc::SIGPIPE => Ok("SIGPIPE"),
        libc::SIGALRM => Ok("SIGALRM"),
        libc::SIGTERM => Ok("SIGTERM"),
        libc::SIGSTKFLT => Ok("SIGSTKFLT"),
        libc::SIGCHLD => Ok("SIGCHLD"),
        libc::SIGCONT => Ok("SIGCONT"),
        libc::SIGSTOP => Ok("SIGSTOP"),
        libc::SIGTSTP => Ok("SIGTSTP"),
        libc::SIGTTIN => Ok("SIGTTIN"),
        libc::SIGTTOU => Ok("SIGTTOU"),
        libc::SIGURG => Ok("SIGURG"),
        libc::SIGXCPU => Ok("SIGXCPU"),
        libc::SIGXFSZ => Ok("SIGXFSZ"),
        libc::SIGVTALRM => Ok("SIGVTALRM"),
        libc::SIGPROF => Ok("SIGPROF"),
        libc::SIGWINCH => Ok("SIGWINCH"),
        libc::SIGIO => Ok("SIGIO"),
        libc::SIGPWR => Ok("SIGPWR"),
        libc::SIGSYS => Ok("SIGSYS"),
        _ => Err(failure(
            "layout-mismatch",
            "exit signal is outside NodeJS.Signals",
        )),
    }
}

#[napi]
pub fn become_child_subreaper() -> Result<()> {
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[napi]
pub fn is_child_subreaper() -> Result<bool> {
    let mut value = 0_i32;
    if unsafe { libc::prctl(libc::PR_GET_CHILD_SUBREAPER, &mut value, 0, 0, 0) } != 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(failure("layout-mismatch", "invalid child subreaper flag")),
    }
}

#[napi]
pub fn inspect_child_wait_state(pid: Option<i32>) -> Result<ChildWaitState> {
    let (kind, pid) = match observe(pid)? {
        Observation::None => ("none", None),
        Observation::Running => ("running", None),
        Observation::Exited { pid, .. } => ("exited", Some(pid as u32)),
    };
    Ok(ChildWaitState {
        kind: kind.into(),
        pid,
    })
}

#[napi]
pub fn reap_child(pid: i32) -> Result<Option<ChildExit>> {
    validate_pid(pid)?;
    // Reject unrepresentable real-time signals before consuming their status.
    match observe(Some(pid))? {
        Observation::None => return Err(failure("operation-failed", "not-a-child")),
        Observation::Running => return Ok(None),
        Observation::Exited {
            signal: Some(signal),
            ..
        } => {
            signal_name(signal)?;
        }
        Observation::Exited { signal: None, .. } => {}
    }
    let mut status = 0_i32;
    let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG | libc::__WALL) };
    if result == 0 {
        return Ok(None);
    }
    if result < 0 {
        let error = std::io::Error::last_os_error();
        return Err(if error.raw_os_error() == Some(libc::ECHILD) {
            failure("operation-failed", "not-a-child")
        } else {
            io(error)
        });
    }
    if result != pid {
        return Err(failure("layout-mismatch", "unexpected reaped PID"));
    }
    let (exit_code, signal) = if libc::WIFEXITED(status) {
        (Some(libc::WEXITSTATUS(status)), None)
    } else if libc::WIFSIGNALED(status) {
        (None, Some(signal_name(libc::WTERMSIG(status))?.into()))
    } else {
        return Err(failure("layout-mismatch", "unexpected reaped status"));
    };
    Ok(Some(ChildExit {
        pid: pid as u32,
        exit_code,
        signal,
    }))
}
