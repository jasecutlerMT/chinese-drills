# Chinese Drills — written production practice with a persistent error log

Module 1 of a modular Mandarin learning app: typed composition drills graded by Claude,
with every attempt and every error logged to a local SQLite database. The error log
drives weakness-targeted task generation and on-demand diagnosis. (Module 2, stroke
order, comes later.)

## Setup

Precondition: the [`claude` CLI](https://claude.ai/code) is installed and logged in
with your Claude subscription (`claude` → complete login once). No API key, no `.env`.

**Normal use: double-click `Chinese Drills.app`** (or `Start Chinese Drills.command`,
which does the same thing in a Terminal window). Either one installs what's missing,
repairs a half-installed copy, opens the browser, and — the part that matters —
restarts the server after an in-app update. Started any other way, an update installs
and then leaves the app stopped.

### Keeping it in the Dock and on the Desktop

`Chinese Drills.app` has its own icon, so it can live in the Dock like any other app:

1. **Dock** — drag `Chinese Drills.app` onto the Dock. Dragging to the Dock makes a
   shortcut; it does not move the app.
2. **Desktop** — hold **Option** and **Command** together while dragging
   `Chinese Drills.app` to the Desktop. That makes an alias (a shortcut) and leaves
   the app where it is.

**Do not move `Chinese Drills.app` out of the `chinese-drills` folder.** The app
finds the rest of its files by looking around itself, so moved on its own it can no
longer start — it will say so rather than fail silently. Option+Command-dragging, as
above, is the way to have it in two places at once.

If you downloaded the app in a ZIP by hand, macOS blocks the first launch. Right-click
`Chinese Drills.app` → **Open** → **Open**, once. Updates installed from inside the app
are not affected.

The app runs without a Terminal window, so when something goes wrong it writes what
happened to `launch-log.txt` next to the app and tells you to look there.

The very first time a new word is spoken, you may hear a plainer voice: the good
voice is being fetched in the background, and every play after that uses it.

For development, where you want the terminal:

```bash
cd chinese-drills
npm install
npm run dev     # → http://localhost:3000
```

The in-app updater will not complete a restart under `npm run dev`; use the
launcher when testing updates.

## How it works

- **Practice** — pick a lesson range (Integrated Chinese lessons 1–40, i.e. all of
  Level 1 and Level 2) and task size; the app generates a prompt with target vocab +
  grammar (haiku), you type simplified Chinese, and grading (sonnet) returns a
  corrected version, categorized errors, and — after a major error — a one-sentence
  micro-task. The next task is pre-generated in the background while you type. The
  setup screen also shows what your flashcard deck owes you in that same lesson range,
  and the words it can see you wobbling on.
- **Flashcards** — Anki-style spaced repetition over every word in Integrated Chinese
  Level 1 (Parts 1–2) and Level 2 (Parts 1–2). Same SM-2 scheduler Anki uses: learning
  steps of 1 and 10 minutes, graduating at 1 day, intervals multiplied by an ease factor
  that moves with your Again/Hard/Good/Easy ratings. Each word gets a recognition card
  (characters → meaning) and, once you know it by sight, a production card
  (meaning → characters, with optional typing). Words you keep forgetting are fed back
  into your writing tasks.
- **Dictionary** — Pleco-style lookup (typed hanzi/pinyin/English, or spoken Mandarin
  via the mic button in Chrome) backed by CC-CEDICT offline. Each entry shows all
  senses plus AI-generated usage sentences (cached after first view), and a Strokes
  tab that animates stroke order and lets you practice drawing each character.
- **Review** — the error log with a Weakness view (by category and by item) and a
  Diagnose button (sonnet reads your last 50 errors, on demand only).
- **Settings** — default lesson range, daily rep target, and the in-app updater:
  "Check for updates" pulls the latest release from the public
  `jasecutlerMT/chinese-drills` repo, installs it, and restarts — no manual
  downloads and no GitHub login needed (start the app via
  `Start Chinese Drills.command` so the restart loop is active).
- Once the log has 10+ errors, ~40% of new tasks quietly target your most frequent
  recent weaknesses (tagged "targeted").

## House rule: characters, pinyin, meaning — always all three

Wherever Chinese appears in this app — flashcards, task targets, corrections, error
log, dictionary, dictation, translation — it appears with its pinyin and its English
meaning. Anything the model returns is checked server-side and back-filled from the
dictionary if a part is missing, so none of the three can silently go absent.

## Data you may want to edit

- `data/lessons.json` — all vocabulary and grammar for Integrated Chinese Level 1
  (lessons 1–20) and Level 2 (lessons 21–40): 40 lessons, 1,530 words, 340 grammar
  points. **Reconstructed from general knowledge of the textbooks, not scanned from
  them** — each lesson carries a `confidence` field (`high` for Level 1 Part 1, mostly
  `medium` for Level 2, `low` where even the lesson title is a guess), and anything
  wrong is yours to correct. Hand-editable; the dev server picks up changes on the next
  request. After editing, press **Sync deck** in Settings (or "Build my deck" on the
  Flashcards page the first time) to fold the changes into your cards. Cards are keyed
  by their characters, so correcting a pinyin, a meaning or a lesson number updates the
  existing card and your review history is kept.

  To check your corrections, run `npm run check-lessons` in the app folder. It
  compares every word against CC-CEDICT and prints what disagrees — currently 1,472
  of 1,530 readings are confirmed, 17 differ only by the tone changes on 一 and 不
  that the textbook writes and the dictionary doesn't, 19 are neutral-tone spellings
  where both forms are used, and 22 are words the dictionary doesn't list (the
  textbook's own character names, and ordinary compounds like 招聘广告 zhāopìn
  guǎnggào "job advertisement"). Nothing it prints is automatically wrong; it's a
  second opinion.

  Updates refresh this file while it is still exactly as some release shipped it.
  The moment it differs, updates take that as your work and leave it alone, dropping
  the new textbook data next to it as `data/lessons.incoming.json` to merge in your
  own time — `update-log.txt` says so when it happens. Recognition is by checksum
  against `data/lessons-known-hashes.txt`, which lists every version ever released
  and travels inside the release itself, so a fresh install is protected too.
- `data/drills.db` — your attempts and error log (SQLite, created on first run,
  gitignored). Delete it to start over.

All LLM calls go through the local `claude` CLI (subscription billing), behind an
`LLMProvider` interface (`src/lib/llm/`) so an API-backed provider could be swapped
in later without touching app code.
