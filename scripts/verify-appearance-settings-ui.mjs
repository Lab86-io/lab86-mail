/** Real inline Appearance controls, pre-existing local preferences, no account API. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const artifacts = await mkdtemp(join(tmpdir(), 'albatross-appearance-settings-ui-'));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  args: ['--no-sandbox'],
});
const preferences = {
  accentHue: 33,
  accentChroma: 0.09,
  accent2Hue: 170,
  accent2Chroma: 0.06,
  accent3Hue: 290,
  accent3Chroma: 0.11,
  bgHue: 41,
  surfaceTint: 0.25,
  depthSpread: 1.15,
  washOpacity: 0.2,
  bgWashOpacity: 0.35,
  grainOpacity: 0.08,
  grainScale: 160,
  appFont: 'news',
};
const readPreferences = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('lab86-mail-ui')).state);
const evidence = [];
try {
  for (const width of [390, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript((preferences) => {
      if (!localStorage.getItem('lab86-mail-ui'))
        localStorage.setItem(
          'lab86-mail-ui',
          JSON.stringify({ state: { ...preferences, query: 'from:alex', capacity: 'low' }, version: 5 }),
        );
    }, preferences);
    const page = await context.newPage();
    const errors = [];
    const apiRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
    });
    await page.goto('http://127.0.0.1:18844/?view=appearance');
    await page.getByRole('slider', { name: 'Palette wheel' }).waitFor();
    await page.waitForFunction(
      () => document.documentElement.style.getPropertyValue('--accent-hue') === '33',
    );
    assert.deepEqual(
      await readPreferences(page),
      { ...preferences, query: 'from:alex', capacity: 'low' },
      'Mounting inline Appearance does not reset, migrate, or rewrite existing choices',
    );
    const applied = await page.evaluate(() => {
      const style = document.documentElement.style;
      return {
        accent: style.getPropertyValue('--accent-hue'),
        grain: style.getPropertyValue('--grain-opacity'),
        grainSize: style.getPropertyValue('--grain-scale'),
        type: style.getPropertyValue('--font-display-choice'),
      };
    });
    assert.deepEqual(applied, {
      accent: '33',
      grain: '0.08',
      grainSize: '160px',
      type: 'var(--font-averia)',
    });
    assert.equal(
      await page.getByRole('button', { name: 'Theme', exact: true }).count(),
      0,
      'Settings renders controls inline, not another popover trigger',
    );
    for (const theme of ['Light', 'Dark']) {
      const mode = page.getByRole('button', { name: theme, exact: true });
      await mode.click();
      await page.waitForFunction(
        (dark) => document.documentElement.classList.contains('dark') === dark,
        theme === 'Dark',
      );
      assert.equal(
        await mode.getAttribute('aria-pressed'),
        'true',
        'Selected mode is exposed to assistive technology',
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
        `${width}/${theme}: no horizontal overflow`,
      );
      const textContrast = await page.evaluate(() => {
        const names = new Set([
          'Palette',
          'Accent',
          'Second accent',
          'Third accent',
          'Background',
          'Effects',
          'Display type',
        ]);
        const headings = [...document.querySelectorAll('div')].filter(
          (element) => element.children.length === 0 && names.has(element.textContent),
        );
        const targets = [...headings, ...document.querySelectorAll('label > span > span')];
        const pixel = (color) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d');
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        };
        const luminance = (rgb) => {
          const values = rgb.slice(0, 3).map((value) => {
            const unit = value / 255;
            return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
          });
          return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
        };
        return targets.map((element) => {
          const style = getComputedStyle(element);
          let background = element;
          while (background.parentElement && pixel(getComputedStyle(background).backgroundColor)[3] === 0)
            background = background.parentElement;
          const foreground = pixel(style.color);
          const backdrop = pixel(getComputedStyle(background).backgroundColor);
          const first = luminance(foreground);
          const second = luminance(backdrop);
          return {
            label: element.textContent,
            fontSize: parseFloat(style.fontSize),
            opaque: foreground[3] === 255 && backdrop[3] === 255,
            ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
          };
        });
      });
      assert(textContrast.length >= 20, 'Measure both meaningful headings and slider labels/readouts');
      for (const text of textContrast) {
        assert(text.opaque, 'Contrast is measured against the actual opaque working surface');
        assert(text.fontSize >= 12, `${text.label}: inline settings text is at least 12px`);
        assert(
          text.ratio >= 4.5,
          `${text.label}: ${theme} normal-text contrast is at least 4.5:1 (received ${text.ratio.toFixed(2)})`,
        );
      }
      evidence.push({ width, theme, textContrast });
      await page.screenshot({
        path: join(artifacts, `appearance-${width}-${theme.toLowerCase()}.png`),
        fullPage: true,
      });
    }
    const sans = page.getByRole('button', { name: 'Ag Sans', exact: true });
    await sans.click();
    assert.equal(await sans.getAttribute('aria-pressed'), 'true');
    const afterFont = await readPreferences(page);
    for (const [key, value] of Object.entries(preferences))
      assert.deepEqual(afterFont[key], key === 'appFont' ? 'sans' : value, `Font change preserves ${key}`);
    const wheel = page.getByRole('slider', { name: 'Palette wheel' });
    const beforeWheel = Number(await wheel.getAttribute('aria-valuenow'));
    await wheel.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(Number(await wheel.getAttribute('aria-valuenow')), (beforeWheel + 1) % 20);
    const afterWheel = await readPreferences(page);
    assert.equal(afterWheel.appFont, 'sans');
    assert.equal(afterWheel.grainOpacity, preferences.grainOpacity);
    assert.equal(afterWheel.grainScale, preferences.grainScale);
    assert.equal(afterWheel.depthSpread, preferences.depthSpread);
    assert.equal(afterWheel.query, 'from:alex');
    assert.equal(afterWheel.capacity, 'low');
    await page.getByRole('button', { name: 'Leave Appearance', exact: true }).click();
    assert.equal(await page.getByRole('slider', { name: 'Palette wheel' }).count(), 0);
    await page.getByRole('button', { name: 'Return to Appearance', exact: true }).click();
    await page.getByRole('slider', { name: 'Palette wheel' }).waitFor();
    assert.deepEqual(
      await readPreferences(page),
      afterWheel,
      'Leaving and reopening Settings preserves choices',
    );
    await page.reload();
    await page.getByRole('slider', { name: 'Palette wheel' }).waitFor();
    assert.deepEqual(
      await readPreferences(page),
      afterWheel,
      'A real page reload rehydrates the same preferences',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Ag Sans', exact: true }).getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Dark', exact: true }).getAttribute('aria-pressed'),
      'true',
    );
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    assert.deepEqual(apiRequests, [], 'Appearance verification never calls account APIs');
    evidence.push({
      width,
      mountedWithoutReset: true,
      wheelKeyboard: true,
      preferencesSurviveRemountAndReload: true,
    });
    await context.close();
  }
  const report = JSON.stringify({ status: 'passed', artifacts, evidence }, null, 2);
  await writeFile(join(artifacts, 'evidence.json'), report);
  console.log(report);
} finally {
  await browser.close();
}
