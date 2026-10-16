# Evaluator self-test only: fixed-size pieces (the baseline the target should beat).
import os, sys
n = os.path.getsize(sys.argv[1])
for i in range(0, n, 8192):
    print(min(8192, n - i))
