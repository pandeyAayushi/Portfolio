/* ═══════════════════════════════════════════
   PURPLE WHALE — SMOOTH ANIMATION ENGINE v2
   ═══════════════════════════════════════════
   Key upgrades over v1:
   - True frame BLENDING (alpha-composite adjacent frames)
   - Spring-physics scroll easing (not naive lerp)
   - All DOM writes batched inside RAF (no layout thrash)
   - Cached radial gradient (created once, reused)
   - Scroll progress stored as float [0-191], not integer
   - Offscreen canvas for compositing
   ═══════════════════════════════════════════ */

(function () {
  'use strict';

  /* ─── CONFIG ─── */
  const TOTAL_FRAMES  = 192;
  const FRAME_FOLDER  = './PURPLE WHALE SEQUENCE/';
  const FRAME_PREFIX  = '_MConverter.eu_purple whale-';
  const FRAME_EXT     = '.png';

  // Spring physics for frame easing
  const SPRING_STIFFNESS = 0.09;  // Lower = floatier/slower catch-up
  const SPRING_DAMPING   = 0.78;  // Higher = less overshoot

  /* ─── STATE ─── */
  const images = new Array(TOTAL_FRAMES).fill(null);
  let loadedCount = 0;

  // Float frame position — e.g. 45.73 means 73% between frame 45 and 46
  let smoothFramePos = 0;   // what we actually draw (spring-eased)
  let targetFramePos = 0;   // what scroll wants (raw float)
  let frameVelocity  = 0;   // spring velocity

  // Mouse parallax
  let mouseNX = 0.5, mouseNY = 0.5;   // normalized mouse [0-1]
  let lerpNX  = 0.5, lerpNY  = 0.5;  // smoothed mouse

  // Scroll state (read on scroll, applied in RAF)
  let scrollProgress = 0;

  // Cached gradient (built once after first resize)
  let cachedGrad = null;
  let gradCW = -1, gradCH = -1;

  // Cover-fit cache
  let fitCache = { cw: -1, ch: -1, iw: -1, ih: -1, scale: 1, dw: 0, dh: 0, dx: 0, dy: 0 };

  // RAF state
  let rafId = null;
  let isLoaded = false;

  // Pending DOM updates (batched in RAF)
  let pendingProgress = 0;
  let pendingFrame    = 0;
  let pendingDepth    = 0;
  let pendingHud      = 'intro';
  let currentHud      = 'intro';
  let needsUIUpdate   = false;

  /* ─── ELEMENTS ─── */
  const loader        = document.getElementById('loader');
  const loaderBar     = document.getElementById('loaderBar');
  const loaderPercent = document.getElementById('loaderPercent');
  const canvas        = document.getElementById('whaleCanvas');
  const ctx           = canvas.getContext('2d', { alpha: false });
  const progressFill  = document.getElementById('progressFill');
  const frameCounter  = document.getElementById('currentFrame');
  const depthBar      = document.getElementById('depthBar');
  const depthValue    = document.getElementById('depthValue');
  const cursorGlow    = document.getElementById('cursorGlow');
  const replayBtn     = document.getElementById('replayBtn');
  const hudIntro      = document.getElementById('hud-intro');
  const hudMid        = document.getElementById('hud-mid');
  const hudEnd        = document.getElementById('hud-end');
  const nav           = document.getElementById('mainNav');

  /* ════════════════════════════════════════════
     CANVAS + FIT CACHE
  ════════════════════════════════════════════ */
  function resizeCanvas() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    cachedGrad = null; // invalidate gradient cache
    fitCache.cw = -1;  // invalidate fit cache
    if (isLoaded) renderFrame(smoothFramePos);
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  /* Compute cover-fit params, cached until resize */
  function getFit(iw, ih) {
    const cw = canvas.width, ch = canvas.height;
    if (fitCache.cw === cw && fitCache.ch === ch && fitCache.iw === iw && fitCache.ih === ih) {
      return fitCache;
    }
    const scale = Math.max(cw / iw, ch / ih);
    fitCache = { cw, ch, iw, ih, scale, dw: iw * scale, dh: ih * scale, dx: (cw - iw * scale) / 2, dy: (ch - ih * scale) / 2 };
    return fitCache;
  }

  /* Build radial gradient once per canvas size */
  function getGradient() {
    const cw = canvas.width, ch = canvas.height;
    if (cachedGrad && gradCW === cw && gradCH === ch) return cachedGrad;
    gradCW = cw; gradCH = ch;
    cachedGrad = ctx.createRadialGradient(cw / 2, ch / 2, ch * 0.18, cw / 2, ch / 2, ch * 0.82);
    cachedGrad.addColorStop(0, 'rgba(0,0,0,0)');
    cachedGrad.addColorStop(0.7, 'rgba(13,0,16,0.15)');
    cachedGrad.addColorStop(1,   'rgba(13,0,16,0.55)');
    return cachedGrad;
  }

  /* ════════════════════════════════════════════
     CORE RENDER — TRUE FRAME BLENDING
     framePos: float [0 … TOTAL_FRAMES-1]
  ════════════════════════════════════════════ */
  function renderFrame(framePos) {
    const cw = canvas.width, ch = canvas.height;

    const floorIdx = Math.floor(framePos);
    const ceilIdx  = Math.min(floorIdx + 1, TOTAL_FRAMES - 1);
    const blend    = framePos - floorIdx;   // fractional part [0-1]

    const imgA = images[floorIdx];
    const imgB = images[ceilIdx];

    if (!imgA) return;

    // Parallax offset (clamped, in pixels)
    const px = (lerpNX - 0.5) * 18;
    const py = (lerpNY - 0.5) * 10;

    ctx.clearRect(0, 0, cw, ch);

    // ── Draw base frame (floor) ──
    const { dw, dh, dx, dy } = getFit(imgA.naturalWidth, imgA.naturalHeight);
    ctx.globalAlpha = 1;
    ctx.drawImage(imgA, dx + px, dy + py, dw, dh);

    // ── Blend next frame on top (ceil) with fractional alpha ──
    if (blend > 0.001 && imgB && imgB.complete && imgB.naturalWidth) {
      const fitB = getFit(imgB.naturalWidth, imgB.naturalHeight);
      ctx.globalAlpha = blend;
      ctx.drawImage(imgB, fitB.dx + px, fitB.dy + py, fitB.dw, fitB.dh);
    }

    ctx.globalAlpha = 1;

    // ── Vignette / tint overlay ──
    ctx.fillStyle = getGradient();
    ctx.fillRect(0, 0, cw, ch);
  }

  /* ════════════════════════════════════════════
     SPRING-PHYSICS RAF LOOP
  ════════════════════════════════════════════ */
  function startRaf() {
    function loop() {
      // ── Spring physics: smoothly chase targetFramePos ──
      const force     = (targetFramePos - smoothFramePos) * SPRING_STIFFNESS;
      frameVelocity   = frameVelocity * SPRING_DAMPING + force;
      smoothFramePos += frameVelocity;

      // Clamp
      smoothFramePos = Math.max(0, Math.min(TOTAL_FRAMES - 1, smoothFramePos));

      // ── Mouse lerp ──
      lerpNX += (mouseNX - lerpNX) * 0.05;
      lerpNY += (mouseNY - lerpNY) * 0.05;

      // ── Render ──
      renderFrame(smoothFramePos);

      // ── Flush pending UI updates (batched, no layout thrash) ──
      if (needsUIUpdate) {
        needsUIUpdate = false;
        flushUI();
      }

      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);
  }

  /* ════════════════════════════════════════════
     SCROLL HANDLER — only cheap reads, no writes
  ════════════════════════════════════════════ */
  const stickyContainer = document.getElementById('sticky-container');

  function onScroll() {
    const containerTop = stickyContainer.offsetTop;
    const containerH   = stickyContainer.offsetHeight - window.innerHeight;
    const rawScrolled  = window.scrollY - containerTop;
    scrollProgress     = Math.min(Math.max(rawScrolled / containerH, 0), 1);

    // Target frame as float (not floored!)
    targetFramePos = scrollProgress * (TOTAL_FRAMES - 1);

    // Stage UI updates for the RAF flush
    pendingProgress = scrollProgress;
    pendingFrame    = Math.round(targetFramePos) + 1;
    pendingDepth    = Math.round(scrollProgress * 11000);
    pendingHud      = scrollProgress < 0.15 ? 'intro' : scrollProgress < 0.75 ? 'mid' : 'end';
    needsUIUpdate   = true;
  }

  window.addEventListener('scroll', onScroll, { passive: true });

  /* ════════════════════════════════════════════
     UI FLUSH — called inside RAF, safe to write
  ════════════════════════════════════════════ */
  function flushUI() {
    // Progress bar
    progressFill.style.width = (pendingProgress * 100).toFixed(2) + '%';

    // Depth meter
    depthBar.style.height = (pendingProgress * 100).toFixed(2) + '%';
    depthValue.textContent = pendingDepth.toLocaleString() + ' m';
    depthValue.style.color = pendingProgress > 0.5 ? 'var(--accent-pink)' : 'var(--accent-cyan)';

    // Frame counter
    frameCounter.textContent = String(Math.min(pendingFrame, TOTAL_FRAMES)).padStart(3, '0');

    // HUD
    if (pendingHud !== currentHud) {
      currentHud = pendingHud;
      hudIntro.classList.toggle('hidden', currentHud !== 'intro');
      hudMid.classList.toggle('hidden',   currentHud !== 'mid');
      hudEnd.classList.toggle('hidden',   currentHud !== 'end');
    }
  }

  /* ════════════════════════════════════════════
     PRELOAD — priority-order loading
  ════════════════════════════════════════════ */
  function preloadFrames() {
    // Load in a smart order: 1,2,192,3,191,4... ensures first & last load fast
    const order = [];
    let lo = 0, hi = TOTAL_FRAMES - 1;
    while (lo <= hi) {
      if (lo === hi) { order.push(lo); break; }
      order.push(lo++);
      order.push(hi--);
    }

    order.forEach(idx => {
      const img = new Image();
      img.decoding = 'async';
      img.src = FRAME_FOLDER + FRAME_PREFIX + (idx + 1) + FRAME_EXT;
      img.onload = img.onerror = () => {
        loadedCount++;
        const pct = Math.round((loadedCount / TOTAL_FRAMES) * 100);
        loaderBar.style.width    = pct + '%';
        loaderPercent.textContent = pct + '%';
        if (loadedCount === TOTAL_FRAMES) setTimeout(onAllLoaded, 300);
      };
      images[idx] = img;
    });
  }

  function onAllLoaded() {
    isLoaded = true;
    loader.classList.add('hidden');
    renderFrame(0);
    spawnParticles();
    startRaf();
  }

  /* ════════════════════════════════════════════
     MOUSE + CURSOR
  ════════════════════════════════════════════ */
  let cursorRaf = null;
  let cursorTargetX = window.innerWidth / 2;
  let cursorTargetY = window.innerHeight / 2;
  let cursorCurrX   = cursorTargetX;
  let cursorCurrY   = cursorTargetY;

  window.addEventListener('mousemove', (e) => {
    mouseNX = e.clientX / window.innerWidth;
    mouseNY = e.clientY / window.innerHeight;
    cursorTargetX = e.clientX;
    cursorTargetY = e.clientY;
    if (!cursorRaf) animateCursor();
  });

  function animateCursor() {
    cursorCurrX += (cursorTargetX - cursorCurrX) * 0.25;
    cursorCurrY += (cursorTargetY - cursorCurrY) * 0.25;

    cursorGlow.style.left = cursorCurrX + 'px';
    cursorGlow.style.top  = cursorCurrY + 'px';

    const dist = Math.abs(cursorTargetX - cursorCurrX) + Math.abs(cursorTargetY - cursorCurrY);
    cursorRaf = dist > 0.5 ? requestAnimationFrame(animateCursor) : null;
  }

  /* ════════════════════════════════════════════
     CURSOR HOVER EXPAND
  ════════════════════════════════════════════ */
  document.querySelectorAll('a, button').forEach(el => {
    el.addEventListener('mouseenter', () => {
      cursorGlow.style.width   = '60px';
      cursorGlow.style.height  = '60px';
      cursorGlow.style.opacity = '0.5';
    });
    el.addEventListener('mouseleave', () => {
      cursorGlow.style.width   = '24px';
      cursorGlow.style.height  = '24px';
      cursorGlow.style.opacity = '1';
    });
  });

  /* ════════════════════════════════════════════
     NAV HIDE ON SCROLL
  ════════════════════════════════════════════ */
  let lastScrollY = 0;
  window.addEventListener('scroll', () => {
    const curr = window.scrollY;
    if (curr > lastScrollY + 60 && curr > 200) {
      nav.classList.add('hidden');
    } else if (curr < lastScrollY - 30) {
      nav.classList.remove('hidden');
    }
    lastScrollY = curr;
  }, { passive: true });

  /* ════════════════════════════════════════════
     PARTICLES
  ════════════════════════════════════════════ */
  function spawnParticles() {
    const container = document.getElementById('particleContainer');
    container.innerHTML = '';
    for (let i = 0; i < 28; i++) {
      const p    = document.createElement('div');
      p.className = 'particle';
      const size  = Math.random() * 5 + 2;
      const x     = Math.random() * 100;
      const dur   = Math.random() * 14 + 8;
      const delay = Math.random() * dur;
      const hue   = Math.random() > 0.5 ? '270' : '195';
      p.style.cssText = `left:${x}%;width:${size}px;height:${size}px;`
        + `animation-duration:${dur}s;animation-delay:-${delay}s;`
        + `background:radial-gradient(circle,hsl(${hue},100%,80%) 0%,transparent 70%);`
        + `box-shadow:0 0 ${size * 3}px hsl(${hue},100%,65%);`;
      container.appendChild(p);
    }
  }

  /* ════════════════════════════════════════════
     STAR FIELD
  ════════════════════════════════════════════ */
  function createStarField() {
    const hero   = document.getElementById('sticky-hero');
    const starDiv = document.createElement('div');
    starDiv.className = 'star-field';
    hero.insertBefore(starDiv, hero.firstChild);

    for (let i = 0; i < 55; i++) {
      const star = document.createElement('div');
      const size  = Math.random() * 2 + 0.5;
      const dur   = Math.random() * 3 + 2;
      star.style.cssText = `position:absolute;`
        + `left:${Math.random() * 100}%;top:${Math.random() * 100}%;`
        + `width:${size}px;height:${size}px;border-radius:50%;background:white;`
        + `opacity:${Math.random() * 0.6 + 0.2};`
        + `animation:starTwinkle ${dur}s ease-in-out infinite alternate;`
        + `animation-delay:-${Math.random() * dur}s;`;
      starDiv.appendChild(star);
    }

    if (!document.getElementById('starKF')) {
      const s = document.createElement('style');
      s.id = 'starKF';
      s.textContent = '@keyframes starTwinkle{from{opacity:.1;transform:scale(.8)}to{opacity:.9;transform:scale(1.4)}}';
      document.head.appendChild(s);
    }
  }

  /* ════════════════════════════════════════════
     SCROLL ANCHORS
  ════════════════════════════════════════════ */
  function attachScrollAnchors() {
    const container = document.getElementById('sticky-container');
    const totalH    = container.offsetHeight;
    ['section-intro', 'section-mid', 'section-end'].forEach((id, i) => {
      let el = document.getElementById(id);
      if (!el) { el = document.createElement('div'); el.id = id; container.appendChild(el); }
      el.style.cssText = `position:absolute;pointer-events:none;top:${Math.round(totalH * i * 0.33)}px`;
    });
  }

  /* ════════════════════════════════════════════
     OUTRO INTERSECTION REVEAL
  ════════════════════════════════════════════ */
  function initOutroReveal() {
    const outro = document.getElementById('outro-section');
    if (!outro) return;
    const io = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.querySelectorAll('.outro-heading,.outro-body,.outro-stats,.btn-outro').forEach((el, i) => {
          el.style.cssText = `opacity:0;transform:translateY(28px);transition:opacity .8s ease ${i * .15}s,transform .8s ease ${i * .15}s`;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            el.style.opacity = '1';
            el.style.transform = 'translateY(0)';
          }));
        });
        io.unobserve(entry.target);
      });
    }, { threshold: 0.15 });
    io.observe(outro);
  }

  /* ════════════════════════════════════════════
     REPLAY BUTTON
  ════════════════════════════════════════════ */
  if (replayBtn) {
    replayBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }

  /* ════════════════════════════════════════════
     INIT
  ════════════════════════════════════════════ */
  createStarField();
  attachScrollAnchors();
  initOutroReveal();
  preloadFrames();

})();
