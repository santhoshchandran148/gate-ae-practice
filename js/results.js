/* ============================================================
 * results.js — Results summary, detailed review, retry logic.
 * ============================================================ */
(function () {
  'use strict';

  let currentResult = null;
  let reviewFilter = 'all';

  async function finalize(session) {
    const settings = Storage.getSettings();
    const questions = State.allQuestions();
    const result = await Scoring.evaluate(session, questions, settings);
    
    State.addAttempt(result);
    State.clearSession();
    
    return result;
  }

  function renderPage(params) {
    const main = document.getElementById('main');
    UI.clear(main);
    
    let attemptId = params ? params.id : null;
    if (!attemptId) {
      main.innerHTML = '<div class="card empty">No attempt ID provided.</div>';
      return;
    }

    let result = State.attemptById(attemptId);
    if (!result) {
      main.innerHTML = '<div class="card empty">Result not found in history. (Did you clear your data?)</div>';
      return;
    }

    currentResult = result;
    
    Scoring.loadAnswers().then(() => {
      renderSummary(main, result);
    }).catch(err => {
      UI.clear(main);
      main.appendChild(UI.el('div', { class: 'card empty', style: 'border-color:var(--err)' },
        UI.el('h2', { style: 'color:var(--err)' }, 'Answers Missing'),
        UI.el('p', {}, err.message || String(err)),
        UI.el('button', { class: 'btn primary', onclick: () => window.location.reload() }, 'Retry Evaluation')
      ));
    });
  }

  function renderSummary(main, result) {
    try {
      UI.clear(main);
      
      const badgeClass = result.passed ? 'ok' : 'err';
      const badgeText = result.passed ? 'PASS' : 'FAIL';

      const header = UI.el('div', { class: 'card' },
        UI.el('div', { class: 'row spread' },
          UI.el('div', {},
            UI.el('h1', { style: 'margin:0' }, 'Exam Results'),
            UI.el('div', { class: 'faint' }, new Date(result.date).toLocaleString())
          ),
          UI.el('div', { class: 'badge ' + badgeClass, style: 'font-size:1.2rem; padding:8px 16px' }, badgeText)
        ),
        UI.el('hr', { style: 'border:none; border-top:1px solid var(--border); margin:16px 0' }),
        UI.el('div', { class: 'row', style: 'justify-content:space-around; text-align:center; flex-wrap:wrap; gap:10px' },
          UI.el('div', { style: 'min-width:90px' },
            UI.el('div', { style: 'font-size:2rem; font-weight:bold' }, `${result.score} / ${result.maxScore}`),
            UI.el('div', { class: 'muted' }, 'Score')
          ),
          UI.el('div', { style: 'min-width:90px' },
            UI.el('div', { style: 'font-size:2rem; font-weight:bold; color:var(--ok)' }, String(result.counts.correct)),
            UI.el('div', { class: 'muted' }, 'Correct')
          ),
          UI.el('div', { style: 'min-width:90px' },
            UI.el('div', { style: 'font-size:2rem; font-weight:bold; color:var(--err)' }, String(result.counts.wrong)),
            UI.el('div', { class: 'muted' }, 'Wrong')
          ),
          UI.el('div', { style: 'min-width:90px' },
            UI.el('div', { style: 'font-size:2rem; font-weight:bold; color:var(--warn)' }, String(result.counts.skipped || 0)),
            UI.el('div', { class: 'muted' }, 'Skipped')
          ),
          UI.el('div', { style: 'min-width:90px' },
            UI.el('div', { style: 'font-size:2rem; font-weight:bold; color:var(--fg-faint)' }, String(result.counts.not_visited || 0)),
            UI.el('div', { class: 'muted' }, 'Not Visited')
          )
        )
      );
      main.appendChild(header);

      if (result.sectionScores) {
        const secCard = UI.el('div', { class: 'card' }, UI.el('h3', {}, 'Section Breakdown'));
        const grid = UI.el('div', { style: 'display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:16px;' });
        
        for (const [sec, data] of Object.entries(result.sectionScores)) {
          const pct = data.max > 0 ? (data.score / data.max) * 100 : 0;
          grid.appendChild(UI.el('div', { style: 'background:var(--bg-soft); padding:12px; border-radius:8px;' },
            UI.el('h4', { style: 'margin:0 0 8px' }, sec),
            UI.el('div', {}, `Score: ${data.score} / ${data.max} (${Math.round(pct)}%)`),
            UI.el('div', { class: 'faint' }, `Correct: ${data.correct} / ${data.total}`)
          ));
        }
        secCard.appendChild(grid);
        main.appendChild(secCard);
      }

      const actions = UI.el('div', { class: 'row', style: 'margin-bottom:16px' },
        UI.el('button', { class: 'btn primary', onclick: () => startRetry(result) }, 'Retry Missed Questions'),
        UI.el('button', { class: 'btn', onclick: () => window.location.hash = '#/home' }, 'Back to Home'),
        UI.el('button', { class: 'btn', onclick: () => window.print() }, 'Print Result')
      );
      main.appendChild(actions);

      const reviewCard = UI.el('div', { class: 'card' });
      const filterRow = UI.el('div', { class: 'row', style: 'margin-bottom:16px; flex-wrap:wrap; gap:8px;' },
        UI.el('h3', { style: 'margin:0; flex:1' }, 'Detailed Review')
      );
      
      const filters = [
        { id: 'all', label: 'All' },
        { id: 'correct', label: 'Correct' },
        { id: 'wrong', label: 'Wrong' },
        { id: 'skipped', label: 'Skipped' },
        { id: 'not_visited', label: 'Not Visited' }
      ];

      filters.forEach(f => {
        filterRow.appendChild(UI.el('button', { 
          class: `btn sm ${reviewFilter === f.id ? 'primary' : 'ghost'}`,
          onclick: () => { reviewFilter = f.id; renderSummary(main, result); }
        }, f.label));
      });
      
      reviewCard.appendChild(filterRow);
      
      const list = UI.el('div', { id: 'review-list' });
      
      result.perQuestion.forEach(pq => {
        if (reviewFilter !== 'all' && pq.status !== reviewFilter) return;
        
        const q = State.questionById(pq.id);
        if (!q) return; 

        const answers = window.ANSWERS || {};
        const ansKey = answers[pq.id] || {};
        
        let statusColor = 'var(--fg-muted)';
        let statusText = 'NOT VISITED';
        if (pq.status === 'correct') { statusColor = 'var(--ok)'; statusText = 'CORRECT'; }
        else if (pq.status === 'wrong') { statusColor = 'var(--err)'; statusText = 'WRONG'; }
        else if (pq.status === 'skipped') { statusColor = 'var(--warn)'; statusText = 'SKIPPED'; }

        const imgSrc = q.image;
        const imgEl = UI.el('img', { src: imgSrc, style: 'max-width: 100%; border: 1px solid var(--border); border-radius: 4px; margin-top: 4px;', loading: 'lazy' });
        
        if (q.id.startsWith('custom_')) {
          Storage.getImage(q.id).then(blob => {
            if (blob) imgEl.src = URL.createObjectURL(blob);
          }).catch(err => console.error('Failed to load custom image', err));
        }

        const card = UI.el('div', { style: `border-left: 4px solid ${statusColor}; padding: 12px; background: var(--bg-soft); border-radius: 6px; margin-bottom: 12px;` },
          UI.el('div', { class: 'row spread' },
            UI.el('div', {}, 
              UI.el('strong', {}, `Q ${q.qno}`), 
              UI.el('span', { class: 'badge', style: 'margin-left:8px' }, q.type),
              UI.el('span', { class: 'muted', style: 'margin-left:8px; font-size:0.9rem' }, q.tag)
            ),
            UI.el('div', { style: `color: ${statusColor}; font-weight: bold;` }, 
              `${statusText} ${pq.status !== 'not_visited' ? `(${pq.marksEarned > 0 ? '+' : ''}${pq.marksEarned})` : ''}`
            )
          ),
          UI.el('div', { style: 'margin-top: 12px; display: flex; flex-wrap: wrap; gap: 16px;' },
            UI.el('div', { style: 'flex: 1 1 300px' },
              UI.el('div', { class: 'faint' }, 'Question Image'),
              imgEl
            ),
            UI.el('div', { style: 'flex: 1 1 200px' },
              UI.el('div', { style: 'margin-bottom: 8px' },
                UI.el('div', { class: 'faint' }, 'Your Answer'),
                UI.el('strong', { style: `color: ${pq.status === 'correct' ? 'var(--ok)' : (pq.status === 'wrong' ? 'var(--err)' : 'var(--fg-muted)')}` }, formatAns(pq.response, q.type))
              ),
              UI.el('div', {},
                UI.el('div', { class: 'faint' }, 'Correct Answer'),
                UI.el('strong', { style: 'color: var(--ok)' }, formatAns(ansKey.answer, q.type))
              )
            )
          )
        );
        list.appendChild(card);
      });
      
      if (list.children.length === 0) {
        list.appendChild(UI.el('div', { class: 'empty' }, 'No questions match this filter.'));
      }

      reviewCard.appendChild(list);
      main.appendChild(reviewCard);
    } catch (err) {
      console.error('renderSummary failed:', err);
      UI.clear(main);
      main.appendChild(UI.el('div', { class: 'card empty', style: 'border-color:var(--err)' },
        UI.el('h2', { style: 'color:var(--err)' }, 'Render Error'),
        UI.el('p', {}, err.message),
        UI.el('button', { class: 'btn primary', onclick: () => window.location.reload() }, 'Reload Page')
      ));
    }
  }

  function formatAns(val, type) {
    if (!val) return '—';
    if (type === 'NAT' && typeof val === 'object' && val.min !== undefined) {
      return `${val.min} to ${val.max}`;
    }
    if (Array.isArray(val)) return val.join(', ');
    return String(val);
  }

  function startRetry(result) {
    const wrongIds = result.perQuestion.filter(pq => pq.status === 'wrong' || pq.status === 'skipped').map(pq => pq.id);
    if (wrongIds.length === 0) {
      UI.toast('No wrong or skipped questions to retry!', 'info');
      return;
    }
    Exam.startExam({
      durationMin: result.durationSec / 60,
      questionIds: wrongIds,
      shuffle: result.settings.shuffle,
      negativeMarking: result.settings.negativeMarking,
      sectionFilter: result.settings.sectionFilter,
      tagFilter: result.settings.tagFilter
    });
  }

  window.Results = { finalize, renderPage };
})();