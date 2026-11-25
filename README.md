# dsh-model-pointer

Standalone plugin for DSH that looks up any model currently available in DSH — plus its reasoning effort — and inserts a canonical model pointer into your chat message.

## What It Is

`dsh-model-pointer` is a neutral, read-only lookup and message-insertion plugin. It does not bundle, host, or manage any models or providers; it simply reads the live model catalog that DSH already exposes (built-in and plugin-added providers alike) so you and your agents can reference the exact same provider, model, and reasoning effort.

## What It Does

- **Uses the same popup mechanic as `/model`:** Type `/model-pointer` anywhere in the composer (at the start of a message or inline) to open DSH's native searchable model picker — fast, with no file/folder lookup overhead.
- **Shows every model available to DSH:** Reads directly from DSH's live model catalog (`remote.session.modelCatalog()`), grouped by provider, with no hardcoded provider list or arbitrary item limit.
- **Adds reasoning-effort selection:** When a chosen model advertises reasoning efforts, a second picker step lets you choose `Default` or any advertised effort level (or go back to pick another model).
- **Inserts an atomic `@` chip into your message:**
  - Displays the selected model name and reasoning effort (e.g. `@ Model X · High`) as a single non-editable composer chip — pressing Backspace deletes the whole chip at once without leaving `@` text behind to trigger file/folder lookup.
  - Serializes cleanly on send (and copy/paste) to the canonical pointer:
    - Without explicit effort: `@model[provider-a/model-x]`
    - With reasoning effort: `@model[provider-a/model-x@high]`
- **Host resolution tool (`resolve_model_pointer`):** Read-only tool that lets agents parse, validate, or search `@model[provider/model@effort]` pointers against live `ctx.llm`.

### Example Message

```text
Compare @model[provider-a/model-x@high] with @model[provider-b/model-x@medium] on this task.
```

## Installation

Install into your DSH profile (e.g. `~/.dsh/profiles/web`):

```bash
npm install dsh-model-pointer
```

Or add the package to your DSH profile's `dsh.profile.bundles` and restart DSH.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT © Cyance
