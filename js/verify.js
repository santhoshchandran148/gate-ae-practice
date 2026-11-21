/* ============================================================
 * verify.js — Setup-only gallery with answers visible.
 * ============================================================ */
(function () {
  'use strict';

  async function renderPage() {
    const main = document.getElementById('main');
    UI.clear(main);

    main.appendChild(UI.el('div', { class: 'card', style: 'border-color:var(--warn); background:var(--warn-soft)' },
      UI.el('h2', { style: 'color:var(--warn)' }, '⚠️ Verify Mode (Answers Visible)'),
      UI.el('p', {}, 'This page is for debugging only. Do not use this while taking a test.')
    ));

    try {
      const answers = await Scoring.loadAnswers();
      const questions = State.allQuestions();
      await AddQuestions.resolveImages(questions);

      const grid = UI.el('div', { style: 'display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:16px;' });

      questions.forEach(q => {
        const ansKey = answers[q.id] || {};
        let ansText = '—';
        if (q.type === 'NAT' && ansKey.answer) ansText = `${ansKey.answer.min} to ${ansKey.answer.max}`;
        else if (Array.isArray(ansKey.answer)) ansText = ansKey.answer.join(', ');
        else if (ansKey.answer) ansText = String(ansKey.answer);

        grid.appendChild(UI.el('div', { class: 'card', style: 'margin:0; padding:12px' },
          UI.el('div', { class: 'row spread', style: 'margin-bottom:8px' },
            UI.el('strong', {}, `Q ${q.qno}`),
            UI.el('div', {},
              UI.el('span', { class: 'badge' }, q.type),
              UI.el('span', { class: 'badge' }, q.section),
              UI.el('span', { class: 'badge', style: 'background:var(--accent); color:#fff' }, `Ans: ${ansText}`)
            )
          ),
          UI.el('div', { class: 'faint' }, q.tag),
          UI.el('img', { src: q.image, style: 'width:100%; margin-top:8px; border-radius:4px', loading: 'lazy' })
        ));
      });

      main.appendChild(grid);
    } catch (err) {
      main.appendChild(UI.el('div', { class: 'card empty', style: 'color:var(--err)' },
        UI.el('h3', {}, 'Error loading answers'),
        UI.el('p', {}, err.message)
      ));
    }
  }

  window.Verify = { renderPage };
})();