---
name: natural-writing
description: Use when writing or editing any prose in this repository - README, docs, code comments, commit messages, issue templates, UI copy, or PR descriptions. Makes writing read like a person wrote it rather than a model.
---

# Natural writing

Everything written here is read by strangers deciding whether to trust the
project. Writing that sounds generated makes people distrust the code too,
whether or not that is fair.

## Punctuation

Do not use em dashes or en dashes. If a sentence needs one, it needs to be two
sentences or a comma.

- Bad: Location updates are batched for battery — the server dedupes them.
- Good: Location updates are batched for battery. The server dedupes them.

Do not use semicolons in prose. Start a new sentence. They are fine in code.

Avoid the colon-then-elaboration habit. Once or twice per document is normal.
Ten times is a tell.

Avoid parenthetical asides stacked inside sentences. Move the aside into its
own sentence or cut it.

## Words and rhythm

Do not use these. They are the loudest tells:

| Avoid                                        | Use                                   |
| -------------------------------------------- | ------------------------------------- |
| leverage, utilise                            | use                                   |
| robust, seamless, powerful, elegant          | say what it actually does, or nothing |
| comprehensive, holistic                      | cut it                                |
| delve into, dive into                        | look at                               |
| it is worth noting that                      | just say the thing                    |
| in order to                                  | to                                    |
| a wide range of, a variety of                | name them, or cut                     |
| ensure that                                  | make sure, or cut                     |
| facilitate                                   | let, help                             |
| Additionally, Furthermore, Moreover          | And, Also, or start the sentence      |
| That said, Ultimately, At the end of the day | usually cut entirely                  |

Do not open a paragraph with "In today's world", "As developers", or any
scene setting. Start with the fact.

Do not end a section with a summary of what the section just said.

Vary sentence length. Two short sentences next to a long one reads human. Six
medium sentences in a row reads generated.

Contractions are fine and usually better. "Doesn't" beats "does not" in a
README. Keep them out of formal reference tables where they read oddly.

## Structure

Do not make everything a bulleted list. Prose is fine and often better. Use a
list when the items are genuinely parallel.

Do not use the "Problem / Solution / Result" template. Do not use bold lead-ins
on every bullet in a list.

Three sentence paragraphs are fine. One sentence paragraphs are fine.

## Honesty

Say what does not work. An open source README that admits a limitation reads
far more credible than one that does not.

Do not claim things you have not verified. "Tested on iOS 18 and Android 14" is
only allowed if that happened.

## Checking your own writing

Search your draft for these before you finish:

```text
—  –  ;  leverage  robust  seamless  comprehensive  delve
"It is worth noting"  "In order to"  "Additionally,"  "Furthermore,"
```

If a sentence would sound strange read aloud to a colleague, rewrite it.
