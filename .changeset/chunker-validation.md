---
"@statewalker/indexer-chunker": minor
---

`chunkMarkdown` now throws a `RangeError` unless `targetChars` is a positive integer and `overlap` an integer with `0 <= overlap < targetChars` (previously such options produced one chunk per character or thousands of near-duplicate chunks). Chunk `endPos` no longer exceeds the text length with an unclosed fence or a closing fence on the last line, and no extra last chunk lies inside the previous one. Code fences follow the CommonMark rule: `~~~` fences are recognised, and a fence closes only with a run of the same character at least as long as the opening one (`findCodeFences` and `scanBreakPoints` agree). The fence break point (score 80) now sits right after a closing fence, so it can win. Hard cuts and overlapped chunk starts no longer split a UTF-16 surrogate pair.
