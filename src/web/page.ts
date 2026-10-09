/**
 * The whole screen: one HTML document, no external assets (CSP allows only
 * nonce'd inline style/script, data: images and same-origin fetch).
 * Data arrives as the `Display` JSON from /api/usage and is rendered with
 * textContent only. The client script avoids backticks and `${` on purpose:
 * it lives inside this template literal.
 */
export function renderPage(nonce: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Claude · uso</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%23d0602c'/%3E%3C/svg%3E">
<style nonce="${nonce}">
:root {
  color-scheme: light dark;
  --bg: #dcd8cf;
  --panel: #f4f2ed;
  --edge: #d9d4ca;
  --ink: #1c1a17;
  --ink-2: #5b554c;
  --ink-3: #8f887d;
  --track: #e3dfd6;
  --tick: #b9b2a6;
  --accent: #d0602c;
  --warn: #b97f0c;
  --crit: #c0392b;
  --seg-1: var(--accent);
  --seg-2: #3d3832;
  --seg-3: #b38d55;
  --seg-4: #8f887d;
  --seg-5: #5f7f70;
  --grille: rgba(28, 26, 23, .2);
  --glow: rgba(255, 255, 255, .3);
  --lift: 0 1px 0 rgba(255, 255, 255, .85) inset, 0 0 0 1px var(--edge), 0 28px 56px -32px rgba(46, 34, 20, .5);
  --f-num: "DIN Condensed", "Bahnschrift Condensed", "Roboto Condensed", "Arial Narrow", sans-serif;
  --f-label: "DIN Alternate", "Bahnschrift", "Avenir Next", sans-serif;
  --f-body: "Avenir Next", "Seravek", "Segoe UI", "Helvetica Neue", sans-serif;
  --f-mono: "SF Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d0c0b;
    --panel: #191816;
    --edge: #2b2926;
    --ink: #eeeae3;
    --ink-2: #a39c91;
    --ink-3: #6f695f;
    --track: #262421;
    --tick: #4a463f;
    --accent: #ee7b46;
    --warn: #e7b14d;
    --crit: #f2604f;
    --seg-2: #d8d2c8;
    --seg-3: #c9a46b;
    --seg-4: #6f695f;
    --seg-5: #86ac98;
    --grille: rgba(238, 234, 227, .16);
    --glow: rgba(255, 255, 255, .035);
    --lift: 0 1px 0 rgba(255, 255, 255, .05) inset, 0 0 0 1px var(--edge), 0 28px 56px -32px rgba(0, 0, 0, .9);
  }
}
*, *::before, *::after { box-sizing: border-box; }
* { margin: 0; padding: 0; }
[hidden] { display: none !important; }
html { background: var(--bg); }
body {
  min-height: 100vh;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 36px 16px;
  color: var(--ink);
  font: 15px/1.45 var(--f-body);
  -webkit-font-smoothing: antialiased;
  background: radial-gradient(120% 70% at 50% -10%, var(--glow), transparent 65%), var(--bg);
}
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  opacity: .55;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .07 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
.panel {
  position: relative;
  width: 100%;
  max-width: 470px;
  padding: 24px 26px 18px;
  background: var(--panel);
  border-radius: 20px;
  box-shadow: var(--lift);
}
@media (max-width: 520px) {
  body { padding: 0; }
  .panel { max-width: none; min-height: 100vh; border-radius: 0; box-shadow: none; }
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--edge);
}
h1 {
  display: flex;
  align-items: center;
  gap: 10px;
  font: 700 13px/1 var(--f-label);
  letter-spacing: .24em;
  text-transform: uppercase;
}
.lamp {
  --lamp: var(--ink-3);
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--lamp);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--lamp) 20%, transparent), 0 0 10px color-mix(in srgb, var(--lamp) 65%, transparent);
  transition: background .3s, box-shadow .3s;
}
.lamp.live { --lamp: var(--accent); }
.lamp.warn { --lamp: var(--warn); }
.lamp.down { --lamp: var(--crit); }
.lamp.idle { box-shadow: none; }
.lamp.busy { animation: pulse 1.1s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .3; } }
.sub {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
  color: var(--ink-2);
  font-size: 13px;
}
.plan {
  font: 700 10px/1 var(--f-label);
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--ink);
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 4px 6px 3px;
}
.email { margin-top: 5px; color: var(--ink-3); font-size: 12.5px; overflow-wrap: anywhere; }
.grille {
  flex: none;
  width: 64px;
  height: 36px;
  background-image: radial-gradient(circle, var(--grille) 1.5px, transparent 1.9px);
  background-size: 8px 8px;
  -webkit-mask-image: linear-gradient(to left, #000 55%, transparent);
  mask-image: linear-gradient(to left, #000 55%, transparent);
}
.banner {
  --tone: var(--warn);
  margin-top: 16px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13.5px;
  line-height: 1.45;
  background: color-mix(in srgb, var(--tone) 11%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--tone) 38%, transparent);
}
.banner.error { --tone: var(--crit); }
.banner strong { display: block; font-weight: 600; }
.banner .hint { display: block; margin-top: 2px; color: var(--ink-2); }
code {
  font: 600 12px/1 var(--f-mono);
  padding: 2px 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}
.meter { padding: 18px 0 16px; border-bottom: 1px solid var(--edge); }
.meter:last-child { border-bottom: 0; }
.meter.enter { animation: rise .55s cubic-bezier(.2, .7, .2, 1) both; animation-delay: calc(var(--i, 0) * 80ms); }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } }
.meter.sev-normal { --sev: var(--accent); }
.meter.sev-warning { --sev: var(--warn); }
.meter.sev-critical { --sev: var(--crit); }
.meter-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; }
.meter-label h3 {
  font: 700 12px/1.1 var(--f-label);
  letter-spacing: .16em;
  text-transform: uppercase;
}
.meter-label p { margin-top: 5px; color: var(--ink-2); font-size: 13px; }
.meter-value {
  display: flex;
  align-items: flex-start;
  font-family: var(--f-num);
  font-weight: 700;
  line-height: .8;
  font-variant-numeric: tabular-nums;
}
.meter-value .num { font-size: 50px; }
.meter-value .pct { margin: 3px 0 0 2px; font-size: 19px; color: var(--ink-2); }
.sev-warning .num, .sev-critical .num { color: var(--sev); }
.skeleton .num { color: var(--ink-3); }
.track {
  height: 12px;
  margin-top: 14px;
  border-radius: 3px;
  background: var(--track);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, .14);
  overflow: hidden;
}
.fill {
  width: 0;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(to bottom, rgba(255, 255, 255, .24), rgba(255, 255, 255, 0) 60%), var(--sev, var(--accent));
  transition: width .9s cubic-bezier(.2, .8, .2, 1);
}
.scale {
  height: 7px;
  margin-top: 3px;
  border-right: 1px solid var(--tick);
  background:
    linear-gradient(to right, var(--tick) 1px, transparent 1px) 0 0 / 50% 7px repeat-x,
    linear-gradient(to right, var(--tick) 1px, transparent 1px) 0 0 / 10% 4px repeat-x;
}
.reset { margin-top: 9px; color: var(--ink-2); font-size: 13px; }
.reset strong {
  color: var(--ink);
  font: 700 14px/1 var(--f-label);
  letter-spacing: .02em;
  font-variant-numeric: tabular-nums;
}
.reset.passed { color: var(--warn); }
/* Server gone: its countdowns are frozen, so they would lie. */
.stale .reset { visibility: hidden; }
.empty { padding: 30px 0 24px; }
.empty h3 {
  font: 700 12px/1.1 var(--f-label);
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--ink-2);
}
.empty p { margin-top: 8px; font-size: 14px; }
.empty p + p { margin-top: 4px; color: var(--ink-2); }
.block { padding: 16px 0 6px; border-top: 1px solid var(--edge); }
h2 {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  font: 700 11px/1.2 var(--f-label);
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--ink-2);
}
h2 .aside { font: 400 12.5px/1.2 var(--f-body); letter-spacing: 0; text-transform: none; color: var(--ink-3); text-align: right; }
h2 .aside.on { color: var(--ink); }
.stack {
  display: flex;
  gap: 2px;
  height: 8px;
  margin-top: 12px;
  border-radius: 2px;
  overflow: hidden;
  background: var(--track);
}
.stack span { display: block; min-width: 2px; height: 100%; }
.legend {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin-top: 11px;
  font-size: 13px;
}
.legend li { display: flex; align-items: center; gap: 7px; }
.legend .sw { width: 9px; height: 9px; border-radius: 2px; background: var(--c); }
.legend .v { font: 700 13px/1 var(--f-label); font-variant-numeric: tabular-nums; }
.legend li.zero { color: var(--ink-3); }
.legend li.zero .sw { opacity: .45; }
.foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  padding-top: 14px;
  border-top: 1px solid var(--edge);
}
.stamp { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--ink-3); }
.stamp .now { color: var(--ink-2); }
.refresh {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: none;
  padding: 8px 13px 7px;
  font: 700 10.5px/1 var(--f-label);
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--ink);
  background: transparent;
  border: 1px solid var(--ink);
  border-radius: 999px;
  cursor: pointer;
  transition: background .2s, color .2s;
}
.refresh:hover:not([aria-disabled="true"]) { background: var(--ink); color: var(--panel); }
.refresh:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.refresh[aria-disabled="true"] { cursor: default; opacity: .55; }
.refresh .icon { display: inline-block; font-size: 13px; line-height: 1; }
.refresh[aria-busy="true"] .icon { animation: spin .9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
</style>
</head>
<body>
<main class="panel" aria-labelledby="title">
  <header class="head">
    <div>
      <h1 id="title"><span id="lamp" class="lamp idle" aria-hidden="true"></span>Claude</h1>
      <p class="sub"><span>uso do plano</span><span id="plan" class="plan" hidden></span></p>
      <p id="email" class="email"></p>
    </div>
    <div class="grille" aria-hidden="true"></div>
  </header>
  <div id="banner" class="banner" role="status" aria-live="polite" hidden></div>
  <section id="meters" class="meters" aria-label="Limites do plano" aria-busy="true">
    <article class="meter skeleton">
      <div class="meter-head"><div class="meter-label"><h3>Sessão atual</h3><p>carregando…</p></div><div class="meter-value"><span class="num">–</span></div></div>
      <div class="track"></div><div class="scale" aria-hidden="true"></div>
    </article>
    <article class="meter skeleton">
      <div class="meter-head"><div class="meter-label"><h3>Semana</h3><p>carregando…</p></div><div class="meter-value"><span class="num">–</span></div></div>
      <div class="track"></div><div class="scale" aria-hidden="true"></div>
    </article>
  </section>
  <section id="breakdown" class="block" aria-label="Uso da semana por superfície" hidden>
    <h2><span>Semana por superfície</span><span id="since" class="aside"></span></h2>
    <div id="stack" class="stack" aria-hidden="true"></div>
    <ul id="legend" class="legend"></ul>
  </section>
  <section id="credits" class="block" aria-label="Créditos de uso" hidden>
    <h2><span>Créditos de uso</span><span id="credits-text" class="aside"></span></h2>
  </section>
  <footer class="foot">
    <p class="stamp"><span id="updated" class="now">carregando…</span><span id="login"></span></p>
    <button id="refresh" class="refresh" type="button" title="Atualizar agora (R)"><span class="icon" aria-hidden="true">↻</span>Atualizar</button>
  </footer>
</main>
<script nonce="${nonce}">
(function () {
  'use strict';
  var POLL_MS = 30000;
  var TICK = String.fromCharCode(96);
  var DOWN = { level: 'error', message: 'Servidor local parado.', hint: 'Rode ' + TICK + 'claude-usage --web' + TICK + ' de novo.' };
  function byId(id) { return document.getElementById(id); }
  var ui = {
    lamp: byId('lamp'), plan: byId('plan'), email: byId('email'), banner: byId('banner'), meters: byId('meters'),
    breakdown: byId('breakdown'), since: byId('since'), stack: byId('stack'), legend: byId('legend'),
    credits: byId('credits'), creditsText: byId('credits-text'), updated: byId('updated'), login: byId('login'),
    refresh: byId('refresh')
  };
  var timer = 0;
  var busy = false;
  var firstRender = true;
  var lastDisplay = null;
  var bannerKey = '';

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function richText(parent, text) {
    String(text).split(TICK).forEach(function (part, index) {
      if (!part) return;
      parent.appendChild(index % 2 === 1 ? el('code', null, part) : document.createTextNode(part));
    });
    return parent;
  }

  function clamp(value) {
    var number = Number(value);
    return isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
  }

  function meter(limit, index) {
    var node = el('article', 'meter sev-' + limit.severity + (firstRender ? ' enter' : ''));
    node.style.setProperty('--i', String(index));
    var head = el('div', 'meter-head');
    var label = el('div', 'meter-label');
    label.appendChild(el('h3', null, limit.label));
    if (limit.detail) label.appendChild(el('p', null, limit.detail));
    var value = el('div', 'meter-value');
    value.appendChild(el('span', 'num', limit.percent));
    value.appendChild(el('span', 'pct', '%'));
    head.appendChild(label);
    head.appendChild(value);

    var track = el('div', 'track');
    track.setAttribute('role', 'meter');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(clamp(limit.percent)));
    track.setAttribute('aria-valuetext', limit.percent + '% usado');
    track.setAttribute('aria-label', limit.detail ? limit.label + ', ' + limit.detail : limit.label);
    var fill = el('div', 'fill');
    track.appendChild(fill);
    var scale = el('div', 'scale');
    scale.setAttribute('aria-hidden', 'true');

    var reset = el('p', 'reset');
    if (limit.resetPassed && limit.resetAt) {
      reset.classList.add('passed');
      reset.textContent = 'renovou ' + limit.resetAt + ' · número anterior à renovação';
    } else if (limit.resetIn && limit.resetAt) {
      reset.appendChild(document.createTextNode('renova em '));
      reset.appendChild(el('strong', null, limit.resetIn));
      reset.appendChild(document.createTextNode(' · ' + limit.resetAt));
    } else {
      reset.textContent = 'sem horário de renovação';
    }

    node.appendChild(head);
    node.appendChild(track);
    node.appendChild(scale);
    node.appendChild(reset);

    var width = clamp(limit.percent) + '%';
    if (firstRender) {
      requestAnimationFrame(function () { requestAnimationFrame(function () { fill.style.width = width; }); });
    } else {
      fill.style.width = width;
    }
    return node;
  }

  function emptyState(display) {
    var box = el('div', 'empty');
    var notice = display && display.notice;
    box.appendChild(el('h3', null, notice ? 'Sem dados' : 'Nada pra mostrar'));
    if (notice) {
      richText(box.appendChild(el('p')), notice.message);
      if (notice.hint) richText(box.appendChild(el('p')), notice.hint);
    } else {
      box.appendChild(el('p', null, 'A API não retornou limites.'));
    }
    return box;
  }

  function showBanner(notice) {
    // The banner is a live region: rewriting the same text would make screen readers repeat it every poll.
    var key = notice ? notice.level + '|' + notice.message + '|' + (notice.hint || '') : '';
    if (key === bannerKey) return;
    bannerKey = key;
    ui.banner.replaceChildren();
    if (!notice) { ui.banner.hidden = true; return; }
    ui.banner.className = 'banner ' + notice.level;
    richText(ui.banner.appendChild(el('strong')), notice.message);
    if (notice.hint) richText(ui.banner.appendChild(el('span', 'hint')), notice.hint);
    ui.banner.hidden = false;
  }

  function renderBreakdown(breakdown) {
    if (!breakdown || !breakdown.rows.length) { ui.breakdown.hidden = true; return; }
    ui.since.textContent = breakdown.since ? 'desde ' + breakdown.since : '';
    ui.stack.replaceChildren();
    ui.legend.replaceChildren();
    breakdown.rows.forEach(function (row, index) {
      var color = 'var(--seg-' + ((index % 5) + 1) + ')';
      if (row.percent > 0) {
        var segment = el('span');
        segment.style.flex = clamp(row.percent) + ' 1 0';
        segment.style.background = color;
        segment.title = row.label + ': ' + row.percent + '%';
        ui.stack.appendChild(segment);
      }
      var item = el('li', row.percent > 0 ? null : 'zero');
      var swatch = el('span', 'sw');
      swatch.style.setProperty('--c', color);
      item.appendChild(swatch);
      item.appendChild(el('span', null, row.label));
      item.appendChild(el('span', 'v', row.percent + '%'));
      ui.legend.appendChild(item);
    });
    ui.breakdown.hidden = false;
  }

  function renderCredits(credits) {
    if (!credits) { ui.credits.hidden = true; return; }
    ui.creditsText.textContent = credits.summary + (credits.enabled && credits.percent !== null ? ' · ' + credits.percent + '%' : '');
    ui.creditsText.classList.toggle('on', Boolean(credits.enabled));
    ui.credits.hidden = false;
  }

  function setLamp(state) {
    ui.lamp.className = 'lamp ' + state + (busy ? ' busy' : '');
  }

  function render(display) {
    lastDisplay = display;
    ui.plan.textContent = display.plan || '';
    ui.plan.hidden = !display.plan;
    ui.email.textContent = display.email || '';
    var hasLimits = display.limits && display.limits.length > 0;
    showBanner(hasLimits ? display.notice : null);
    var fragment = document.createDocumentFragment();
    if (hasLimits) {
      display.limits.forEach(function (limit, index) { fragment.appendChild(meter(limit, index)); });
    } else {
      fragment.appendChild(emptyState(display));
    }
    ui.meters.replaceChildren(fragment);
    ui.meters.classList.remove('stale');
    ui.meters.setAttribute('aria-busy', 'false');
    renderBreakdown(display.breakdown);
    renderCredits(display.credits);
    ui.updated.textContent = display.updatedAt
      ? 'atualizado ' + display.updatedAt + (display.updatedAgo ? ' · ' + display.updatedAgo : '')
      : 'sem dados ainda';
    ui.login.textContent = display.loginStatus || '';
    setLamp(display.notice ? (display.notice.level === 'error' ? 'down' : 'warn') : hasLimits ? 'live' : 'idle');
    document.title = hasLimits ? display.limits[0].percent + '% · Claude' : 'Claude · uso';
    firstRender = false;
  }

  function serverDown() {
    if (lastDisplay && lastDisplay.limits && lastDisplay.limits.length) {
      showBanner(DOWN);
      ui.meters.classList.add('stale');
      ui.updated.textContent = lastDisplay.updatedAt ? 'último dado ' + lastDisplay.updatedAt : 'sem dados';
    } else {
      showBanner(null);
      ui.meters.replaceChildren(emptyState({ notice: DOWN }));
      ui.meters.setAttribute('aria-busy', 'false');
      ui.updated.textContent = 'sem dados';
    }
    ui.login.textContent = '';
    setLamp('down');
    document.title = 'Claude · uso (parado)';
  }

  function setBusy(value) {
    busy = value;
    ui.lamp.classList.toggle('busy', value);
    // aria-disabled, not disabled: a disabled button drops keyboard focus mid-refresh.
    ui.refresh.setAttribute('aria-disabled', value ? 'true' : 'false');
    ui.refresh.setAttribute('aria-busy', value ? 'true' : 'false');
  }

  function schedule() {
    window.clearTimeout(timer);
    timer = window.setTimeout(function () { load(false); }, POLL_MS);
  }

  function load(force) {
    if (busy) return;
    setBusy(true);
    window.clearTimeout(timer);
    fetch('/api/usage' + (force ? '?force=1' : ''), { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (body) {
        if (body && body.display) render(body.display);
        else serverDown();
      })
      .catch(function () { serverDown(); })
      .then(function () {
        setBusy(false);
        schedule();
      });
  }

  ui.refresh.addEventListener('click', function () { load(true); });
  document.addEventListener('keydown', function (event) {
    if ((event.key === 'r' || event.key === 'R') && !event.metaKey && !event.ctrlKey && !event.altKey) load(true);
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) load(false);
  });
  load(false);
})();
</script>
</body>
</html>
`;
}
