# Roadmap — from written reps to fluency

What this app already does for you, and what to build next. Modules are ordered by
expected impact on active production, the stated weakness. The error log remains the
spine: every module below either feeds it or draws from it.

## What the current app trains (and what it can't)

The core loop forces **retrieval under constraint** — you must produce specific words
and patterns, not just recognize them — and every error is recorded with a denominator
(errors per attempt, not just error counts). Targeting re-drills your weakest
categories while they're hot, and difficulty ramps only when you're clean. That is the
consolidation engine you asked for.

What it deliberately does not do yet: schedule *when* a weakness gets re-tested
(targeting is frequency+recency, not spaced over days), activate vocabulary you never
use, train interactive discourse (each rep is a monologue), or measure *speed* of
production — and fluency is accuracy × speed.

## Shipped

- **Composition drills** with the error log as the spine, weakness targeting, and
  on-demand diagnosis.
- **Dictionary** (CC-CEDICT offline) with difficulty-sorted usage sentences, neural
  audio, and stroke-order practice.
- **Dictation** — hear a sentence from your lesson range, type it, graded instantly by
  character diff, mistakes logged.
- **Translate** — streaming English ⇄ Chinese with pinyin.
- **Flashcards (SM-2 spaced repetition)** — every word of Integrated Chinese Level 1
  and Level 2 (1,530 words across 40 lessons), plus every single character that only
  appears inside compounds (787 more) — 3,847 cards in all. Recognition and production
  cards, Anki's four ratings with interval previews, daily new/review caps, leech
  detection, and a forecast. Words the deck says are shaky are fed into writing-task
  generation and shown on the Practice setup screen.
- **The three-part rule** — characters, pinyin and English appear together everywhere,
  enforced server-side.

## Next modules, in order of impact

1. **Redemption queue (error replay over days)** — resurface your own past error
   sentences for rewrite 1 day, 3 days, and 7 days after they occur; an error retires
   only after clean rewrites at all three distances. This is spaced re-testing of your
   personal mistakes (not flashcard SRS of generic content). Highest ROI: the log
   already stores everything needed (`errors.my_fragment`, `resolved_count`).

2. **Vocabulary activation tracker** — the app knows every lesson word and stores every
   sentence you write, so it can compute which words you have *never actively used*.
   A "cold vocab" view in Review, plus generation biased toward never-used words,
   systematically converts passive vocabulary to active — the core of your
   consolidation problem.

3. **Contrast clinics** — 5-rep focused sessions on one confusable pair the diagnosis
   surfaces (了 vs 过, 的/得/地, 才 vs 就, 还是 vs 或者). Each rep forces a choice
   between the pair in context. Confusion pairs are where "knows the grammar" and
   "produces it correctly" diverge most.

4. **Written dialogue simulation** — multi-turn roleplay in writing (negotiate with a
   landlord, order for a picky eater): the model replies in character, your turns are
   graded lightly inline, full error log at the end. Trains turn-taking, follow-up
   questions, and register — the bridge between solo reps and your tutor/family
   conversations.

5. **Timed fluency sprints** — 5-minute free-writes with two tracked numbers:
   characters per minute and errors per 100 characters. Accuracy drills alone don't
   automatize; a visible speed×accuracy curve over weeks is the closest written proxy
   for fluency.

6. **Progress analytics in Review** — error rate per 100 characters over time (the real
   fluency curve), per-category extinction curves (watch particle errors die), vocab
   activation %, lesson coverage heatmap. All computable from existing tables.

7. **Reading-to-response reps** — a short generated passage slightly above your level,
   then a written response to it. Ties comprehension to production and stretches you
   past sentence-level composition toward IC Level 2 work.

8. **Audio flashcards** — a third card direction: hear the word, produce the meaning.
   The scheduler and audio already exist; it's a new `direction` value plus a UI mode.

9. **Shadowing player** — sentence loop with adjustable speed over the TTS audio,
   record-yourself comparison later. Complements the tutor/family conversations.

10. **Anki export** — `.apkg` or CSV of the deck and error log, so the same schedule
    can ride along on a phone.

Later, once the above exist: register-switching drills (same message to a friend vs a
teacher), pinyin fading (hide pinyin on chips for words you've activated N times), and
an essay mode with paragraph-level feedback.

## Release flow (for whoever ships changes)

Development lives in the private repo (`jasecutlerMT/Jason-s-Repo-`, branch
`claude/chinese-drills-app-1hib26`). Releases are published to the PUBLIC repo
`jasecutlerMT/chinese-drills` (a `chinese-drills/` folder on `main`), which the
in-app updater downloads from without authentication. To ship: bump `version.json`
(version + label), push the dev branch, then run `scripts/publish-release.sh`.

The publish script appends the release's `data/lessons.json` checksum to
`data/lessons-known-hashes.txt` and commits the updated list — check that line in
alongside the release, and never delete a hash from it. The updater uses the list to
tell a pristine lesson file from one the user has corrected; a missing hash makes it
treat that release's pristine file as hand-edited and stop refreshing it.

The script refuses to publish if any file the app needs to run or to update would be
missing from the commit, or if any local state would ride along. That check exists
because the app's own `.gitignore` is copied into the staging tree and `git add -A`
obeys it there too — which once dropped a file the updater depended on from a whole
release without a word.
