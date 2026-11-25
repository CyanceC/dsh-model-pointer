# Model Pointer

Standalone, provider-neutral lookup plugin for DSH that finds any available model (plus reasoning effort) and inserts a canonical pointer into your chat message.

- Type `/model-pointer` anywhere in the composer to open DSH's native searchable picker (same mechanic as `/model`, without `@` file/folder overhead).
- Lists every provider and model currently exposed by DSH's live model catalog.
- Adds a reasoning-effort step when the selected model advertises effort levels.
- Inserts an atomic `@` chip (model name + reasoning effort) that deletes in one Backspace without triggering `@` file/folder search, and serializes to `@model[provider/model]` or `@model[provider/model@effort]` on send.
- Exposes the read-only `resolve_model_pointer` host tool so agents can validate or search pointers against live `ctx.llm`.
