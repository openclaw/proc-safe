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
    pub signal_number: Option<i32>,
}

enum Observation {
    None,
    Running,
    Exited { pid: i32 },
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
    let which = if pid.is_some() {
        libc::P_PID
    } else {
        libc::P_ALL
    };
    let id = pid.unwrap_or(0) as libc::id_t;
    let mut options = libc::WEXITED | libc::WNOWAIT | libc::WNOHANG | libc::__WALL;
    let mut result = unsafe { libc::waitid(which, id, &mut info, options) };
    if result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) {
        // Linux < 4.7 rejects __WALL in waitid options with EINVAL (the flag is
        // only accepted for clone children from 4.7 on). Retry without it so the
        // strict cleanup path stays usable on those kernels. The fallback
        // observes direct children only, which covers spawned processes; clone
        // children (threads) are not reached.
        options &= !libc::__WALL;
        result = unsafe { libc::waitid(which, id, &mut info, options) };
    }
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
    match info.si_code {
        libc::CLD_EXITED | libc::CLD_KILLED | libc::CLD_DUMPED => {}
        _ => return Err(failure("layout-mismatch", "unexpected child wait state")),
    }
    Ok(Observation::Exited { pid: observed })
}

fn signal_name(signal: i32) -> Option<&'static str> {
    match signal {
        libc::SIGHUP => Some("SIGHUP"),
        libc::SIGINT => Some("SIGINT"),
        libc::SIGQUIT => Some("SIGQUIT"),
        libc::SIGILL => Some("SIGILL"),
        libc::SIGTRAP => Some("SIGTRAP"),
        libc::SIGABRT => Some("SIGABRT"),
        libc::SIGBUS => Some("SIGBUS"),
        libc::SIGFPE => Some("SIGFPE"),
        libc::SIGKILL => Some("SIGKILL"),
        libc::SIGUSR1 => Some("SIGUSR1"),
        libc::SIGSEGV => Some("SIGSEGV"),
        libc::SIGUSR2 => Some("SIGUSR2"),
        libc::SIGPIPE => Some("SIGPIPE"),
        libc::SIGALRM => Some("SIGALRM"),
        libc::SIGTERM => Some("SIGTERM"),
        libc::SIGSTKFLT => Some("SIGSTKFLT"),
        libc::SIGCHLD => Some("SIGCHLD"),
        libc::SIGCONT => Some("SIGCONT"),
        libc::SIGSTOP => Some("SIGSTOP"),
        libc::SIGTSTP => Some("SIGTSTP"),
        libc::SIGTTIN => Some("SIGTTIN"),
        libc::SIGTTOU => Some("SIGTTOU"),
        libc::SIGURG => Some("SIGURG"),
        libc::SIGXCPU => Some("SIGXCPU"),
        libc::SIGXFSZ => Some("SIGXFSZ"),
        libc::SIGVTALRM => Some("SIGVTALRM"),
        libc::SIGPROF => Some("SIGPROF"),
        libc::SIGWINCH => Some("SIGWINCH"),
        libc::SIGIO => Some("SIGIO"),
        libc::SIGPWR => Some("SIGPWR"),
        libc::SIGSYS => Some("SIGSYS"),
        _ => None,
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
    let mut status = 0_i32;
    let mut result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG | libc::__WALL) };
    if result < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) {
        // Same kernel limitation as in observe(): retry without __WALL.
        result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    }
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
    let (exit_code, signal, signal_number) = if libc::WIFEXITED(status) {
        (Some(libc::WEXITSTATUS(status)), None, None)
    } else if libc::WIFSIGNALED(status) {
        let number = libc::WTERMSIG(status);
        (None, signal_name(number).map(str::to_owned), Some(number))
    } else {
        return Err(failure("layout-mismatch", "unexpected reaped status"));
    };
    Ok(Some(ChildExit {
        pid: pid as u32,
        exit_code,
        signal,
        signal_number,
    }))
}
