// Run against the real GUI, not a mocked DOM. Requires playwright-core and Chromium.
// DSH_WEB_URL=https://... PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node test/verify-live.mjs
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(process.env.DSH_WEB_URL || 'http://localhost:3000');
  const editor = page.locator('[data-composer-input][contenteditable="true"]');
  await editor.waitFor();
  const desktop = await editor.evaluate(e => getComputedStyle(e).fontSize);
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  assert.doesNotMatch(viewport, /user-scalable\s*=\s*no|maximum-scale\s*=/);
  for (const width of [390, 767]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await editor.evaluate(e => parseFloat(getComputedStyle(e).fontSize) >= 16), 'phone composer is at least 16px');
    // Exercise the actual editor without sending a message or leaving a draft behind.
    await editor.fill('Mobile input verification');
    await editor.press('End');
    await editor.press('!');
    assert.equal(await editor.innerText(), 'Mobile input verification!');
    await editor.fill('');
    // Exercise all covered field kinds against the live stylesheet, including dynamic fields.
    const sizes = await page.evaluate(() => {
      const host = document.createElement('div');
      host.style.fontSize = '12px';
      host.innerHTML = '<input><textarea></textarea><select><option>Test</option></select><div contenteditable="true"></div><div contenteditable="plaintext-only"></div>';
      document.body.appendChild(host);
      const small = [...host.children].map(e => parseFloat(getComputedStyle(e).fontSize));
      host.style.fontSize = '22px';
      const large = [...host.children].map(e => parseFloat(getComputedStyle(e).fontSize));
      host.remove();
      return { small, large };
    });
    assert.ok(sizes.small.every(n => n >= 16), JSON.stringify(sizes));
    assert.ok(sizes.large.every(n => n >= 22), 'larger text preferences are preserved');
    console.log(`PASS ${width}px: composer, typing, dynamic fields, larger text, pinch-zoom viewport`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await editor.evaluate(e => getComputedStyle(e).fontSize), desktop, 'desktop size is unchanged');
  console.log(`PASS desktop: composer restored to ${desktop}`);
  console.log('UNVERIFIED: native iPhone Safari focus-zoom behavior requires a device check.');
} finally {
  await browser.close();
}
