// Correct sum, printed with ONE trailing space. `trim-trailing` (the
// default comparator) accepts it; `exact` does not.
#include <cstdio>

int main() {
  long long a = 0, b = 0;
  if (std::scanf("%lld %lld", &a, &b) != 2) return 1;
  std::printf("%lld \n", a + b);
  return 0;
}
