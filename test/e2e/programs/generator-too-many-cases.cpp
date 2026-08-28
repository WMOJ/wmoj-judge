// 201 pairs: one past the case cap /submit will later enforce on exactly
// this data. The judge must refuse it here rather than hand an admin test
// data it would 413 on.
#include <cstdio>

int main() {
  std::printf("[");
  std::fprintf(stderr, "[");
  for (int i = 0; i <= 200; ++i) {
    const char* sep = i == 0 ? "" : ",";
    std::printf("%s\"%d\"", sep, i);
    std::fprintf(stderr, "%s\"%d\"", sep, i);
  }
  std::printf("]");
  std::fprintf(stderr, "]");
  return 0;
}
