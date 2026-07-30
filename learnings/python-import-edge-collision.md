# Python import edge collisions

## Symptom

A full v2 dogfood index failed with `FACT_ID_CONFLICT` on an `imports` edge even though every
individual Python import parsed and resolved successfully.

## Trigger

Repository edges are identified by `(kind, from, to)`. Two statements in the same Python module
imported different names from the same target module, so they described one semantic relation but
the producer emitted two facts with different singular `specifier` metadata.

## Why the mapping was not obvious

The exception surfaced in the generic deterministic assembler. The invalid multiplicity originated
earlier in the Python producer and only appears when separate import declarations resolve to the
same module pair; extractor-only corpus tests therefore remained green.

## Detection and prevention

Exercise the integrated runtime against real multi-file Python corpora, not only extractor output.
Producers must aggregate occurrence-level evidence and metadata before emitting any relation whose
identity intentionally collapses parallel occurrences.
