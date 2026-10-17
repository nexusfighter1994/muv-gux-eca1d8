export function customPage(stylesString = '') {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Custom - VidForge</title>${stylesString}
<link rel="stylesheet" href="/assets/pc-boost-settings-20261002.css?v=mods-20261015a">
<link rel="stylesheet" href="/assets/pc-transfer-settings-20261011.css?v=mods-20261015a">
<link rel="stylesheet" href="/assets/vf-custom.css?v=mods-20261015a">
<script type="module" src="/assets/pc-boost-settings-20261002.js?v=motion-settings-20261017a"></script>
<script type="module" src="/assets/pc-transfer-settings-20261011.js?v=size-nvenc-20261013a"></script>
<script type="module" src="/assets/vf-custom-page.js?v=mods-20261015a"></script>
</head><body class="vfc-body"><main id="vfc-mods" class="vfc-main">
<header class="vfc-head"><a class="vfc-back" href="/settings">Zurueck zu Einstellungen</a><h1>Custom</h1></header>
<div data-vfc-editor></div>
<section id="pc-boost-host"><div id="engine-health"></div></section>
<details class="vfc-integration"><summary>Integrationsdetails</summary><div id="vfc-status" role="region" aria-label="Integrationsdiagnose">Wird geladen</div></details>
</main></body></html>`;
}
