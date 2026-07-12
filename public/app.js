// ============================================================
// Zirkel Timer - Hauptlogik
// ============================================================

(function () {
  'use strict';

  // --- DOM Elements ---
  const setupScreen = document.getElementById('setup-screen');
  const timerScreen = document.getElementById('timer-screen');
  const settingsForm = document.getElementById('settings-form');
  const phaseLabel = document.getElementById('phase-label');
  const timerDisplay = document.getElementById('timer-display');
  const roundInfo = document.getElementById('round-info');
  const intervalInfo = document.getElementById('interval-info');
  const totalElapsed = document.getElementById('total-elapsed');
  const btnPause = document.getElementById('btn-pause');
  const btnStop = document.getElementById('btn-stop');

  // --- Settings Fields ---
  const fields = {
    warmup: document.getElementById('warmup'),
    rounds: document.getElementById('rounds'),
    intervals: document.getElementById('intervals'),
    'interval-time': document.getElementById('interval-time'),
    'pause-time': document.getElementById('pause-time'),
    'round-pause-time': document.getElementById('round-pause-time'),
    countdown: document.getElementById('countdown'),
  };

  // --- State ---
  let timerTimeout = null;
  let timerRunning = false;
  let lastTickTime = 0;
  let isPaused = false;
  let totalSeconds = 0;
  let phases = [];
  let currentPhaseIndex = 0;
  let currentPhaseRemaining = 0;
  let audioCtx = null;
  let compressor = null;

  // ============================================================
  // Audio - Web Audio API
  // ============================================================

  async function getAudioContext() {
    if (!audioCtx) {
      try {
        // Safari/WebKit: 'ambient' mixes with background music
        // instead of interrupting it (supported since Safari 16+)
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 44100,
        });
      } catch (e) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }

      // DynamicsCompressor allows high gain without clipping
      compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-6, audioCtx.currentTime);
      compressor.knee.setValueAtTime(3, audioCtx.currentTime);
      compressor.ratio.setValueAtTime(4, audioCtx.currentTime);
      compressor.attack.setValueAtTime(0.003, audioCtx.currentTime);
      compressor.release.setValueAtTime(0.1, audioCtx.currentTime);
      compressor.connect(audioCtx.destination);

      // Use a silent buffer trick to keep audio session "ambient" on iOS:
      // Play a short silent buffer immediately to establish the session
      // without interrupting music
      if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
        const silentBuffer = audioCtx.createBuffer(1, 1, 44100);
        const source = audioCtx.createBufferSource();
        source.buffer = silentBuffer;
        source.connect(audioCtx.destination);
        source.start(0);
      }
    }
    // Await the resume so the context is fully active before we play anything
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    return audioCtx;
  }

  async function playTone(frequency, duration, type = 'sine', volume = 1) {
    const ctx = await getAudioContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);

    // Multiply volume by 4 - compressor prevents clipping
    gainNode.gain.setValueAtTime(volume * 4, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);

    oscillator.connect(gainNode);
    gainNode.connect(compressor);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + duration);
  }

  function playCountdownBeep() {
    playTone(800, 0.1, 'sine', 1.0);
  }

  function playCountdownFinal() {
    playTone(1200, 0.4, 'sine', 1.0);
  }

  function playExerciseStart() {
    // Hoher langer Ton
    playTone(880, 0.5, 'sine', 1.0);
  }

  function playPauseStart() {
    // Tiefer kurzer Ton
    playTone(400, 0.3, 'triangle', 1.0);
  }

  function playRoundPauseStart() {
    // Doppelter Ton
    playTone(600, 0.2, 'sine', 1.0);
    setTimeout(() => playTone(600, 0.2, 'sine', 1.0), 300);
  }

  function playWorkoutDone() {
    // Dreifacher aufsteigender Ton
    playTone(523, 0.3, 'sine', 1.0);
    setTimeout(() => playTone(659, 0.3, 'sine', 1.0), 350);
    setTimeout(() => playTone(784, 0.5, 'sine', 1.0), 700);
  }

  // ============================================================
  // URL Parameter Management
  // ============================================================

  function loadSettingsFromURL() {
    const params = new URLSearchParams(window.location.search);
    for (const [key, input] of Object.entries(fields)) {
      const val = params.get(key);
      if (val !== null && !isNaN(parseInt(val))) {
        input.value = parseInt(val);
      }
    }
  }

  function saveSettingsToURL() {
    const params = new URLSearchParams();
    for (const [key, input] of Object.entries(fields)) {
      params.set(key, input.value);
    }
    const newURL = window.location.pathname + '?' + params.toString();
    window.history.replaceState({}, '', newURL);
  }

  function getSettings() {
    return {
      warmup: parseInt(fields.warmup.value) || 0,
      rounds: parseInt(fields.rounds.value) || 1,
      intervals: parseInt(fields.intervals.value) || 1,
      intervalTime: parseInt(fields['interval-time'].value) || 30,
      pauseTime: parseInt(fields['pause-time'].value) || 0,
      roundPauseTime: parseInt(fields['round-pause-time'].value) || 0,
      countdown: parseInt(fields.countdown.value) || 0,
    };
  }

  // ============================================================
  // Phase Building
  // ============================================================

  // Jede Phase: { type, duration, round, interval, label }
  function buildPhases(settings) {
    const p = [];

    // Warmup
    if (settings.warmup > 0) {
      p.push({
        type: 'warmup',
        duration: settings.warmup,
        label: 'Warmup',
        round: 0,
        interval: 0,
      });
    }

    for (let r = 1; r <= settings.rounds; r++) {
      for (let i = 1; i <= settings.intervals; i++) {
        // Intervall (Übung)
        p.push({
          type: 'exercise',
          duration: settings.intervalTime,
          label: `Übung`,
          round: r,
          interval: i,
        });

        // Pause zwischen Intervallen (nicht nach dem letzten Intervall einer Runde)
        if (i < settings.intervals && settings.pauseTime > 0) {
          p.push({
            type: 'pause',
            duration: settings.pauseTime,
            label: 'Pause',
            round: r,
            interval: i,
          });
        }
      }

      // Pause zwischen Runden (nicht nach der letzten Runde)
      if (r < settings.rounds && settings.roundPauseTime > 0) {
        p.push({
          type: 'round-pause',
          duration: settings.roundPauseTime,
          label: 'Rundenpause',
          round: r,
          interval: 0,
        });
      }
    }

    return p;
  }

  // ============================================================
  // Timer Logic
  // ============================================================

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function updateDisplay() {
    const phase = phases[currentPhaseIndex];
    if (!phase) return;

    const settings = getSettings();

    phaseLabel.textContent = phase.label;
    timerDisplay.textContent = formatTime(currentPhaseRemaining);
    roundInfo.textContent = `Runde ${phase.round}/${settings.rounds}`;
    intervalInfo.textContent = `Intervall ${phase.interval}/${settings.intervals}`;
    totalElapsed.textContent = formatTime(totalSeconds);

    // Update background color based on phase
    timerScreen.className = 'screen phase-' + phase.type;

    // Show/hide round and interval info based on phase
    if (phase.type === 'warmup') {
      roundInfo.textContent = '';
      intervalInfo.textContent = '';
    } else if (phase.type === 'round-pause') {
      intervalInfo.textContent = '';
    }
  }

  function playPhaseStartSound(phase) {
    switch (phase.type) {
      case 'warmup':
        // Kein Sound am Anfang des Warmups
        break;
      case 'exercise':
        playExerciseStart();
        break;
      case 'pause':
        playPauseStart();
        break;
      case 'round-pause':
        playRoundPauseStart();
        break;
    }
  }

  function startPhase(index) {
    if (index >= phases.length) {
      // Workout fertig!
      finishWorkout();
      return;
    }

    currentPhaseIndex = index;
    const phase = phases[index];
    currentPhaseRemaining = phase.duration;

    // Play sound at phase start (except for first phase warmup)
    if (index > 0 || phase.type !== 'warmup') {
      playPhaseStartSound(phase);
    }

    updateDisplay();
  }

  // Advance state by 1 second without sounds — used to catch up after device sleep.
  function advanceSilently() {
    currentPhaseRemaining--;
    totalSeconds++;

    if (currentPhaseRemaining < 0) {
      currentPhaseIndex++;
      if (currentPhaseIndex >= phases.length) {
        timerRunning = false;
        finishWorkout();
        return;
      }
      currentPhaseRemaining = phases[currentPhaseIndex].duration;
    }
  }

  function tick() {
    const countdownSecs = parseInt(fields.countdown.value) || 3;

    // Akustischer Countdown in den letzten Sekunden jeder Phase
    // (signalisiert, dass gleich etwas Neues kommt)
    if (currentPhaseRemaining > 0 && currentPhaseRemaining <= countdownSecs) {
      playCountdownBeep();
    }

    currentPhaseRemaining--;
    totalSeconds++;

    if (currentPhaseRemaining < 0) {
      // Phase ist vorbei, nächste Phase starten
      startPhase(currentPhaseIndex + 1);
    } else {
      updateDisplay();
    }
  }

  // Schedule the next tick, correcting for how long the current tick actually took.
  // This prevents drift: if a tick fires 50 ms late, the next one fires 50 ms early.
  function scheduleNextTick() {
    if (!timerRunning || isPaused) return;
    const elapsed = Date.now() - lastTickTime;
    const delay = Math.max(0, 1000 - elapsed);
    timerTimeout = setTimeout(runTick, delay);
  }

  function runTick() {
    if (!timerRunning || isPaused) return;

    const now = Date.now();
    const elapsed = now - lastTickTime;
    // How many whole seconds passed (normally 1; more if the device was asleep)
    const ticks = Math.max(1, Math.round(elapsed / 1000));
    lastTickTime = now;

    // Silently advance state for any missed seconds so the display jumps to
    // the correct position without replaying stale sounds.
    for (let i = 0; i < ticks - 1 && timerRunning; i++) {
      advanceSilently();
    }

    // Play the current second normally (with sounds)
    if (timerRunning) {
      tick();
    }

    scheduleNextTick();
  }

  function finishWorkout() {
    timerRunning = false;
    clearTimeout(timerTimeout);
    timerTimeout = null;

    playWorkoutDone();

    phaseLabel.textContent = 'FERTIG!';
    timerDisplay.textContent = formatTime(totalSeconds);
    roundInfo.textContent = '';
    intervalInfo.textContent = '';
    timerScreen.className = 'screen phase-done';
    btnPause.style.display = 'none';
  }

  function startTimer() {
    const settings = getSettings();
    saveSettingsToURL();

    phases = buildPhases(settings);

    if (phases.length === 0) {
      alert('Keine Phasen konfiguriert!');
      return;
    }

    // Reset state
    totalSeconds = 0;
    isPaused = false;
    btnPause.textContent = 'PAUSE';
    btnPause.style.display = 'block';

    // Switch screens
    setupScreen.classList.add('hidden');
    timerScreen.classList.remove('hidden');

    // Initialize audio context (needs user interaction)
    getAudioContext();

    // Start first phase
    startPhase(0);

    // Start the tick loop
    timerRunning = true;
    lastTickTime = Date.now();
    scheduleNextTick();
  }

  function stopTimer() {
    timerRunning = false;
    clearTimeout(timerTimeout);
    timerTimeout = null;
    isPaused = false;

    // Switch back to setup
    timerScreen.classList.add('hidden');
    setupScreen.classList.remove('hidden');

    // Remove phase classes
    timerScreen.className = 'screen hidden';
  }

  function togglePause() {
    if (!timerRunning) return; // Already finished

    isPaused = !isPaused;
    btnPause.textContent = isPaused ? 'WEITER' : 'PAUSE';

    if (isPaused) {
      btnPause.classList.add('paused');
      clearTimeout(timerTimeout);
      timerTimeout = null;
    } else {
      btnPause.classList.remove('paused');
      // Reset lastTickTime so we don't count the paused duration as elapsed
      lastTickTime = Date.now();
      scheduleNextTick();
    }
  }

  // ============================================================
  // Event Listeners
  // ============================================================

  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    startTimer();
  });

  btnPause.addEventListener('click', togglePause);
  btnStop.addEventListener('click', stopTimer);

  // Prevent screen from sleeping (if supported)
  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (err) {
      // Wake Lock not supported or failed
    }
  }

  // Load settings from URL on page load
  loadSettingsFromURL();

  // Also request wake lock on start
  settingsForm.addEventListener('submit', () => {
    requestWakeLock();
  });

  document.getElementById('btn-stop').addEventListener('click', () => {
    if (wakeLock) {
      wakeLock.release();
      wakeLock = null;
    }
  });

  // iOS suspends the AudioContext whenever you switch to another app.
  // resume() only works from inside a user-gesture handler (touchstart qualifies).
  // We hook every possible re-entry point so the first tap after returning
  // to Safari unblocks audio before the next beep fires.
  function tryResumeAudio() {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  document.addEventListener('touchstart', tryResumeAudio, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tryResumeAudio();
  });
  window.addEventListener('focus', tryResumeAudio);
  window.addEventListener('pageshow', tryResumeAudio);

})();
