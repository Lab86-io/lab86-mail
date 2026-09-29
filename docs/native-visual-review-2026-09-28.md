# Native visual review, 2026-09-28

This document gives the UI defects that the first native screenshot tour shows. It does not correct them. The owner selects the defects to correct.

## Source

- Gallery: the `native-tour` artifact of Native acceptance run 36474407812 (pull request #300, commit `ff6cc017`). Open `index.html` in the artifact.
- The tour makes each image from fixture data through a stub backend. It sends no network requests. The fixture data is in `apps/ios/Lab86MailTests/Tour/NativeTourFixtures.json`.
- iOS and iPadOS: 19 screens with 7 variants each, and 5 full-page iPhone images. The variants are iPhone (light, dark, AX3 text) and iPad (portrait and landscape, light and dark).
- macOS: 11 screens at 1440 × 900 points, light and dark.
- The PNG names below are the file names in the artifact, in `images/ios/` or `images/macos/`.

## How to read this list

Each row gives the screen, the size, the appearance, the defect, and the PNG file. "AX3" is the accessibility extra large text size. The iPhone window is 402 × 874 points. The iPad window is 820 × 1180 points (portrait) or 1180 × 820 points (landscape).

The section "Limits of the tour" gives the items that the images cannot show correctly. Those items are not defects.

## Top ten

1. **Compose at AX3 (iPhone).** The bottom tool strip becomes a large circle. "Attach" and "Send now" wrap one letter on each line. See D1.
2. **Month view weekday header (iPhone).** The header row shows only "M", a small mark, and "F" or "S". The other weekday letters do not show. See D10.
3. **Brief "Today" lane (iPhone, default text).** The time column is too narrow. "11:00 AM" wraps as "11:0", "0", "AM". See D18.
4. **Week view titles (iPhone).** Event titles in the seven narrow columns break in the middle of words ("Boa / rd / d…"). Short events show only "C…". See D11.
5. **Day view at AX3 (iPhone).** The week strip shows "…" in place of the dates. The hour labels cut to "2…", and the event titles cut at the bottom of their blocks. See D2.
6. **Initials avatars at AX3.** The avatar circles show "…" in place of the initials in the mail list, the thread, and the sidebar. See D3.
7. **Today masthead at AX3 (iPhone).** The edition title cuts to "The Mond…", and the dateline overlaps the title. See D4.
8. **The same mail two times on Today.** "Mail that matters" and the "Answer" lane show the same three messages. See D19.
9. **Destructive buttons on the Mac.** In Settings, "Sign out" and "Delete account and data" use the green accent. On iOS they are red. See D27.
10. **Mac thread pane.** The pane does not show the thread subject. The first line is directly below the toolbar, with no space. See D28.

## Defects

### Large text (AX3)

| ID | Screen | Size | Appearance | Defect | PNG |
| --- | --- | --- | --- | --- | --- |
| D1 | Compose, new and reply | iPhone, AX3 | Light | The bottom tool strip becomes a circle that fills the lower half of the sheet. "Attach" and "Send now" wrap one letter on each line. | `ios-compose-new-iphone-ax3.png`, `ios-compose-reply-iphone-ax3.png` |
| D2 | Calendar, day | iPhone, AX3 | Light | The week strip shows "…" for the dates 27 to 30 and in the selected day circle. The hour labels cut to "2…" and "3…". The event titles cut at the bottom of their blocks. | `ios-calendar-day-iphone-ax3.png` |
| D3 | Mail list, thread, sidebar | iPhone, AX3 | Light | The initials avatars show "…" in place of the initials. In the mail list the sender names cut to about eight characters ("Sarah C…", "Priya Pa…"). | `ios-mail-list-iphone-ax3.png`, `ios-mail-thread-iphone-ax3.png`, `ios-shell-sidebar-iphone-ax3.png` |
| D4 | Today | iPhone, AX3 | Light | The masthead title cuts to "The Mond…". The dateline overlaps the first line of the title. The sources line fills the rest of the first screen and breaks the email addresses with hyphens. | `ios-today-brief-iphone-ax3.png` |
| D5 | Albatrosses (Work list) | iPhone, AX3 | Light | The section hint wraps in a narrow column next to the heading. The row details break words with hyphens ("ques-tion", "wait-ing", "Tea m", "off-site"). | `ios-work-iphone-ax3.png` |
| D6 | Sidebar | iPhone, AX3 | Light | The row icons touch their labels, with no space between them. The area rows cut ("1 needs you ·…"). The Settings footer cuts the second area row. | `ios-shell-sidebar-iphone-ax3.png` |
| D7 | Calendar, week | iPhone, AX3 | Light | The weekday letters become larger, but the event text and the all-day chips stay small. The two text sizes do not agree. | `ios-calendar-week-iphone-ax3.png` |
| D8 | Chat | iPhone, AX3 | Light | The composer placeholder cuts to "Ask or h…". | `ios-chat-iphone-ax3.png` |
| D9 | Files | iPhone, AX3 | Light | The row details cut ("Document · 2 hou…"). The floating search field covers the details of the first upload row. | `ios-files-iphone-ax3.png` |

### Layout on iPhone

| ID | Screen | Size | Appearance | Defect | PNG |
| --- | --- | --- | --- | --- | --- |
| D10 | Calendar, month | iPhone | Light and dark | The weekday header row shows only "M", a small mark, and "F" (light) or "S" (dark). The other letters do not show. | `ios-calendar-month-iphone-light.png`, `ios-calendar-month-iphone-dark.png` |
| D11 | Calendar, week | iPhone | Light and dark | The event titles break in the middle of words ("Boa / rd / d…"). Short events show only "C…". The all-day chips cut to "Draft th…" and "Offsite…". | `ios-calendar-week-iphone-light.png`, `ios-calendar-week-iphone-dark.png` |
| D12 | Calendar, day and week | iPhone, iPad, Mac | Light and dark | The time grid opens near the current hour. The event at the top edge shows as a thin block with no title ("Lunch with Priya" on iPhone, "Quarterly review" on the Mac). | `ios-calendar-day-iphone-light.png`, `ios-calendar-week-ipad-landscape-light.png`, `macos-mac-calendar-week-light.png` |
| D13 | Albatrosses (Work list) | iPhone | Light and dark | In each row the area name ("· Team offsite") is centered on the two-line detail text. It does not align with a line of that text, so the dot is between the lines. | `ios-work-iphone-light.png`, `ios-work-iphone-dark.png` |
| D14 | Sidebar | iPhone, iPad landscape | Light and dark | The Settings footer cuts the last row. On iPhone only the top half of "New Area" shows. On iPad landscape the "Home" area row is cut, and no sign shows that the list continues. | `ios-shell-sidebar-iphone-light.png`, `ios-shell-sidebar-iphone-dark.png`, `ios-mail-list-ipad-landscape-light.png` |
| D15 | Today | iPhone | Light and dark | An empty band of about 120 points is between the top of the screen and the masthead art. Only the toolbar buttons are in it. | `ios-today-brief-iphone-light.png`, `ios-today-brief-iphone-dark.png` |
| D16 | Today, "Your day" | iPhone, iPad | Light and dark | The hour labels use a smaller monospaced style ("10am", "1pm"). The event rows use a different style ("9:30 AM – 9:45 AM"). | `ios-today-brief-iphone-light.png` |
| D17 | Calendar, month | iPhone, iPad | Light and dark | The title shows only the year ("2026"). Day and week show "September 2026". On iOS the first month on the screen has no heading, but "October" has one. The Mac shows the two headings. | `ios-calendar-month-iphone-light.png`, `ios-calendar-month-ipad-portrait-light.png` |
| D18 | Today, brief "Today" lane | iPhone | Light | The time column is too narrow for "11:00". The time wraps as "11:0", "0", "AM". "3:00 PM" fits. | `ios-today-brief-iphone-light-full.png` |
| D19 | Today, full page | iPhone | Light | "Mail that matters" shows Sarah Chen, Priya Patel, and Sam Lee. The "Answer" lane of the brief then shows the same three messages again. | `ios-today-brief-iphone-light-full.png` |

### Layout on iPad

| ID | Screen | Size | Appearance | Defect | PNG |
| --- | --- | --- | --- | --- | --- |
| D20 | Today | iPad portrait and landscape | Light and dark | The toolbar shows two ellipsis buttons next to each other (Brief options and a system overflow button). The notification bell that iPhone shows is not in the bar. | `ios-today-brief-ipad-portrait-light.png`, `ios-today-brief-ipad-landscape-light.png` |
| D21 | Calendar, day | iPad portrait and landscape | Light and dark | Each event block shows a short bar in its lower right corner. The bars are the same on all blocks and add visual noise. | `ios-calendar-day-ipad-portrait-light.png` |
| D22 | Tasks board | iPad landscape | Light and dark | The right edge of the screen cuts the third column ("Done"). Its card titles cut at the edge ("Print the DS-82 fo…"). | `ios-tasks-ipad-landscape-light.png` |
| D23 | Chat and thread | iPad landscape | Light and dark | The text goes across the full width of the detail column, about 110 characters on each line. The text has no maximum width. | `ios-chat-ipad-landscape-light.png`, `ios-mail-thread-ipad-landscape-light.png` |
| D24 | Today | iPad landscape | Light and dark | The floating "+" button covers the right end of the "Your day" rows. | `ios-today-brief-ipad-landscape-light.png` |

### Dark mode and contrast

| ID | Screen | Size | Appearance | Defect | PNG |
| --- | --- | --- | --- | --- | --- |
| D25 | Work detail (missed move) | iPhone, iPad | Light and dark | In dark mode the missed-move block ("Mail the DS-82 form", "Find another time") has a card surface. In light mode it has no surface and no edge. | `ios-work-detail-iphone-light.png`, `ios-work-detail-iphone-dark.png`, `ios-work-detail-ipad-portrait-light.png` |
| D26 | Reply sheet | iPad landscape | Dark | The sheet and the dimmed page behind it have almost the same color. The edge of the sheet is difficult to see. | `ios-compose-reply-ipad-landscape-dark.png` |

### Mac

| ID | Screen | Size | Appearance | Defect | PNG |
| --- | --- | --- | --- | --- | --- |
| D27 | Settings sheet | Mac | Light and dark | "Sign out" and "Delete account and data" show as green accent buttons. On iOS the same rows are red. The destructive actions do not look destructive. | `macos-mac-settings-light.png`, `macos-mac-settings-dark.png` |
| D28 | Mail, thread pane | Mac | Light and dark | The pane does not show the thread subject. The first line (message count, sender, and date) is directly below the toolbar, with no space. | `macos-mac-mail-light.png`, `macos-mac-mail-dark.png` |
| D29 | Reply sheet | Mac | Light and dark | All the body text is selected, with an accent highlight, when the sheet opens. The subject has a text field border and the body has a heavy focus ring. iOS shows the two fields with no borders. | `macos-mac-compose-light.png`, `macos-mac-compose-dark.png` |
| D30 | Albatrosses, "Later" shelf | Mac | Light and dark | The card shows "Someday" two times (a green label and an italic line). The ruler to the left of the card shows broken tick marks. | `macos-mac-work-light.png`, `macos-mac-work-dark.png` |

## Limits of the tour

These items are not defects. They come from the method that the tour uses to make the images.

- **Mac vibrancy.** The Mac images use `cacheDisplay`, which draws the views but not the vibrancy of the window server. In dark mode the sidebar labels show dark on dark (`macos-mac-today-dark.png`). A Mac shows them light. Text field placeholders on the Mac can also look like body text.
- **Mac toolbar button in light mode.** In light mode the sidebar toggle next to the "+" menu shows as an empty circle (`macos-mac-today-light.png`). In dark mode the symbol shows. This is probably the same capture limit. Examine it on a Mac.
- **Mac Files filter in dark mode.** The selected "All" chip is almost invisible in `macos-mac-files-dark.png`. It can be a material that `cacheDisplay` does not draw. Examine it on a Mac.
- **iPad windows on an iPhone simulator.** The iPad images are iPad-sized windows with iPad size classes and safe areas on the iPhone simulator. The device idiom stays iPhone. A view that reads the idiom can show differently on an iPad.
- **Keyboard and status bar.** The tour does not show the keyboard or the status bar.
- **Full-page images.** A full-page image makes the window as tall as the page, so floating controls are at its foot. The Today full page is too tall for `drawHierarchy`, so it uses `layer.render`. That method does not show blur and glass, so the toolbar is empty in that image.
- **Fixture data.** The data is synthetic. Some requests have no fixture and get an empty answer (for example sender photos, signatures, and saved replies). The gallery lists them for each image.
