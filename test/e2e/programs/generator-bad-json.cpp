// Truncated JSON on stdout. The parse failure must name stdout and echo
// the raw text so an admin can see what their generator printed.
#include <cstdio>

int main() {
  std::printf("[");
  std::fprintf(stderr, "[]");
  return 0;
}
