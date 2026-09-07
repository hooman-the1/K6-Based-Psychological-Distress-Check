# Shared visual foundation

This document is the source of truth for the application's shared visual
foundation. The application uses one mobile-first light composition at every
width. Route-specific component polish is deliberately deferred as described
below.

## Color

The document declares `color-scheme: only light`. The body uses the page color,
the single page shell uses the surface color, and normal text uses the text
color. There is no dark token set, theme switch, gradient, or color-scheme media
override.

| Token | Value | Purpose |
| --- | --- | --- |
| `--color-page` | `#f7f8fa` | Page background |
| `--color-surface` | `#ffffff` | Page shell and secondary-control surface |
| `--color-text` | `#1f2933` | Default text and headings |
| `--color-muted` | `#52606d` | Supporting text |
| `--color-border` | `#bcccdc` | Decorative borders and disabled-control border |
| `--color-primary` | `#0b5cad` | Primary actions and links |
| `--color-primary-hover` | `#084887` | Primary/link hover state |
| `--color-on-primary` | `#ffffff` | Text on primary and danger fills |
| `--color-focus` | `#7c3aed` | Keyboard focus outline |
| `--color-danger` | `#9f1239` | Destructive action |
| `--color-danger-hover` | `#7f1230` | Destructive hover state |
| `--color-disabled-bg` | `#e4e7eb` | Disabled-control fill |
| `--color-disabled-text` | `#52606d` | Disabled-control text |

Normal-text contrast expectations on the relevant background are:

| Pair | Approximate ratio |
| --- | ---: |
| text / surface | 14.76:1 |
| muted / surface | 6.46:1 |
| primary / surface | 6.67:1 |
| white / primary | 6.67:1 |
| white / danger | 8.02:1 |
| disabled text / disabled background | 5.20:1 |
| focus / surface | 5.70:1 |

All normal-text pairs must remain at least 4.5:1. Decorative borders are never
the only carrier of text or state meaning.

## Typography

The shared font stack is exactly `system-ui, -apple-system, BlinkMacSystemFont,
"Segoe UI", sans-serif`.

- Body text: 16px, line-height 1.5, weight 400.
- Supporting text (`small`, figure captions, and question counts): 14px,
  line-height 1.5.
- `h1`: 32px, line-height 1.2, weight 700.
- `h2`: 24px, line-height 1.25, weight 700.

Headings inherit the default text color and font family. The existing semantic
heading hierarchy is retained; no decorative display font is used.

## Spacing and flow

| Token | Value |
| --- | --- |
| `--space-1` | `0.25rem` |
| `--space-2` | `0.5rem` |
| `--space-3` | `0.75rem` |
| `--space-4` | `1rem` |
| `--space-5` | `1.5rem` |
| `--space-6` | `2rem` |

Headings, paragraphs, lists, figures, and shared action groups have explicit
margins. Direct visible page-shell blocks use a 24px vertical rhythm. An `h1`
has 16px separation from its immediately following content, and an `h2` has
12px separation from its immediately following content. Hidden content uses
`display: none` and consumes no space.

`.action-stack` is a single-column grid with a 12px gap and no breakpoint. It is
used for grouped page-level actions such as the Home CTAs.

## Page and surface

Box sizing is `border-box` for every element and pseudo-element. The body has no
margin or forced content width, has a minimum height of `100vh`, and establishes
a flow root so its shell margins do not create incidental scrolling.

Every route contains one direct `main.page-shell` body child. The shell has:

- width `min(calc(100% - 2rem), 36rem)` with horizontal auto margins;
- 16px block margins;
- padding `clamp(1.25rem, 5vw, 2rem)`;
- a 1px `--color-border` border and 12px radius;
- a `--color-surface` background.

There are no layout breakpoints or desktop alternatives. Required measurements:

| Viewport | Shell width | Gutters | Padding |
| ---: | ---: | ---: | ---: |
| 320px | 288px | 16px | 20px |
| 375px | 343px | 16px | 20px |
| 768px | 576px | 96px | 32px |

Horizontal overflow is not allowed; vertical scrolling is. Shared replaced
media uses `max-width: 100%`. The History SVG remains a block at 100% width with
automatic height.

## Shared controls

The supported classes are `.button`, `.button--primary`, `.button--secondary`,
`.button--danger`, `.button--text`, `.link`, and `.action-stack`.

Every `.button` is declared as an inline-flex centered control with inherited
16px type, weight 600, line-height 1.25, a minimum 44px width and height, 10px
vertical/16px horizontal padding, a 1px border, 8px radius, no underline, and a
pointer cursor while enabled. Grid and flex layout may blockify its computed
outer display without changing that box model. Anchor and native-button uses are
equivalent.

- Primary: white on primary with a matching border; primary-hover fill/border
  on hover.
- Secondary: primary text/border on surface; primary-hover text and `#eaf2fb`
  fill on hover.
- Danger: white on danger with a matching border; danger-hover fill/border on
  hover.
- Text button: transparent with underlined primary text; primary-hover text and
  `#eaf2fb` fill on hover.
- Disabled native buttons and any shared `[aria-disabled="true"]` control:
  disabled background/text, shared border, opacity 1, and a not-allowed cursor.
  Disabled controls do not acquire hover colors.

`.link` is inline-flex, centers wrapped content, has a minimum 44px height, uses
underlined primary text with a 2px underline offset, and permits long text to
wrap. Hover uses primary-hover while visited links retain primary and remain
underlined.

Every enabled shared control receives a keyboard-only `:focus-visible` outline
of 3px solid focus color with a 2px offset. Controls stay within the shell and
viewport. Adjacent grouped controls have at least 8px separation; the standard
action-stack separation is 12px.

Required route wiring:

- Home: Start Test is primary; View History is secondary; both are in an action
  stack.
- Questionnaire: Back is secondary, Next and See my result are primary, and What
  does this mean? is a text button.
- Result: Take test again is primary; generated resource anchors are links.
- History: empty-state Take Test is primary; Clear All History is danger.

## Motion and scope

The default foundation has no transitions or animations on the shell, controls,
progress, notices, lists, or chart. A `prefers-reduced-motion: reduce` rule also
forces animation and transition off and scroll behavior to auto. No control
moves, scales, fades, or animates on interaction.

The foundation adds no logo, illustration, image, remote font or asset, advanced
branding, dark theme, loading treatment, persistent header/navigation/footer,
sidebar, overlay, or alternate desktop composition.

Questionnaire and Result component composition, response-card/progress/score and
resource polish are deferred to #21. History chart/list/state/Clear composition
and final visual polish are deferred to #22. Shared styling must not alter copy,
semantics, hooks, routes, scoring, questionnaire behavior, Result behavior,
resource destinations, or History/storage behavior.
