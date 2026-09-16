(() => {
  if (window.__glimpInstalled) return;
  window.__glimpInstalled = true;

  const WRAPPER_ID = 'glimp-camera-wrapper';
  const VIDEO_ID = 'glimp-camera-video';
  const PLACEHOLDER_ID = 'glimp-camera-placeholder';
  const SHUTTER_ID = 'glimp-camera-shutter';
  const PIN_BADGE_ID = 'glimp-camera-pin-badge';
  const REC_BADGE_ID = 'glimp-camera-rec-badge';
  const EXTENSION_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');

  let wrapper = null;
  let video = null;
  let placeholder = null;
  let shutter = null;
  let pinBadge = null;
  let recBadge = null;
  let recTimeEl = null;
  let isVisible = false;
  let stopTimeout = null;
  let permissionDenied = false;

  let channel = null;
  let frameReady = false;
  let pendingStart = false;
  let cameraActive = false;
  let modifiersPrewarmed = false;
  let pinned = false;
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let isRecording = false;
  let recordingStartedAt = 0;
  let recordingTimerInterval = null;

  function isLKey(event) {
    return event.code === 'KeyL' || (event.key && event.key.toLowerCase() === 'l');
  }

  function isPKey(event) {
    return event.code === 'KeyP' || (event.key && event.key.toLowerCase() === 'p');
  }

  function isRKey(event) {
    return event.code === 'KeyR' || (event.key && event.key.toLowerCase() === 'r');
  }

  function isModifierHeld(event) {
    return event.ctrlKey || event.metaKey;
  }

  function isShortcutKey(event) {
    return (
      isLKey(event) ||
      event.code === 'ControlLeft' ||
      event.code === 'ControlRight' ||
      event.code === 'ShiftLeft' ||
      event.code === 'ShiftRight' ||
      event.code === 'MetaLeft' ||
      event.code === 'MetaRight'
    );
  }

  function createOverlay() {
    if (document.getElementById(WRAPPER_ID)) return;

    wrapper = document.createElement('div');
    wrapper.id = WRAPPER_ID;
    wrapper.setAttribute('role', 'dialog');
    wrapper.setAttribute('aria-label', 'Camera preview');

    // The camera lives in an extension-origin iframe (not a <video> fed by a
    // page-scoped getUserMedia call) so the permission grant is tied to this
    // extension's own origin and persists across every site instead of
    // re-prompting per site.
    video = document.createElement('iframe');
    video.id = VIDEO_ID;
    video.setAttribute('allow', 'camera; microphone');
    video.setAttribute('frameborder', '0');
    video.addEventListener('load', initFrameChannel, { once: true });
    video.src = chrome.runtime.getURL('camera-frame.html');

    placeholder = document.createElement('div');
    placeholder.id = PLACEHOLDER_ID;
    const spinner = document.createElement('div');
    spinner.className = 'glimp-spinner';
    placeholder.appendChild(spinner);

    shutter = document.createElement('div');
    shutter.id = SHUTTER_ID;

    pinBadge = document.createElement('div');
    pinBadge.id = PIN_BADGE_ID;
    pinBadge.textContent = 'Pinned';

    recBadge = document.createElement('div');
    recBadge.id = REC_BADGE_ID;
    const recDot = document.createElement('span');
    recDot.className = 'glimp-rec-dot';
    recTimeEl = document.createElement('span');
    recTimeEl.className = 'glimp-rec-time';
    recTimeEl.textContent = '0:00';
    recBadge.appendChild(recDot);
    recBadge.appendChild(recTimeEl);

    wrapper.appendChild(video);
    wrapper.appendChild(placeholder);
    wrapper.appendChild(shutter);
    wrapper.appendChild(pinBadge);
    wrapper.appendChild(recBadge);
    wrapper.addEventListener('mousedown', startDrag);

    if (document.body) {
      document.body.appendChild(wrapper);
    } else {
      document.documentElement.appendChild(wrapper);
    }
  }

  function initFrameChannel() {
    channel = new MessageChannel();
    channel.port1.onmessage = handleFrameMessage;
    frameReady = true;
    video.contentWindow.postMessage({ type: 'GLIMP_INIT' }, EXTENSION_ORIGIN, [channel.port2]);

    if (pendingStart) {
      pendingStart = false;
      sendStart();
    }
  }

  function handleFrameMessage(event) {
    const data = event.data;
    if (!data) return;

    if (data.type === 'GLIMP_STARTED') {
      cameraActive = true;
      permissionDenied = false;
      if (video) video.classList.add('glimp-active');
    } else if (data.type === 'GLIMP_ERROR') {
      cameraActive = false;
      console.error('Glimp camera error:', data.message);
      if (!permissionDenied) {
        permissionDenied = true;
        openPermissionPage();
      }
      hideOverlay(true);
    } else if (data.type === 'GLIMP_CAPTURED') {
      downloadBlob(data.blob, 'png');
    } else if (data.type === 'GLIMP_RECORDING_STOPPED') {
      downloadBlob(data.blob, 'webm');
    } else if (data.type === 'GLIMP_RECORD_ERROR') {
      console.error('Glimp recording error:', data.message);
      resetRecordingUi();
    }
  }

  function sendStart() {
    if (!channel) return;
    channel.port1.postMessage({ type: 'GLIMP_START' });
  }

  function startCamera() {
    if (cameraActive) return;
    if (!frameReady) {
      pendingStart = true;
      return;
    }
    sendStart();
  }

  function stopCamera() {
    if (channel) {
      channel.port1.postMessage({ type: 'GLIMP_STOP' });
    }
    cameraActive = false;
    if (video) {
      video.classList.remove('glimp-active');
    }
  }

  function showOverlay() {
    clearTimeout(stopTimeout);
    createOverlay();
    isVisible = true;
    modifiersPrewarmed = false;
    if (wrapper) {
      wrapper.classList.add('glimp-active');
    }
    startCamera();
  }

  function cancelPrewarm() {
    if (!modifiersPrewarmed) return;
    modifiersPrewarmed = false;
    stopCamera();
  }

  function setPinned(value) {
    pinned = value;
    if (pinBadge) {
      pinBadge.classList.toggle('glimp-active', value);
    }
    if (wrapper) {
      wrapper.classList.toggle('glimp-pinned', value);
    }
    if (!value) {
      endDrag();
      // Unpinning implies going back to release-to-close — an active
      // recording would otherwise keep running invisibly and be lost the
      // moment the keys are released.
      stopRecording();
    }
  }

  function startRecording() {
    if (isRecording || !cameraActive || !channel) return;
    // Recording only makes sense if the preview sticks around; this is what
    // makes Cmd/Ctrl+Shift+L+R (L already held, then R) pin-and-record in
    // one motion without a separate combo to detect.
    if (!pinned) {
      setPinned(true);
    }
    isRecording = true;
    recordingStartedAt = Date.now();
    updateRecordingTimer();
    recordingTimerInterval = setInterval(updateRecordingTimer, 1000);
    // The recording indicator replaces the pinned badge while active —
    // showing both is redundant since recording already implies pinned.
    if (pinBadge) {
      pinBadge.classList.remove('glimp-active');
    }
    if (recBadge) {
      recBadge.classList.add('glimp-active');
    }
    channel.port1.postMessage({ type: 'GLIMP_RECORD_START' });
  }

  function updateRecordingTimer() {
    if (!recTimeEl) return;
    const elapsed = Math.floor((Date.now() - recordingStartedAt) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    recTimeEl.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function resetRecordingUi() {
    isRecording = false;
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
    if (recBadge) {
      recBadge.classList.remove('glimp-active');
    }
    if (recTimeEl) {
      recTimeEl.textContent = '0:00';
    }
    // Bring the pinned badge back, but only if we're still pinned — when
    // this runs because setPinned(false) is unpinning/closing, pinned is
    // already false by the time we get here, so it correctly stays hidden.
    if (pinBadge) {
      pinBadge.classList.toggle('glimp-active', pinned);
    }
  }

  function stopRecording() {
    if (!isRecording) return;
    resetRecordingUi();
    if (channel) {
      channel.port1.postMessage({ type: 'GLIMP_RECORD_STOP' });
    }
  }

  function downloadBlob(blob, extension) {
    if (!blob) return;

    const url = URL.createObjectURL(blob);
    const filename = `glimp-${Date.now()}.${extension}`;
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function resetDragPosition() {
    if (!wrapper) return;
    wrapper.style.left = '';
    wrapper.style.top = '';
    wrapper.style.marginLeft = '';
  }

  function startDrag(event) {
    if (!pinned || !wrapper) return;
    event.preventDefault();
    const rect = wrapper.getBoundingClientRect();
    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
    isDragging = true;
    wrapper.classList.add('glimp-dragging');
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', endDrag);
  }

  function onDragMove(event) {
    if (!isDragging || !wrapper) return;
    const maxLeft = Math.max(window.innerWidth - wrapper.offsetWidth, 0);
    const maxTop = Math.max(window.innerHeight - wrapper.offsetHeight, 0);
    const left = Math.min(Math.max(event.clientX - dragOffsetX, 0), maxLeft);
    const top = Math.min(Math.max(event.clientY - dragOffsetY, 0), maxTop);
    wrapper.style.left = `${left}px`;
    wrapper.style.top = `${top}px`;
    wrapper.style.marginLeft = '0';
  }

  function endDrag() {
    if (!isDragging) return;
    isDragging = false;
    if (wrapper) {
      wrapper.classList.remove('glimp-dragging');
    }
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', endDrag);
  }

  function hideOverlay(immediate = false) {
    isVisible = false;
    setPinned(false);
    resetDragPosition();
    if (wrapper) {
      wrapper.classList.remove('glimp-active');
    }

    clearTimeout(stopTimeout);
    if (immediate) {
      stopCamera();
    } else {
      // Keep the camera warm for 1 second so quick re-opens are instant.
      stopTimeout = setTimeout(() => stopCamera(), 1000);
    }
  }

  function triggerShutter() {
    if (!shutter) return;
    shutter.classList.remove('glimp-active');
    // Force reflow so the animation can restart if triggered rapidly.
    void shutter.offsetWidth;
    shutter.classList.add('glimp-active');
  }

  function captureImage() {
    if (!cameraActive || !channel) return;

    triggerShutter();
    playCaptureSound();
    channel.port1.postMessage({ type: 'GLIMP_CAPTURE' });
  }

  function playCaptureSound() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.08);
      setTimeout(() => ctx.close(), 200);
    } catch (e) {
      console.error('Glimp: failed to play capture sound', e);
    }
  }

  function openPermissionPage() {
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_PERMISSION_PAGE' });
    } catch (e) {
      console.error('Glimp: failed to open permission page', e);
    }
  }

  document.addEventListener('keydown', (event) => {
    if (event.repeat) return;

    if (isVisible && event.code === 'Escape') {
      event.preventDefault();
      hideOverlay();
      return;
    }

    if (isVisible && event.code === 'Enter') {
      event.preventDefault();
      captureImage();
      return;
    }

    // Pressing P while the preview is open pins it open — releasing the
    // shortcut keys no longer closes it; only Escape does.
    if (isVisible && !pinned && isPKey(event)) {
      event.preventDefault();
      setPinned(true);
      return;
    }

    // R toggles recording. Pressing it while the base combo is still held
    // (Cmd/Ctrl+Shift+L+R in one motion) both pins and starts recording,
    // since startRecording() pins implicitly if needed — no separate
    // four-key combo detection required.
    if (isVisible && isRKey(event)) {
      event.preventDefault();
      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
      return;
    }

    // Pressing the same open shortcut again while pinned toggles the pin
    // back off — the very next release then closes it as usual.
    if (isVisible && pinned && isLKey(event) && isModifierHeld(event) && event.shiftKey) {
      event.preventDefault();
      setPinned(false);
      return;
    }

    if (isLKey(event) && isModifierHeld(event) && event.shiftKey && !isVisible) {
      event.preventDefault();
      showOverlay();
      return;
    }

    // Both modifiers are down but L hasn't landed yet — warm the camera up
    // now so it's already live by the time L is pressed. If this combo turns
    // out to be some other shortcut (Cmd+Shift+T, Cmd+Shift+N, ...), the
    // keyup/blur handlers below cancel it again.
    if (!isVisible && !isLKey(event) && isModifierHeld(event) && event.shiftKey && !modifiersPrewarmed) {
      modifiersPrewarmed = true;
      startCamera();
    }
  });

  document.addEventListener('keyup', (event) => {
    if (isVisible && !pinned && isShortcutKey(event)) {
      hideOverlay();
      return;
    }

    if (!isVisible && isShortcutKey(event)) {
      cancelPrewarm();
    }
  });

  window.addEventListener('blur', () => {
    if (isVisible) {
      // A plain tab switch also fires window blur (not just switching to a
      // different application), so this needs the same pinned exemption as
      // visibilitychange below — otherwise this fires first and closes it
      // anyway. Net effect: pinned now also survives switching applications
      // entirely, not just switching tabs, since blur doesn't distinguish
      // the two.
      if (pinned) return;
      hideOverlay(true);
    } else {
      cancelPrewarm();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    if (isVisible) {
      // Pinning means "stay open until Escape" — switching tabs shouldn't
      // count as closing it. The camera keeps running in this background
      // tab until you come back and press Escape (keyboard shortcuts can't
      // reach a tab that isn't focused, so Esc/Enter won't work from
      // elsewhere in the meantime).
      if (pinned) return;
      hideOverlay(true);
    } else {
      cancelPrewarm();
    }
  });

  // Preload the overlay element as soon as the page is ready so the first
  // shortcut press opens instantly without waiting for DOM creation.
  createOverlay();
})();
