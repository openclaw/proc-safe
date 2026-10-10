#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

struct child_args { const char *fifo; int ready; int signal_exit; int code; };

static int child(void *value) {
    struct child_args *args = value;
    close(STDIN_FILENO);
    close(STDOUT_FILENO);
    int gate = open(args->fifo, O_RDWR | O_CLOEXEC);
    if (gate < 0) _exit(90);
    if (write(args->ready, "r", 1) != 1) _exit(91);
    close(args->ready);
    char command;
    if (read(gate, &command, 1) != 1 || command != 'e') _exit(92);
    close(gate);
    if (args->signal_exit) {
        signal(SIGTERM, SIG_DFL);
        kill(getpid(), SIGTERM);
        _exit(93);
    }
    _exit(args->code);
}

int main(int argc, char **argv) {
    int launch = argc == 7 && strcmp(argv[1], "--launch") == 0;
    if (!launch && argc != 3) return 2;
    const char *fifo = launch ? argv[2] : argv[1];
    if (mkfifo(fifo, 0600) != 0) return 3;
    int ready[2];
    if (pipe(ready) != 0) return 4;
    struct child_args args = { fifo, ready[1], !launch && strcmp(argv[2], "signal") == 0,
        launch ? 42 : 23 };
    pid_t pid;
    if (launch) {
        // No exit signal: __WALL is required. Exec keeps this direct child
        // attached to the same parent PID without reparenting it to SIGCHLD.
        void *stack = malloc(1024 * 1024);
        if (!stack) return 5;
        pid = clone(child, (char *)stack + 1024 * 1024, 0, &args);
    } else {
        pid = fork();
        if (pid == 0) child(&args);
    }
    if (pid < 0) return 6;
    close(ready[1]);
    char response;
    if (read(ready[0], &response, 1) != 1 || response != 'r') return 7;
    close(ready[0]);
    if (launch) {
        char number[32];
        snprintf(number, sizeof(number), "%d", pid);
        char *command[] = { argv[3], argv[4], argv[5], argv[6], number, argv[2], NULL };
        execv(argv[3], command);
        kill(pid, SIGKILL);
        waitpid(pid, NULL, __WALL);
        return 8;
    }
    printf("%d\n", pid);
    fflush(stdout);
    // The blocked grandchild is now adopted by the Node subreaper.
    return 0;
}
