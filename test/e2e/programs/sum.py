# Reads two integers and prints their sum. CPython/PyPy twin of sum.cpp.
import sys

a, b = map(int, sys.stdin.readline().split())
print(a + b)
