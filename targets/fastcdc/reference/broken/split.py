# Evaluator self-test only: drops the last piece, so it never covers the file.
import os, sys
n = os.path.getsize(sys.argv[1])
for i in range(0, n - 8192, 8192):
    print(8192)
