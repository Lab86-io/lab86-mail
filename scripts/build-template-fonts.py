"""Build the TrueType fonts that the Word templates embed.

The source files are the OFL fonts in public/fonts (see public/fonts/LICENSES.md).
Output: lib/documents/templates/fonts/*.ttf, Latin subsets with the layout features
that invoices use (kerning, ligatures, tabular figures).

Fraunces is a variable font. The templates use one static cut, "Fraunces Display":
the variable font instanced at optical size 72 and weight 400.

Run: uv run --with fonttools --with brotli python scripts/build-template-fonts.py
"""

import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "public", "fonts")
OUT = os.path.join(ROOT, "lib", "documents", "templates", "fonts")

# Basic Latin, Latin-1, Latin Extended-A, common punctuation, currency signs, arrows, math.
UNICODES = (
    list(range(0x20, 0x7F))
    + list(range(0xA0, 0x180))
    + [0x192, 0x2C6, 0x2C7, 0x2D8, 0x2D9, 0x2DA, 0x2DB, 0x2DC, 0x2DD]
    + list(range(0x2010, 0x2027))
    + [0x2030, 0x2032, 0x2033, 0x2039, 0x203A, 0x2044]
    + list(range(0x20A0, 0x20C1))
    + [0x2116, 0x2122, 0x2190, 0x2191, 0x2192, 0x2193, 0x2212, 0x2248, 0x2260, 0x2264, 0x2265]
)


def subset_font(font: TTFont) -> TTFont:
    options = subset.Options()
    options.layout_features = ["kern", "liga", "calt", "tnum", "lnum", "case", "ccmp", "mark", "mkmk"]
    options.glyph_names = False
    options.name_IDs = ["*"]
    options.notdef_outline = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=UNICODES)
    subsetter.subset(font)
    return font


def rename(font: TTFont, family: str, style: str) -> None:
    for record in font["name"].names:
        if record.nameID in (1, 16):
            record.string = family
        elif record.nameID in (2, 17):
            record.string = style
        elif record.nameID == 4:
            record.string = f"{family} {style}"
        elif record.nameID == 6:
            record.string = f"{family.replace(' ', '')}-{style}"


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    for weight in ("Regular", "Bold"):
        font = TTFont(os.path.join(SOURCE, f"Geist-{weight}.woff2"))
        font.flavor = None
        subset_font(font).save(os.path.join(OUT, f"Geist-{weight}.ttf"))
    variable = TTFont(os.path.join(SOURCE, "Fraunces-Variable.woff2"))
    variable.flavor = None
    display = instancer.instantiateVariableFont(variable, {"opsz": 72, "wght": 400}, updateFontNames=False)
    rename(display, "Fraunces Display", "Regular")
    display["OS/2"].usWeightClass = 400
    subset_font(display).save(os.path.join(OUT, "FrauncesDisplay-Regular.ttf"))
    for name in sorted(os.listdir(OUT)):
        if name.endswith(".ttf"):
            print(name, os.path.getsize(os.path.join(OUT, name)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
