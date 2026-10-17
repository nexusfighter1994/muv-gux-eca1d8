'use strict';

const FLOAT_EPSILON_SECONDS = 1e-7;

function number(value, positive = false) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))) return null;
  const result = Number(value);
  return Number.isFinite(result) && (!positive || result > 0) ? result : null;
}

function count(value) {
  const result = number(value, true);
  return Number.isSafeInteger(result) ? result : null;
}

function rational(value) {
  if (typeof value !== 'string' || !/^\d+\/\d+$/.test(value)) return null;
  const [numerator, denominator] = value.split('/').map(count);
  if (!numerator || !denominator) return null;
  let a = numerator, b = denominator;
  while (b) [a, b] = [b, a % b];
  return { key: `${numerator / a}/${denominator / a}`, value: numerator / denominator };
}

function text(value) { return typeof value === 'string' && value.trim() ? value : null; }

function inspect(raw, location) {
  const fail = (reason, field) => ({ failure: { ok: false, reason, details: { location, field } } });
  if (!raw || !Array.isArray(raw.streams) || !raw.format) return fail('missing_metadata', 'streams/format');
  const videos = raw.streams.filter(s => s?.codec_type === 'video');
  const audios = raw.streams.filter(s => s?.codec_type === 'audio');
  if (videos.length !== 1 || audios.length > 1 || raw.streams.length !== videos.length + audios.length) return fail('unexpected_streams', 'streams');
  const video = videos[0], audio = audios[0] || null;
  if (video.disposition?.attached_pic) return fail('unexpected_streams', 'attached_pic');
  if (video.codec_name !== 'h264') return fail('unsupported_video_codec', 'video.codec_name');
  const fps = rational(video.r_frame_rate), timeBase = rational(video.time_base);
  const width = count(video.width), height = count(video.height), frames = count(video.nb_frames);
  const duration = number(video.duration, true), start = number(video.start_time);
  const formatDuration = number(raw.format.duration, true), formatStart = number(raw.format.start_time);
  const fields = { profile: text(video.profile), pix_fmt: text(video.pix_fmt), width, height, r_frame_rate: fps, time_base: timeBase, nb_frames: frames, duration, start_time: start, formatDuration, formatStart };
  for (const [field, value] of Object.entries(fields)) if (value === null) return fail('missing_metadata', field);
  let audioSignature = null, audioDuration = null, audioStart = null, sampleRate = null;
  if (audio) {
    if (audio.codec_name !== 'aac' || (audio.profile !== undefined && audio.profile !== 'LC')) return fail('unsupported_audio_codec', 'audio.codec_name/profile');
    sampleRate = count(audio.sample_rate);
    const channels = count(audio.channels), layout = text(audio.channel_layout), audioTimeBase = rational(audio.time_base);
    audioDuration = number(audio.duration, true); audioStart = number(audio.start_time);
    const audioFields = { sample_rate: sampleRate, channels, channel_layout: layout, time_base: audioTimeBase, duration: audioDuration, start_time: audioStart };
    for (const [field, value] of Object.entries(audioFields)) if (value === null) return fail('missing_metadata', 'audio.' + field);
    audioSignature = JSON.stringify(['aac', sampleRate, channels, layout, audioTimeBase.key]);
  }
  return {
    location, video, audio, frames, fps: fps.value, duration, start, formatDuration, formatStart,
    sampleRate, audioDuration, audioStart,
    videoSignature: JSON.stringify(['h264', video.profile, video.pix_fmt, width, height, fps.key, timeBase.key]),
    audioSignature,
  };
}

