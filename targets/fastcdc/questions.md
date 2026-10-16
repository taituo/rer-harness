<!--
DRAFT path for the pilot, written by hand as a starting point. Review it with the same rules as any path, or replace it
with `node rer.ts design targets/fastcdc/experiment.json` and edit that. Run the guessers before any doer run.
-->

I back up a lot of large files that change a little every day, and I keep paying to store almost the same bytes again. I'd like to understand how much of a changed file is really new. Set yourself up with some realistic test files and measure it before we try anything clever.

---

Here's what bugs me: if I cut each file into equal blocks and only store blocks I haven't seen, it works great when bytes are overwritten, and terribly when a single byte is inserted near the start. Show me that properly, with numbers, and explain exactly why it happens.

---

So the problem is where the cuts land. What if the cut positions didn't depend on where they are in the file at all? What could they depend on instead? Try ideas and measure each one, even the bad ones.

---

Can you make the decision to cut depend only on a small neighbourhood of bytes, and compute it cheaply as you slide along the file? I care about speed too, so measure it.

---

Now what happens to piece sizes? I can't have pieces of a few bytes or of a gigabyte. How do you keep them in a sensible range without losing what you just gained? Measure the trade-off.

---

Test it the way it would fail in real life: random data, logs, files with lots of repetition, edits at the start, middle and end, deletions. Where does it stop working?

---

How much of the work is the hashing itself? See how fast you can make it without changing which pieces it produces, and prove the pieces stayed the same.

---

Is the size distribution as good as it could be? Some schemes get pieces that cluster nicely around a target size; see if you can tighten it without hurting reuse.

---

Pull it together: what is the best version you have, what are its numbers against equal-size blocks, and what did you try that didn't work?
