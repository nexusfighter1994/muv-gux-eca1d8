import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as recipes from '../node/home-media-recipes.mjs';

const blurOverlay = () => JSON.parse(fs.readFileSync(new URL('./fixtures/home-media-blur-overlay.json',import.meta.url))).argv;

test('observed native blur/fade overlay retains exact High24 stream and audio flags',()=>{
  const args=blurOverlay(),before=[...args];
  assert.equal(recipes.classifyHomeMediaArgv(args),'composite-blur-overlay');
  assert.deepEqual(args,before);
  for(const [key,value] of [['-crf','16'],['-r','30'],['-g','60'],['-c:a','aac'],['-movflags','+faststart']]){
    const changed=[...args];changed[changed.indexOf(key)+1]=value;
    assert.equal(recipes.classifyHomeMediaArgv(changed),null);
  }
  for(const [from,to] of [['sigma=18','sigma=99'],['start=0.5000','start=4.5000'],['PTS+0.5000/TB','PTS+0.6000/TB'],['d=0.5500','d=9.0000'],['[l0]','[l1]']]){
    const changed=[...args];changed[5]=changed[5].replace(from,to);
    assert.equal(recipes.classifyHomeMediaArgv(changed),null);
  }
  assert.equal(recipes.classifyHomeMediaArgv([...args,'-an']),null);
});

const SIMPLE = '[0:v][1:v]overlay=0:0:eof_action=pass[v]';
const TIMED = '[0:v]fps=24,setsar=1[base];[1:v]fps=24,setpts=PTS+0.5000/TB[fx];[base][fx]overlay=0:0:eof_action=pass,format=yuv420p[v]';
const STILL = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=24';
const overlay = (filter = SIMPLE, crf = '20') => ['-i', '/data/projects/base.mp4',
  '-i', '/data/projects/overlay.mov', '-filter_complex', filter, '-map', '[v]',
  '-map', '0:a?', '-c:v', 'libx264', '-crf', crf, '-preset', 'medium',
  '-pix_fmt', 'yuv420p', '-c:a', 'copy', '/data/projects/composited.part.mp4'];
const image = () => ['-loop', '1', '-i', '/data/projects/still.png', '-t', '3.000',
  '-vf', STILL, '-r', '24', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '/data/projects/image.part.mp4'];
