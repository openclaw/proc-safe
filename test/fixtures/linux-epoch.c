#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static long long micros(clockid_t clock) {
  struct timespec value;
  if (clock_gettime(clock, &value) != 0) _exit(2);
  return (long long)value.tv_sec * 1000000 + value.tv_nsec / 1000;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "hold") == 0) {
    puts("ready");
    fflush(stdout);
    for (;;) pause();
  }
  long long before = micros(CLOCK_REALTIME);
  long long boot = micros(CLOCK_BOOTTIME);
  long long after = micros(CLOCK_REALTIME);
  long long monotonic = micros(CLOCK_MONOTONIC);
  long long raw = micros(CLOCK_MONOTONIC_RAW);
  long long btime = -1;
  char line[4096];
  FILE *stat = fopen("/proc/stat", "r");
  if (!stat) return 2;
  while (fgets(line, sizeof(line), stat)) {
    if (sscanf(line, "btime %lld", &btime) == 1) break;
  }
  fclose(stat);
  if (btime < 0) return 2;
  printf("{\"realtimeBeforeMicros\":%lld,\"realtimeAfterMicros\":%lld,"
         "\"boottimeMicros\":%lld,\"monotonicMicros\":%lld,"
         "\"monotonicRawMicros\":%lld,\"btime\":%lld,\"hz\":%ld}\n",
         before, after, boot, monotonic, raw, btime, sysconf(_SC_CLK_TCK));
}
