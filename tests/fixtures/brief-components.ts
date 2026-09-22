import type { BriefComponentName } from '../../lib/brief/component-catalog';

const media = 'https://example.com/source.jpg';
const author = { name: 'Maya', handle: 'maya', avatarUrl: media };
/** Synthetic source fixtures, never customer information. */
export const briefComponentFixtures: Record<BriefComponentName, Record<string, unknown>> = {
  'approval-card': {
    title: 'Use the shorter review?',
    description: 'Record your preference before preparing an invitation.',
  },
  audio: { assetId: 'audio', src: 'https://example.com/recording.mp3', title: 'Meeting recording' },
  chart: {
    type: 'bar',
    title: 'Quoted costs',
    xKey: 'vendor',
    series: [{ key: 'cost', label: 'USD' }],
    data: [
      { vendor: 'North', cost: 120 },
      { vendor: 'South', cost: 180 },
    ],
  },
  citation: { title: 'Support proposal', href: 'https://example.com/proposal' },
  'code-block': { language: 'typescript', code: 'const review = true;' },
  'code-diff': { filename: 'review.ts', oldCode: 'const days = 2;', newCode: 'const days = 3;' },
  'data-table': {
    columns: [
      { key: 'vendor', label: 'Vendor', sortable: true },
      { key: 'cost', label: 'Quote', sortable: true, format: { kind: 'currency', currency: 'USD' } },
    ],
    data: [
      { vendor: 'North', cost: 120 },
      { vendor: 'South', cost: 180 },
    ],
  },
  'geo-map': { title: 'Review venue', markers: [{ id: 'venue', lat: 40.75, lng: -73.98, label: 'Office' }] },
  image: { assetId: 'image', src: media, alt: 'Source reference photograph' },
  'image-gallery': {
    images: [
      { id: 'one', src: media, alt: 'First reference', width: 640, height: 480 },
      { id: 'two', src: media, alt: 'Second reference', width: 640, height: 480 },
    ],
  },
  'instagram-post': { author, text: 'Published studio update' },
  'item-carousel': {
    title: 'Compare the proposals',
    items: [
      { id: 'north', name: 'North', subtitle: '$120' },
      { id: 'south', name: 'South', subtitle: '$180' },
    ],
  },
  'link-preview': { title: 'The proposal', href: 'https://example.com/proposal' },
  'linkedin-post': { author, text: 'Published team update' },
  'message-draft': {
    channel: 'email',
    to: ['maya@example.com'],
    subject: 'Re: Support review',
    body: 'Maya, please send the revised staffing plan before our review.',
  },
  'option-list': {
    options: [
      { id: 'review', label: 'Review both proposals' },
      { id: 'clarify', label: 'Ask for the missing costs' },
    ],
    selectionMode: 'single',
  },
  'order-summary': {
    title: 'Quoted equipment',
    items: [{ id: 'one', name: 'Monitor', unitPrice: 120, quantity: 1 }],
    pricing: { subtotal: 120, total: 120, currency: 'USD' },
  },
  'parameter-slider': {
    sliders: [
      { id: 'minutes', label: 'Review time', min: 15, max: 60, step: 15, value: 30, unit: 'minutes' },
    ],
  },
  plan: {
    title: 'Prepare the review',
    todos: [{ id: 'read', label: 'Read the proposals', status: 'pending' }],
  },
  'preferences-panel': {
    title: 'Prepare my comparison',
    sections: [
      {
        items: [
          { id: 'costs', type: 'switch', label: 'Include costs', defaultChecked: true },
          {
            id: 'depth',
            type: 'toggle',
            label: 'Depth',
            options: [
              { value: 'short', label: 'Short' },
              { value: 'full', label: 'Full' },
            ],
            defaultValue: 'full',
          },
        ],
      },
    ],
  },
  'progress-tracker': {
    steps: [
      { id: 'quotes', label: 'Quotes received', status: 'completed' },
      { id: 'review', label: 'Review due', status: 'pending' },
    ],
  },
  'question-flow': {
    steps: [
      {
        id: 'priority',
        title: 'What matters most?',
        options: [
          { id: 'cost', label: 'Cost' },
          { id: 'speed', label: 'Delivery time' },
        ],
      },
      {
        id: 'detail',
        title: 'Which details should we include?',
        selectionMode: 'multi',
        options: [
          { id: 'support', label: 'Support' },
          { id: 'setup', label: 'Setup' },
        ],
      },
    ],
  },
  'stats-display': {
    title: 'Two proposals',
    stats: [{ key: 'cost', label: 'Lower quote', value: 120, format: { kind: 'currency', currency: 'USD' } }],
  },
  terminal: { command: 'bun test', stdout: '2 tests passed', exitCode: 0 },
  video: { assetId: 'video', src: 'https://example.com/recording.mp4', title: 'Review recording' },
  'weather-widget': {
    version: '3.1',
    location: { name: 'New York' },
    units: { temperature: 'fahrenheit' },
    current: { conditionCode: 'clear', temperature: 70, tempMin: 60, tempMax: 75 },
    forecast: [],
    time: { timeBucket: 4 },
  },
  'x-post': { author, text: 'Published product update' },
  'editorial-text': {
    title: 'The support decision needs one more answer',
    role: 'lede',
    text: 'The launch budget is ready for review, but support still needs an owner. Maya’s request connects the cost decision with the staffing plan: agreeing the budget alone would leave the handoff unresolved.\n\nRead the two proposals together before the review. The lower quote saves $60; the available figures do not yet establish whether it covers the same support hours. Ask for that scope difference before treating price as the deciding factor.\n\nThe useful next move is to get the revised staffing plan into the same conversation, then confirm who will own support after launch. The choices below let you record how you want the comparison prepared.',
  },
};
