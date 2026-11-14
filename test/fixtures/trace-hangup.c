#include <signal.h>
#include <unistd.h>

static char *number(char *out, unsigned int value) {
    char digits[16];
    int count = 0;
    do { digits[count++] = '0' + value % 10; value /= 10; } while (value);
    while (count) *out++ = digits[--count];
    return out;
}

static void hangup(int signal, siginfo_t *info, void *context) {
    (void)context;
    char line[128], *out = line;
    const char *prefix = "HUP TRACE pid/ppid/pgrp/sender/code: ";
    while (*prefix) *out++ = *prefix++;
    out = number(out, getpid()); *out++ = '/';
    out = number(out, getppid()); *out++ = '/';
    out = number(out, getpgrp()); *out++ = '/';
    out = number(out, info->si_pid); *out++ = '/';
    out = number(out, info->si_code); *out++ = '\n';
    write(STDERR_FILENO, line, out - line);
    _exit(128 + signal);
}

__attribute__((constructor)) static void install(void) {
    struct sigaction action = {0};
    action.sa_sigaction = hangup;
    action.sa_flags = SA_SIGINFO;
    sigemptyset(&action.sa_mask);
    sigaction(SIGHUP, &action, 0);
}
