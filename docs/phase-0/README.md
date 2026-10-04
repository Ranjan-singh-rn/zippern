# ZIPPER — Phase 0 Documentation

| File | What it is |
|---|---|
| `ZIPPER-Phase-0-Documentation.pdf` | The deliverable. 106 pages, bookmarked and searchable. |
| `ZIPPER-Phase-0-Documentation.md` | The source. Edit this to revise. |
| `cover.tex`, `preamble.tex` | The styling. |
| `evidence/` | The six raw discovery sweeps the document was written from, with file:line citations throughout. |

## Rebuilding after an edit

    pandoc ZIPPER-Phase-0-Documentation.md -o ZIPPER-Phase-0-Documentation.pdf \
      --pdf-engine=xelatex -H preamble.tex --include-before-body=cover.tex \
      --toc --toc-depth=2 -V documentclass=report -V fontsize=10pt

Requires pandoc, xelatex and the DejaVu fonts.

## Scope note

Phase 0 describes the system as it exists. It proposes no changes, ranks no gaps by
business importance, and answers no open question. Phases 1 and 2 follow.
