# StPageFlip calculation core

Upstream: https://github.com/Nodlik/StPageFlip
Version: 2.0.7; commit: `ab30ecc1d9f6d98de1a99b8e296469382f41c120`.
License: MIT, Copyright (c) 2020 Nodlik; see LICENSE.

The files under `src/` are unmodified upstream sources. `FlipCalculation` and
`Helper`, plus the direction/corner enums from `Flip.ts`, are compiled with
`node scripts/build-page-flip-core.mjs` into the checked-in reader vendor module.
No upstream gesture handlers, book layout or perpetual animation loop are used.
BOAA retains navigation, cancellation, image readiness and accessibility ownership.

The adapter follows `HTMLPage.drawSoft` for clip coordinates and rotation and
`HTMLRender.drawFrame` for static page / revealed page / flipping page ordering.
These reference files are retained here for reviewing correspondence. The adapter
freezes both page contents for the turn, mirrors geometry for RTL, reverses the
fold for previous-page turns, and paints a paper back rather than changing the
content of a held sheet. It does not divide text into animated strips.

Adapter input handling keeps the held point inside the paper, interpolates back
to its resting corner at endpoints, keeps fractional folds 0.01px inside the
top/bottom edge to avoid coincident lines, and nudges an exact zero x by
0.000001px to avoid the upstream line/circle intersection's division by zero. The original
calculation source is not patched. Original source and target snapshots remain
fixed until navigation commits or the gesture is cancelled, including when a
held gesture crosses an endpoint repeatedly.

The complete license is embedded in the generated module and shipped separately
in Web builds under `third_party/licenses/st-page-flip/LICENSE`.
