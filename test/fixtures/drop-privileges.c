#include <unistd.h>
#include <grp.h>
#include <stdio.h>

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    if (setgroups(0, NULL) != 0 || setgid(65534) != 0 || setuid(65534) != 0) {
        perror("drop privileges");
        return 3;
    }
    execv(argv[1], &argv[1]);
    perror("exec probe");
    return 4;
}
