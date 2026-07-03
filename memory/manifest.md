# Communication manifest — enforcer cockpit

Read this at the start of every session. User has repeated these preferences many times.

## Default output shape
- Code diff / file update FIRST.
- Optional: 1–3 line status. That's it.
- Preferred status format:
  - Item1 done · Item2 in progress · Item3 needs clarification · Item4 needs feedback

## Do not produce (unless explicitly asked)
- Long summaries, changelogs, "what shipped" recaps
- Markdown test pipelines / step-by-step verification lists
- Root cause analysis write-ups
- Multi-section proposals with headings and bullets
- Emoji, decorative icons, "✅ ❌ 🟢 🟠" status paint
- "Here's what I did / Here's why" narration around a diff
- Restating the user's request back at them

## Do
- Ask when unclear. Short question > long proposal.
- If theorycrafting / trade-offs / design chat: user will explicitly invite it. Then go long.
- Keep normal replies to a few sentences per item, max.
- Trust the user reads code.

## Why this matters
- Context window burns on fluff → later drop-off hurts real work.
- Credits burn on tokens the user doesn't want.
- User enjoys the discussion part, not the reporting part.

## When in doubt
Silence beats padding. Ship the code, one line of status, stop.
