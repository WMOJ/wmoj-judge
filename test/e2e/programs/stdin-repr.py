# Echoes exactly what arrived on stdin, quoted. Distinguishes "no input at
# all" from "one blank line", which is the difference a newline-appending
# bug erases.
import sys

print(repr(sys.stdin.read()))
