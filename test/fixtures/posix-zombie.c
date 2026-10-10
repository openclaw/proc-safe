#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <stdio.h>
#include <signal.h>
#include <errno.h>

int main(void) {
    int gate[2];
    if (pipe(gate) != 0) return 1;
    pid_t child = fork();
    if (child < 0) return 2;
    if (child == 0) {
        close(gate[1]);
        char command;
        if (read(gate[0], &command, 1) != 1) _exit(3);
        _exit(23);
    }
    close(gate[0]);
    printf("%d\n", child);
    fflush(stdout);
    int command = getchar();
    if (command != 'e') { kill(child, SIGKILL); waitpid(child, NULL, 0); return 4; }
    if (write(gate[1], "e", 1) != 1) return 5;
    close(gate[1]);
    siginfo_t observation;
    // Observe termination without consuming the child's kernel identity.
    while (waitid(P_PID, child, &observation, WEXITED | WNOWAIT) != 0) {
        if (errno != EINTR) return 6;
    }
    puts("zombie");
    fflush(stdout);
    if (getchar() != 'r') return 7;
    if (waitpid(child, NULL, 0) != child) return 8;
    return 0;
}
