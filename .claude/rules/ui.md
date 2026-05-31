---
paths:
  - "components/**"
  - "app/**"
---

# UI & Design System

- Use shadcn/ui primitives from `@/components/ui`. To add a new primitive, use the `shadcn` skill / `npx shadcn@latest add <name>` — do not hand-write primitives.
- Style is `radix-nova`, base color `neutral`. Icons: `lucide-react`.
- Use theme CSS variables (`bg-primary`, `text-muted-foreground`, `bg-card`, `--chart-1..5`), never hard-coded hex/rgb colors. Colors are `oklch` vars in `app/globals.css`.
- Dark mode is driven by `next-themes` — ensure new UI works in both `:root` and `.dark`.
- Charts use Recharts; data tables use TanStack React Table with column defs in `*-columns.tsx`.
- Feature components live in `components/`; keep route files in `app/` thin.
- For layout/design decisions and polished interfaces, invoke `ui-ux-pro-max` and `frontend-design`.
