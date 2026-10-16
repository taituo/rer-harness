# Evaluator self-test only: a plain content-defined chunker (gear rolling hash, min/avg/max sizes).
import random, sys
data = open(sys.argv[1], "rb").read()
G = [random.Random(i).getrandbits(64) for i in range(256)]
MIN, MAX, MASK, M64 = 2048, 65536, (1 << 13) - 1, (1 << 64) - 1
start, h, i = 0, 0, 0
while i < len(data):
    h = ((h << 1) + G[data[i]]) & M64
    i += 1
    size = i - start
    if (size >= MIN and (h >> 40) & MASK == 0) or size >= MAX:
        print(size); start, h = i, 0
if start < len(data):
    print(len(data) - start)
