# Code Style

Always-on rules for all TypeScript/TSX in this project.

- Use the `@/` path aliases, never deep relative imports: `@/components`, `@/lib`, `@/components/ui`, `@/hooks`, `@/lib/utils`.
- TypeScript only. Type props and exported functions; avoid `any`.
- Run `yarn typecheck` and `yarn lint` before claiming a change is done.
- Formatting is Prettier-owned (`yarn format`) — do not hand-format; match `.prettierrc`.
- Default to React Server Components. Add `"use client"` only when the file uses hooks, state, or browser APIs.
- Do not add comments that restate the code. Comment only non-obvious intent.
- Reuse existing components and helpers before writing new ones.
