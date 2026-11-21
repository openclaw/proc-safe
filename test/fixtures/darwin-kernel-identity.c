#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc.h>
#include <sys/sysctl.h>

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    int pid = atoi(argv[1]);
    struct proc_bsdinfo bsd = {0};
    errno = 0;
    int actual = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd));
    int error = actual > 0 ? 0 : errno;
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
    struct kinfo_proc kernel = {0};
    size_t length = sizeof(kernel);
    if (sysctl(mib, 4, &kernel, &length, NULL, 0) != 0 || length != sizeof(kernel)) return 3;
    printf("{\"pid\":%d,\"parentPid\":%d,\"startTimeMicros\":%lld,\"procInfoError\":%d}\n",
        kernel.kp_proc.p_pid, kernel.kp_eproc.e_ppid,
        (long long)kernel.kp_proc.p_starttime.tv_sec * 1000000 + kernel.kp_proc.p_starttime.tv_usec, error);
    return 0;
}
