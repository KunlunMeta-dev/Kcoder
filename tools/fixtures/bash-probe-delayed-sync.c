/* Benchmark-only: inject 50 ms into sync calls made by the owning Rust probe.
 * Bash clears LD_PRELOAD from its command environment. No product code uses it. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <time.h>

static int delayed_sync(const char *name, int fd) {
    int (*next)(int) = (int (*)(int))dlsym(RTLD_NEXT, name);
    if (!next) {
        errno = ENOSYS;
        return -1;
    }
    struct timespec pause = {.tv_sec = 0, .tv_nsec = 50000000};
    while (nanosleep(&pause, &pause) != 0 && errno == EINTR) {}
    return next(fd);
}

int fsync(int fd) { return delayed_sync("fsync", fd); }
int fdatasync(int fd) { return delayed_sync("fdatasync", fd); }
