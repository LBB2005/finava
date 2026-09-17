# Browser personas (10 of the 50)

`eval:panel` drives the 40 API personas. The other 10 (ids 2, 22, 24, 27, 33, 35, 37, 41, 43, 47;
2, 22 and 43 at phone width) use the real UI, because some failures only show on screen: layout,
the Stop button, reload, the answer card. They need a browser a script can't drive from here, so a
Claude Code session with Browser tooling runs them.

## Run them

1. Start the app under test (the worktree's `.claude/launch.json` entry, port 3013) and turn on the dev
   auth bypass (localStorage `finava_dev_auth` = `1`).
2. `eval:panel --yes` writes `browser-tasks.json` into its results folder. Give a Claude Code session
   this prompt, one persona at a time:

   > Read `<results>/browser-tasks.json` and `evals/panel/BROWSER.md`. Play persona #N exactly as
   > described (identity, levels, goal, voice). Use the in-app browser at 375 px width if `mobile` is
   > true, else 1440 px. Start at /chat in Auto mode and type their `opening`. Up to 4 messages. Press
   > Stop if you'd have lost patience (S1–S3: about 60–75 s; S4: 180 s; S5: 240 s). Reload the page
   > once after an answer finishes and note whether it's all still there. Then append one entry to
   > `<results>/browser-results.json` in the shape below. Judge only what the screen showed.

3. `npx tsx evals/report/build.ts --panel <results> --live <live results>` picks the file up.

## `browser-results.json`

```json
{
  "results": [
    {
      "persona": { "id": 2, "ai": "A1", "stock": "S1", "channel": "browser", "mobile": true },
      "shown": [{ "lane": "fast", "waitSec": 7.5, "stopped": false }],
      "metrics": [{ "lane": "fast", "totalMs": 7500,
                    "collapse": { "streamedChars": 0, "renderedChars": 1830, "savedChars": 1830, "reloadedChars": 1830, "collapsed": false, "where": null } }],
      "rating": { "scores": { "easeOfUse": 6, "answerUsefulness": 6, "answerClarityForMe": 6, "trustInNumbers": 6, "speed": 7, "modeUnderstanding": 5, "wouldReturn": 6 },
                  "nps": 6, "pay": "maybe", "price": 5, "quit": false },
      "quitMidSession": false,
      "error": null
    }
  ]
}
```

In the browser, "streamed" can't be read off the wire, so the collapse check is: the answer text on
screen when streaming ended = the text after it settled = the text after reload. `lane` is read from
the answer's lane badge.
