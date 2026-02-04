// DOM Elements
const video = document.getElementById("video");
const videoContainer = document.getElementById("videoContainer");
const playIcon = document.getElementById("playIcon");
const pauseIcon = document.getElementById("pauseIcon");
const volumeIcon = document.getElementById("volumeIcon");
const muteIcon = document.getElementById("muteIcon");
const qualityMenu = document.getElementById("qualityMenu");
const currentQuality = document.getElementById("currentQuality");
const bigPlayBtn = document.getElementById("bigPlayBtn");
const loadingSpinner = document.getElementById("loading");
const progressBar = document.getElementById("progressBar");
const bufferBar = document.getElementById("bufferBar");
const progressContainer = document.getElementById("progressContainer");
const volumeSlider = document.getElementById("volumeSlider");

const liveBadge = document.getElementById("liveBadge");
const errorOverlay = document.getElementById("errorOverlay");
const errorMessage = document.getElementById("errorMessage");
const statsOverlay = document.getElementById("statsOverlay");
const loadingStatus = document.getElementById("loadingStatus");
const p2pBadge = document.getElementById("p2pBadge");
const p2pBadgeText = document.getElementById("p2pBadgeText");
const debugBar = document.getElementById("debugBar");
const debugLog = document.getElementById("debugLog");
const debugBtn = document.getElementById("debugBtn");

let hls = null;
let p2pEngine = null;
let levels = [];
let controlsTimeout = null;
let isLive = true;
let statsInterval = null;
let bufferStallTimeout = null;
let retryCount = 0;
let isRecovering = false;
const BUFFER_STALL_THRESHOLD = 3000;
const BUFFER_STALL_RETRY = 8000;
const MAX_SILENT_RETRIES = 3;

// P2P Statistics tracking
let p2pStats = {
  totalHTTPDownloaded: 0,
  totalP2PDownloaded: 0,
  totalP2PUploaded: 0,
  peers: 0,
};

// Debug state
let debugState = {
  engineStatus: "checking",
  serverStatus: "disconnected",
  peerId: null,
  isVisible: false,
};
let debugInterval = null;

// HLS Configuration optimized for P2P
const hlsConfig = {
  // Buffer settings recommended for P2P
  maxBufferSize: 0,
  maxBufferLength: 15,
  liveSyncDurationCount: 10,

  // Low latency settings
  lowLatencyMode: true,
  liveDurationInfinity: true,
  liveBackBufferLength: 60,

  // Buffer hole handling
  maxBufferHole: 0.5,
  highBufferWatchdogPeriod: 2,

  // Start settings
  startLevel: -1,
  autoStartLoad: true,
  startPosition: -1,

  // ABR settings
  abrEwmaDefaultEstimate: 1000000,
  abrEwmaDefaultEstimateMax: 5000000,
  abrEwmaFastLive: 3,
  abrEwmaSlowLive: 9,
  abrBandWidthFactor: 0.95,
  abrBandWidthUpFactor: 0.7,
  abrMaxWithRealBitrate: true,

  // Fragment loading
  fragLoadingTimeOut: 20000,
  fragLoadingMaxRetry: 6,
  fragLoadingRetryDelay: 1000,
  fragLoadingMaxRetryTimeout: 64000,

  // Level/Manifest loading
  levelLoadingTimeOut: 10000,
  levelLoadingMaxRetry: 4,
  levelLoadingRetryDelay: 1000,
  manifestLoadingTimeOut: 10000,
  manifestLoadingMaxRetry: 4,
  manifestLoadingRetryDelay: 1000,

  // Streaming settings
  startFragPrefetch: true,
  testBandwidth: true,
  progressive: true,

  // Back buffer
  backBufferLength: 60,

  // Cap level on FPS drop
  capLevelOnFPSDrop: true,
  capLevelToPlayerSize: false,

  // Nudge settings
  nudgeOffset: 0.1,
  nudgeMaxRetry: 5,

  // Enable worker
  enableWorker: true,
  enableSoftwareAES: true,
};

