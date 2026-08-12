# Albatross context chat research — 2026-08-11

## Product question

How should a person correct an Albatross whose plan is behind reality without turning the plan/brief itself into a second, inferior chat surface?

## Mobbin references

- [Google Gemini — research and source attachments](https://mobbin.com/screens/057d8ba8-d787-4612-b7ce-ea3595a984ed): research mode and Sources/Files live at the composer boundary.
- [Langdock — document context chip](https://mobbin.com/screens/b66870ae-8d47-493d-b1b6-e6c01173ad96): attached context remains visible inside the composer.
- [Sana AI — source chip](https://mobbin.com/screens/b432987b-57ff-4acd-84e8-e65bef26d3c6): context is compact, persistent conversation chrome rather than message prose.
- [Claude — tools and connectors](https://mobbin.com/screens/be54eee2-7dce-401c-87f7-05decb33155c): files, project context, connectors, research, and web are one coherent chat entry point.
- [X — inline search activity](https://mobbin.com/screens/14325480-89b3-4952-bb9e-261b1da9b528): tool activity and source chips appear in the transcript at the point of work.
- [Gorgias — summarization activity](https://mobbin.com/screens/1945ca45-520a-4d75-87aa-ea1934232f33): quiet inline activity preserves conversation flow.
- [Claude iOS — attachment in composer](https://mobbin.com/screens/82c0ad15-8ea6-4201-9f28-45f1d77d327d), [DeepSeek iOS — file chip](https://mobbin.com/screens/d2b51260-b91b-40bd-830d-d6610ab48c29), and [ChatGPT iOS — context chip](https://mobbin.com/screens/1e0d754c-569d-4767-89b7-36bf956dc8b7): mobile context is shown adjacent to the input, not as a separate screen.
- [Langdock “Starting a chat” flow](https://mobbin.com/flows/5404b4c7-aa3a-4589-8b34-7256f2fd14f8): attachment persists while tools remain available and output can open alongside chat.
- [Manus “Creating a task” flow](https://mobbin.com/flows/153b7f2d-db6c-4ee0-a703-e322d3e453dc): progressive tool steps end in a compact completion artifact.
- [ChatGPT file upload](https://mobbin.com/flows/4a2cf78a-9dfc-43a7-8943-f79c6b9e663f), [Claude web upload](https://mobbin.com/flows/c3c3fe5e-482b-4c51-8b9d-a055b24f6d53), and [Claude iOS file input](https://mobbin.com/flows/000b65e0-53df-41b1-87f3-863a6ade9165): the attachment is part of the next conversational turn and remains legible before send.

## Browser research

- [Claude Projects](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects): project knowledge provides reusable context to chats, while chats stay the interaction surface.
- [CodeBolt context and @mentions](https://docs.codebolt.ai/docs/using-codebolt/chat/context-and-at-mentions): explicit attached context gives the model a bounded working set and makes that selection visible to the user.
- [ChatGPT Projects](https://help.openai.com/en/articles/10169521-projects-in-chatgpt): searched as a comparable project-context model; the help page was unavailable to the Browserbase fetch during research, so no implementation claim relies on its contents.

## Frozen interaction decisions

1. The existing full chat is the only conversational surface. A plan document never renders a chat, prompt field, or question gate.
2. Work is attached as structured `{kind, id}` data. The server resolves ownership and current state; clients cannot inject a counterfeit plan into the system prompt.
3. The attachment stays visible in composer chrome on web and iOS. It behaves like a file/project context chip.
4. Research activity remains inline in the transcript. A successful progress write and replan produce compact result cards.
5. A user progress statement is durable, confirmed evidence even when connected-source corroboration is missing. Mail, calendar, tasks, Granola, GitHub, files, and web evidence retain separate provenance and limitations.
6. Replanning versions the plan on the same Work item, removes completed/obsolete steps, and returns the next concrete step. It never creates replacement Work.
7. The creation/replanning model receives read-only research tools. It checks actual connections and uses relevant sources, with Granola first for meeting or spoken-decision evidence and official web sources for current rules/forms.
