// Prints the right answer and then exits non-zero. A case passes only if
// the program itself finished cleanly, so this is RE, not AC.
#include <cstdio>

int main() {
  long long a = 0, b = 0;
  if (std::scanf("%lld %lld", &a, &b) != 2) return 1;
  std::printf("%lld\n", a + b);
  return 1;
}
