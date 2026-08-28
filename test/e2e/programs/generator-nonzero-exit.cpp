// Exits non-zero with nothing on either stream: a generator failure, and
// a 400 rather than /submit's 200-with-compileError.
int main() { return 2; }
