# Fonts

The design system uses two families, from Figma's Foundations page:

- **Plus Jakarta Sans** — Medium, SemiBold, Bold, ExtraBold — display and headings
- **Inter** — Regular, Medium, SemiBold, Bold — body, labels, numerics

Download both from fonts.google.com (the static TTFs, not the variable file),
and place them here with these exact names:

    plus_jakarta_sans_medium.ttf
    plus_jakarta_sans_semibold.ttf
    plus_jakarta_sans_bold.ttf
    plus_jakarta_sans_extrabold.ttf
    inter_regular.ttf
    inter_medium.ttf
    inter_semibold.ttf
    inter_bold.ttf

Then in `ui/theme/Type.kt`, flip `USE_BUNDLED_FONTS` to `true`. Until then the
app renders every text style with the system font at the correct size, weight,
line height and letter spacing — so layouts are right and only the typeface
differs.

Not fetched at runtime via Google Fonts on purpose: that path needs Play
Services and a certificate array that silently falls back to the system font
if a single character is wrong.
