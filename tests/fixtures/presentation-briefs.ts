import {
  type ArtworkCandidate,
  type ImportedArtwork,
  searchArtPool,
  stylesForDirection,
} from '../../lib/documents/deck-art';
import type { CompositionAsset } from '../../lib/documents/presentation-compositions';
import { type PresentationBriefV2, presentationBriefV2Schema } from '../../lib/documents/presentation-design';

/** A pool candidate as an imported asset; the preview address stands in for owned storage. */
export function importedArtwork(candidate: ArtworkCandidate, index: number): ImportedArtwork {
  return {
    assetId: `art-${index + 1}`,
    src: candidate.previewUrl,
    width: 1600,
    height: 1000,
    aspect: 1.6,
    mime: 'image/jpeg',
    size: 100_000,
    attribution: {
      title: candidate.title,
      artist: candidate.artist,
      date: candidate.date,
      credit: candidate.credit,
      source: candidate.source,
      sourceUrl: candidate.sourceUrl,
      license: candidate.license,
      ...(candidate.style ? { style: candidate.style } : {}),
    },
    palette: candidate.palette ?? [],
    accentHue: candidate.accentHue ?? 0,
  };
}

/** Pool pieces as imported assets, deterministic for the fixture seed. */
export function poolArtworks(count: number, text = 'landscape river harbor'): ImportedArtwork[] {
  return searchArtPool({ text, styles: stylesForDirection('editorial'), count, seed: 'fixture' }).map(
    (candidate, index) => importedArtwork(candidate, index),
  );
}

/** Owned art the fixtures may show: the app's own fallback images. */
export const VALLEY: CompositionAsset = {
  assetId: 'dev-art-3',
  src: '/art/fallback-3.jpg',
  aspect: 599 / 395,
  source: 'Albatross art fallback 3',
};
export const HILLS: CompositionAsset = {
  assetId: 'dev-art-1',
  src: '/art/fallback-1.jpg',
  aspect: 600 / 449,
  source: 'Albatross art fallback 1',
};

/** The Lakeshore content of the reference deck as a version 2 brief. */
export function lakeshoreBrief(palette: 'editorial' | 'signal' = 'editorial'): PresentationBriefV2 {
  return presentationBriefV2Schema.parse({
    title: 'The Lakeshore Trail',
    summary: 'A community update on the twelve-mile path.',
    audience: 'the Parks Board',
    purpose: 'Report progress and ask for three decisions.',
    tone: 'warm',
    palette,
    fontPair: palette === 'editorial' ? 'serif' : 'sans',
    imagery: 'Painted landscapes of the valley.',
    slides: [
      {
        role: 'cover',
        title: 'The Lakeshore Trail',
        kicker: 'Community update · Autumn 2026',
        body: 'A community update on the twelve-mile path from Fairhaven to Millbrook.',
        items: [],
        notes: '',
        image: { alt: 'Painted valley with a river and low hills', subject: 'valley', assetId: 'dev-art-3' },
        visualRole: 'Sets the tone with the valley on the right half.',
      },
      {
        role: 'statement',
        title: 'Twelve miles, four towns, one continuous path by 2028.',
        kicker: '',
        body: 'Seven of the twelve miles are open today. The rest follows the old rail bed, which the county deeded to the trust in June.',
        items: [],
        notes: 'Deed recorded June 2026.',
        visualRole: 'One sentence on an ink ground.',
      },
      {
        role: 'image-left',
        title: 'Phase two follows the old rail bed',
        kicker: 'Phase two',
        body: 'The rail bed gives us a grade under three percent for the whole segment, so the path stays accessible without switchbacks. Grading started in May and the crew reached the Millbrook trestle in August.',
        items: [
          { label: '4.6 mi', detail: 'graded this year' },
          { label: '3', detail: 'bridges rebuilt' },
          { label: 'May 2027', detail: 'segment opens' },
        ],
        notes: '',
        image: {
          alt: 'Pastel landscape with green hills and a winding road',
          subject: 'hills',
          assetId: 'dev-art-1',
        },
        visualRole: 'Image left, three facts on a hairline.',
      },
      {
        role: 'metrics',
        title: 'Most of what we raised is already at work on the ground.',
        kicker: 'Where the money went',
        body: '',
        items: [
          { label: '$2.4M', detail: 'raised since the 2024 campaign' },
          { label: '68%', detail: 'of the budget committed to contracts' },
          { label: '1,900', detail: 'volunteer hours logged' },
        ],
        notes: '',
        chart: {
          type: 'column',
          categories: ['Q1', 'Q2', 'Q3', 'Q4 plan'],
          series: [{ name: 'Spend', values: [180, 240, 310, 420] }],
          unit: 'k',
          source: "Spend by quarter, thousands. Source: treasurer's report, September 2026. Fixture data.",
        },
        visualRole: 'Three numbers stacked beside a column chart.',
      },
      {
        role: 'process',
        title: 'Four steps between now and the ribbon.',
        kicker: 'How we get to opening day',
        body: '',
        items: [
          {
            label: 'Survey',
            meta: 'October 2026',
            detail: 'Wetland and drainage survey along the last five miles.',
          },
          {
            label: 'Permits',
            meta: 'January 2027',
            detail: 'County and state review; hearings in Fairhaven and Millbrook.',
          },
          {
            label: 'Grading',
            meta: 'March 2027',
            detail: 'Crews return once the ground thaws; trestle decking first.',
          },
          {
            label: 'Opening',
            meta: 'May 2027',
            detail: 'Ribbon at the Millbrook trailhead with all four towns.',
          },
        ],
        notes: '',
        visualRole: 'Four steps on a hairline with circles.',
      },
      {
        role: 'close',
        title: 'What we ask of the board',
        kicker: '',
        body: 'Questions: trail@lakeshore.org · Next review in January',
        items: [
          {
            label: 'Approve the phase two budget',
            detail: 'Two hundred forty thousand for grading and the trestle, drawn from the reserve.',
          },
          {
            label: 'Name a liaison for Millbrook',
            detail: 'One board member to attend the January permit hearing with staff.',
          },
          {
            label: 'Set the opening date',
            detail: 'A firm May date lets the four towns plan the ribbon together.',
          },
        ],
        notes: '',
        visualRole: 'Three numbered asks and a closing hairline.',
      },
    ],
  });
}

