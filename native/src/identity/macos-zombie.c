#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/proc.h>
#include <stdint.h>
#include <errno.h>

struct proc_safe_bsd_identity {
    uint32_t pid;
    uint32_t parent_pid;
    int64_t seconds;
    int64_t microseconds;
    uint32_t state;
    uint32_t process_group_id;
    uint32_t uid;
    uint32_t exiting;
};

/* The SDK's kern.proc.pid layout still describes zombies and processes libproc hides during exit. */
int proc_safe_read_bsd_identity(uint32_t pid, struct proc_safe_bsd_identity *out) {
    int mib[] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, (int)pid };
    struct kinfo_proc info = {0};
    size_t length = sizeof(info);
    if (sysctl(mib, 4, &info, &length, NULL, 0) != 0) return -errno;
    if (length == 0) return 1;
    if (length != sizeof(info) || info.kp_proc.p_pid != (pid_t)pid || info.kp_eproc.e_ppid < 0 || info.kp_eproc.e_pgid < 0) return -EPROTO;
    out->pid = (uint32_t)info.kp_proc.p_pid;
    out->parent_pid = (uint32_t)info.kp_eproc.e_ppid;
    out->seconds = info.kp_proc.p_starttime.tv_sec;
    out->microseconds = info.kp_proc.p_starttime.tv_usec;
    out->state = (uint32_t)info.kp_proc.p_stat;
    out->process_group_id = (uint32_t)info.kp_eproc.e_pgid;
    out->uid = (uint32_t)info.kp_eproc.e_ucred.cr_uid;
    out->exiting = (info.kp_proc.p_flag & P_WEXIT) != 0;
    return 0;
}
