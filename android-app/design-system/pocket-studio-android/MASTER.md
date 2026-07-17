# Pocket Studio Android Design System

## Direction

**Quiet Technical Workspace**: a content-first mobile control surface for developers managing remote AI sessions. It combines developer-tool precision with messaging ergonomics. Avoid marketing composition, oversized typography, decorative gradients, nested cards, and one-note dark terminal styling.

## Color Tokens

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| Primary | `#007A68` | `#5ED8BE` | Primary commands, focus, connected state |
| On primary | `#FFFFFF` | `#00382F` | Content on primary |
| Background | `#F6F8F7` | `#101413` | App canvas |
| Surface | `#FFFFFF` | `#171C1A` | Bars, sheets, rows |
| Surface variant | `#E6ECE9` | `#27302D` | Tool events, secondary controls |
| On surface | `#18201E` | `#E5ECE9` | Primary content |
| On surface variant | `#596662` | `#AAB7B3` | Metadata |
| Outline | `#C3CECA` | `#46534F` | Inputs and strong boundaries |
| Outline variant | `#DFE6E3` | `#303A37` | Dividers and rows |
| Error | `#BA1A1A` | `#FFB4AB` | Failures and stop action |
| Warning | `#8A5100` | `#FFB95C` | Degraded or waiting state |

Color never acts alone: status also uses an icon or label.

## Typography

Use the Android system sans family for Chinese/Latin consistency and system monospace for paths, IDs, agents, and code.

- Screen title: 22sp / 700
- Section title: 17sp / 600
- Row title: 15sp / 600
- Body: user-adjustable 12-20sp, default 14sp, line height 1.45
- Metadata: 12sp / 400, never below 11sp
- Button label: 14sp / 600
- Letter spacing: platform default

Markdown heading multipliers: `1.55 / 1.35 / 1.20 / 1.12 / 1.06 / 1.0`.

## Shape And Elevation

- Inputs and command surfaces: 8dp
- Rows and tool events: 8dp
- Bottom sheets: Material system shape
- Floating action button: 12dp
- Prefer separators and tonal contrast over shadows.
- Never nest cards.

## Layout

- Base grid: 4dp; primary rhythm: 8dp.
- Phone gutter: 16dp; compact phone gutter: 12dp.
- Tablet content maximum: 760dp, centered.
- Top and bottom fixed UI must reserve system/IME insets.
- Interactive targets: minimum 48x48dp, with at least 8dp separation.

## Components

### Navigation Header

Compact title plus one-line context breadcrumb. Back, refresh, type settings, and connection status each have accessible labels. Loading appears as a thin progress line below the header.

### Operational Row

One icon tile, title, metadata, optional status/time, and chevron. Stable minimum height 72dp. Use a full-width surface with a subtle boundary; no floating shadows.

### Chat

- User: compact high-contrast bubble aligned right.
- Agent: unframed Markdown aligned with a small agent marker.
- Tool: one collapsed event row per tool ID; output is progressive disclosure.
- Composer: fixed above IME; send/stop remains 48dp minimum.

### Empty And Error States

State the condition and next action. Errors stay near the affected workflow and include a recovery command when available.

## Motion

Use Material native sheet/ripple/progress motion. Chat auto-scroll is the only orchestrated movement. Avoid decorative entrance animations. Respect system animation scale.

## Accessibility Checklist

- Contrast: body 4.5:1, large/icons 3:1.
- Icon-only controls have content descriptions.
- Expanded tool rows expose expanded/collapsed semantics.
- Dynamic text must wrap without obscuring adjacent controls.
- Color is not the only status signal.
- Verify phone portrait/landscape and tablet widths.
- Verify keyboard does not hide header or composer.
