# Blocks for 10 s without consuming CPU: nothing the CPU-time gate can
# see. Node's last-resort SIGKILL timer (timeLimit + 5 s) is what ends it,
# and the jail runner's report does not survive that kill.
import time

time.sleep(10)
print("done")