// Initialize
function init() {
  const params = new URLSearchParams(window.location.search);
  const urlParam = params.get("url");
  if (urlParam) {
    document.getElementById("streamUrl").value = urlParam;
  }

  // Set initial volume
  video.volume = 0.8;
  volumeSlider.value = 80;
  video.muted = true;
  updateVolumeIcon();

  // Event listeners
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  video.addEventListener("waiting", onWaiting);
  video.addEventListener("playing", onPlaying);
  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("progress", onProgress);
  video.addEventListener("volumechange", onVolumeChange);
  video.addEventListener("click", togglePlay);
  video.addEventListener("dblclick", toggleFullscreen);

  videoContainer.addEventListener("mousemove", showControls);
  videoContainer.addEventListener("mouseleave", hideControlsDelayed);
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeyDown);
  document
    .getElementById("streamUrl")
    .addEventListener("keypress", onUrlKeypress);

  progressContainer.addEventListener("click", onProgressClick);
  volumeSlider.addEventListener("input", onVolumeSliderChange);

  // Update version info
  updateVersionInfo();

  loadStream();
}

function updateVersionInfo() {
  const versionEl = document.getElementById("statP2PVersion");
  if (versionEl) {
    const hlsVersion = typeof Hls !== "undefined" ? Hls.version : "N/A";
    const p2pVersion =
      typeof P2pEngineHls !== "undefined" ? P2pEngineHls.version : "N/A";
    versionEl.textContent = `HLS ${hlsVersion} / P2P ${p2pVersion}`;
  }
}

function loadStream(silent = false) {
  const url = document.getElementById("streamUrl").value.trim();
  if (!url) return;

  clearBufferStallTimer();

  if (!silent) {
    showLoading("Connecting...");
    retryCount = 0;
  } else {
    setLoadingStatus("Reconnecting...");
  }

  hideError();
  showBigPlay(false);
  isRecovering = false;

  // Reset P2P stats
  p2pStats = {
    totalHTTPDownloaded: 0,
    totalP2PDownloaded: 0,
    totalP2PUploaded: 0,
    peers: 0,
  };

  // Reset debug state
  debugState.engineStatus = "checking";
  debugState.serverStatus = "disconnected";
  debugState.peerId = null;

  addDebugLog(
    "info",
    "Loading stream: " + url.substring(0, 50) + (url.length > 50 ? "..." : ""),
  );

  updateP2PBadge("inactive");

  // Destroy existing instances
  if (p2pEngine) {
    p2pEngine.destroy();
    p2pEngine = null;
  }
  if (hls) {
    hls.destroy();
    hls = null;
  }

  // Determine if this is a live stream
  const isLiveStream =
    url.includes("live") ||
    url.includes("/streams/") ||
    !url.includes(".m3u8") ||
    url.includes("master.m3u8");

  // P2P Configuration
  const p2pConfig = {
    logLevel: "warn",
    live: isLiveStream,
    // Uncomment and add your token for production
    token: "RbhH_bNDR",
    trackerZone: "hk", // or 'hk' for Hong Kong
  };

  if (Hls.isSupported()) {
    // Create HLS instance
    hls = new Hls(hlsConfig);

    // Pass HLS instance to P2P config
    p2pConfig.hlsjsInstance = hls;

    // Standard HLS events
    hls.on(Hls.Events.MANIFEST_PARSED, onManifestParsed);
    hls.on(Hls.Events.MANIFEST_LOADING, () =>
      setLoadingStatus("Loading stream..."),
    );
    hls.on(Hls.Events.LEVEL_SWITCHED, onLevelSwitched);
    hls.on(Hls.Events.ERROR, onHlsError);
    hls.on(Hls.Events.FRAG_BUFFERED, onFragBuffered);
    hls.on(Hls.Events.FRAG_LOADING, () => {
      if (loadingSpinner.classList.contains("show")) {
        setLoadingStatus("Buffering...");
      }
    });

    // Load source and attach media
    hls.loadSource(url);
    hls.attachMedia(video);

    // Create P2P Engine after HLS is set up
    createP2PEngine(p2pConfig);
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    // Native HLS (Safari) - use Service Worker for P2P
    if (
      typeof P2pEngineHls !== "undefined" &&
      P2pEngineHls.tryRegisterServiceWorker
    ) {
      P2pEngineHls.tryRegisterServiceWorker(p2pConfig)
        .then(() => {
          video.src = url;
          createP2PEngine(p2pConfig);
        })
        .catch((err) => {
          console.warn("[P2P] Service Worker registration failed:", err);
          video.src = url;
        });
    } else {
      video.src = url;
    }

    video.addEventListener(
      "loadedmetadata",
      function () {
        video.play();
      },
      { once: true },
    );
  }
}

