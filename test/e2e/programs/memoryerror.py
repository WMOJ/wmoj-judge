# The CPython twin of refuse-allocation.cpp: 600 MB under a 256 MB cap
# raises MemoryError, which is the other allocation signature MLE rule 3
# recognises.
b = bytearray(600 << 20)
print(len(b))
