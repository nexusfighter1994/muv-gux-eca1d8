import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire('C:/Users/user/Documents/Codex/2026-07-04/du-bist-codex-auf-users-windows/signalforge-recovered/package.json');
const {JSDOM} = require('jsdom');
const source = fs.readFileSync(new URL('../ui/pc-boost-settings-20261002.js', import.meta.url), 'utf8');

test('safe GPU decode workers appear in settings and the concurrency tree', () => {
  const dom = new JSDOM('<div id="engine-health"></div><li data-homepc-row="gpu"><strong></strong><span class="vc-faint"></span></li>',
    {url:'https://vidforge.example/custom',runScripts:'outside-only',pretendToBeVisual:true});
  try {
    dom.window.fetch = () => new Promise(() => {});
    dom.window.MutationObserver = class {observe() {}};
    dom.window.eval(source);
    const health = {ffmpeg: {reachable:true, ready:true, gpuAvailable:true, gpuActive:2,
      gpuCapacity:3, completedGpu:7, cpuActive:5, cpuCapacity:16}};
    const settings = dom.window.document.querySelector('pc-boost-settings');
    settings.accept({config:{enabled:true,cpuWorkers:16,gpuWorkers:3,siglipEnabled:true,siglipConcurrency:14,sceneWorkers:0,clipvaultBoost:35,ffmpegBoost:14}});
    settings.renderHealth(health);
    assert.equal(settings.querySelector('[data-active="gpu"]').textContent, '2');
    dom.window.eval('renderConcurrency')({config:{enabled:true}, health});
    const row = dom.window.document.querySelector('[data-homepc-row="gpu"]');
    assert.match(row.textContent, /2\/3 busy/);
    assert.match(row.textContent, /7 completed/);
    assert.match(source, /GPU decode/);
    assert.doesNotMatch(row.textContent, /CPU-only/);
  } finally {dom.window.close();}
});

test('explicit NVENC mode appears in settings and the concurrency tree', () => {
  const dom = new JSDOM('<div id="engine-health"></div><li data-homepc-row="gpu"><strong></strong><span class="vc-faint"></span></li>',
    {url:'https://vidforge.example/custom',runScripts:'outside-only',pretendToBeVisual:true});
  try {
    dom.window.fetch = () => new Promise(() => {});
    dom.window.MutationObserver = class {observe() {}};
    dom.window.eval(source);
    const health = {ffmpeg:{reachable:true,ready:true,gpuAvailable:true,nvencReady:true,
      gpuMode:'nvenc-high-qp14-v1',gpuActive:4,gpuCapacity:6,completedGpu:15}};
    const settings = dom.window.document.querySelector('pc-boost-settings');
    settings.accept({config:{enabled:true,cpuWorkers:16,gpuWorkers:6,siglipEnabled:true,siglipConcurrency:14,sceneWorkers:0,clipvaultBoost:35,ffmpegBoost:14}});
    settings.renderHealth(health);
    assert.equal(settings.querySelector('[data-gpu-label]').textContent,'GPU NVENC High');
    dom.window.eval('renderConcurrency')({config:{enabled:true},health});
    const row=dom.window.document.querySelector('[data-homepc-row="gpu"]');
    assert.match(row.querySelector('strong').textContent,/NVENC/);
    assert.match(row.textContent,/4\/6 busy/);
  } finally {dom.window.close();}
});

test('Home queue dispatch is distinct from actual CPU/GPU busy counters',()=>{
  const dom=new JSDOM('<li data-homepc-row="queue"><strong></strong><span class="vc-faint"></span></li>',
    {url:'https://vidforge.example/jobs/test',runScripts:'outside-only',pretendToBeVisual:true});
  try{
    dom.window.fetch=()=>new Promise(()=>{});dom.window.MutationObserver=class{observe(){}};
    dom.window.eval(source);
    dom.window.eval('renderConcurrency')({config:{enabled:true},homeQueue:{active:12,capacity:22,queued:18}});
    const row=dom.window.document.querySelector('[data-homepc-row="queue"]');
    assert.match(row.textContent,/12\/22 dispatched/);assert.match(row.textContent,/18 ready/);
    assert.doesNotMatch(row.textContent,/busy/);
  }finally{dom.window.close();}
});

test('Map/Motion GPU work has its own row and is not labeled as an NVENC encode',()=>{
  const rows=['cpu','gpu','graphics'].map(key=>`<li data-homepc-row="${key}"><strong></strong><span class="vc-faint"></span></li>`).join('');
  const dom=new JSDOM(rows,{url:'https://vidforge.example/jobs/test',runScripts:'outside-only'});
  try{
    dom.window.fetch=()=>new Promise(()=>{});dom.window.MutationObserver=class{observe(){}};dom.window.eval(source);
    dom.window.eval('renderConcurrency')({config:{enabled:true},health:{ffmpeg:{ready:true,reachable:true,gpuAvailable:true,nvencReady:true,
      cpuBusy:1,cpuCapacity:18,gpuBusy:3,gpuCapacity:6,graphicsBusy:1,graphicsCapacity:1,completedMap:2,completedMotion:3}}});
    const query=key=>dom.window.document.querySelector(`[data-homepc-row="${key}"]`).textContent;
    assert.match(query('cpu'),/0\/18 busy/);assert.match(query('gpu'),/2\/6 busy/);
    assert.match(query('graphics'),/1\/1 busy.*2 maps.*3 motion completed/);
    assert.doesNotMatch(query('graphics'),/NVENC/);
  }finally{dom.window.close();}
});
