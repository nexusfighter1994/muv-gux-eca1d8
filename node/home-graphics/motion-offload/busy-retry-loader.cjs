'use strict';
// vf-custom:motion-busy-retry-v1 (2026-11-22): loads fresh copies of the two Home motion hooks in a RUNNING server.
// Node keeps an imported module for the life of the process, so the patched hook.mjs / alpha-hook.mjs are imported
// under a query string. Only the hot switch (claude-watch/rp/mbr1.js) uses this file; after a restart custom.mjs
// imports the patched hooks directly.
module.exports = {
  loadOpaque: () => import('./hook.mjs?busyretry=1'),
  loadAlpha: () => import('./alpha-hook.mjs?busyretry=1'),
};