// Create and setup P2P Engine
function createP2PEngine(p2pConfig) {
  if (typeof P2pEngineHls === "undefined") {
    console.warn("[P2P] P2pEngineHls not available");
    debugState.engineStatus = "unavailable";
    addDebugLog("error", "P2P Engine not available - SDK not loaded");
    updateP2PBadge("inactive");
    return;
  }

  try {
    debugState.engineStatus = "connecting";
    addDebugLog("info", "Initializing P2P Engine...");

    p2pEngine = new P2pEngineHls(p2pConfig);

    debugState.engineStatus = "active";
    addDebugLog("success", "P2P Engine initialized successfully");
    addDebugLog(
      "info",
      `P2P SDK Version: ${P2pEngineHls.version || "unknown"}`,
    );
    updateP2PBadge("active");

    // Stats event - main source of P2P statistics
    p2pEngine.on(
      "stats",
      function ({
        totalHTTPDownloaded = 0,
        totalP2PDownloaded = 0,
        totalP2PUploaded = 0,
      }) {
        const prevP2P = p2pStats.totalP2PDownloaded;
        const prevHTTP = p2pStats.totalHTTPDownloaded;

        p2pStats.totalHTTPDownloaded = totalHTTPDownloaded;
        p2pStats.totalP2PDownloaded = totalP2PDownloaded;
        p2pStats.totalP2PUploaded = totalP2PUploaded;

        // Update badge with P2P ratio
        const total = totalHTTPDownloaded + totalP2PDownloaded;
        if (total > 0 && totalP2PDownloaded > 0) {
          const ratio = Math.round((totalP2PDownloaded / total) * 100);
          updateP2PBadge("connected", ratio);
        }
      },
    );

    // Fragment loaded event
    p2pEngine.on(
      "FRAG_LOADED",
      ({ url, sn, segId, loaded, duration, byP2p, fromPeerId }) => {
        const source = byP2p ? "P2P" : "HTTP";
        const fileName = url.substring(url.lastIndexOf("/") + 1).split("?")[0];
        const logType = byP2p ? "p2p" : "http";

        addDebugLog(logType, `${source}: ${fileName} (${formatBytes(loaded)})`);

        console.log(
          `[P2P] Fragment loaded: ${fileName} (${formatBytes(loaded)}) via ${source}`,
        );
      },
    );

    // Peer events
    p2pEngine.on("peers", function (peers) {
      const peerCount = Array.isArray(peers) ? peers.length : peers;
      const prevCount = p2pStats.peers;
      p2pStats.peers = peerCount;

      if (peerCount !== prevCount) {
        if (peerCount > prevCount) {
          addDebugLog("success", `Peer joined - Total peers: ${peerCount}`);
        } else {
          addDebugLog("warning", `Peer left - Total peers: ${peerCount}`);
        }
      }
      console.log("[P2P] Connected peers:", peerCount);
    });

    p2pEngine.on("peerId", function (peerId) {
      debugState.peerId = peerId;
      addDebugLog("success", `My Peer ID: ${peerId.substring(0, 16)}...`);
      console.log("[P2P] My peer ID:", peerId);
    });

    p2pEngine.on("serverConnected", function () {
      debugState.serverStatus = "connected";
      addDebugLog("success", "Connected to signaling server");
      console.log("[P2P] Connected to signaling server");
      updateP2PBadge("active");
    });

    p2pEngine.on("serverDisconnected", function () {
      debugState.serverStatus = "disconnected";
      addDebugLog("warning", "Disconnected from signaling server");
      console.log("[P2P] Disconnected from signaling server");
    });

    // Additional events for debugging
    p2pEngine.on("error", function (err) {
      addDebugLog("error", `P2P Error: ${err.message || err}`);
      console.error("[P2P] Error:", err);
    });

    console.log("[P2P] Engine initialized successfully");
  } catch (err) {
    debugState.engineStatus = "failed";
    addDebugLog(
      "error",
      `Failed to initialize P2P Engine: ${err.message || err}`,
    );
    console.error("[P2P] Failed to create engine:", err);
    updateP2PBadge("inactive");
  }
}

