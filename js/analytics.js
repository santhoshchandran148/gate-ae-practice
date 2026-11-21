/* ============================================================
 * analytics.js — History table and SVG Charts
 * ============================================================ */
(function () {
  'use strict';

  function renderHistory() {
    const main = document.getElementById('main');
    UI.clear(main);
    const history = State.getHistory();

    main.appendChild(UI.el('h1', {}, 'Exam History'));
    
    if (history.length === 0) {
      main.appendChild(UI.el('div', { class: 'card empty' }, 'No attempts yet. Start a new exam!'));
      return;
    }

    const table = UI.el('table', { style: 'width:100%; border-collapse:collapse; text-align:left;' });
    const thead = UI.el('thead', {},
      UI.el('tr', { style: 'border-bottom: 2px solid var(--border);' },
        UI.el('th', { style: 'padding:12px 8px' }, 'Date'),
        UI.el('th', { style: 'padding:12px 8px' }, 'Score'),
        UI.el('th', { style: 'padding:12px 8px' }, 'Percent'),
        UI.el('th', { style: 'padding:12px 8px' }, 'Result'),
        UI.el('th', { style: 'padding:12px 8px' }, 'Action')
      )
    );
    
    const tbody = UI.el('tbody');
    history.forEach(attempt => {
      tbody.appendChild(UI.el('tr', { style: 'border-bottom: 1px solid var(--border);' },
        UI.el('td', { style: 'padding:12px 8px' }, new Date(attempt.date).toLocaleString()),
        UI.el('td', { style: 'padding:12px 8px' }, `${attempt.score} / ${attempt.maxScore}`),
        UI.el('td', { style: 'padding:12px 8px' }, `${Math.round(attempt.percent)}%`),
        UI.el('td', { style: 'padding:12px 8px' }, 
          UI.el('span', { class: 'badge ' + (attempt.passed ? 'ok' : 'err') }, attempt.passed ? 'PASS' : 'FAIL')
        ),
        UI.el('td', { style: 'padding:12px 8px' },
          UI.el('a', { href: `#/results?id=${attempt.attemptId}`, class: 'btn sm' }, 'Review')
        )
      ));
    });
    
    table.appendChild(thead);
    table.appendChild(tbody);
    main.appendChild(UI.el('div', { class: 'card', style: 'overflow-x:auto' }, table));
  }

  function renderDashboard() {
    const main = document.getElementById('main');
    UI.clear(main);
    
    // Sort chronologically for the chart
    const history = State.getHistory().slice().sort((a,b) => a.date - b.date);

    main.appendChild(UI.el('h1', {}, 'Analytics'));

    if (history.length === 0) {
      main.appendChild(UI.el('div', { class: 'card empty' }, 'Complete at least one exam to see analytics.'));
      return;
    }

    // --- Score Trend Chart (Inline SVG) ---
    const w = 600, h = 200, pad = 40;
    const maxPct = 100;
    
    // Calculate coordinates for all points
    const pts = history.map((attempt, i) => {
      const x = history.length === 1 ? w / 2 : pad + (i / (history.length - 1)) * (w - pad * 2);
      // Ensure y fits inside the graph (0% goes to bottom, 100% goes to top)
      const pct = Math.max(0, Math.min(100, attempt.percent || 0));
      const y = h - pad - (pct / maxPct) * (h - pad * 2);
      return { x, y, pct, date: attempt.date };
    });

    const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    
    // If there's only one point, draw a horizontal line across to make it visible
    const lineD = pts.length === 1 
      ? `M ${pad} ${pts[0].y} L ${w - pad} ${pts[0].y}` 
      : pathD;

    const svgContent = `
      <svg viewBox="0 0 ${w} ${h}" style="width:100%; height:auto; background:var(--bg-soft); border-radius:8px; overflow:visible;">
        <!-- Grid lines -->
        <line x1="${pad}" y1="${h-pad}" x2="${w-pad}" y2="${h-pad}" stroke="var(--border)" stroke-width="2"/>
        <line x1="${pad}" y1="${h - pad - (h-pad*2)/2}" x2="${w-pad}" y2="${h - pad - (h-pad*2)/2}" stroke="var(--border)" stroke-dasharray="4"/>
        <line x1="${pad}" y1="${pad}" x2="${w-pad}" y2="${pad}" stroke="var(--border)" stroke-dasharray="4"/>
        
        <!-- Labels -->
        <text x="5" y="${h-pad+5}" fill="var(--fg-muted)" font-size="12">0%</text>
        <text x="5" y="${h - pad - (h-pad*2)/2 + 5}" fill="var(--fg-muted)" font-size="12">50%</text>
        <text x="5" y="${pad+5}" fill="var(--fg-muted)" font-size="12">100%</text>

        <!-- Trend Line -->
        <path d="${lineD}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round"/>
        
        <!-- Points -->
        ${pts.map((p, i) => `
          <circle cx="${p.x}" cy="${p.y}" r="5" fill="var(--bg-elev)" stroke="var(--accent)" stroke-width="3">
            <title>${new Date(p.date).toLocaleDateString()}: ${Math.round(p.pct)}%</title>
          </circle>
        `).join('')}
      </svg>
    `;

    main.appendChild(UI.el('div', { class: 'card' },
      UI.el('h3', {}, 'Score Trend (%)'),
      UI.el('div', { html: svgContent })
    ));

    // --- Accuracy per Topic ---
    const tagStats = {};
    history.forEach(attempt => {
      attempt.perQuestion.forEach(pq => {
        const q = State.questionById(pq.id);
        if (!q) return;
        if (!tagStats[q.tag]) tagStats[q.tag] = { correct: 0, total: 0 };
        tagStats[q.tag].total++;
        if (pq.status === 'correct') tagStats[q.tag].correct++;
      });
    });

    const sortedTags = Object.entries(tagStats)
      .map(([tag, d]) => ({ tag, pct: d.total > 0 ? d.correct / d.total : 0, total: d.total }))
      .sort((a, b) => a.pct - b.pct); // Lowest accuracy first

    const tagList = UI.el('div', {});
    sortedTags.forEach(t => {
      tagList.appendChild(UI.el('div', { style: 'margin-bottom:12px' },
        UI.el('div', { class: 'row spread', style: 'font-size:0.9rem; margin-bottom:4px' },
          UI.el('strong', {}, t.tag),
          UI.el('span', { class: 'muted' }, `${Math.round(t.pct*100)}% (${t.total} Qs)`)
        ),
        UI.el('div', { style: 'height:8px; background:var(--bg); border-radius:4px; overflow:hidden' },
          UI.el('div', { style: `height:100%; width:${t.pct*100}%; background:${t.pct < 0.5 ? 'var(--err)' : 'var(--ok)'}` })
        )
      ));
    });
    
    main.appendChild(UI.el('div', { class: 'card' },
      UI.el('h3', {}, 'Accuracy by Topic'),
      tagList
    ));
  }

  window.Analytics = { renderHistory, renderDashboard };
})();