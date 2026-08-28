// Reads two integers and prints their sum. The baseline "correct
// submission" for the AC scenarios.
#include <cstdio>

int main() {
  long long a = 0, b = 0;
  if (std::scanf("%lld %lld", &a, &b) != 2) return 1;
  std::printf("%lld\n", a + b);
  return 0;
}
