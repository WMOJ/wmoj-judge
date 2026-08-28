// A single NUL byte. It is valid UTF-8 and survives decoding, but
// PostgreSQL jsonb cannot store it, so the sandbox substitutes U+FFFD.
#include <cstdio>

int main() {
  std::putchar(0);
  return 0;
}
