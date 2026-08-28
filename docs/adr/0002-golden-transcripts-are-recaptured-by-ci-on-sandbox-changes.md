# Golden transcripts are re-captured by CI on sandbox changes

A fixture is only as true as its last capture, and this repository has the precedent that makes
that dangerous: the nsjail-3.3 log scraper matched nothing for the whole life of the pin, so
`cpuMs` and `memKb` were `0` on every run with no signal anywhere. We decided that any change under
`Dockerfile`, `policy.kafel`, `src/sandbox/**`, `src/verdict/**`, `src/tools/**` or
`test/fixtures/measurements/**` re-captures the measurement fixtures on the x86_64 runner and diffs
them against the committed set, and that the same job runs nightly regardless. The consequence is
that a sandbox change which alters what nsjail or `wmoj-jailrun` reports fails CI instead of passing
a stale suite; the cost is one extra image boot per such change.
