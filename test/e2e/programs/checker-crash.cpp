// A checker that dies by a signal. nsjail reports it as its own
// 128 + SIGSEGV = 139 status and exits normally, so this is the case that
// used to fall through to "rejected" and mass-misgrade a whole problem.
static int* volatile p = nullptr;

int main() {
  *p = 1;
  return 0;
}
