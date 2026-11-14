#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <stdio.h>
#include <signal.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <time.h>

static double now_ms(void) {
    struct timespec time;
    if (clock_gettime(CLOCK_MONOTONIC, &time) != 0) abort();
    return time.tv_sec * 1000.0 + time.tv_nsec / 1000000.0;
}

struct exit_observation {
    int libproc_result, libproc_errno, state, flags;
};

static int observe_exit(pid_t child, struct exit_observation *out) {
    struct proc_bsdshortinfo short_info;
    errno = 0;
    out->libproc_result = proc_pidinfo(child, PROC_PIDT_SHORTBSDINFO, 0, &short_info, sizeof(short_info));
    out->libproc_errno = errno;
    int mib[] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, child };
    struct kinfo_proc info = {0};
    size_t length = sizeof(info);
    if (sysctl(mib, 4, &info, &length, NULL, 0) != 0 || length != sizeof(info)) return -1;
    out->state = info.kp_proc.p_stat;
    out->flags = info.kp_proc.p_flag;
    return out->libproc_result <= 0 && out->libproc_errno == ESRCH &&
        (out->flags & P_WEXIT) != 0 && out->state != SZOMB;
}

static int commands(pid_t child, int gate) {
    double started = 0, observed = 0;
    int command;
    while ((command = getchar()) != EOF) {
        if (command == 's') {
            if (kill(child, SIGSTOP) != 0) return 7;
            int status;
            if (waitpid(child, &status, WUNTRACED) != child || !WIFSTOPPED(status)) return 8;
            puts("stopped"); fflush(stdout);
        } else if (command == 'e') {
            started = now_ms();
            if (kill(child, SIGCONT) != 0 || write(gate, "e", 1) != 1) return 9;
            struct exit_observation observation = {0};
            int exiting;
            while ((exiting = observe_exit(child, &observation)) == 0 &&
                   observation.state != SZOMB && now_ms() - started < 5000) {}
            observed = now_ms();
            if (exiting != 1) {
                fprintf(stderr, "missed-exiting: elapsedMs=%.3f libprocResult=%d errno=%d p_stat=%d p_flag=0x%x\n",
                    observed - started, observation.libproc_result, observation.libproc_errno,
                    observation.state, observation.flags);
                puts("missed-exiting"); fflush(stdout);
                return 13;
            }
            puts("exiting"); fflush(stdout);
        } else if (command == 'q') {
            struct exit_observation observation = {0};
            int exiting = observe_exit(child, &observation);
            printf("{\"stillExiting\":%s,\"elapsedMs\":%.3f,\"observedWindowMs\":%.3f,\"libprocResult\":%d,\"libprocErrno\":%d,\"state\":%d,\"flags\":%d}\n",
                exiting == 1 ? "true" : "false", now_ms() - started, now_ms() - observed,
                observation.libproc_result, observation.libproc_errno, observation.state, observation.flags);
            fflush(stdout);
            if (exiting != 1) return 14;
        } else if (command == 'z') {
            siginfo_t observation;
            while (waitid(P_PID, child, &observation, WEXITED | WNOWAIT) != 0) {
                if (errno != EINTR) return 10;
            }
            puts("zombie");
            printf("{\"exitToZombieMs\":%.3f,\"observedWindowToZombieMs\":%.3f}\n", now_ms() - started, now_ms() - observed);
            fflush(stdout);
        } else if (command == 'r') {
            if (waitpid(child, NULL, 0) != child) return 11;
            return 0;
        }
    }
    return 12;
}

int main(void) {
    int master = posix_openpt(O_RDWR | O_NOCTTY);
    if (master < 0 || grantpt(master) != 0 || unlockpt(master) != 0) return 1;
    char *slave_path = ptsname(master);
    if (slave_path == NULL) return 1;
    int gate[2], ready[2];
    if (pipe(gate) != 0 || pipe(ready) != 0) return 1;
    pid_t child = fork();
    if (child < 0) return 2;
    if (child == 0) {
        close(gate[1]); close(ready[0]);
        close(master);
        if (setsid() != getpid()) _exit(3);
        int slave = open(slave_path, O_RDWR | O_NOCTTY | O_NONBLOCK);
        if (slave < 0) _exit(4);
        char buffer[1024];
        memset(buffer, 'x', sizeof(buffer));
        while (write(slave, buffer, sizeof(buffer)) > 0) {}
        if (errno != EAGAIN || fcntl(slave, F_SETFL, 0) != 0) _exit(4);
        // Keep the slave open: exit must drain its output while the master stays unread.
        if (write(ready[1], "r", 1) != 1) _exit(4);
        close(ready[1]);
        char command;
        if (read(gate[0], &command, 1) != 1) _exit(5);
        _exit(23);
    }
    close(gate[0]); close(ready[1]);
    char response;
    if (read(ready[0], &response, 1) != 1) return 6;
    close(ready[0]);
    printf("%d\n", child); fflush(stdout);
    int result = commands(child, gate[1]);
    close(gate[1]);
    close(master);
    if (result != 0) {
        kill(child, SIGKILL);
        waitpid(child, NULL, 0);
    }
    return result;
}
