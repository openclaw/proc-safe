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

// Linux < 4.7 rejects __WALL in waitid options with EINVAL, so observe() retries
// without it. Clone children whose exit signal is 0 are then invisible to
// waitid: ECHILD is only a proven absence when procfs confirms that no child
// is left; a procfs lookup that cannot answer is an incomplete observation.
enum ParentState {
    Child,
    NotChild,
    Unknown,
}

fn parse_parent_pid(stat: &[u8]) -> Option<i32> {
    // Field 4 is the parent PID; comm (field 2) may contain spaces, parens and
    // non-UTF-8 bytes, so the record is parsed as bytes.
    let close = stat.iter().rposition(|byte| *byte == b')')?;
    let rest = &stat[close + 1..];
    let mut fields = rest
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|field| !field.is_empty());
    let _state = fields.next()?;
    std::str::from_utf8(fields.next()?).ok()?.parse::<i32>().ok()
}

fn procfs_available() -> bool {
    // Read per observation: /proc can be unmounted or remounted after startup.
    std::fs::metadata("/proc/self/stat").is_ok()
}

// With hidepid=1/2 a child that clears PR_SET_DUMPABLE disappears from procfs
// entirely, so ENOENT no longer proves absence. Unknown mounts are treated as
// restricted to stay conservative.
fn procfs_hides_children() -> bool {
    // hidepid can change via remount while this process lives, so the mount
    // options are read for every observation instead of being cached.
    let Ok(mounts) = std::fs::read_to_string("/proc/mounts") else {
        return true;
    };
    mounts.lines().any(|line| {
        let mut fields = line.split_whitespace();
        let _source = fields.next();
        let target = fields.next();
        let _fstype = fields.next();
        let options = fields.next();
        target == Some("/proc")
            && options.is_some_and(|options| {
                options
                    .split(',')
                    .any(|option| option == "hidepid=1" || option == "hidepid=2")
            })
    })
}

fn parent_state(pid: i32) -> ParentState {
    match std::fs::read(format!("/proc/{pid}/stat")) {
        Ok(stat) => match parse_parent_pid(&stat) {
            Some(ppid) if ppid == unsafe { libc::getpid() } => ParentState::Child,
            Some(_) => ParentState::NotChild,
            None => ParentState::Unknown,
        },
        // ENOENT only proves that the process is gone when procfs itself is
        // mounted and readable. In a chroot or mount namespace without /proc it
        // proves nothing, so the observation stays inconclusive.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if procfs_available() && !procfs_hides_children() {
                ParentState::NotChild
            } else {
                ParentState::Unknown
            }
        }
        Err(_) => ParentState::Unknown,
    }
}

fn live_children_state() -> ParentState {
    let self_pid = unsafe { libc::getpid() };
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return ParentState::Unknown;
    };
    let mut unknown = false;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                unknown = true;
                continue;
            }
        };
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        if pid == self_pid {
            continue;
        }
        match parent_state(pid) {
            ParentState::Child => return ParentState::Child,
            ParentState::Unknown => unknown = true,
            ParentState::NotChild => {}
        }
    }
    if unknown || procfs_hides_children() {
        ParentState::Unknown
    } else {
        ParentState::NotChild
    }
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
    let mut fallback = false;
    if result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) {
        // Linux < 4.7 rejects __WALL in waitid options with EINVAL (the flag is
        // only accepted for clone children from 4.7 on). Retry without it so the
        // strict cleanup path stays usable on those kernels; clone children with
        // exit signal 0 are then invisible to waitid.
        fallback = true;
        options &= !libc::__WALL;
        result = unsafe { libc::waitid(which, id, &mut info, options) };
    }
    if result != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ECHILD) {
            if fallback {
                // Without __WALL a clone child (exit signal 0) is invisible, so
                // ECHILD is only a proven absence when procfs confirms that no
                // child is left; a lookup that cannot answer is incomplete.
                let state = match pid {
                    Some(pid) => parent_state(pid),
                    None => live_children_state(),
                };
                if !matches!(state, ParentState::NotChild) {
                    return Err(failure(
                        "incomplete",
                        "cannot observe clone children without __WALL on this kernel",
                    ));
                }
            }
            return Ok(Observation::None);
        }
        return Err(io(error));
    }
    let observed = unsafe { info.si_pid() };
    if observed == 0 {
        // Without __WALL an exited clone child (exit signal 0) is invisible to
        // an aggregate wait, so a successful "no exit status" aggregate result
        // cannot prove completeness while ordinary children keep running.
        if fallback && pid.is_none() {
            return Err(failure(
                "incomplete",
                "cannot observe clone children without __WALL on this kernel",
            ));
        }
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
    let mut fallback = false;
    if result < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) {
        // Same kernel limitation as in observe(): retry without __WALL.
        fallback = true;
        result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    }
    if result == 0 {
        return Ok(None);
    }
    if result < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ECHILD) {
            // With the fallback active, ECHILD may mean an invisible clone
            // child; procfs decides whether the PID is still our child. A
            // lookup that cannot answer stays inconclusive.
            return Err(if fallback {
                match parent_state(pid) {
                    ParentState::NotChild => failure("operation-failed", "not-a-child"),
                    ParentState::Child | ParentState::Unknown => failure(
                        "incomplete",
                        "cannot reap clone children without __WALL on this kernel",
                    ),
                }
            } else {
                failure("operation-failed", "not-a-child")
            });
        }
        return Err(io(error));
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
