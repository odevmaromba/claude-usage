import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/web/page.js';

/** The page script from one function declaration to the next (no DOM harness here; QA is headless Chrome). */
function scriptSource(from: string, to: string): string {
  const html = renderPage('n');
  const start = html.indexOf(`function ${from}(`);
  return html.slice(start, html.indexOf(`function ${to}(`, start));
}

describe('web page script', () => {
  it('sends the notice to the banner whenever there is data, even with no limits', () => {
    expect(scriptSource('emptyState', 'showBanner')).toContain('!display.hasData ? display.notice : null');
    expect(scriptSource('render', 'serverDown')).toContain('showBanner(display.hasData ? display.notice : null)');
  });

  it('treats data without limits as data when the server goes away (banner, not "Sem dados")', () => {
    expect(scriptSource('serverDown', 'setBusy')).toContain('if (lastDisplay && lastDisplay.hasData)');
  });

  it('drops the day-relative breakdown label when the server goes away', () => {
    const body = scriptSource('serverDown', 'setBusy');
    expect(body).toContain("ui.meters.classList.add('stale')");
    expect(body).toContain("ui.since.textContent = ''");
  });
});
