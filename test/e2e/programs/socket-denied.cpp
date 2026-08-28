// Network access is blocked by seccomp alone -- there is no second layer.
// policy.kafel lists `socket` under ERRNO(1), so the call FAILS with
// EPERM rather than killing the process; an unfiltered judge prints a
// live descriptor here instead.
#include <cerrno>
#include <cstdio>
#include <sys/socket.h>

int main() {
  errno = 0;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  std::printf("fd=%d errno=%d\n", fd, fd < 0 ? errno : 0);
  return 0;
}
