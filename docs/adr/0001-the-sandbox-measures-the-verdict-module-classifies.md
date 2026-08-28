# The sandbox measures; the verdict module classifies

Verdict policy used to be split across the sandbox seam: `runSandboxed` decided the kill class and
exported the RSS threshold, and `submit.ts` re-implemented the RSS rule against that same constant,
so the load-bearing TLE → MLE → RE → IE ladder was private to a 969-line module and could only be
exercised by spawning a real jail. We decided that `runSandboxed` returns raw facts (`RunOutcome`:
a `RunMeasurement` or a judge fault) and that every threshold and every ordering lives in
`src/verdict`, behind one function, `gradeCase`, over plain data. The consequence is that a new
measurement (page faults, say) is added to `RunMeasurement` without a verdict rule, a new rule is
added to `gradeCase` without touching the sandbox, and the whole ladder is replayed from JSON
fixtures on any machine — a sandbox that "knows best" would have kept the ladder untestable.
