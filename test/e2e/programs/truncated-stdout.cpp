// Writes 2 MiB, twice the sandbox's 1 MiB stdout cap, so the retained
// stdout is a prefix and `truncated` is set.
#include <cstdio>

int main() {
  for (int i = 0; i < 2 * 1024 * 1024; ++i) std::putchar('x');
  return 0;
}
