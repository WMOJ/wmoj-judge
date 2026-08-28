# Uncaught exception: exit 1 with a traceback on stderr. The traceback
# carries the per-submission workdir path, so only the exception name is
# asserted.
raise ValueError("boom")
