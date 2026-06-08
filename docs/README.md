# Documentation site

The Hearth documentation, built with [Docusaurus](https://docusaurus.io).

Everything under `docs/` is the documentation itself, and it is the only copy.
There is no parallel set of markdown elsewhere in the repository, so a page is
edited in exactly one place.

```bash
pnpm install --ignore-workspace   # once, from this directory
pnpm start                        # local preview with hot reload
pnpm build                        # what CI runs
```

`onBrokenLinks` is set to `throw`, so an internal link to a page that has moved
or been removed fails the build instead of shipping. That is deliberate: it is
the mechanism that keeps the documentation honest as the code changes.

Search is built at compile time and served from the site itself. Hosted search
would mean a third party seeing what self-hosters look up, which is a strange
thing to ask of this audience.
