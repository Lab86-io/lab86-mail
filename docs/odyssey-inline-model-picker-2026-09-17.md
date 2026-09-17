# Permanent Odyssey UI model picker

The Normal and Fast model controls in AI Settings now embed Odyssey UI's actual model-selector registry component as permanent panels. The source was retrieved from [the public registry](https://www.odysseyui.com/r/components-ai-model-selector.json), with attribution in `components/odysseyui/model-selector.tsx`.

The registry's context, provider sidebar, animated provider indicator, model rows, capability badges, and session stars form the component. The trigger and modal wrapper are removed. Selection is controlled by the settings form and never closes or hides the panel. The form still saves both model choices with its existing Save AI settings action.

Local adaptations:

- Live, vision-only catalog and existing availability, vendor-key, fast-tier, and older-model rules replace the demo models. GLM-5.3 Flash remains supported; deployment defaults are unchanged.
- The two panels span the form width so the provider rail and model descriptions fit. Lists and provider rails scroll independently inside a bounded panel.
- Model selection and star controls are separate native buttons; favoriting never selects a model. Stars last for the mounted session, as in Odyssey's source, and can be filtered.
- Controlled values, empty/unavailable saved models, provider switches, disabled states, per-instance IDs, accessible names, visible focus, arrow/Home/End navigation and reduced motion are supported. Opening Settings does not steal keyboard focus.
- Existing Albatross tokens, vendor glyphs, type scale and real context/token prices replace the registry's demo styling/cost multipliers. No dependency was added. Vision, reasoning and tool capabilities are labeled separately.

## Research

Reviewed the surrounding AI Settings form and both model slots before changing their layout. Opened [Odyssey's model-selector demo](https://www.odysseyui.com/docs/components/ai/model-selector) in Browserbase and inspected its open picker: search header, icon provider rail, descriptive rows, capability badges, star buttons and selected-model footer. Read its complete registry source and retained the core component structure while extracting the body into an inline panel.

Applied the Mobbin research skill. Mobbin tools are not connected in this session, so no fresh Mobbin search results are claimed. Existing project research references [Relevance AI](https://mobbin.com/screens/94a61b0c-d8b5-4254-8147-426391e60452), [Langdock](https://mobbin.com/screens/4513a553-1cfa-4f66-949e-a7047ba11af3), and [Vercel](https://mobbin.com/screens/43b56b19-c2f2-4adf-acdc-445c98112c87). Odyssey's browser demo and registry source are the implementation reference for this change.

## Validation

- Nine new component tests cover immediate permanent rendering, controlled selection without closing/search reset, provider/search filters, independent favorites, independent Normal/Fast state, disabled controls, catalog changes, tier/older-model expansion and unavailable/empty choices.
- All 4,106 tests pass; one optional test is skipped. Typecheck and lint pass (pre-existing lint notices remain).
- Chromium checked the actual AiSection with a fixture settings API at 1200px and 390px: both panels appear without a click, provider and favorites filters work, search excludes text-only models, Arrow/Enter/Home/End navigation works, and saving a Normal choice preserves the Fast GLM choice. No horizontal page overflow or browser exceptions. Inspected screenshots at both sizes.
