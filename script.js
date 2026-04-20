// ── Web Audio API setup ───────────────────────────────────────────────────────
const ctx      = new (window.AudioContext || window.webkitAudioContext)();
const analyser = ctx.createAnalyser();
const gainNode = ctx.createGain();

analyser.fftSize = 64;        // produces 32 frequency bins
gainNode.connect(analyser);
analyser.connect(ctx.destination);
gainNode.gain.value = 0.8;    // default volume (matches slider)

// ── Playback state ────────────────────────────────────────────────────────────
let source      = null;       // AudioBufferSourceNode (recreated on every play)
let audioBuffer = null;       // decoded PCM data
let isPlaying   = false;
let startTime   = 0;          // ctx.currentTime when playback started
let pauseOffset = 0;          // seconds into the track when paused
let loopOn      = false;
let muted       = false;
let lastVol     = 0.8;        // remembered volume so unmute restores it
let rafId       = null;       // requestAnimationFrame handle for progress loop
let vizRafId    = null;       // requestAnimationFrame handle for visualizer loop

const freqData  = new Uint8Array(analyser.frequencyBinCount);

// ── DOM references ────────────────────────────────────────────────────────────
const playBtn       = document.getElementById('playBtn');
const playIcon      = document.getElementById('playIcon');
const loopBtn       = document.getElementById('loopBtn');
const skipBBtn      = document.getElementById('skipBBtn');
const skipFBtn      = document.getElementById('skipFBtn');
const muteBtn       = document.getElementById('muteBtn');
const volSlider     = document.getElementById('volSlider');
const volVal        = document.getElementById('volVal');
const speedSlider   = document.getElementById('speedSlider');
const speedVal      = document.getElementById('speedVal');
const progressFill  = document.getElementById('progressFill');
const progressThumb = document.getElementById('progressThumb');
const progressTrack = document.getElementById('progressTrack');
const timeCurrent   = document.getElementById('timeCurrent');
const timeDuration  = document.getElementById('timeDuration');
const statusDot     = document.getElementById('statusDot');
const vizBars       = document.getElementById('vizBars');
const toast         = document.getElementById('toast');

// ── Build visualizer bars ─────────────────────────────────────────────────────
const NUM_BARS = 40;
const bars     = [];

for (let i = 0; i < NUM_BARS; i++) {
  const b = document.createElement('div');
  b.className = 'bar';
  b.style.cssText =
    `flex:1; height:4px;` +
    `background: rgba(174,169,236,${0.4 + (i % 3) * 0.1});` +
    `border-radius: 2px 2px 0 0; transition: height 0.08s ease;`;
  vizBars.appendChild(b);
  bars.push(b);
}

// ── Utility helpers ───────────────────────────────────────────────────────────

/**
 * Format seconds as M:SS
 * @param {number} s
 * @returns {string}
 */
function fmt(s) {
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
}

/**
 * Show a brief toast notification in the visualizer area
 * @param {string} msg
 */
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), 1400);
}

// ── Generate demo audio buffer ────────────────────────────────────────────────
/**
 * Procedurally synthesises a 30-second tone sequence using additive synthesis.
 * No external file needed — works offline.
 * @returns {AudioBuffer}
 */
function generateDemoBuffer() {
  const duration = 30;
  const sr       = ctx.sampleRate;
  const buf      = ctx.createBuffer(2, duration * sr, sr);
  const notes    = [261.63, 293.66, 329.63, 349.23, 392, 440, 493.88, 523.25]; // C4–C5
  const noteLen  = sr * 0.6; // each note lasts 0.6 s

  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);

    for (let i = 0; i < data.length; i++) {
      const noteIdx = Math.floor(i / noteLen) % notes.length;
      const freq    = notes[noteIdx];
      const t       = i / sr;

      // Simple ADSR-style envelope per note
      const posInNote = i % noteLen;
      const attack    = Math.min(1, posInNote / (sr * 0.02));
      const release   = Math.max(0, 1 - posInNote / (sr * 0.5));
      const env       = attack * release;

      // Additive synthesis: fundamental + 2nd + 3rd harmonic
      data[i] = Math.sin(2 * Math.PI * freq * t)       * 0.35 * env
              + Math.sin(2 * Math.PI * freq * 2 * t)   * 0.12 * env
              + Math.sin(2 * Math.PI * freq * 3 * t)   * 0.07 * env;

      // Slight stereo detune on right channel
      if (ch === 1) {
        data[i] += Math.sin(2 * Math.PI * (freq * 1.003) * t) * 0.1 * env;
      }
    }
  }

  return buf;
}

// ── Audio lifecycle ───────────────────────────────────────────────────────────

/**
 * Create a fresh AudioBufferSourceNode.
 * A new node must be created each time play() is called because
 * AudioBufferSourceNode can only be started once.
 */
function makeSource() {
  source = ctx.createBufferSource();
  source.buffer             = audioBuffer;
  source.playbackRate.value = parseFloat(speedSlider.value);
  source.loop               = loopOn;
  source.connect(gainNode);

  source.onended = () => {
    if (!loopOn) {
      isPlaying   = false;
      pauseOffset = 0;
      updatePlayIcon();
      statusDot.style.display = 'none';
      cancelAnimationFrame(rafId);
      cancelAnimationFrame(vizRafId);
    }
  };
}

/** Start (or resume) playback from pauseOffset */
function play() {
  if (!audioBuffer) return;
  if (ctx.state === 'suspended') ctx.resume();

  makeSource();
  source.start(0, pauseOffset);
  startTime = ctx.currentTime - pauseOffset;
  isPlaying = true;

  updatePlayIcon();
  statusDot.style.display = '';
  tickProgress();
  tickViz();
}

