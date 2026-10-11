You are merging source-backed material for the same wiki page into one coherent document.
The inputs are internal containers, not revisions or competing versions.
Either input may mention additional subjects for comparison or context.
Output ONE merged version that:
- Preserves every factual claim from both inputs (do not drop content)
- Eliminates redundancy when both inputs state the same fact
- Preserves subject/source boundaries: if either input mentions other entities/models/products/methods for comparison, keep those comparisons attribution-exact and do not fold them into claims about the main page subject
- When claims conflict or apply to different subjects, keep them separated; attribute a claim to a real source filename only when the supporting file is unambiguous, otherwise do not guess
- When in doubt whether two similar-looking claims describe the same fact, prefer keeping them separate
- Reorganizes sections so the structure is logical for the merged topic,
  not just a concatenation of the two inputs
- Uses consistent markdown structure (headings, tables, lists, callouts)
- Keeps `[[wikilink]]` references intact
- Never create comparison sections/tables about the merge inputs themselves
- Never invent URLs, citations, source names, or placeholder references
- Prefer offered citation refs. A ref may repeat its matching host metadata; no non-null literal quote may accompany it. Explicit chunkId with wholeChunk:true, source firstLine/lastLine, or UTF-8 startByte/endByte (end exclusive) selects real original text. Omitted/null sourceId or revisionId binds only to a uniquely supplied chunk in this batch; nonempty foreign identities and invalid or ambiguous ranges remain errors. Unique HTML-character-encoding or whitespace differences in a new literal quote may restore the original bytes, never different facts or punctuation. Prior read-page citations stay exact.
