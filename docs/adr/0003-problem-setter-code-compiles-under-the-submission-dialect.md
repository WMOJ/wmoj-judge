# Problem-setter code compiles under the submission dialect

Checkers and generators used to be compiled with a hand-spelled `g++ -O2 -std=gnu++17` line in two
files, while submissions got `-std=c++17` (plus `-fmax-errors=50`) from `languages.json` — three
copies of one command that had already drifted, and a dialect difference nobody had chosen. Before
deciding, we audited every stored problem-setter program in production: 56 generators, 7 custom
checkers and the reference checker — 64 of 64 — compile clean with g++ 14.2.0 under both `gnu++17`
and `c++17`, and none is testlib-derived. We decided that problem-setter code compiles under the
**submission dialect**: `setterCompileArgv` in `src/languages` is the `cpp17` entry's compiler and
standard through the same `cppCompileArgv` that builds every submission's line, so there is one
g++ line in the codebase and a checker is compiled exactly as the solution it judges. The
consequence is that a future checker relying on a GNU extension fails to compile with a
`checkerError` naming the line, rather than passing where the submission would not; wmoj-app's
`generator-style.md` still says `gnu++17` and is a one-line follow-up in that repository.