// Update P2P badge UI
function updateP2PBadge(state, ratio = 0) {
  if (!p2pBadge || !p2pBadgeText) return;

  p2pBadge.classList.remove("active", "connected");

  switch (state) {
    case "connected":
      p2pBadge.classList.add("connected");
      p2pBadgeText.textContent = `P2P ${ratio}%`;
      p2pBadge.title = `P2P CDN Active - ${ratio}% from peers`;
      break;
    case "active":
      p2pBadge.classList.add("active");
      p2pBadgeText.textContent = "P2P";
      p2pBadge.title = "P2P CDN Active - Connecting to peers";
      break;
    default:
      p2pBadgeText.textContent = "P2P";
      p2pBadge.title = "P2P CDN Inactive";
  }
}

// HLS Event Handlers
function onManifestParsed(event, data) {
  levels = data.levels;
  buildQualityMenu();
  retryCount = 0;
  hideLoading();
  video.play();
}

function onLevelSwitched(event, data) {
  updateCurrentQuality(data.level);
}

function onHlsError(event, data) {
  console.warn("HLS Error:", data.type, data.details);

  if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
    if (!isRecovering) {
      isRecovering = true;
      setLoadingStatus("Buffering...");
      showLoading();
    }
    return;
  }

  if (data.details === Hls.ErrorDetails.BUFFER_APPEND_ERROR) {
    console.log("Buffer append error, recovering...");
    if (retryCount < MAX_SILENT_RETRIES) {
      retryCount++;
      setTimeout(() => retryStream(true), 500);
    }
    return;
  }

  if (
    data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
    data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT
  ) {
    if (!isRecovering) {
      setLoadingStatus("Buffering...");
    }
    return;
  }

  if (data.fatal) {
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      if (retryCount < MAX_SILENT_RETRIES) {
        retryCount++;
        setLoadingStatus("Reconnecting...");
        showLoading();
        setTimeout(() => {
          if (hls) hls.startLoad();
        }, 1000);
        return;
      }
    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      setLoadingStatus("Recovering...");
      hls.recoverMediaError();
      return;
    }

    hideLoading();
    showError(getErrorMessage(data.details));
  }
}

function getErrorMessage(details) {
  const messages = {
    [Hls.ErrorDetails.MANIFEST_LOAD_ERROR]: "Stream not available",
    [Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT]: "Connection timeout",
    [Hls.ErrorDetails.MANIFEST_PARSING_ERROR]: "Invalid stream format",
    [Hls.ErrorDetails.LEVEL_LOAD_ERROR]: "Failed to load stream",
    [Hls.ErrorDetails.FRAG_LOAD_ERROR]: "Playback error",
  };
  return messages[details] || "Stream error";
}

function onFragBuffered() {
  hideLoading();
  isRecovering = false;
}

// Player Controls
function togglePlay() {
  if (video.paused) {
    video.play();
  } else {
    video.pause();
  }
}

function onPlay() {
  playIcon.style.display = "none";
  pauseIcon.style.display = "block";
  showBigPlay(false);
}

function onPause() {
  playIcon.style.display = "block";
  pauseIcon.style.display = "none";
  showBigPlay(true);
  clearBufferStallTimer();
}

function onWaiting() {
  startBufferStallTimer();
}

function onPlaying() {
  hideLoading();
  clearBufferStallTimer();
  isRecovering = false;
}

let stallStatusTimeout = null;
let stallRetryTimeout = null;

function startBufferStallTimer() {
  clearBufferStallTimer();

  stallStatusTimeout = setTimeout(() => {
    setLoadingStatus("Buffering...");
    showLoading();
  }, BUFFER_STALL_THRESHOLD);

  stallRetryTimeout = setTimeout(() => {
    if (retryCount < MAX_SILENT_RETRIES) {
      retryCount++;
      console.log("Buffer stall detected, auto-retrying...");
      retryStream(true);
    } else {
      setLoadingStatus("Stream stalled");
    }
  }, BUFFER_STALL_RETRY);
}

function clearBufferStallTimer() {
  if (stallStatusTimeout) {
    clearTimeout(stallStatusTimeout);
    stallStatusTimeout = null;
  }
  if (stallRetryTimeout) {
    clearTimeout(stallRetryTimeout);
    stallRetryTimeout = null;
  }
  if (bufferStallTimeout) {
    clearTimeout(bufferStallTimeout);
    bufferStallTimeout = null;
  }
}

function onTimeUpdate() {
  if (!video.duration || !isFinite(video.duration)) {
    progressBar.style.width = "100%";
    return;
  }

  const progress = (video.currentTime / video.duration) * 100;
  progressBar.style.width = `${progress}%`;
}

