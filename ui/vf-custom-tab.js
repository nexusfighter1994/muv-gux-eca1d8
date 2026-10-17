// vf-custom: adds "Custom" to the VidForge UI without touching its React code.
// 1) a sidebar entry cloned from the Settings link, 2) a tab next to "Experimental" in Settings.
// Both only use visible labels/links; if an update changes them, /custom still works directly.
const LABEL = 'Custom';
const HREF = '/custom';

function textOf(node) { return (node.textContent || '').trim(); }

function addNavEntry() {
  if (document.querySelector('[data-vfc-nav]')) return;
  const settings = [...document.querySelectorAll('a[href="/settings"]')].find(a => /settings/i.test(textOf(a)) && a.offsetParent !== null);
  if (!settings) return;
  const clone = settings.cloneNode(true);
  clone.setAttribute('href', HREF);
  clone.dataset.vfcNav = '1';
  clone.removeAttribute('aria-current');
  clone.classList.forEach(cls => { if (/active|current|selected/i.test(cls)) clone.classList.remove(cls); });
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  let replaced = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (/settings/i.test(node.nodeValue)) { node.nodeValue = node.nodeValue.replace(/settings/i, LABEL); replaced = true; }
  }
  if (!replaced) clone.append(LABEL);
  clone.addEventListener('click', event => { event.preventDefault(); location.href = HREF; });
  settings.insertAdjacentElement('afterend', clone);
}

function addSettingsTab() {
  if (!location.pathname.startsWith('/settings') || document.querySelector('[data-vfc-tab]')) return;
  const candidates = [...document.querySelectorAll('button, a, [role="tab"]')].filter(el => textOf(el) === 'Experimental' && el.offsetParent !== null);
  const tab = candidates.find(el => el.parentElement && [...el.parentElement.children].some(s => textOf(s) === 'Providers'));
  if (!tab) return;
  const clone = tab.cloneNode(true);
  clone.dataset.vfcTab = '1';
  clone.removeAttribute('aria-selected');
  clone.removeAttribute('aria-current');
  clone.classList.forEach(cls => { if (/active|current|selected/i.test(cls)) clone.classList.remove(cls); });
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue.includes('Experimental')) node.nodeValue = node.nodeValue.replace('Experimental', LABEL);
  clone.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); location.href = HREF; }, true);
  tab.insertAdjacentElement('afterend', clone);
}

let scheduled = false;
function run() { scheduled = false; try { addNavEntry(); addSettingsTab(); } catch {} }
new MutationObserver(() => { if (!scheduled) { scheduled = true; setTimeout(run, 150); } })
  .observe(document.documentElement, { childList: true, subtree: true });
run();
