#define _DARWIN_C_SOURCE
#include <sys/types.h>
#include <sys/stat.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define READ_LIMIT (512u * 1024u)
#define WRITE_LIMIT (8u * 1024u * 1024u)
#define LIST_LIMIT (1024u * 1024u)

static void fail(void) {
    perror("project file operation refused");
    exit(1);
}
static void refuse(void) {
    errno = EPERM;
    fail();
}
static void allwrite(int fd, const void *data, size_t length) {
    const unsigned char *cursor = data;
    while (length) {
        ssize_t written = write(fd, cursor, length);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) fail();
        cursor += written;
        length -= (size_t)written;
    }
}
static ssize_t retryread(int fd, void *buffer, size_t length) {
    ssize_t result;
    do { result = read(fd, buffer, length); } while (result < 0 && errno == EINTR);
    if (result < 0) fail();
    return result;
}

int main(int argc, char **argv) {
    if (argc != 3 || strlen(argv[2]) > 4096 || argv[2][0] == '/') refuse();
    struct stat root;
    if (fstat(3, &root) < 0) fail();
    if (!S_ISDIR(root.st_mode)) refuse();

    char *copy = strdup(argv[2]);
    if (!copy) fail();
    int parent = dup(3);
    if (parent < 0) fail();
    char *save = NULL, *part = strtok_r(copy, "/", &save), *next;
    if (!part) part = ".";
    // Every ancestor is opened relative to an already held directory. A symlink swap
    // can make this fail, but cannot make the next lookup follow an outside pathname.
    while ((next = strtok_r(NULL, "/", &save))) {
        if (!strcmp(part, ".") || !strcmp(part, "..")) refuse();
        int directory = openat(parent, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (directory < 0) fail();
        close(parent);
        parent = directory;
        part = next;
    }
    if (!strcmp(part, "..")) refuse();
    int listing = !strcmp(argv[1], "list");
    int tailing = !strcmp(argv[1], "tail");
    int reading = !strcmp(argv[1], "read") || tailing;
    int writing = !strcmp(argv[1], "write");
    if (!listing && !reading && !writing) refuse();
    if (!strcmp(part, ".") && !listing) refuse();
    int flags = listing ? O_RDONLY | O_DIRECTORY : reading ? O_RDONLY : O_WRONLY | O_CREAT;
    // O_NONBLOCK ensures a FIFO/device cannot hold the app waiting for a peer.
    int fd = openat(parent, part, flags | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600);
    if (fd < 0) fail();
    close(parent);
    struct stat st;
    if (fstat(fd, &st) < 0) fail();

    if (listing) {
        DIR *directory = fdopendir(fd);
        if (!directory) fail();
        size_t total = 0;
        struct dirent *entry;
        errno = 0;
        while ((entry = readdir(directory))) {
            if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
            size_t length = strlen(entry->d_name) + 1;
            total += length + 1;
            if (total > LIST_LIMIT) refuse();
            struct stat item;
            if (fstatat(dirfd(directory), entry->d_name, &item, AT_SYMLINK_NOFOLLOW) < 0) fail();
            unsigned char kind = S_ISDIR(item.st_mode) ? 1 : 0;
            allwrite(1, &kind, 1);
            allwrite(1, entry->d_name, length);
            errno = 0;
        }
        if (errno) fail();
        if (closedir(directory) < 0) fail();
    } else {
        // In particular, never truncate a link or special file before validating it.
        if (!S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_size < 0) refuse();
        if (reading) {
            if (tailing && st.st_size > READ_LIMIT && lseek(fd, st.st_size - READ_LIMIT, SEEK_SET) < 0) fail();
            uint64_t size = (uint64_t)st.st_size;
            unsigned char header[8];
            for (int i = 7; i >= 0; i--) { header[i] = (unsigned char)(size & 255); size >>= 8; }
            allwrite(1, header, 8);
            unsigned char buffer[16384];
            size_t left = READ_LIMIT;
            while (left) {
                ssize_t length = retryread(fd, buffer, left < sizeof buffer ? left : sizeof buffer);
                if (!length) break;
                allwrite(1, buffer, (size_t)length);
                left -= (size_t)length;
            }
        } else {
            unsigned char *buffer = malloc(WRITE_LIMIT + 1);
            if (!buffer) fail();
            size_t length = 0;
            while (length <= WRITE_LIMIT) {
                ssize_t count = retryread(0, buffer + length, WRITE_LIMIT + 1 - length);
                if (!count) break;
                length += (size_t)count;
            }
            if (length > WRITE_LIMIT) refuse();
            if (ftruncate(fd, 0) < 0) fail();
            allwrite(fd, buffer, length);
            if (fsync(fd) < 0) fail();
            free(buffer);
        }
        if (close(fd) < 0) fail();
    }
    free(copy);
    return 0;
}