/** Pause playback and store the current offset */
function pause() {
  if (!isPlaying) return;

  pauseOffset = ctx.currentTime - startTime;
  source.stop();
  source    = null;
  isPlaying = false;

  updatePlayIcon();
  statusDot.style.display = 'none';
  cancelAnimationFrame(rafId);
  cancelAnimationFrame(vizRafId);
}

/** Swap the play icon between the play triangle and pause rectangles */
function updatePlayIcon() {
  playIcon.innerHTML = isPlaying
    ? `<rect x="6"  y="4" width="4" height="16" fill="white"/>
       <rect x="14" y="4" width="4" height="16" fill="white"/>`
    : `<polygon points="5,3 19,12 5,21" fill="white"/>`;
}

// ── Animation loops ───────────────────────────────────────────────────────────

/** Update progress bar + timestamp every frame */
function tickProgress() {
  if (!isPlaying) return;

  const elapsed = ctx.currentTime - startTime;
  const dur     = audioBuffer.duration;
  const pct     = Math.min(100, (elapsed / dur) * 100);

  progressFill.style.width = pct + '%';
  progressThumb.style.left = pct + '%';
  timeCurrent.textContent  = fmt(elapsed);

  rafId = requestAnimationFrame(tickProgress);
}

/** Read frequency data from AnalyserNode and animate bars */
function tickViz() {
  if (!isPlaying) return;

  analyser.getByteFrequencyData(freqData);
  const step = Math.floor(freqData.length / NUM_BARS);

  for (let i = 0; i < NUM_BARS; i++) {
    const magnitude = (freqData[i * step] || 0) / 255;
    bars[i].style.height = Math.max(3, magnitude * 64) + 'px';
  }

  vizRafId = requestAnimationFrame(tickViz);
}

// ── Seek ──────────────────────────────────────────────────────────────────────

/** Return current playback position in seconds */
function currentTime() {
  return isPlaying ? ctx.currentTime - startTime : pauseOffset;
}

/**
 * Jump to a specific time in the track
 * @param {number} newT - target time in seconds
 */
function seekTo(newT) {
  newT = Math.max(0, Math.min(audioBuffer.duration, newT));

  if (isPlaying) {
    pause();
    pauseOffset = newT;
    play();
  } else {
    pauseOffset = newT;
    const pct = (newT / audioBuffer.duration) * 100;
    progressFill.style.width = pct + '%';
    progressThumb.style.left = pct + '%';
    timeCurrent.textContent  = fmt(newT);
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

// Play / Pause button
playBtn.addEventListener('click', () => {
  isPlaying ? pause() : play();
});

// Loop toggle
loopBtn.addEventListener('click', () => {
  loopOn = !loopOn;
  if (source) source.loop = loopOn;
  loopBtn.classList.toggle('active', loopOn);
  showToast(loopOn ? 'Loop on' : 'Loop off');
});

// Mute / Unmute
muteBtn.addEventListener('click', () => {
  muted = !muted;
  gainNode.gain.setTargetAtTime(muted ? 0 : lastVol, ctx.currentTime, 0.05);
  muteBtn.classList.toggle('active', muted);

  const ic = document.getElementById('volIcon');
  if (muted) {
    ic.innerHTML =
      `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
       <line x1="23" y1="9"  x2="17" y2="15"/>
       <line x1="17" y1="9"  x2="23" y2="15"/>`;
  } else {
    ic.innerHTML =
      `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
       <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
       <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`;
  }
  showToast(muted ? 'Muted' : 'Unmuted');
});

// Skip back 10 seconds
skipBBtn.addEventListener('click', () => {
  if (audioBuffer) { seekTo(currentTime() - 10); showToast('-10s'); }
});

// Skip forward 10 seconds
skipFBtn.addEventListener('click', () => {
  if (audioBuffer) { seekTo(currentTime() + 10); showToast('+10s'); }
});

// Volume slider
volSlider.addEventListener('input', () => {
  const v = parseInt(volSlider.value) / 100;
  lastVol = v;
  if (!muted) gainNode.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
  volVal.textContent = volSlider.value + '%';
});

// Playback speed slider
speedSlider.addEventListener('input', () => {
  const v = parseFloat(speedSlider.value);
  speedVal.textContent = v + 'x';
  if (source) source.playbackRate.value = v;

  // Restart at same offset so speed change takes effect immediately
  if (isPlaying) {
    const off = currentTime();
    pause();
    pauseOffset = off;
    play();
  }
  showToast(v + 'x speed');
});

// Click to seek on the progress bar
progressTrack.addEventListener('click', e => {
  if (!audioBuffer) return;
  const rect = progressTrack.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  seekTo(pct * audioBuffer.duration);
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  // Don't fire when typing in an input field
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      isPlaying ? pause() : play();
      break;
    case 'm': case 'M':
      muteBtn.click();
      break;
    case 'l': case 'L':
      loopBtn.click();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      skipBBtn.click();
      break;
    case 'ArrowRight':
      e.preventDefault();
      skipFBtn.click();
      break;
    case 'ArrowUp':
      e.preventDefault();
      volSlider.value = Math.min(100, +volSlider.value + 5);
      volSlider.dispatchEvent(new Event('input'));
      break;
    case 'ArrowDown':
      e.preventDefault();
      volSlider.value = Math.max(0, +volSlider.value - 5);
      volSlider.dispatchEvent(new Event('input'));
      break;
  }
});

// ── Initialise ────────────────────────────────────────────────────────────────
audioBuffer = generateDemoBuffer();
timeDuration.textContent = fmt(audioBuffer.duration);