function validateCopy(inputs, output) {
  if (!Array.isArray(inputs) || inputs.length === 0) return { ok: false, reason: 'invalid_inputs', details: {} };
  const rows = [];
  for (let i = 0; i < inputs.length; i++) {
    const row = inspect(inputs[i], `input[${i}]`);
    if (row.failure) return row.failure;
    rows.push(row);
  }
  const actual = inspect(output, 'output');
  if (actual.failure) return actual.failure;
  const reference = rows[0];
  const frameSeconds = 1 / reference.fps;
  const aacFrameSeconds = reference.audio ? 1024 / reference.sampleRate : 0;
  const envelopeSeconds = Math.max(2 * frameSeconds, 2 * aacFrameSeconds + frameSeconds);
  const details = { inputCount: rows.length, frameSeconds, aacFrameSeconds, envelopeSeconds, audioCountCheck: 'unavailable' };
  const fail = (reason, extra = {}) => ({ ok: false, reason, details: { ...details, ...extra } });
  for (const row of [...rows, actual]) {
    if (row.videoSignature !== reference.videoSignature) return fail('video_signature_mismatch', { location: row.location });
    if (row.audioSignature !== reference.audioSignature) return fail('audio_signature_mismatch', { location: row.location });
  }
  for (const row of rows) {
    const starts = [row.start - row.formatStart, ...(row.audio ? [row.audioStart - row.formatStart] : [])];
    const ends = [starts[0] + row.duration, ...(row.audio ? [starts[1] + row.audioDuration] : [])];
    if (starts.some(start => start < -envelopeSeconds - FLOAT_EPSILON_SECONDS) || ends.some(end => !Number.isFinite(end) || end <= 0 || end > row.formatDuration + envelopeSeconds + FLOAT_EPSILON_SECONDS)) return fail('invalid_stream_timeline', { location: row.location });
  }
  details.expectedVideoFrames = rows.reduce((sum, row) => sum + row.frames, 0);
  details.actualVideoFrames = actual.frames;
  if (!Number.isSafeInteger(details.expectedVideoFrames)) return fail('frame_count_overflow');
  if (actual.frames !== details.expectedVideoFrames) return fail('video_frame_count_mismatch');
  if ([actual.start, actual.formatStart, ...(actual.audio ? [actual.audioStart] : [])].some(start => Math.abs(start) > frameSeconds + FLOAT_EPSILON_SECONDS)) return fail('output_start_not_near_zero');

  details.expectedFormatDurationSeconds = rows.reduce((sum, row) => sum + row.formatDuration, 0);
  details.sumInputMaxAVSeconds = rows.reduce((sum, row) => sum + Math.max(row.duration, row.audioDuration || 0), 0);
  details.actualFormatDurationSeconds = actual.formatDuration;
  const prefix = details.expectedFormatDurationSeconds - rows[rows.length - 1].formatDuration;
  const last = rows[rows.length - 1];
  details.expectedVideoEndSeconds = prefix + last.start - last.formatStart + last.duration;
  details.actualVideoEndSeconds = actual.start - actual.formatStart + actual.duration;
  details.formatDurationDeltaSeconds = actual.formatDuration - details.expectedFormatDurationSeconds;
  details.videoEndDeltaSeconds = details.actualVideoEndSeconds - details.expectedVideoEndSeconds;
  if (!Object.values(details).filter(value => typeof value === 'number').every(Number.isFinite)) return fail('invalid_timeline');
  const outside = delta => Math.abs(delta) > envelopeSeconds + FLOAT_EPSILON_SECONDS;
  if (outside(details.formatDurationDeltaSeconds)) return fail('format_duration_outside_envelope');
  if (outside(actual.formatDuration - details.sumInputMaxAVSeconds)) return fail('max_av_duration_outside_envelope');
  if (outside(details.videoEndDeltaSeconds)) return fail('video_end_outside_envelope');
  if (actual.audio) {
    details.expectedAudioEndSeconds = prefix + last.audioStart - last.formatStart + last.audioDuration;
    details.actualAudioEndSeconds = actual.audioStart - actual.formatStart + actual.audioDuration;
    if (outside(details.actualAudioEndSeconds - details.expectedAudioEndSeconds)) return fail('audio_end_outside_envelope');
    // Counted packets and MP4 AAC frame metadata are checked independently when complete.
    for (const field of ['nb_read_packets', 'nb_frames']) {
      const values = [...rows, actual].map(row => count(row.audio[field]));
      if (values.some(value => value === null)) continue;
      const expected = values.slice(0, -1).reduce((sum, value) => sum + value, 0);
      if (!Number.isSafeInteger(expected)) return fail('audio_count_overflow', { field });
      details.audioCountCheck = details.audioCountCheck === 'unavailable' ? field : details.audioCountCheck + '+' + field;
      if (values[values.length - 1] !== expected) return fail('audio_count_mismatch', { field, expectedAudioCount: expected, actualAudioCount: values[values.length - 1] });
    }
  }
  return { ok: true, reason: 'copy_integrity_verified', details };
}

module.exports = { validateCopy };