function onProgress() {
  if (video.buffered.length > 0) {
    const buffered = video.buffered.end(video.buffered.length - 1);
    const duration = video.duration || buffered;
    const bufferProgress = (buffered / duration) * 100;
    bufferBar.style.width = `${bufferProgress}%`;
  }
}

function onProgressClick(e) {
  if (!video.duration || !isFinite(video.duration)) return;
  const rect = progressContainer.getBoundingClientRect();
  const pos = (e.clientX - rect.left) / rect.width;
  video.currentTime = pos * video.duration;
}

function toggleMute() {
  video.muted = !video.muted;
  updateVolumeIcon();
}

function updateVolumeIcon() {
  if (video.muted || video.volume === 0) {
    volumeIcon.style.display = "none";
    muteIcon.style.display = "block";
  } else {
    volumeIcon.style.display = "block";
    muteIcon.style.display = "none";
  }
}

function onVolumeChange() {
  updateVolumeIcon();
  volumeSlider.value = video.muted ? 0 : video.volume * 100;
}

function onVolumeSliderChange() {
  const value = volumeSlider.value / 100;
  video.volume = value;
  video.muted = value === 0;
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    videoContainer.requestFullscreen();
  }
}

function jumpToLive() {
  if (hls && hls.liveSyncPosition) {
    video.currentTime = hls.liveSyncPosition;
  }
}

// Quality Menu
function toggleQualityMenu() {
  qualityMenu.classList.toggle("show");
}