/** A second topic with no images: a product launch retro with a chart and a process. */
export function retroBrief(): PresentationBriefV2 {
  return presentationBriefV2Schema.parse({
    title: 'Launch retro: Fieldnotes 2.0',
    summary: 'What the launch did, what it cost, and what changes next time.',
    audience: 'the product team',
    purpose: 'Agree on three changes before the next launch.',
    tone: 'plain',
    palette: 'editorial',
    fontPair: 'serif',
    imagery: 'None supplied; typographic slides.',
    slides: [
      {
        role: 'cover',
        title: 'Fieldnotes 2.0 launch retro',
        kicker: 'Product review · September 2026',
        body: 'Six weeks after release: what happened and what we change.',
        items: [],
        notes: 'Dates in Pacific time.',
        visualRole: 'Cover without art, ink panel on the right.',
      },
      {
        role: 'statement',
        title: 'The launch worked; the week after it did not.',
        kicker: 'In one line',
        body: 'Sign-ups beat the plan. Support load doubled and stayed there for nine days.',
        items: [],
        notes: 'Support numbers from the help desk export, 2026-08-01 to 2026-08-14.',
        visualRole: 'One sentence on ink.',
      },
      {
        role: 'chart',
        title: 'Sign-ups by week against the plan',
        kicker: 'Demand',
        body: 'Week one landed above plan and held. Week three dipped when the onboarding mail was paused.',
        items: [{ label: 'Plan', detail: 'From the launch brief, June 2026' }],
        notes: 'Source: analytics export, weekly cohorts.',
        chart: {
          type: 'line',
          categories: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'],
          series: [
            { name: 'Sign-ups', values: [1240, 1310, 980, 1150, 1220, 1275] },
            { name: 'Plan', values: [900, 950, 1000, 1050, 1100, 1150] },
          ],
          source: 'Analytics export, weekly cohorts. Fixture data.',
        },
        visualRole: 'Line chart on the right, one callout on the left.',
      },
      {
        role: 'process',
        title: 'How the launch ran',
        kicker: 'Timeline',
        body: '',
        items: [
          { label: 'Freeze', meta: 'July 14', detail: 'Feature freeze and the last localization pass.' },
          {
            label: 'Beta',
            meta: 'July 21',
            detail: 'Two hundred invited accounts; twelve blocking bugs found.',
          },
          { label: 'Release', meta: 'August 4', detail: 'Staged rollout over three days by region.' },
          { label: 'Review', meta: 'September 12', detail: 'This retro and the follow-up plan.' },
        ],
        notes: '',
        visualRole: 'Four steps on a hairline.',
      },
      {
        role: 'comparison',
        title: 'What we planned against what we got',
        kicker: '',
        body: '',
        items: [
          { label: 'Planned', detail: 'One support hire, a launch mail on day one, and a two-day rollout.' },
          {
            label: 'Actual',
            detail: 'No hire in time, the mail paused in week three, and a three-day rollout.',
          },
        ],
        notes: '',
        visualRole: 'Two panels, the second in accent.',
      },
      {
        role: 'quote',
        title: 'The product was ready. The team around it was not staffed for the first week.',
        kicker: 'From the support lead',
        body: 'Retro interview, September 10.',
        items: [],
        notes: '',
        visualRole: 'A quote with an upright accent rule.',
      },
      {
        role: 'list',
        title: 'What changes for the next launch',
        kicker: 'Decisions',
        body: 'Three changes with an owner each.',
        items: [
          { label: 'Staff support before release', detail: 'Hire closes four weeks before the date.' },
          { label: 'Never pause onboarding mail', detail: 'Edits ship as a new version, not a pause.' },
          { label: 'Rollout in two days', detail: 'Regions grouped by time zone.' },
        ],
        notes: '',
        visualRole: 'Numbered list with hairlines.',
      },
      {
        role: 'close',
        title: 'Three asks',
        kicker: '',
        body: 'Owners confirm by Friday.',
        items: [
          { label: 'Approve the support hire', detail: 'Budget from the Q4 reserve.' },
          { label: 'Adopt the mail rule', detail: 'Written into the launch checklist.' },
          { label: 'Set the next date', detail: 'Rollout plan due two weeks before.' },
        ],
        notes: '',
        visualRole: 'Three numbered asks.',
      },
    ],
  });
}

