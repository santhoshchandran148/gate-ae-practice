/* ============================================================
 * app.js — Boot and hash router.
 * ============================================================ */
(function () {
  'use strict';

  async function renderHome() {
    const main = document.getElementById('main');
    UI.clear(main);

    // Resolve custom images (IndexedDB) before rendering
    const allQs = State.allQuestions();
    if (window.AddQuestions) {
      await AddQuestions.resolveImages(allQs);
    }

    const session = State.getSession();
    const active = State.isSessionActive(session);
    const history = State.getHistory();
    const lastAttempt = history.length > 0 ? history[history.length - 1] : null;
    const settings = Storage.getSettings();
    const totalQs = allQs.length;
    const tagList = State.tags();

    const hero = UI.el('header', { class: 'hero' },
      UI.el('h1', {}, 'Exam Practice'),
      UI.el('p', { class: 'muted' }, `${totalQs} questions available (including custom).`)
    );
    main.appendChild(hero);

    if (active) {
      const remaining = State.sessionRemainingMs(session);
      if (remaining > 0) {
        main.appendChild(UI.el('div', { class: 'card', style: 'border-color:var(--accent);background:var(--accent-soft)' },
          UI.el('div', { class: 'row spread' },
            UI.el('div', {}, 
              UI.el('h3', { style: 'margin:0' }, 'Unfinished Exam'),
              UI.el('div', { class: 'faint', style: 'margin-top:4px' }, `Time remaining: ${UI.fmtTime(remaining/1000)}`)
            ),
            UI.el('button', { class: 'btn primary', onclick: () => Exam.resumeExam() }, 'Resume')
          )
        ));
      }
    }

    if (lastAttempt) {
      main.appendChild(UI.el('div', { class: 'card' },
        UI.el('h3', {}, 'Last Attempt'),
        UI.el('div', { class: 'row spread' },
          UI.el('div', {}, 
            UI.el('div', { class: 'faint' }, new Date(lastAttempt.date).toLocaleString()),
            UI.el('div', { style: 'font-size:1.5rem;font-weight:bold' }, 
              `${lastAttempt.score} / ${lastAttempt.maxScore} (${Math.round(lastAttempt.percent)}%)`
            )
          ),
          UI.el('a', { href: `#/results?id=${lastAttempt.attemptId}`, class: 'btn' }, 'Review')
        )
      ));
    }

    const form = UI.el('form', { class: 'card stack', onsubmit: (e) => { e.preventDefault(); startFromForm(form); } });
    form.appendChild(UI.el('h2', {}, 'Start New Exam'));

    const row1 = UI.el('div', { class: 'form-grid' });
    row1.appendChild(UI.el('div', {}, UI.el('label', {}, 'Time Limit'), 
      UI.el('select', { name: 'duration' },
        UI.el('option', { value: '60' }, '1 Hour'),
        UI.el('option', { value: '180', selected: 'selected' }, '3 Hours'),
        UI.el('option', { value: '15' }, '15 Mins')
      )
    ));
    row1.appendChild(UI.el('div', {}, UI.el('label', {}, 'Number of Questions'),
      UI.el('input', { type: 'number', name: 'numQ', min: '1', max: String(totalQs), value: totalQs })
    ));
    form.appendChild(row1);

    const row2 = UI.el('div', { class: 'form-grid' });
    row2.appendChild(UI.el('div', {}, UI.el('label', {}, 'Section'), 
      UI.el('select', { name: 'section' },
        UI.el('option', { value: '' }, 'All Sections'),
        ...State.sections().map(s => UI.el('option', { value: s }, s))
      )
    ));

    const tagWrap = UI.el('div', { class: 'tag-select', style: 'max-height:120px' });
    tagList.forEach(t => tagWrap.appendChild(UI.el('label', {}, UI.el('input', { type: 'checkbox', name: 'tags', value: t }), t)));
    row2.appendChild(UI.el('div', {}, UI.el('label', {}, 'Tags'), tagWrap));
    form.appendChild(row2);

    form.appendChild(UI.el('div', { style: 'display:flex; gap:20px; margin:8px 0' },
      UI.el('div', { class: 'checkbox' }, UI.el('input', { type: 'checkbox', name: 'shuffle', id: 'chk-shuffle' }), UI.el('label', { for: 'chk-shuffle' }, 'Shuffle')),
      UI.el('div', { class: 'checkbox' }, UI.el('input', { type: 'checkbox', name: 'neg', id: 'chk-neg', checked: settings.negativeMarking }), UI.el('label', { for: 'chk-neg' }, 'Negative Marking'))
    ));

    form.appendChild(UI.el('div', { style: 'margin-top:12px' }, UI.el('button', { type: 'submit', class: 'btn primary', style: 'width:100%' }, 'Start Exam')));
    main.appendChild(form);
  }

  function startFromForm(form) {
    const fd = new FormData(form);
    const durationMin = parseInt(fd.get('duration'), 10);
    let numQ = parseInt(fd.get('numQ'), 10);
    const section = fd.get('section') || '';
    const shuffle = fd.get('shuffle') === 'on';
    const negativeMarking = fd.get('neg') === 'on';
    const tags = fd.getAll('tags');

    let qPool = State.filterQuestions({ section, tags });
    if (qPool.length === 0) { UI.toast('No questions match filters.', 'err'); return; }

    if (shuffle) qPool = State.shuffled(qPool);
    if (!numQ || numQ > qPool.length) numQ = qPool.length;
    qPool = qPool.slice(0, numQ);

    Exam.startExam({
      durationMin, questionIds: qPool.map(q => q.id), shuffle, negativeMarking, sectionFilter: section, tagFilter: tags
    });
  }

  function renderHowTo() {
    const main = document.getElementById('main');
    UI.clear(main);
    main.appendChild(UI.el('div', { class: 'card' },
      UI.el('h1', {}, 'How to use this app'),
      UI.el('p', {}, 'This is an offline-first exam practice tool.'),
      UI.el('h3', {}, 'Starting an Exam'),
      UI.el('p', {}, 'Go to Home, select your filters, and click Start.'),
      UI.el('h3', {}, 'Keyboard Shortcuts'),
      UI.el('ul', {},
        UI.el('li', {}, '1, 2, 3, 4 to select MCQ options'),
        UI.el('li', {}, 'Shift+N / Shift+P for Next / Prev'),
        UI.el('li', {}, 'Shift+S to Skip, Shift+M to Mark'),
        UI.el('li', {}, 'Shift+C to Clear, Shift+Z to Zoom')
      )
    ));
  }

  function parseRoute(hash) {
    const raw = hash.replace(/^#\//, '');
    const parts = raw.split('?');
    return { path: parts[0] || 'home', queryParams: new URLSearchParams(parts[1] || '') };
  }

  async function router() {
    const hash = window.location.hash || '#/home';
    const { path, queryParams } = parseRoute(hash);
    const main = document.getElementById('main');

    document.querySelectorAll('.topnav a').forEach(a => {
      a.classList.toggle('active', a.getAttribute('href') === '#/' + path);
    });
    window.scrollTo(0, 0);

    try {
      if (path === 'home' || path === '') await renderHome();
      else if (path === 'exam') Exam.renderPage();
      else if (path === 'results') Results.renderPage({ id: queryParams.get('id') });
      else if (path === 'history') Analytics.renderHistory();
      else if (path === 'analytics') Analytics.renderDashboard();
      else if (path === 'add' && window.AddQuestions) AddQuestions.renderPage();
      else if (path === 'verify' && window.Verify) Verify.renderPage();
      else if (path === 'how') renderHowTo();
      else main.innerHTML = '<div class="card empty"><h2>Page not found</h2></div>';
    } catch (err) {
      console.error('Router Error:', err);
      main.innerHTML = `<div class="card empty" style="border-color:var(--err)"><h2>Application Error</h2><p>${err.message}</p></div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    UI.initTheme();
    UI.initModal();
    Exam.init();
    window.addEventListener('hashchange', router);
    router();
  });
})();