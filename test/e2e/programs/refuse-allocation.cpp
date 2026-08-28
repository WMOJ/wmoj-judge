// Asks for 600 MB and touches every page. Under a real RLIMIT_AS the
// allocation is REFUSED (not killed): std::bad_alloc escapes, terminate
// aborts, and the process exits 134 with the allocation signature on
// stderr that MLE rule 3 reads.
#include <cstddef>
#include <cstdio>

int main() {
  const std::size_t n = static_cast<std::size_t>(600) << 20;
  char* p = new char[n];
  for (std::size_t i = 0; i < n; i += 4096) p[i] = 1;
  std::printf("%d\n", static_cast<int>(p[0]));
  return 0;
}
