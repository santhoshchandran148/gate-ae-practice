/* ============================================================
 * exam.js — Core exam engine: timer, autosave, palette, submit.
 * ============================================================ */
(function () {
  'use strict';

  let session = null;
  let timerId = null;
  let lastTickTime = 0;
  let currentQid = null;
  let tabLockId = Math.random().toString(36).slice(2);
  let zoomed = false;

  function ensureResponse(s, qid) {
    if (!s.responses[qid]) {
      s.responses[qid] = { value: null, status: 'not_visited', timeSpentSec: 0, visits: 0 };
    }
    return s.responses[qid];
  }

  function startExam(opts) {
    const s = State.newSession(opts);
    State.saveSession(s);
    session = s;
    Storage.setTabLock(tabLockId);
    window.location.hash = '#/exam';
  }

  function resumeExam() {
    const s = State.getSession();
    if (!s || s.status !== 'active') {
      UI.toast('No active exam found.', 'err');
      window.location.hash = '#/home';
      return;
    }
    session = s;
    Storage.setTabLock(tabLockId);
    window.location.hash = '#/exam';
  }

  function checkTabLock() {
    const active = Storage.getTabLock();
    if (active && active !== 'null' && active !== tabLockId && session && session.status === 'active') {
      const main = document.getElementById('main');
      if (main) {
        main.innerHTML = `
          <div class="card empty" style="border-color:var(--warn)">
            <h2>Exam Active in Another Tab</h2>
            <p>This exam is currently open in another window. To prevent data loss, please close this tab or return to the original tab.</p>
            <button class="btn primary" onclick="window.location.hash='#/home'">Go Home</button>
          </div>
        `;
      }
      clearInterval(timerId);
      return false;
    }
    return true;
  }

  function startTimer() {
    clearInterval(timerId);
    lastTickTime = Date.now();
    timerId = setInterval(tick, 1000);
    tick(); 
  }

  function tick() {
    if (!session || session.status !== 'active') return;
    
    const now = Date.now();
    const delta = now - lastTickTime;
    lastTickTime = now;

    if (currentQid && delta > 0 && delta < 5000) {
      const resp = ensureResponse(session, currentQid);
      resp.timeSpentSec = (resp.timeSpentSec || 0) + (delta / 1000);
    }

    const remainingMs = session.endTime - now;
    if (remainingMs <= 0) {
      clearInterval(timerId);
      autoSubmit();
      return;
    }

    const el = document.getElementById('exam-timer');
    if (el) {
      el.textContent = UI.fmtTime(remainingMs / 1000);
      if (remainingMs < 60000) el.className = 'timer crit';
      else if (remainingMs < 300000) el.className = 'timer warn';
      else el.className = 'timer';
    }
  }

  function save() {
    if (!session) return;
    State.saveSession(session);
    updatePalette();
  }

  function goTo(index) {
    try {
      if (!session || index < 0 || index >= session.questionOrder.length) return;

      const prevQid = session.questionOrder[session.currentIndex];
      if (prevQid && session.currentIndex !== index) {
        const prevResp = ensureResponse(session, prevQid);
        if (prevResp.status === 'unanswered' && !prevResp.value) {
          prevResp.status = 'skipped';
        }
      }

      session.currentIndex = index;
      currentQid = session.questionOrder[index];
      
      const resp = ensureResponse(session, currentQid);
      if (resp.status === 'not_visited') {
        resp.status = 'unanswered'; 
      }
      resp.visits = (resp.visits || 0) + 1;

      State.saveSession(session);
      renderQuestion();
      updatePalette();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      console.error('goTo failed:', err);
      UI.toast('Navigation error. Check console.', 'err');
    }
  }

  function selectOption(key) {
    if (!currentQid) return;
    const resp = ensureResponse(session, currentQid);
    const q = State.questionById(currentQid);
    
    if (q.type === 'MCQ') {
      resp.value = (resp.value === key) ? null : key; 
    } else if (q.type === 'MSQ') {
      let arr = Array.isArray(resp.value) ? resp.value.slice() : [];
      if (arr.includes(key)) arr = arr.filter(k => k !== key);
      else arr.push(key);
      resp.value = arr.length ? arr.sort() : null;
    }
    
    resp.status = resp.value ? 'answered' : 'unanswered';
    save();
    renderQuestion();
  }

  function inputNAT(val) {
    if (!currentQid) return;
    const resp = ensureResponse(session, currentQid);
    resp.value = val.trim();
    resp.status = resp.value ? 'answered' : 'unanswered';
    save();
    updatePalette();
  }

  function clearResponse() {
    if (!currentQid) return;
    const resp = ensureResponse(session, currentQid);
    resp.value = null;
    resp.status = 'unanswered';
    save();
    renderQuestion();
  }

  function skipQuestion() {
    if (!currentQid) return;
    const resp = ensureResponse(session, currentQid);
    resp.status = 'skipped';
    save();
    nextQuestion();
  }

  function toggleMark() {
    if (!currentQid) return;
    const resp = ensureResponse(session, currentQid);
    resp.status = (resp.status === 'marked') ? (resp.value ? 'answered' : 'unanswered') : 'marked';
    save();
    renderQuestion();
    updatePalette();
  }

  function nextQuestion() {
    if (session.currentIndex < session.questionOrder.length - 1) {
      goTo(session.currentIndex + 1);
    } else {
      UI.toast('Reached end of exam. You can submit now.', 'info');
    }
  }

  function prevQuestion() {
    if (session.currentIndex > 0) {
      goTo(session.currentIndex - 1);
    }
  }

  function updatePalette() {
    if (!session) return;
    const grid = document.getElementById('palette-grid');
    if (!grid) return;

    const filterChip = document.querySelector('[data-filter="skipped"]');
    const filterSkipped = filterChip && filterChip.getAttribute('aria-pressed') === 'true';

    UI.clear(grid);

    let answered = 0, skipped = 0, marked = 0, notVisited = 0;

    session.questionOrder.forEach((qid, idx) => {
      const resp = ensureResponse(session, qid);
      
      let baseState = 'not_visited';
      if (resp.status === 'answered') baseState = 'answered';
      else if (resp.status === 'marked') baseState = 'marked';
      else if (resp.status === 'skipped') baseState = 'skipped';
      else if (resp.status === 'unanswered') baseState = 'visited';

      if (baseState === 'answered') answered++;
      else if (baseState === 'skipped') skipped++;
      else if (baseState === 'marked') marked++;
      else if (baseState === 'not_visited') notVisited++;

      if (filterSkipped && baseState !== 'skipped') return;

      const isCurrent = (idx === session.currentIndex);
      const isMarked = (resp.status === 'marked');
      
      let finalState = baseState;
      if (baseState === 'answered' && isMarked) finalState = 'answered-marked';

      const btn = UI.el('button', {
        class: `palette-btn ${isCurrent ? 'current' : ''}`,
        'data-state': finalState,
        'data-marked': isMarked,
        onclick: () => goTo(idx)
      }, String(idx + 1));
      
      grid.appendChild(btn);
    });

    const elAns = document.getElementById('cnt-answered');
    const elSkip = document.getElementById('cnt-skipped');
    const elMark = document.getElementById('cnt-marked');
    if (elAns) elAns.textContent = answered;
    if (elSkip) elSkip.textContent = skipped;
    if (elMark) elMark.textContent = marked;
  }

  function renderQuestion() {
    const wrap = document.getElementById('q-container');
    if (!wrap || !session) return;
    
    UI.clear(wrap);
    const qid = session.questionOrder[session.currentIndex];
    const q = State.questionById(qid);
    
    if (!q) {
      wrap.innerHTML = `<div class="card empty" style="color:var(--err)"><strong>Error:</strong> Question ID ${qid} not found in database.</div>`;
      return;
    }
    
    const resp = ensureResponse(session, qid);

    const meta = UI.el('div', { class: 'q-meta' },
      UI.el('div', {}, UI.el('strong', {}, `Q ${session.currentIndex + 1}`), ` of ${session.questionOrder.length}`),
      UI.el('div', {}, `Marks: `, UI.el('strong', {}, String(q.marks))),
      UI.el('div', {}, UI.el('span', { class: 'badge' }, q.type)),
      UI.el('div', { class: 'muted' }, q.section)
    );

    const imgWrap = UI.el('div', { class: 'q-image-wrap', title: 'Click to zoom' });
    let imgSrc = q.image;
    const img = UI.el('img', { src: imgSrc, alt: `Question ${q.qno}`, loading: 'lazy' });

    if (q.id.startsWith('custom_')) {
      Storage.getImage(q.id).then(blob => {
        if (blob) img.src = URL.createObjectURL(blob);
      }).catch(err => console.error('Failed to load custom image', err));
    }

    img.onerror = () => {
      imgWrap.className = 'q-image-wrap missing';
      imgWrap.innerHTML = `<strong>Image missing:</strong> ${q.image}`;
      imgWrap.onclick = null;
    };
    if (!imgWrap.classList.contains('missing')) {
      imgWrap.appendChild(img);
      imgWrap.onclick = () => openZoom(img.src);
    }

    const controls = UI.el('div', {});
    
    if (q.type === 'MCQ' || q.type === 'MSQ') {
      const group = UI.el('div', { class: 'answer-group', role: q.type === 'MCQ' ? 'radiogroup' : 'group' });
      ['A', 'B', 'C', 'D'].forEach(k => {
        let selected = false;
        if (q.type === 'MCQ') selected = (resp.value === k);
        if (q.type === 'MSQ') selected = Array.isArray(resp.value) && resp.value.includes(k);
        
        const btn = UI.el('button', {
          class: 'answer-btn',
          'aria-pressed': selected ? 'true' : 'false',
          onclick: () => selectOption(k)
        }, k);
        group.appendChild(btn);
      });
      controls.appendChild(group);
    } 
    else if (q.type === 'NAT') {
      const natWrap = UI.el('div', { class: 'nat-wrap' });
      const input = UI.el('input', {
        type: 'text',
        inputmode: 'decimal',
        value: resp.value || '',
        placeholder: 'Enter value',
        'aria-label': 'Numeric answer',
        oninput: (e) => inputNAT(e.target.value)
      });
      
      const keypad = UI.el('div', { class: 'nat-keypad' });
      ['7','8','9','4','5','6','1','2','3','-','0','.'].forEach(char => {
        keypad.appendChild(UI.el('button', {
          type: 'button',
          onclick: () => { input.value += char; inputNAT(input.value); input.focus(); }
        }, char));
      });
      keypad.appendChild(UI.el('button', {
        type: 'button', style: 'grid-column: span 2',
        onclick: () => { input.value = input.value.slice(0, -1); inputNAT(input.value); input.focus(); }
      }, '⌫'));
      keypad.appendChild(UI.el('button', {
        type: 'button',
        onclick: () => { input.value = ''; inputNAT(''); input.focus(); }
      }, 'CLR'));

      natWrap.appendChild(input);
      controls.appendChild(natWrap);
      controls.appendChild(keypad);
    }

    const actions = UI.el('div', { class: 'q-actions' },
      UI.el('button', { class: 'btn', onclick: prevQuestion }, 'Previous'),
      UI.el('button', { class: 'btn', onclick: skipQuestion }, 'Skip'),
      UI.el('button', { class: 'btn', onclick: toggleMark }, resp.status === 'marked' ? 'Unmark' : 'Mark for review'),
      UI.el('button', { class: 'btn', onclick: clearResponse }, 'Clear'),
      UI.el('button', { class: 'btn primary', onclick: nextQuestion }, 'Next')
    );

    wrap.appendChild(UI.el('div', { class: 'q-card' }, meta, imgWrap, controls, actions));
  }

  function openZoom(src) {
    if (zoomed) return;
    zoomed = true;
    const overlay = UI.el('div', { class: 'zoom-overlay', onclick: (e) => {
      if (e.target.tagName === 'IMG') return;
      closeZoom();
    }});
    
    const img = UI.el('img', { src, draggable: 'false' });
    let isDown = false, startX, startY, scrollLeft, scrollTop;
    
    img.addEventListener('mousedown', (e) => {
      isDown = true; startX = e.pageX - img.offsetLeft; startY = e.pageY - img.offsetTop;
      scrollLeft = overlay.scrollLeft; scrollTop = overlay.scrollTop;
    });
    img.addEventListener('mouseleave', () => isDown = false);
    img.addEventListener('mouseup', () => isDown = false);
    img.addEventListener('mousemove', (e) => {
      if (!isDown) return;
      e.preventDefault();
      const x = e.pageX - img.offsetLeft; const y = e.pageY - img.offsetTop;
      overlay.scrollLeft = scrollLeft - (x - startX);
      overlay.scrollTop = scrollTop - (y - startY);
    });

    const controls = UI.el('div', { class: 'zoom-controls' }, UI.el('button', { class: 'btn', onclick: closeZoom }, 'Close (Esc)'));
    overlay.appendChild(img);
    overlay.appendChild(controls);
    document.body.appendChild(overlay);
  }

  function closeZoom() {
    zoomed = false;
    const ov = document.querySelector('.zoom-overlay');
    if (ov) ov.remove();
  }

  async function confirmSubmit() {
    if (!session) return;
    const { answered, skipped, marked, notVisited } = State.attemptSummary(session);
    const res = await UI.modal({
      title: 'Submit Exam?',
      body: `<p>Are you sure you want to finish?</p>
        <ul>
          <li>Answered: <strong>${answered}</strong></li>
          <li>Marked for review: <strong>${marked}</strong></li>
          <li>Skipped / Unanswered: <strong>${skipped + notVisited}</strong></li>
        </ul>`,
      actions: [
        { label: 'Cancel', value: false, type: 'ghost' },
        { label: 'Submit Now', value: true, type: 'primary' }
      ]
    });
    if (res) executeSubmit();
  }

  function autoSubmit() {
    UI.toast('Time expired! Auto-submitting...', 'err');
    setTimeout(executeSubmit, 1500);
  }

  async function executeSubmit() {
    if (!session) return;
    clearInterval(timerId);
    session.status = 'submitted';
    State.saveSession(session);
    Storage.setTabLock('');
    
    const main = document.getElementById('main');
    if (main) main.innerHTML = '<div class="card"><h2>Evaluating exam...</h2><p>Comparing your answers with the key.</p></div>';

    try {
      const result = await Results.finalize(session);
      window.location.hash = `#/results?id=${result.attemptId}`;
    } catch (err) {
      console.error(err);
      if (main) {
        main.innerHTML = `<div class="card empty" style="border-color:var(--err)">
          <h2>Evaluation Failed</h2>
          <p>${err.message}</p>
          <button class="btn" onclick="window.location.hash='#/home'">Back to Home</button>
        </div>`;
      }
    }
  }

  function initGlobalEvents() {
    window.addEventListener('keydown', (e) => {
      if (!session || session.status !== 'active') return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      
      const key = e.key.toUpperCase();
      if (['1','2','3','4'].includes(key)) {
        const opt = key === '1' ? 'A' : key === '2' ? 'B' : key === '3' ? 'C' : 'D';
        selectOption(opt);
      }
      else if (e.shiftKey) {
        if (key === 'N') nextQuestion();
        else if (key === 'P') prevQuestion();
        else if (key === 'S') skipQuestion();
        else if (key === 'M') toggleMark();
        else if (key === 'C') clearResponse();
        else if (key === 'Z') {
          const img = document.querySelector('.q-image-wrap img');
          if (img) openZoom(img.src);
        }
      }
      else if (e.key === 'Escape') closeZoom();
    });

    window.addEventListener('beforeunload', (e) => {
      if (session && session.status === 'active') {
        e.preventDefault();
        e.returnValue = 'Exam in progress. Are you sure you want to leave?';
        return e.returnValue;
      }
    });

    window.addEventListener('storage', (e) => {
      if (e.key === Storage.KEYS.tabLock && session && session.status === 'active') {
        checkTabLock();
      }
    });
  }

  let pageRendered = false;

  function renderPage() {
    if (pageRendered) return;

    const main = document.getElementById('main');
    UI.clear(main);

    if (!session) {
      session = State.getSession();
    }
    
    if (!session || session.status !== 'active') {
      window.location.hash = '#/home';
      return;
    }

    if (!checkTabLock()) return;

    currentQid = session.questionOrder[session.currentIndex];
    
    const shell = UI.el('div', { class: 'exam-shell' });
    
    const aside = UI.el('aside', { class: 'palette-aside' },
      UI.el('div', { class: 'palette' },
        UI.el('h3', {}, 'Questions'),
        UI.el('div', { class: 'palette-filters' },
          UI.el('button', { 
            class: 'btn sm ghost', 
            'data-filter': 'skipped', 
            'aria-pressed': 'false',
            onclick: (e) => {
              const b = e.currentTarget;
              b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
              updatePalette();
            }
          }, 'Skipped Only')
        ),
        UI.el('div', { class: 'palette-grid', id: 'palette-grid' }),
        UI.el('ul', { class: 'palette-legend' },
          UI.el('li', {}, UI.el('span', { class: 'legend-swatch answered' }), 'Answered'),
          UI.el('li', {}, UI.el('span', { class: 'legend-swatch skipped' }), 'Skipped'),
          UI.el('li', {}, UI.el('span', { class: 'legend-swatch marked' }), 'Marked'),
          UI.el('li', {}, UI.el('span', { class: 'legend-swatch visited' }), 'Visited')
        ),
        UI.el('div', { class: 'faint', style: 'margin-top:12px;display:flex;gap:8px;flex-wrap:wrap' },
          UI.el('span', {}, 'Answered: ', UI.el('b', { id: 'cnt-answered' }, '0')),
          UI.el('span', {}, 'Skipped: ', UI.el('b', { id: 'cnt-skipped' }, '0')),
          UI.el('span', {}, 'Marked: ', UI.el('b', { id: 'cnt-marked' }, '0'))
        )
      )
    );

    const mainArea = UI.el('div', { class: 'exam-main' },
      UI.el('div', { class: 'exam-topbar' },
        UI.el('div', { class: 'title' }, 'Mock Exam'),
        UI.el('div', { class: 'timer', id: 'exam-timer' }, '--:--'),
        UI.el('button', { class: 'btn primary', onclick: confirmSubmit }, 'Submit')
      ),
      UI.el('div', { id: 'q-container' })
    );

    shell.appendChild(aside);
    shell.appendChild(mainArea);
    main.appendChild(shell);

    pageRendered = true;
    startTimer();
    renderQuestion();
    updatePalette();
  }

  window.Exam = {
    startExam, resumeExam,
    renderPage,
    init: () => {
      initGlobalEvents();
      window.addEventListener('hashchange', () => {
        if (window.location.hash.startsWith('#/exam')) {
          renderPage();
        } else {
          pageRendered = false;
          clearInterval(timerId);
        }
      });
    }
  };

})();