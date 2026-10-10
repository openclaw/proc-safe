#include <sys/prctl.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
    /* Kernel comm permits raw bytes and parentheses, independent of UTF-8. */
    const char name[] = { (char)0xff, 'p', ')', ' ', '(', 'x', 0 };
    if (prctl(PR_SET_NAME, name, 0, 0, 0) != 0) return 1;
    puts("ready");
    fflush(stdout);
    for (;;) pause();
}
