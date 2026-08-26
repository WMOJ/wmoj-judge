// Reference custom checker for wmoj-judge.
//
// A checker is what you send in the `checker` field of POST /submit for
// a problem whose answer is not unique. wmoj-judge compiles it once per
// submission with
//
//     /usr/bin/g++ -O2 -std=gnu++17 Checker.cpp -o checker.out
//
// and runs it once per test case, inside the same nsjail sandbox as the
// contestant's program, as
//
//     checker.out <input_file> <expected_file> <contestant_output_file>
//
// with the submission's workdir as cwd. Exit code carries the verdict
// (testlib / DMOJ convention):
//
//     0  accepted
//     1  wrong answer
//     2  presentation error   -- wmoj-judge folds this into WA
//     3  checker internal error -> verdict IE; the PROBLEM is at fault
//     any other non-zero      -> wrong answer
//
// Anything >= 128 is NOT a verdict: nsjail reports a checker that died
// by a signal as its own `128 + WTERMSIG` status (139 SIGSEGV, 134
// SIGABRT, 159 SIGSYS from a syscall outside policy.kafel) and exits 255
// when it could not exec the checker at all. wmoj-judge treats all of
// those as IE. Do not use them as verdicts.
//
// !! THE EXIT CODES ARE TESTLIB'S; THE ARGUMENT ORDER IS NOT. !!
// Upstream testlib.h binds argv[2] to the PARTICIPANT's output and
// argv[3] to the JURY's answer. wmoj-judge passes them the other way
// round, as written above. A checker lifted from a testlib problem
// therefore ends up validating the jury's own answer -- which is valid
// by construction -- so it exits 0 on every case and every submission to
// that problem silently scores 100%, with nothing in the response to
// distinguish it from an easy problem. Swap the two answer files when
// adapting a testlib checker.
//
// Whatever the checker writes to stderr is trimmed, truncated to ~1 KB,
// and returned to the caller as TestResult.checkerMessage. That is where
// you explain WHY an answer was rejected -- use it.
//
// When a checker is supplied it REPLACES compareMode entirely; the byte
// comparison is not run at all.
//
// ---------------------------------------------------------------------
// The toy problem this checker judges
//
//   Input : n S, then n integers a[1..n].
//   Output: any 1-based pair of distinct indices i j with a[i]+a[j] == S,
//           or the single token IMPOSSIBLE if no such pair exists.
//
// The expected output holds ONE reference answer. Any other valid pair
// must also be accepted -- which is exactly what byte comparison cannot
// do, and the entire reason checkers exist.
//
// Note this deliberately uses plain standard headers rather than
// <bits/stdc++.h>, so it also compiles under clang for local testing.
// ---------------------------------------------------------------------

#include <cstddef>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

constexpr int kAccepted = 0;
constexpr int kWrongAnswer = 1;
constexpr int kPresentationError = 2;
constexpr int kInternalError = 3;

[[noreturn]] void quit(int code, const std::string& message) {
  if (!message.empty()) std::cerr << message << std::endl;
  std::exit(code);
}

// Read the answer written by one side. Returns false when the stream
// held no answer at all.
bool readAnswer(std::istream& in, bool& impossible, long long& i,
                long long& j, std::string& trailing) {
  std::string token;
  if (!(in >> token)) return false;
  if (token == "IMPOSSIBLE") {
    impossible = true;
  } else {
    impossible = false;
    try {
      // std::stoll parses a numeric PREFIX and discards the rest, so
      // std::stoll("1abc") is 1 with no exception. Checking that the
      // whole token was consumed is what stops "1abc 2" being read as
      // the pair (1, 2) and ACCEPTED -- by a checker that goes out of
      // its way to reject surplus output thirty lines below.
      std::size_t consumed = 0;
      i = std::stoll(token, &consumed);
      if (consumed != token.size()) return false;
    } catch (...) {
      return false;
    }
    if (!(in >> j)) return false;
  }
  // Anything further is surplus output.
  in >> trailing;
  return true;
}

bool pairIsValid(const std::vector<long long>& a, long long target,
                 long long i, long long j) {
  const long long n = static_cast<long long>(a.size());
  if (i < 1 || i > n || j < 1 || j > n) return false;
  if (i == j) return false;
  return a[static_cast<size_t>(i - 1)] + a[static_cast<size_t>(j - 1)] == target;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 4) {
    quit(kInternalError,
         "usage: checker <input_file> <expected_file> <contestant_output_file>");
  }

  std::ifstream fin(argv[1]);
  std::ifstream fexpected(argv[2]);
  std::ifstream fcontestant(argv[3]);
  if (!fin) quit(kInternalError, std::string("cannot open input file: ") + argv[1]);
  if (!fexpected) quit(kInternalError, std::string("cannot open expected file: ") + argv[2]);
  if (!fcontestant) quit(kInternalError, std::string("cannot open output file: ") + argv[3]);

  long long n = 0;
  long long target = 0;
  if (!(fin >> n >> target)) quit(kInternalError, "malformed input: expected 'n S'");
  if (n < 0 || n > 10000000LL) quit(kInternalError, "malformed input: implausible n");

  std::vector<long long> a(static_cast<size_t>(n));
  for (long long k = 0; k < n; ++k) {
    if (!(fin >> a[static_cast<size_t>(k)])) {
      quit(kInternalError, "malformed input: fewer than n values");
    }
  }

  bool juryImpossible = false;
  long long juryI = 0, juryJ = 0;
  std::string juryTrailing;
  if (!readAnswer(fexpected, juryImpossible, juryI, juryJ, juryTrailing)) {
    quit(kInternalError, "malformed expected output");
  }
  if (!juryImpossible && !pairIsValid(a, target, juryI, juryJ)) {
    quit(kInternalError, "the expected output is not itself a valid answer");
  }

  bool userImpossible = false;
  long long userI = 0, userJ = 0;
  std::string userTrailing;
  if (!readAnswer(fcontestant, userImpossible, userI, userJ, userTrailing)) {
    quit(kPresentationError,
         "no answer found: expected 'i j' or the token IMPOSSIBLE");
  }
  if (!userTrailing.empty()) {
    quit(kPresentationError, "surplus output after the answer: '" + userTrailing + "'");
  }

  if (userImpossible) {
    if (juryImpossible) quit(kAccepted, "");
    quit(kWrongAnswer,
         "claimed IMPOSSIBLE, but " + std::to_string(juryI) + " " +
             std::to_string(juryJ) + " is a valid pair");
  }

  if (!pairIsValid(a, target, userI, userJ)) {
    quit(kWrongAnswer, "pair " + std::to_string(userI) + " " +
                           std::to_string(userJ) +
                           " is out of range, not distinct, or does not sum to " +
                           std::to_string(target));
  }

  if (juryImpossible) {
    // The contestant found a valid pair the jury said did not exist:
    // the TEST DATA is wrong, not the contestant. Exit 3 so this shows
    // up as IE and someone fixes the problem.
    quit(kInternalError,
         "contestant found valid pair " + std::to_string(userI) + " " +
             std::to_string(userJ) + " but the expected output says IMPOSSIBLE");
  }

  quit(kAccepted, "");
}
