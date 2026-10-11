#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

// Test-only external writer. The real app-server has no fault-injection branch.
static int fired;
static int eligible(const char *mode) {
    const char *ready = getenv("KCODER_FILE_FAULT_READY");
    const char *actual = getenv("KCODER_FILE_FAULT_MODE");
    return !fired && ready && actual && !strcmp(actual, mode) && !access(ready, F_OK);
}
static void mark(void) {
    fired = 1;
    const char *marker = getenv("KCODER_FILE_FAULT_MARKER");
    int fd = ((int (*)(const char *, int, ...))dlsym(RTLD_NEXT, "open"))(marker, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd >= 0) close(fd);
}
static void overwrite(const char *path, const char *content, int exclusive) {
    int fd = ((int (*)(const char *, int, ...))dlsym(RTLD_NEXT, "open"))(path, O_WRONLY | O_CREAT | (exclusive ? O_EXCL : O_TRUNC), 0600);
    if (fd < 0) _exit(92);
    if (write(fd, content, strlen(content)) != (ssize_t)strlen(content)) _exit(93);
    close(fd);
}
static void read_fault(const char *path) {
    if (!eligible("read") || !path) return;
    const char *leaf = strrchr(path, '/');
    if (strcmp(leaf ? leaf + 1 : path, "note.txt")) return;
    mark();
    const char *parent = getenv("KCODER_FILE_FAULT_PARENT");
    char moved[4096];
    snprintf(moved, sizeof(moved), "%s-moved", parent);
    if (((int (*)(const char *, const char *))dlsym(RTLD_NEXT, "rename"))(parent, moved)) _exit(94);
    if (symlink(getenv("KCODER_FILE_FAULT_OUTSIDE"), parent)) _exit(95);
}
int open64(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) { va_list args; va_start(args, flags); mode = va_arg(args, int); va_end(args); }
    read_fault(path);
    return ((int (*)(const char *, int, ...))dlsym(RTLD_NEXT, "open64"))(path, flags, mode);
}
int openat64(int dirfd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) { va_list args; va_start(args, flags); mode = va_arg(args, int); va_end(args); }
    read_fault(path);
    return ((int (*)(int, const char *, int, ...))dlsym(RTLD_NEXT, "openat64"))(dirfd, path, flags, mode);
}
int openat(int dirfd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) { va_list args; va_start(args, flags); mode = va_arg(args, int); va_end(args); }
    read_fault(path);
    return ((int (*)(int, const char *, int, ...))dlsym(RTLD_NEXT, "openat"))(dirfd, path, flags, mode);
}
static void rename_fault(const char *source, const char *destination) {
    const char *leaf = destination ? strrchr(destination, '/') : NULL;
    leaf = leaf ? leaf + 1 : destination;
    if (eligible("save-late") && leaf && !strncmp(leaf, ".kcoder-previous-", 17)) {
        mark();
        overwrite(getenv("KCODER_FILE_FAULT_TARGET"), "EXTERNAL_NEW_EDIT", 0);
    }
    const char *source_leaf = source ? strrchr(source, '/') : NULL;
    source_leaf = source_leaf ? source_leaf + 1 : source;
    if (eligible("save-new-target") && leaf && !strcmp(leaf, "note.txt") && source_leaf && source_leaf[0] == '.') {
        mark();
        overwrite(getenv("KCODER_FILE_FAULT_TARGET"), "EXTERNAL_NEW_TARGET", 1);
    }
    if (!eligible("rename") || !destination) return;
    if (strcmp(leaf, "dest.txt")) return;
    mark();
    overwrite(getenv("KCODER_FILE_FAULT_TARGET"), "EXTERNAL_NEW_TARGET", 1);
}
int rename(const char *source, const char *destination) {
    rename_fault(source, destination);
    return ((int (*)(const char *, const char *))dlsym(RTLD_NEXT, "rename"))(source, destination);
}
int renameat(int sfd, const char *source, int dfd, const char *destination) {
    rename_fault(source, destination);
    return ((int (*)(int, const char *, int, const char *))dlsym(RTLD_NEXT, "renameat"))(sfd, source, dfd, destination);
}
int renameat2(int sfd, const char *source, int dfd, const char *destination, unsigned int flags) {
    rename_fault(source, destination);
    return ((int (*)(int, const char *, int, const char *, unsigned int))dlsym(RTLD_NEXT, "renameat2"))(sfd, source, dfd, destination, flags);
}
int fsync(int fd) {
    if (eligible("save")) {
        char link[64], path[4096];
        snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
        ssize_t length = readlink(link, path, sizeof(path)-1);
        if (length >= 0) {
            path[length] = 0;
            const char *parent = getenv("KCODER_FILE_FAULT_PARENT");
            const char *leaf = strrchr(path, '/');
            if (parent && leaf && leaf[1] == '.' && !strstr(leaf, "lock") && (size_t)(leaf-path) == strlen(parent) && !strncmp(path, parent, strlen(parent))) {
                mark();
                overwrite(getenv("KCODER_FILE_FAULT_TARGET"), "EXTERNAL_NEW_EDIT", 0);
            }
        }
    }
    return ((int (*)(int))dlsym(RTLD_NEXT, "fsync"))(fd);
}

// cap-primitives can issue openat directly. libstd metadata reaches statx
// or fstat on the opened handle; both exercise the same parent replacement.
static void read_handle_fault(int fd) {
    if (!eligible("read")) return;
    char link[64], path[4096];
    snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
    ssize_t length = readlink(link, path, sizeof(path)-1);
    if (length < 0) return;
    path[length] = 0;
    const char *parent = getenv("KCODER_FILE_FAULT_PARENT");
    const char *leaf = strrchr(path, '/');
    if (parent && leaf && !strcmp(leaf+1, "note.txt") && (size_t)(leaf-path) == strlen(parent) && !strncmp(path, parent, strlen(parent))) read_fault(path);
}
int fstat64(int fd, struct stat64 *info) {
    read_handle_fault(fd);
    return ((int (*)(int, struct stat64 *))dlsym(RTLD_NEXT, "fstat64"))(fd, info);
}
int fstat(int fd, struct stat *info) {
    read_handle_fault(fd);
    return ((int (*)(int, struct stat *))dlsym(RTLD_NEXT, "fstat"))(fd, info);
}
int statx(int dirfd, const char *path, int flags, unsigned int mask, struct statx *info) {
    if (!path[0]) read_handle_fault(dirfd);
    return ((int (*)(int, const char *, int, unsigned int, struct statx *))dlsym(RTLD_NEXT, "statx"))(dirfd, path, flags, mask, info);
}
