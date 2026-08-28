# Sleeps past its 500 ms limit in wall-clock terms but exits cleanly with
# almost no CPU. The clean-exit guard must keep this AC.
import sys
import time

a, b = map(int, sys.stdin.readline().split())
time.sleep(2)
print(a + b)
