#include <errno.h>
#include <stdio.h>
#include <sys/sysctl.h>

int main(void) {
    int translated = -1;
    size_t size = sizeof(translated);
    int result = sysctlbyname("sysctl.proc_translated", &translated, &size, NULL, 0);
    int error = errno;
    if (result == -1 && error == EPERM) {
        puts("denied");
        return 0;
    }
    if (result == -1 && error == ENOENT) {
        puts("absent");
        return 0;
    }
    if (result == 0 && size == sizeof(translated) && (translated == 0 || translated == 1)) {
        puts(translated ? "translated" : "native");
        return 0;
    }
    fprintf(stderr, "unexpected translation query: result=%d errno=%d value=%d size=%zu\n",
            result, error, translated, size);
    return 1;
}
