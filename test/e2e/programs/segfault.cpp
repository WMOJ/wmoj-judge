// Null-pointer write -> SIGSEGV -> nsjail reports 128 + 11 = 139.
//
// `p` is itself volatile so the LOAD of the pointer is a volatile access:
// without that, -O2's -fisolate-erroneous-paths-dereference can prove the
// store is a null dereference and replace it with __builtin_trap, which
// raises SIGILL (exit 132) instead of the SIGSEGV this scenario pins.
static int* volatile p = nullptr;

int main() {
  *p = 1;
  return 0;
}
