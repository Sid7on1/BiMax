The first `saved-copy-leaf-link` attempt used `false &&` ahead of a discriminated-union access.
TypeScript reported TS2339 at thread.undo.ts:298 (`backup` does not exist on `JournalOp`),
with zero executed tests. It is invalid, not a kill. The receipt is retained in
`mutation-fixture-attempts.json`. The mutation was rewritten to evaluate the narrowed access
before `&& false`. Its executable rerun is recorded in `mutations.json` and the current
`mutation-saved-copy-leaf-link.log`; that rerun replaced the initial raw log. This note
transcribes the initial compiler diagnostic, rather than representing a behavioral result.
