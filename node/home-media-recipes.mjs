// Syntax only. The caller owns root checks, High24 probes, NVENC policy and
// counted native recovery. These functions never rewrite a command or do I/O.
export {classifyHomeMediaCallback} from './home-media-callbacks.mjs';

const SIMPLE_GRAPH = '[0:v][1:v]overlay=0:0:eof_action=pass[v]';
const TIMED_GRAPH = /^\[0:v\]fps=24,setsar=1\[base\];\[1:v\]fps=24(?:,setpts=PTS\+((?:0|[1-9][0-9]{0,5})\.[0-9]{4})\/TB)?\[fx\];\[base\]\[fx\]overlay=0:0:eof_action=pass,format=yuv420p\[v\]$/;
const STILL_GRAPH = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=24';
const PRESETS = new Set(['veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']);
const OVERLAY = ['-i', null, '-i', null, '-filter_complex', null, '-map', '[v]',
  '-map', '0:a?', '-c:v', 'libx264', '-crf', null, '-preset', null,
  '-pix_fmt', 'yuv420p', '-c:a', 'copy', null];
const IMAGE = ['-loop', '1', '-i', null, '-t', null, '-vf', STILL_GRAPH, '-r', '24',
  '-pix_fmt', 'yuv420p', '-c:v', 'libx264', null];
const MIRROR = ['-i', null, '-filter:v', 'hflip', '-c:v', 'libx264',
  '-preset', 'fast', '-crf', '18', '-an', null];
const BLUR_OVERLAY = [...OVERLAY.slice(0,18), '-fps_mode','cfr','-r','24/1','-g','48',
  '-keyint_min','48','-sc_threshold','0','-flags','+cgop','-video_track_timescale','12288',
  '-movflags','+negative_cts_offsets','-c:a','copy',null];
const BLUR_GRAPH = /^\[0:v\]setpts=PTS-STARTPTS,fps=24\[bfs\];\[bfs\]split=2\[gk0\]\[gc0\];\[gc0\]trim=start=(\d{1,3}\.\d{4}):end=(\d{1,3}\.\d{4}),setpts=PTS-STARTPTS,scale=2016:1134:flags=bicubic,crop=1920:1080,gblur=sigma=18:steps=2,format=yuva420p,fade=t=in:st=0:d=(\d{1,3}\.\d{4}):alpha=1,fade=t=out:st=(\d{1,3}\.\d{4}):d=(\d{1,3}\.\d{4}):alpha=1,setpts=PTS\+(\d{1,3}\.\d{4})\/TB\[gw0\];\[gk0\]\[gw0\]overlay=0:0:eof_action=pass\[gb0\];\[1:v\]fps=24,setpts=PTS\+(\d{1,3}\.\d{4})\/TB\[l0\];\[gb0\]\[l0\]overlay=0:0:eof_action=pass\[v\]$/;

function validBlurGraph(graph){
  const match=BLUR_GRAPH.exec(graph);if(!match)return false;
  const values=match.slice(1).map(Number),[start,end,fadeIn,fadeStart,fadeOut,offset,layerOffset]=values;
  return values.every(v=>v>=0&&v<=600)&&start<end&&offset===start&&layerOffset<=end
    &&fadeIn>0&&fadeOut>0&&fadeIn<=end-start+0.0002&&fadeStart+fadeOut<=end-start+0.0002;
}

const matches = (argv, template) => argv.length === template.length
  && template.every((value, index) => value === null || argv[index] === value);
const media = (value, extensions) => typeof value === 'string' && !value.startsWith('-')
  && new RegExp(`\\.(?:${extensions})$`, 'i').test(value);
const fixedDuration = value => /^(?:0|[1-9][0-9]{0,5})\.[0-9]{3}$/.test(value)
  && Number(value) >= 0.05 && Number(value) <= 600;

export function classifyHomeMediaArgv(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.length > 256) return null;
  for (const value of argv) {
    if (typeof value !== 'string' || !value.length || value.length > 32768 || /[\0\r\n]/.test(value)) return null;
  }
  // it() adds its own common prefix; its removal belongs to the bridge. Native
  // mirror includes one more -y, which may remain after that removal.
  const args = argv[0] === '-y' ? argv.slice(1) : argv;
  if (!media(args.at(-1), 'mp4')) return null;
  if(matches(args,BLUR_OVERLAY)&&media(args[1],'mp4')&&media(args[3],'mp4|mov')
      &&args[13]==='18'&&PRESETS.has(args[15])&&validBlurGraph(args[5]))return 'composite-blur-overlay';
  if (matches(args, OVERLAY) && media(args[1], 'mp4')
      && media(args[3], 'mp4|mov') && PRESETS.has(args[15])) {
    if (args[5] === SIMPLE_GRAPH && args[13] === '20') return 'composite-overlay';
    const timed = TIMED_GRAPH.exec(args[5]);
    if (timed && args[13] === '18'
        && (!timed[1] || Number(timed[1]) > 0 && Number(timed[1]) <= 600)) return 'composite-overlay';
    return null;
  }
  if (matches(args, IMAGE) && media(args[3], 'png|jpg|jpeg|webp|bmp') && fixedDuration(args[5])) {
    return 'broll-simpleimage';
  }
  if (matches(args, MIRROR) && media(args[1], 'mp4')) return 'video-mirror';
  return null;
}
