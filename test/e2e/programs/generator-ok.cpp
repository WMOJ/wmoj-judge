// Inputs on stdout, expected outputs on stderr, equal length.
#include <cstdio>

int main() {
  std::printf("[\"1 2\",\"3 4\"]");
  std::fprintf(stderr, "[\"3\",\"7\"]");
  return 0;
}
