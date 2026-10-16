"""Hidden acceptance tests for the content-defined chunking target.

Never visible to the researcher. Called as `python3 evaluate.py <copy of the work>`, prints one JSON object.

The interface the researcher was asked for (identically in every arm, at the end of the run):
    ./split FILE   (or split.py / split.sh)   prints the byte length of each piece, one per line, in order,
                                               and the pieces together cover FILE exactly.

What is measured, separately, because they trade off:
    correctness  the pieces cover each file exactly; output is deterministic; edge cases work
    dedup        after an edit, how many bytes of the new file are in pieces that already existed before the edit,
                 compared with fixed-size pieces of the same mean size (the gain is the point: fixed-size pieces lose
                 almost everything after a one-byte insert at the start)
    shape        mean piece size and spread, largest piece relative to the mean
    cost         throughput

No piece boundary is compared with any reference implementation: any method that does well on the contract counts.
"""
import hashlib, json, os, random, subprocess, sys, time

WORK = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
# The real study uses private-seeds.local.json, made on your machine and never committed (see README); `freeze` hashes
# it, so the committed freeze file pre-registers the seed without revealing it. The committed file is for CI only.
_local = os.path.join(HERE, "private-seeds.local.json")
SEED = json.load(open(_local if os.path.exists(_local) else os.path.join(HERE, "private-seeds.json")))["seed"]
TIMEOUT = 60
SIZE = 384 * 1024


def entry():
    for name, cmd in (("split", ["./split"]), ("split.py", ["python3", "split.py"]), ("split.sh", ["sh", "split.sh"])):
        p = os.path.join(WORK, name)
        if os.path.isfile(p) and (name != "split" or os.access(p, os.X_OK)):
            return cmd
    return None


def corpus(rng):
    words = "alpha beta gamma delta request response cache miss hit user session token timeout retry ok error".split()
    def text(n):
        out, t = [], 1_700_000_000
        while sum(map(len, out)) < n:
            t += rng.randint(0, 3)
            out.append(f"{t} {rng.choice(['INFO','WARN','DEBUG'])} {' '.join(rng.choice(words) for _ in range(rng.randint(3, 12)))} id={rng.randint(0, 99999)}\n")
        return "".join(out).encode()[:n]
    def repetitive(n):
        blocks = [rng.randbytes(rng.randint(500, 3000)) for _ in range(12)]
        out = bytearray()
        while len(out) < n:
            b = bytearray(rng.choice(blocks))
            if rng.random() < 0.3:
                b[rng.randrange(len(b))] ^= 0xFF
            out += b
        return bytes(out[:n])
    return {"random": rng.randbytes(SIZE), "text": text(SIZE), "repetitive": repetitive(SIZE)}


def edits(rng, data):
    mid, third = len(data) // 2, len(data) // 3
    return {
        "insert_1_byte_at_start": b"\x00" + data,
        "insert_200_bytes_in_middle": data[:mid] + rng.randbytes(200) + data[mid:],
        "delete_1000_bytes": data[:third] + data[third + 1000:],
        "append_5000_bytes": data + rng.randbytes(5000),
    }


def run(cmd, data, tmp):
    path = os.path.join(tmp, "input.bin")
    with open(path, "wb") as f:
        f.write(data)
    t0 = time.time()
    try:
        r = subprocess.run(cmd + [path], cwd=WORK, capture_output=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return None, TIMEOUT
    dt = time.time() - t0
    if r.returncode != 0:
        return None, dt
    try:
        lengths = [int(x) for x in r.stdout.decode().split()]
    except ValueError:
        return None, dt
    return lengths, dt


def covers(lengths, data):
    if lengths is None:
        return False
    if len(data) == 0:
        return lengths in ([], [0])
    return all(n > 0 for n in lengths) and sum(lengths) == len(data)


def pieces(lengths, data):
    out, pos = [], 0
    for n in lengths:
        out.append(data[pos:pos + n])
        pos += n
    return out


def reuse(before, after):
    known = {hashlib.sha256(p).digest() for p in before}
    return sum(len(p) for p in after if hashlib.sha256(p).digest() in known) / max(1, sum(map(len, after)))


def fixed(data, size):
    return [data[i:i + size] for i in range(0, len(data), size)]


def main():
    cmd = entry()
    if cmd is None:
        print(json.dumps({"interface": 0, "error": "no ./split, split.py or split.sh in the project"}))
        return
    rng = random.Random(SEED)
    tmp = os.path.join("/tmp", f"rer-eval-{os.getpid()}")
    os.makedirs(tmp, exist_ok=True)
    m = {"interface": 1}
    bases = corpus(rng)
    total_bytes, total_time, covered, checked, crashes = 0, 0.0, 0, 0, 0
    sizes, gains, dedup_all, fixed_all = [], [], [], []
    for cls, data in bases.items():
        base_len, dt = run(cmd, data, tmp)
        checked += 1
        if base_len is None:
            crashes += 1
            continue
        total_bytes += len(data); total_time += dt
        ok = covers(base_len, data); covered += ok
        if not ok:
            continue
        again, _ = run(cmd, data, tmp)
        m[f"deterministic_{cls}"] = int(again == base_len)
        sizes += base_len
        mean = sum(base_len) / len(base_len)
        before = pieces(base_len, data)
        for name, edited in edits(rng, data).items():
            el, dt = run(cmd, edited, tmp)
            checked += 1
            if el is None:
                crashes += 1
                continue
            total_bytes += len(edited); total_time += dt
            if not covers(el, edited):
                continue
            covered += 1
            d = reuse(before, pieces(el, edited))
            f = reuse(fixed(data, max(1, round(mean))), fixed(edited, max(1, round(mean))))
            m[f"dedup_{cls}_{name}"] = round(d, 4)
            dedup_all.append(d); fixed_all.append(f); gains.append(d - f)
    for name, data in {"empty": b"", "one_byte": b"x", "small_100_bytes": rng.randbytes(100)}.items():
        el, _ = run(cmd, data, tmp)
        checked += 1
        m[f"edge_{name}"] = int(covers(el, data))
    m["exact_cover_rate"] = round(covered / max(1, checked - 3), 4)
    m["crashes_or_bad_output"] = crashes
    if dedup_all:
        m["dedup_mean"] = round(sum(dedup_all) / len(dedup_all), 4)
        m["dedup_fixed_size_baseline"] = round(sum(fixed_all) / len(fixed_all), 4)
        m["dedup_gain_over_fixed"] = round(sum(gains) / len(gains), 4)
    if sizes:
        mean = sum(sizes) / len(sizes)
        var = sum((s - mean) ** 2 for s in sizes) / len(sizes)
        m["piece_mean_bytes"] = round(mean)
        m["piece_cv"] = round(var ** 0.5 / mean, 3)
        m["piece_max_over_mean"] = round(max(sizes) / mean, 2)
        m["pieces_total"] = len(sizes)
    if total_time:
        m["throughput_mb_s"] = round(total_bytes / total_time / 1e6, 3)
    print(json.dumps(m))


main()
