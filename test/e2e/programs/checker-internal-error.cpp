// The checker declaring that IT could not answer: verdict IE, counted as
// a failed case, never billed to the student as WA.
#include <cstdio>

int main() {
  std::fprintf(stderr, "checker broke\n");
  return 3;
}
