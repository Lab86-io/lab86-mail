# Picture frame assets

The five PNG files are photographs of real frames with transparent openings. The brief
applies them with CSS `border-image`. The registry with slice values is
`lib/brief/frames.ts`. The source photographs and their terms:

| File | Source | Terms |
| --- | --- | --- |
| `david-gilt.png` | [Frame of Jacques-Louis David, Mars Disarmed by Venus](https://commons.wikimedia.org/wiki/File:Jacques-louis_david,_marte_disarmato_da_venere,_1824,_picture_frame.png), photo by Sailko | CC BY 3.0 |
| `robert-gilt.png` | [Empty-frame.png](https://commons.wikimedia.org/wiki/File:Empty-frame.png), after Hubert Robert | Public domain |
| `rijks-french-gilt.png` | [19th-century French carved gilt frame, RP-L-137](https://commons.wikimedia.org/wiki/File:19e-eeuwse_Franse_tweezijdige_vergulde_en_gesneden_lijst,_RP-L-137.jpg), Rijksmuseum | CC0 |
| `rijks-walnut-gilt.png` | [Stained profile frame with gilt inner edge, SK-L-1856](https://commons.wikimedia.org/wiki/File:Bruine_gebeitste_profiellijst_met_vergulde_binnenrand_met_p%C3%A2te-ornamenten,_4_afzonderlijk_genummerde_delen._SK-L-1856.jpg), Rijksmuseum | CC0 |
| `rijks-glass-gilt.png` | [Frame with glass plate, RP-L-530](https://commons.wikimedia.org/wiki/File:Lijst_met_glasplaat,_RP-L-530.jpg), Rijksmuseum | CC0 |

The three Rijksmuseum photographs had a plain studio backdrop. The cutout uses
rembg (ISNet) for the shape, including the opening, then a local estimate of
the backdrop colour to decontaminate edge pixels and to drop dust specks. The
French frame stood on a pedestal, which was cropped away; its cream mat is part
of the asset. The two Commons files already had transparent openings; their
white fringes were removed. The script lives with the session notes as
`cutout.py` (rembg, numpy, scipy, Pillow).

The sixteen SVG mouldings are original Albatross designs, created with
`scripts/generate-brief-frames.ts`. They are interpretations of historical and
modern frame styles, not museum objects or reproductions of particular frames.

- Black Gothic: Cathedral, Quatrefoil, Thorn, Ebony, Tracery, Reliquary.
- Modern: Graphite, Ivory, Oak, Aluminum, Walnut.
- Art Deco: Metropolis, Palmette, Solstice, Emerald, Champagne.

`ink-grain.svg` is an original procedural texture for the masthead lettering.
It caps black flecks at 6% opacity; the ink contrast calculation includes that cap.
