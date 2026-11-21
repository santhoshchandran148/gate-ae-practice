/* ============================================================
 * state.js — app-wide state helpers on top of Storage.
 * ============================================================ */
(function () {
  'use strict';

  function loadAllQuestions() {
    const base = (window.QUESTIONS || []).map(q => ({
      ...q,
      id: q.id || `q${String(q.qno).padStart(3, '0')}`,
      tag: q.tag || 'Untagged',
      section: q.section || 'AE',
      marks: Number(q.marks) || 1,
    }));

    const custom = Storage.getCustomQs().map(q => ({
      ...q,
      tag: q.tag || 'Custom',
      section: q.section || 'Custom'
    }));

    return base.concat(custom);
  }

  let QUESTIONS = loadAllQuestions();

  function refreshQuestions() {
    QUESTIONS = loadAllQuestions();
  }

  function allQuestions() { return QUESTIONS.slice(); }
  function questionById(id) { return QUESTIONS.find(q => q.id === id) || null; }
  function questionsById(ids) { return ids.map(id => questionById(id)).filter(Boolean); }
  function sections() { return Array.from(new Set(QUESTIONS.map(q => q.section))).sort(); }
  function tags() { return Array.from(new Set(QUESTIONS.map(q => q.tag))).sort(); }

  function filterQuestions({ section, tags: tagList }) {
    return QUESTIONS.filter(q => {
      if (section && q.section !== section) return false;
      if (tagList && tagList.length && !tagList.includes(q.tag)) return false;
      return true;
    });
  }

  function shuffled(arr, seed) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

    function newSession(opts) {
    const now = Date.now();
    const durationSec = Math.max(60, Math.floor(opts.durationMin * 60));
    const ids = opts.questionIds.slice();
    const s = {
      sessionId: 'sess_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      startedAt: now,
      endTime: now + durationSec * 1000,
      durationSec,
      questionOrder: ids,
      currentIndex: 0,
      responses: {},
      settings: {
        negativeMarking: !!opts.negativeMarking,
        shuffle: !!opts.shuffle,
        sectionFilter: opts.sectionFilter || '',
        tagFilter: (opts.tagFilter || []).slice(),
      },
      status: 'active',
    };
    for (const qid of ids) {
      // Default state is 'not_visited'. Exam.js changes this when you click on it.
      s.responses[qid] = { value: null, status: 'not_visited', timeSpentSec: 0, visits: 0 };
    }
    return s;
  }

  function attemptSummary(s, responseMap) {
    const responses = responseMap || (s && s.responses) || {};
    let answered = 0, skipped = 0, marked = 0, notVisited = 0;
    for (const qid of (s ? s.questionOrder : [])) {
      const r = responses[qid] || { status: 'not_visited' };
      if (r.status === 'answered') answered++;
      else if (r.status === 'skipped') skipped++;
      else if (r.status === 'marked') marked++;
      if (r.status === 'not_visited') notVisited++;
    }
    return { answered, skipped, marked, notVisited };
  }

  function getHistory() {
    const arr = Storage.getHistory() || [];
    return arr.slice().sort((a, b) => (b.date || 0) - (a.date || 0));
  }
  function addAttempt(result) {
    const arr = Storage.getHistory() || [];
    arr.push(result);
    Storage.setHistory(arr);
    return arr;
  }
  function attemptById(id) {
    return (Storage.getHistory() || []).find(a => a.attemptId === id) || null;
  }

  window.State = {
    allQuestions, questionById, questionsById, refreshQuestions,
    sections, tags, filterQuestions, shuffled,
    newSession, getSession: Storage.getSession, saveSession: Storage.setSession, clearSession: Storage.clearSession,
    isSessionActive: (s) => !!s && s.status === 'active',
    sessionRemainingMs: (s) => s ? Math.max(0, s.endTime - Date.now()) : 0,
    attemptSummary, getHistory, addAttempt, attemptById,
  };
})();