/** A harbor deck with no owned images: every artwork composition role and one metrics slide. */
export function harborBrief(): PresentationBriefV2 {
  return presentationBriefV2Schema.parse({
    title: 'Harbor Works',
    summary: 'The dredging plan for the outer harbor.',
    audience: 'the Harbor Commission',
    purpose: 'Agree on the dredging schedule.',
    tone: 'formal',
    palette: 'editorial',
    fontPair: 'serif',
    imagery: 'Harbor paintings, ships and water at dusk.',
    slides: [
      {
        role: 'cover',
        title: 'Harbor Works',
        kicker: 'Dredging plan · 2027',
        body: 'How the outer harbor reaches a nine-metre channel by the spring tide of 2028.',
        items: [],
        notes: 'Depths in metres below chart datum.',
        visualRole: 'Cover with a painting on the right.',
      },
      {
        role: 'statement',
        title: 'Nine metres of water, open all year, by spring 2028.',
        kicker: 'The aim',
        body: 'The channel is seven metres today and closes to deep hulls at low water.',
        items: [],
        notes: '',
        visualRole: 'Painting behind the statement.',
      },
      {
        role: 'image-right',
        title: 'The channel silts from the north bank',
        kicker: 'Where the sand comes from',
        body: 'Winter storms move sand off the north spit into the channel. The survey shows the bar grows most in January and February.',
        items: [
          { label: '0.4 m', detail: 'lost each winter' },
          { label: '2', detail: 'survey passes a year' },
        ],
        notes: 'Survey by the port authority, March 2026.',
        image: { alt: 'Sand bar at the harbor mouth', subject: 'harbor' },
        visualRole: 'Painting right, facts on a hairline.',
      },
      {
        role: 'metrics',
        title: 'What the work costs',
        kicker: 'Budget',
        body: '',
        items: [
          { label: '3.2M', detail: 'dredging contract' },
          { label: '18', detail: 'weeks of work' },
        ],
        notes: 'Figures from the tender, fixture data.',
        visualRole: 'Numbers in a row.',
      },
      {
        role: 'quote',
        title: 'Every winter we lose depth we paid for the summer before.',
        kicker: 'From the harbor master',
        body: 'Commission hearing, June 2026.',
        items: [{ label: 'R. Lindqvist', detail: 'Harbor master since 2019' }],
        notes: '',
        visualRole: 'Quote beside a painting.',
      },
      {
        role: 'close',
        title: 'Three decisions',
        kicker: '',
        body: 'Questions: works@harbor.example',
        items: [
          { label: 'Approve the tender', detail: 'Contract signed before the autumn.' },
          { label: 'Fix the survey cadence', detail: 'Two passes a year, January and July.' },
          { label: 'Set the opening tide', detail: 'Spring tide, March 2028.' },
        ],
        notes: '',
        visualRole: 'Three asks under an art strip.',
      },
    ],
  });
}
