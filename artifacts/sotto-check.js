const fs = require('node:fs');
const path = require('node:path');

const url = process.env.SOTTO_URL || 'http://127.0.0.1:8080/';

function findPlaywrightPackage() {
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm-cache', '_npx'),
  ].filter(Boolean);

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      const candidate = path.join(root, entry, 'node_modules', 'playwright');
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    }
  }

  throw new Error('Playwright package not found in npm npx cache. Run `npx playwright --version` first.');
}

const { chromium } = require(findPlaywrightPackage());

async function openPage(viewport) {
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const events = { consoleErrors: [], pageErrors: [], failedRequests: [] };

  page.on('console', (msg) => {
    if (msg.type() === 'error') events.consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => events.pageErrors.push(err.message));
  page.on('requestfailed', (request) => {
    events.failedRequests.push({
      url: request.url(),
      failure: request.failure()?.errorText || 'unknown',
    });
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  return { browser, page, events };
}

async function inspectViewport(viewport) {
  const { browser, page, events } = await openPage(viewport);
  const result = await page.evaluate(() => {
    const vw = window.innerWidth;
    const visibleOverflow = [...document.querySelectorAll('body *')]
      .map((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number(style.opacity) === 0 ||
          rect.width === 0 ||
          rect.height === 0
        ) return null;
        const excessLeft = Math.max(0, -rect.left);
        const excessRight = Math.max(0, rect.right - vw);
        if (excessLeft < 1 && excessRight < 1) return null;
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          className: String(el.className || '').slice(0, 120),
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      })
      .filter(Boolean)
      .slice(0, 20);

    const videos = [...document.querySelectorAll('video')].map((video) => ({
      id: video.id,
      currentSrc: video.currentSrc,
      readyState: video.readyState,
      networkState: video.networkState,
      duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    }));

    const hashLinks = [...document.querySelectorAll('a[href^="#"]')].map((a) => ({
      text: (a.textContent || '').trim().replace(/\s+/g, ' '),
      href: a.getAttribute('href'),
      targetExists: a.getAttribute('href') === '#'
        ? false
        : Boolean(document.querySelector(a.getAttribute('href'))),
    }));

    return {
      title: document.title,
      innerWidth: vw,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      visibleOverflow,
      videos,
      brokenHashLinks: hashLinks.filter((link) => !link.targetExists),
    };
  });

  await browser.close();
  return { viewport, events, result };
}

async function inspectInteractions() {
  const { browser, page } = await openPage({ width: 390, height: 844 });

  await page.click('#burger');
  const menuAfterOpen = await page.evaluate(() => ({
    menuOpen: document.querySelector('#menu')?.classList.contains('show'),
    burgerLabel: document.querySelector('#burger')?.getAttribute('aria-label'),
    bodyOverflow: document.body.style.overflow,
  }));

  await page.click('#menu a[href="#features"]');
  const menuAfterLink = await page.evaluate(() => ({
    menuOpen: document.querySelector('#menu')?.classList.contains('show'),
    bodyOverflow: document.body.style.overflow,
    hash: location.hash,
  }));

  const faqs = page.locator('.faq');
  await faqs.nth(0).locator('.faq-trigger').click();
  const firstAfterClick = await faqs.nth(0).evaluate((el) => el.classList.contains('open'));
  await faqs.nth(1).locator('.faq-trigger').click();
  const faqAfterSecond = await page.evaluate(() => [...document.querySelectorAll('.faq')].map((el) => el.classList.contains('open')));

  await browser.close();
  return { menuAfterOpen, menuAfterLink, firstAfterClick, faqAfterSecond };
}

(async () => {
  const output = {
    viewports: [
      await inspectViewport({ width: 1440, height: 1000 }),
      await inspectViewport({ width: 390, height: 844 }),
    ],
    interactions: await inspectInteractions(),
  };

  console.log(JSON.stringify(output, null, 2));
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
