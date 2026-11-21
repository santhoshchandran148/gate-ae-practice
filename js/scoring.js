/* ============================================================
 * scoring.js — Evaluates attempts against answers.js
 * ============================================================ */
(function () {
  'use strict';

  let answersPromise = null;

  function loadAnswers() {
    if (window.ANSWERS) return Promise.resolve(window.ANSWERS);
    if (answersPromise) return answersPromise;

    answersPromise = new Promise((resolve, reject) => {
      const oldScript = document.getElementById('answers-script');
      if (oldScript) oldScript.remove();

      const script = document.createElement('script');
      script.id = 'answers-script';
      script.src = 'data/answers.js';
      
      const timeout = setTimeout(() => {
        reject(new Error('Timeout loading data/answers.js. Check that the file exists.'));
      }, 5000);

      script.onload = () => {
        clearTimeout(timeout);
        if (window.ANSWERS && typeof window.ANSWERS === 'object') {
          resolve(window.ANSWERS);
        } else {
          reject(new Error('Script loaded, but window.ANSWERS is missing or invalid.'));
        }
      };
      
      script.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Failed to fetch data/answers.js.'));
      };
      
      document.body.appendChild(script);
    });
    return answersPromise;
  }

  async function evaluate(session, questions, settings) {
    const answers = await loadAnswers();
    if (!answers) throw new Error("Answers object is empty.");

    const negEnabled = session.settings.negativeMarking;
    const mcqNeg = settings.marking.mcqWrongFactor;

    let score = 0;
    let maxScore = 0;
    
    let correctCount = 0;
    let wrongCount = 0;
    let skippedCount = 0;
    let notVisitedCount = 0;

    const sectionScores = {};
    const tagAccuracy = {};
    const perQuestion = [];

    for (const qid of session.questionOrder) {
      const q = questions.find(x => x.id === qid) || { marks: 1, type: 'MCQ', section: 'Unknown', tag: 'Unknown' };
      const resp = session.responses[qid] || { value: null, status: 'not_visited' };
      const ansKey = answers[qid] || {};
      const correctAns = ansKey.answer;

      maxScore += q.marks || 1;

      let isCorrect = false;
      let marksEarned = 0;
      let status = 'skipped';

      // 1. Not Visited vs Skipped
      if (resp.status === 'not_visited') {
        notVisitedCount++;
        status = 'not_visited';
      } 
      else if (!resp.value || (Array.isArray(resp.value) && resp.value.length === 0)) {
        skippedCount++;
        status = 'skipped';
      } 
      // 2. Answered (Correct or Wrong)
      else {
        if (q.type === 'MCQ') {
          if (String(resp.value).toUpperCase() === String(correctAns).toUpperCase()) {
            isCorrect = true;
            marksEarned = q.marks;
            correctCount++;
            status = 'correct';
          } else {
            marksEarned = negEnabled ? -(q.marks * mcqNeg) : 0;
            wrongCount++;
            status = 'wrong';
          }
        } 
        else if (q.type === 'MSQ') {
          const sel = Array.isArray(resp.value) ? resp.value.slice().sort() : [];
          const cor = Array.isArray(correctAns) ? correctAns.slice().sort() : [];
          if (sel.length === cor.length && sel.every((v, i) => v === cor[i])) {
            isCorrect = true;
            marksEarned = q.marks;
            correctCount++;
            status = 'correct';
          } else {
            wrongCount++;
            status = 'wrong';
          }
        } 
        else if (q.type === 'NAT') {
          const val = parseFloat(resp.value);
          if (!isNaN(val) && correctAns && typeof correctAns.min === 'number') {
            if (val >= correctAns.min && val <= correctAns.max) {
              isCorrect = true;
              marksEarned = q.marks;
              correctCount++;
              status = 'correct';
            } else {
              wrongCount++;
              status = 'wrong';
            }
          } else {
            wrongCount++;
            status = 'wrong';
          }
        }
      }

      score += marksEarned;
      
      if (!sectionScores[q.section]) sectionScores[q.section] = { score: 0, max: 0, correct: 0, total: 0 };
      sectionScores[q.section].score += marksEarned;
      sectionScores[q.section].max += (q.marks || 1);
      sectionScores[q.section].total++;
      if (isCorrect) sectionScores[q.section].correct++;

      if (!tagAccuracy[q.tag]) tagAccuracy[q.tag] = { correct: 0, total: 0 };
      tagAccuracy[q.tag].total++;
      if (isCorrect) tagAccuracy[q.tag].correct++;

      perQuestion.push({
        id: qid,
        response: resp.value,
        correct: isCorrect,
        status: status,
        marksEarned: marksEarned,
        timeSpentSec: resp.timeSpentSec || 0
      });
    }

    const percent = maxScore > 0 ? (score / maxScore) * 100 : 0;
    const passPercent = settings.passPercent || 50;

    return {
      attemptId: session.sessionId,
      date: Date.now(),
      durationSec: session.durationSec,
      timeUsedSec: Math.floor((Date.now() - session.startedAt) / 1000),
      settings: session.settings,
      score: score,
      maxScore: maxScore,
      percent: percent,
      passed: percent >= passPercent,
      counts: {
        correct: correctCount,
        wrong: wrongCount,
        skipped: skippedCount,
        not_visited: notVisitedCount,
        total: session.questionOrder.length
      },
      sectionScores,
      tagAccuracy,
      perQuestion
    };
  }

  window.Scoring = { evaluate, loadAnswers };
})();