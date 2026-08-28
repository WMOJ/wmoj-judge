// Burns CPU forever. The arithmetic is on a volatile so the loop cannot
// be optimised away, which would turn the CPU-time TLE gate into a wall
// -clock one.
int main() {
  volatile unsigned long long x = 1;
  for (;;) x = x * 1103515245ULL + 12345ULL;
}
