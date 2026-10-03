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