function formatBitrate(bps) {
  if (bps >= 1000000) {
    return (bps / 1000000).toFixed(1) + " Mbps";
  }
  return Math.round(bps / 1000) + " Kbps";
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function buildQualityMenu() {
  const container = document.getElementById("qualityOptions");
  container.innerHTML = "";

  const autoOption = document.createElement("div");
  autoOption.className = "quality-option active";
  autoOption.innerHTML = `
        <svg class="check" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg>
        <span class="label">Auto</span>
    `;
  autoOption.onclick = () => setQuality(-1);
  container.appendChild(autoOption);

  levels.forEach((level, index) => {
    const option = document.createElement("div");
    option.className = "quality-option";
    option.innerHTML = `
            <svg class="check" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg>
            <span class="label">${level.height}p</span>
            <span class="bitrate">${formatBitrate(level.bitrate)}</span>
        `;
    option.onclick = () => setQuality(index);
    container.appendChild(option);
  });
}

function setQuality(index) {
  if (!hls) return;

  if (index === -1) {
    hls.currentLevel = -1;
    hls.nextLevel = -1;
    currentQuality.textContent = "Auto";
  } else {
    hls.currentLevel = index;
    hls.nextLevel = index;
    hls.loadLevel = index;
    currentQuality.textContent = levels[index].height + "p";
  }

  qualityMenu.classList.remove("show");

  const options = document.querySelectorAll(".quality-option");
  options.forEach((opt, i) => {
    opt.classList.remove("active");
    if (index === -1 && i === 0) {
      opt.classList.add("active");
    } else if (i === index + 1) {
      opt.classList.add("active");
    }
  });
}

function updateCurrentQuality(level) {
  if (hls && hls.autoLevelEnabled && levels[level]) {
    currentQuality.textContent = levels[level].height + "p";
  }
}

// UI Helpers
function showControls() {
  videoContainer.classList.add("show-controls");
  videoContainer.classList.remove("hide-cursor");
  clearTimeout(controlsTimeout);
  controlsTimeout = setTimeout(hideControlsDelayed, 3000);
}

function hideControlsDelayed() {
  if (!video.paused) {
    videoContainer.classList.remove("show-controls");
    videoContainer.classList.add("hide-cursor");
    qualityMenu.classList.remove("show");
  }
}

function showBigPlay(show) {
  bigPlayBtn.classList.toggle("hidden", !show);
}

function showLoading(status = "") {
  if (status) {
    setLoadingStatus(status);
  }
  loadingSpinner.classList.add("show");
}

function hideLoading() {
  loadingSpinner.classList.remove("show");
  setLoadingStatus("");
}

function setLoadingStatus(text) {
  if (loadingStatus) {
    loadingStatus.textContent = text;
  }
}

function showError(message) {
  errorMessage.textContent = message || "An error occurred";
  errorOverlay.classList.add("show");
}

function hideError() {
  errorOverlay.classList.remove("show");
}

function retryStream(silent = false) {
  hideError();
  loadStream(silent);
}

function copyShareLink() {
  const streamUrl = document.getElementById("streamUrl").value.trim();
  if (!streamUrl) return;

  const shareUrl = new URL("/play-p2p", window.location.origin);
  shareUrl.searchParams.set("url", streamUrl);

  navigator.clipboard.writeText(shareUrl.toString()).then(() => {
    const shareBtn = document.getElementById("shareBtn");
    shareBtn.title = "Copied!";
    setTimeout(() => {
      shareBtn.title = "Copy Share Link";
    }, 2000);
  });
}

function toggleStats() {
  statsOverlay.classList.toggle("show");
  if (statsOverlay.classList.contains("show")) {
    updateStats();
    statsInterval = setInterval(updateStats, 1000);
  } else {
    clearInterval(statsInterval);
  }
}

function updateStats() {
  // Playback stats
  if (hls) {
    document.getElementById("statResolution").textContent = levels[
      hls.currentLevel
    ]
      ? `${levels[hls.currentLevel].width}x${levels[hls.currentLevel].height}`
      : "-";
    document.getElementById("statBitrate").textContent = levels[
      hls.currentLevel
    ]
      ? formatBitrate(levels[hls.currentLevel].bitrate)
      : "-";
    document.getElementById("statLatency").textContent = hls.latency
      ? hls.latency.toFixed(2) + "s"
      : "-";
  }

  document.getElementById("statBuffer").textContent =
    video.buffered.length > 0
      ? (video.buffered.end(0) - video.currentTime).toFixed(1) + "s"
      : "-";
  document.getElementById("statDropped").textContent =
    video.getVideoPlaybackQuality
      ? video.getVideoPlaybackQuality().droppedVideoFrames
      : "-";

  // P2P stats
  document.getElementById("statPeers").textContent = p2pStats.peers;
  document.getElementById("statP2PDownload").textContent = formatBytes(
    p2pStats.totalP2PDownloaded * 1024,
  ); // Stats are in KB
  document.getElementById("statP2PUpload").textContent = formatBytes(
    p2pStats.totalP2PUploaded * 1024,
  );
  document.getElementById("statHTTPDownload").textContent = formatBytes(
    p2pStats.totalHTTPDownloaded * 1024,
  );

  // Calculate P2P ratio and saved traffic
  const total = p2pStats.totalHTTPDownloaded + p2pStats.totalP2PDownloaded;
  const p2pRatio =
    total > 0 ? Math.round((p2pStats.totalP2PDownloaded / total) * 100) : 0;
  document.getElementById("statP2PRatio").textContent = p2pRatio + "%";
  document.getElementById("statSavedTraffic").textContent = formatBytes(
    p2pStats.totalP2PDownloaded * 1024,
  );
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Event Handlers
function onDocumentClick(e) {
  if (!e.target.closest(".quality-btn") && !e.target.closest(".quality-menu")) {
    qualityMenu.classList.remove("show");
  }
}

function onUrlKeypress(e) {
  if (e.key === "Enter") loadStream();
}

function onKeyDown(e) {
  if (e.target.tagName === "INPUT") return;

  switch (e.key.toLowerCase()) {
    case " ":
    case "k":
      e.preventDefault();
      togglePlay();
      break;
    case "f":
      e.preventDefault();
      toggleFullscreen();
      break;
    case "m":
      e.preventDefault();
      toggleMute();
      break;
    case "arrowup":
      e.preventDefault();
      video.volume = Math.min(1, video.volume + 0.1);
      break;
    case "arrowdown":
      e.preventDefault();
      video.volume = Math.max(0, video.volume - 0.1);
      break;
    case "arrowleft":
      e.preventDefault();
      video.currentTime -= 10;
      break;
    case "arrowright":
      e.preventDefault();
      video.currentTime += 10;
      break;
    case "s":
      e.preventDefault();
      toggleStats();
      break;
    case "d":
      e.preventDefault();
      toggleDebugBar();
      break;
    case "escape":
      qualityMenu.classList.remove("show");
      statsOverlay.classList.remove("show");
      if (debugState.isVisible) {
        toggleDebugBar();
      }
      break;
  }
}

// ============== Debug Bar Functions ==============

function toggleDebugBar() {
  debugState.isVisible = !debugState.isVisible;

  if (debugBar) {
    debugBar.classList.toggle("show", debugState.isVisible);
  }
  if (debugBtn) {
    debugBtn.classList.toggle("active", debugState.isVisible);
  }

  if (debugState.isVisible) {
    updateDebugBar();
    debugInterval = setInterval(updateDebugBar, 500);
    addDebugLog("info", "Debug console opened");
  } else {
    if (debugInterval) {
      clearInterval(debugInterval);
      debugInterval = null;
    }
  }
}

function updateDebugBar() {
  // Update engine status
  updateDebugStatus("debugEngineStatus", debugState.engineStatus);
  updateDebugStatus("debugServerStatus", debugState.serverStatus);

  // Update peer info
  const peerIdEl = document.getElementById("debugPeerId");
  if (peerIdEl) {
    peerIdEl.textContent = debugState.peerId
      ? debugState.peerId.substring(0, 16) + "..."
      : "-";
  }

  const peerCountEl = document.getElementById("debugPeerCount");
  if (peerCountEl) {
    peerCountEl.textContent = p2pStats.peers;
  }

  // Calculate ratios
  const total = p2pStats.totalHTTPDownloaded + p2pStats.totalP2PDownloaded;
  const p2pRatio =
    total > 0 ? Math.round((p2pStats.totalP2PDownloaded / total) * 100) : 0;
  const httpRatio =
    total > 0 ? Math.round((p2pStats.totalHTTPDownloaded / total) * 100) : 0;

  // Update metrics
  const p2pPercentEl = document.getElementById("debugP2PPercent");
  const httpPercentEl = document.getElementById("debugHTTPPercent");
  const p2pBarEl = document.getElementById("debugP2PBar");
  const httpBarEl = document.getElementById("debugHTTPBar");

  if (p2pPercentEl) p2pPercentEl.textContent = p2pRatio + "%";
  if (httpPercentEl) httpPercentEl.textContent = httpRatio + "%";
  if (p2pBarEl) p2pBarEl.style.width = p2pRatio + "%";
  if (httpBarEl) httpBarEl.style.width = httpRatio + "%";

  // Update traffic values
  const p2pDownEl = document.getElementById("debugP2PDown");
  const p2pUpEl = document.getElementById("debugP2PUp");
  const httpDownEl = document.getElementById("debugHTTPDown");
  const savedEl = document.getElementById("debugSaved");

  if (p2pDownEl)
    p2pDownEl.textContent = formatBytes(p2pStats.totalP2PDownloaded * 1024);
  if (p2pUpEl)
    p2pUpEl.textContent = formatBytes(p2pStats.totalP2PUploaded * 1024);
  if (httpDownEl)
    httpDownEl.textContent = formatBytes(p2pStats.totalHTTPDownloaded * 1024);
  if (savedEl)
    savedEl.textContent = formatBytes(p2pStats.totalP2PDownloaded * 1024);
}

function updateDebugStatus(elementId, status) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const dot = el.querySelector(".status-dot");
  const text = el.querySelector(".status-text");

  if (!dot || !text) return;

  dot.className = "status-dot";

  switch (status) {
    case "success":
    case "connected":
    case "active":
      dot.classList.add("success");
      text.textContent = status === "active" ? "Active" : "Connected";
      break;
    case "connecting":
    case "checking":
    case "warning":
      dot.classList.add("warning");
      text.textContent =
        status === "checking" ? "Checking..." : "Connecting...";
      break;
    case "error":
    case "failed":
    case "unavailable":
      dot.classList.add("error");
      text.textContent = status === "unavailable" ? "Not Available" : "Failed";
      break;
    case "disconnected":
    default:
      text.textContent = "Disconnected";
      break;
  }
}

function addDebugLog(type, message) {
  if (!debugLog) return;

  const now = new Date();
  const time = now.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${message}</span>`;

  debugLog.appendChild(entry);

  // Keep only last 50 entries
  while (debugLog.children.length > 50) {
    debugLog.removeChild(debugLog.firstChild);
  }

  // Auto-scroll to bottom
  debugLog.scrollTop = debugLog.scrollHeight;
}

function clearDebugLog() {
  if (debugLog) {
    debugLog.innerHTML = "";
    addDebugLog("info", "Log cleared");
  }
}

// ============== End Debug Bar Functions ==============

// Initialize on DOM ready
document.addEventListener("DOMContentLoaded", init);