const mirror = () => ['-y', '-i', '/data/projects/base.part.mp4', '-filter:v', 'hflip',
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an', '/data/projects/mirrored.part.mp4'];
const classify = argv => {
  assert.equal(typeof recipes.classifyHomeMediaArgv, 'function', 'closed argv classifier is missing');
  return recipes.classifyHomeMediaArgv(argv);
};
const callback = source => {
  assert.equal(typeof recipes.classifyHomeMediaCallback, 'function', 'callback classifier is missing');
  return recipes.classifyHomeMediaCallback(source);
};

test('exact native two-input simple and timed overlays preserve copied audio', () => {
  assert.equal(classify(overlay()), 'composite-overlay');
  assert.equal(classify(overlay(TIMED, '18')), 'composite-overlay');
  assert.equal(classify(overlay(TIMED.replace(',setpts=PTS+0.5000/TB', ''), '18')), 'composite-overlay');
  assert.equal(classify(overlay().map(x => x === '/data/projects/overlay.mov' ? '/data/projects/overlay.mp4' : x)), 'composite-overlay');
});

test('only the full-frame native simple still recipe is admitted', () => {
  for (const suffix of ['png', 'jpg', 'jpeg', 'webp', 'bmp']) {
    const argv = image(); argv[3] = '/data/projects/still.' + suffix;
    assert.equal(classify(argv), 'broll-simpleimage');
  }
  for (const duration of ['0.050', '3.000', '600.000']) {
    const argv = image(); argv[5] = duration;
    assert.equal(classify(argv), 'broll-simpleimage');
  }
});

test('native mirror accepts its optional duplicate overwrite flag without rewriting argv', () => {
  const argv = mirror(), before = [...argv];
  assert.equal(classify(argv), 'video-mirror');
  assert.equal(classify(argv.slice(1)), 'video-mirror');
  assert.deepEqual(argv, before);
  assert.equal(classify(['-y', ...argv]), null);
});

test('mask graphs, third inputs and unrelated layer graphs remain native', () => {
  const masked = TIMED.replace('[base];', ',split=2[base][pre];[2:v]alphaextract[mask];[pre][mask]alphamerge[graded];');
  for (const argv of [overlay(masked, '18'), overlay(SIMPLE + ';movie=/etc/passwd[out]'),
    [...overlay().slice(0, 4), '-i', '/data/projects/mask.mov', ...overlay().slice(4)],
    overlay('[1:v]fps=24,setpts=PTS+0.0000/TB[l0];[0:v][l0]overlay=0:0:eof_action=pass[v]', '18')]) {
    assert.equal(classify(argv), null);
  }
});

test('every fixed overlay token is closed including maps, audio, CRF and output format', () => {
  for (const [index, value] of [[0, '-ss'], [4, '-vf'], [6, '-map_metadata'], [7, '0:v:0'],
    [9, '1:a?'], [11, 'h264_nvenc'], [13, '18'], [15, 'ultrafast'], [17, 'yuva420p'],
    [19, 'aac'], [20, '/data/projects/output.mov']]) {
    const argv = overlay(); argv[index] = value;
    assert.equal(classify(argv), null, `mutation at ${index}`);
  }
  const timed = overlay(TIMED, '18'); timed[13] = '20';
  assert.equal(classify(timed), null);
  for (const argv of [overlay().slice(0, -1), [...overlay(), '-an'], ['ffmpeg', ...overlay()],
    ['-y', '-hide_banner', '-loglevel', 'error', ...overlay()]]) assert.equal(classify(argv), null);
});

test('timed overlays require the native positive fixed-four-decimal offset', () => {
  for (const offset of ['0.0000', '-0.5000', '0.5', '1e3', 'NaN', 'Infinity', '600.0001', '00.5000']) {
    assert.equal(classify(overlay(TIMED.replace('0.5000', offset), '18')), null, offset);
  }
});

test('simpleimage does not claim zoompan, smooth transforms, 30fps or changed audio', () => {
  for (const [index, value] of [[1, '-1'], [3, '/data/projects/source.mp4'], [5, '0.000'],
    [5, '3'], [5, '600.001'], [7, STILL + ',zoompan=z=2'], [9, '30'], [11, 'yuv444p'], [13, 'h264_nvenc']]) {
    const argv = image(); argv[index] = value;
    assert.equal(classify(argv), null);
  }
  assert.equal(classify([...image().slice(0, -1), '-an', image().at(-1)]), null);
  assert.equal(classify(['-y', '-i', '/data/projects/generated.mp4', '-vf',
    'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,tpad=stop_mode=clone:stop_duration=3',
    '-t', '3', '-r', '30', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '/data/projects/generated.part.mp4']), null);
});

test('mirror stays exact and slow-to-fit CRF16 stays native', () => {
  for (const [index, value] of [[4, 'vflip'], [8, 'veryfast'], [10, '16'], [11, '-sn']]) {
    const argv = mirror(); argv[index] = value;
    assert.equal(classify(argv), null);
  }
  assert.equal(classify(['-i', '/data/projects/source.mp4', '-vf', 'setpts=1.5000*PTS',
    '-fps_mode', 'cfr', '-an', '-t', '3.000', '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', '16', '-pix_fmt', 'yuv420p', '/data/projects/slowed.mp4']), null);
});

test('malformed or oversized values cannot qualify', () => {
  for (const argv of [null, {}, [], 'ffmpeg', new Array(257).fill('x'), [...image().slice(0, -1), null]]) {
    assert.equal(classify(argv), null);
  }
  for (const value of ['', '/data/projects/a\n.mp4', '/data/projects/a\r.mp4', '/data/projects/a\0.mp4', 'a'.repeat(32769) + '.mp4']) {
    const argv = overlay(); argv[1] = value;
    assert.equal(classify(argv), null);
  }
});

test('only exact reviewed native callback fingerprints become candidates', () => {
  assert.equal(callback('()=>x($,{...L,signal:c})'), 'composite-overlay');
  assert.equal(callback('()=>i(T,{signal:p})'), 'composite-overlay');
  const source = '()=>Ke(["-y","-i",U,"-filter:v","hflip","-c:v","libx264","-preset","fast","-crf","18","-an",W])';
  assert.equal(callback(source), 'video-mirror');
  for (const value of [source + ';unknown()', source.replace('hflip', 'vflip'),
    source.replace('Ke(', 'other('), '()=>x($,{...L,signal:other})', '()=>i(T,{signal:p,extra:true})',
    '()=>O1a(At,Nt,rt.window.slowFactor,F,u)', 'async()=>{await SWe({imagePath:t})}', () => 1, null, {}]) {
    assert.equal(callback(value), null);
  }
});
