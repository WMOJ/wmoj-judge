# Interpreted languages bypass the compile cache

The compile cache exists for g++: a C++ submission resubmitted within fifteen minutes skips a
multi-second compile. Python and PyPy went through it anyway — keyed on an empty compile argv, a
"hit" was a recursive copy of the cached workdir plus a chown, to save one `writeFile` of at most
100 KB — so on the 0.1-CPU host the hit was slower than the miss, and every interpreted submission
still left a directory under `COMPILE_CACHE_DIR` for the TTL to reap. We decided that a language
whose spec has no compile step (`compileArgv === null`) has no cache key, no `get` and no `put`:
`/submit` writes the source into the workspace and runs it. The consequence is that `python3` and
`pypy3` never touch the cache directory, the cache holds only what a compile produced (the spec's
`artifacts`, never a checker binary or scratch file), and a future compiled language gets caching
by declaring its artifacts rather than by being special-cased.
