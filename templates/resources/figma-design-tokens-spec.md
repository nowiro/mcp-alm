# Figma Design Tokens — W3C-compatible spec

## Format

`mcp-figma.export_tokens({ key: <fileKey> })` zwraca tokens jako structured JSON zgodny z [W3C Design Tokens Community Group](https://www.designtokens.org/tr/drafts/format/) draft.

```json
{
  "color": {
    "brand": {
      "primary": { "$type": "color", "$value": "#0066CC" },
      "secondary": { "$type": "color", "$value": "#FF6633" }
    },
    "semantic": {
      "success": { "$type": "color", "$value": "#28A745" },
      "error": { "$type": "color", "$value": "#DC3545" }
    }
  },
  "typography": {
    "heading-1": {
      "$type": "typography",
      "$value": {
        "fontFamily": "Inter",
        "fontSize": "32px",
        "fontWeight": 700,
        "lineHeight": "1.2"
      }
    }
  },
  "spacing": {
    "xs": { "$type": "dimension", "$value": "4px" },
    "sm": { "$type": "dimension", "$value": "8px" },
    "md": { "$type": "dimension", "$value": "16px" },
    "lg": { "$type": "dimension", "$value": "32px" }
  }
}
```

## Categories

| Category     | $type                    | Typical values                            |
| ------------ | ------------------------ | ----------------------------------------- | --- | ----------- |
| `color`      | `color`                  | `#RRGGBB` hex, `rgba(...)`, OKLCH         |
| `typography` | `typography`             | object: fontFamily/Size/Weight/lineHeight |
| `spacing`    | `dimension`              | `<px                                      | rem | em>` string |
| `border`     | `border`                 | object: width/style/color                 |
| `shadow`     | `shadow`                 | object: offsetX/Y/blur/color              |
| `radius`     | `dimension`              | `<px>` corner radius                      |
| `motion`     | `duration`/`cubicBezier` | timing tokens                             |

## Conventions

- **Naming**: kebab-case dla keys (`brand-primary`, nie `brandPrimary`).
- **Hierarchy ≤ 3 levels**: `color.semantic.error` (3) OK, `color.semantic.feedback.error.primary` (5) zbyt głęboko.
- **Aliasing**: użyj `{ "$value": "{color.brand.primary}" }` żeby reference inny token (W3C draft składnia).
- **Modes**: light/dark obsłużone przez Figma Variables Modes — `mcp-figma.export_tokens` zwraca wszystkie modes per token.

## Workflow

1. Designer tworzy zmiany w Figma file.
2. Developer / CI: `figma.export_tokens({ key })` → `tokens.json`.
3. Build step (style-dictionary / tokens-studio-cli): generate platform outputs (CSS vars, Tailwind config, iOS swift constants, Android XML).
4. Commit + PR z `tokens.json` zmianami — review które tokens się zmieniły.

## Anti-patterns

- ❌ Hardcoded `#FFFFFF` w komponencie — używaj `var(--color-base-white)` / `theme.color.base.white`.
- ❌ Custom transformation bez style-dictionary — każdy projekt ma swoją "implementation" — sync drift gwarantowany.
- ❌ Mode-conscious component bez referencji do `color.semantic.*` — łamie dark mode.
- ✅ Single source of truth: Figma → `tokens.json` (w repo) → build-time generate (CSS/iOS/Android).

## Limity

- Figma REST `/files/<key>` max 5MB response — duże design systems wymagają `nodes` filtering.
- `mcp-figma.export_tokens` zwraca tylko Variables (Local Variables, nie Team Library) — Team Library wymaga osobnego API + paid Figma plan.
