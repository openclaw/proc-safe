#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <stdio.h>
#include <signal.h>
#include <errno.h>

int main(void) {
    int gate[2], ready[2];
    if (pipe(gate) != 0 || pipe(ready) != 0) return 1;
    pid_t child = fork();
    if (child < 0) return 2;
    if (child == 0) {
        close(gate[1]); close(ready[0]);
        if (setsid() != getpid()) _exit(3);
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
    int command;
    while ((command = getchar()) != EOF) {
        if (command == 's') {
            if (kill(child, SIGSTOP) != 0) return 7;
            int status;
            if (waitpid(child, &status, WUNTRACED) != child || !WIFSTOPPED(status)) return 8;
            puts("stopped"); fflush(stdout);
        } else if (command == 'z') {
            if (kill(child, SIGCONT) != 0 || write(gate[1], "e", 1) != 1) return 9;
            close(gate[1]);
            siginfo_t observation;
            while (waitid(P_PID, child, &observation, WEXITED | WNOWAIT) != 0) {
                if (errno != EINTR) return 10;
            }
            puts("zombie"); fflush(stdout);
        } else if (command == 'r') {
            if (waitpid(child, NULL, 0) != child) return 11;
            return 0;
        }
    }
    kill(child, SIGKILL);
    waitpid(child, NULL, 0);
    return 12;
}
