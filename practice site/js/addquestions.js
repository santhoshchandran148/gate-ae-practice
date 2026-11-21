/* ============================================================
 * addquestions.js — Add custom questions via screenshots
 * ============================================================ */
(function () {
  'use strict';

  async function renderPage() {
    const main = document.getElementById('main');
    UI.clear(main);

    main.appendChild(UI.el('h1', {}, 'Add Custom Questions'));
    main.appendChild(UI.el('div', { class: 'card' },
      UI.el('p', {}, 'Upload a screenshot of a question. It will be saved to your browser.'),
      UI.el('form', { id: 'add-form', class: 'stack', onsubmit: handleFormSubmit },
        UI.el('div', { class: 'form-grid' },
          UI.el('div', { class: 'full' },
            UI.el('label', {}, 'Question Image (PNG, JPG)'),
            UI.el('input', { type: 'file', name: 'image', accept: 'image/*', required: true })
          ),
          UI.el('div', {},
            UI.el('label', {}, 'Question Type'),
            UI.el('select', { name: 'type', required: true },
              UI.el('option', { value: 'MCQ' }, 'MCQ (Single Correct)'),
              UI.el('option', { value: 'MSQ' }, 'MSQ (Multiple Correct)'),
              UI.el('option', { value: 'NAT' }, 'NAT (Numerical)')
            )
          ),
          UI.el('div', {},
            UI.el('label', {}, 'Marks'),
            UI.el('input', { type: 'number', name: 'marks', value: '1', min: '1', max: '2', required: true })
          ),
          UI.el('div', { class: 'full' },
            UI.el('label', {}, 'Correct Answer'),
            UI.el('div', { id: 'answer-fields' })
          ),
          UI.el('div', {},
            UI.el('label', {}, 'Section'),
            UI.el('input', { type: 'text', name: 'section', value: 'Custom', required: true })
          ),
          UI.el('div', {},
            UI.el('label', {}, 'Tag/Topic'),
            UI.el('input', { type: 'text', name: 'tag', value: 'Custom Topic', required: true })
          )
        ),
        UI.el('div', { style: 'margin-top:16px' },
          UI.el('button', { type: 'submit', class: 'btn primary' }, 'Save Question')
        )
      )
    ));

    // Handle answer field switching based on type
    const typeSelect = main.querySelector('[name="type"]');
    const ansContainer = main.querySelector('#answer-fields');
    
    function updateAnsFields() {
      UI.clear(ansContainer);
      const type = typeSelect.value;
      if (type === 'MCQ') {
        ansContainer.appendChild(UI.el('select', { name: 'answer', required: true },
          ['A', 'B', 'C', 'D'].map(l => UI.el('option', { value: l }, l))
        ));
      } else if (type === 'MSQ') {
        ansContainer.appendChild(UI.el('div', { style: 'display:flex; gap:16px;' },
          ['A', 'B', 'C', 'D'].map(l => UI.el('label', { class: 'checkbox' },
            UI.el('input', { type: 'checkbox', name: 'answer', value: l }), l
          ))
        ));
      } else if (type === 'NAT') {
        ansContainer.appendChild(UI.el('div', { style: 'display:flex; gap:8px; align-items:center' },
          UI.el('input', { type: 'number', name: 'answer_min', step: 'any', placeholder: 'Min', required: true, style: 'width:100px' }),
          UI.el('span', {}, 'to'),
          UI.el('input', { type: 'number', name: 'answer_max', step: 'any', placeholder: 'Max', required: true, style: 'width:100px' })
        ));
      }
    }
    
    typeSelect.addEventListener('change', updateAnsFields);
    updateAnsFields(); // initial load
  }

  async function handleFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const file = fd.get('image');
    const type = fd.get('type');
    const marks = parseInt(fd.get('marks'), 10);
    
    if (!file || file.size === 0) {
      UI.toast('Please select an image.', 'err');
      return;
    }

    let answer = null;
    if (type === 'MCQ') {
      answer = fd.get('answer');
    } else if (type === 'MSQ') {
      answer = fd.getAll('answer').sort();
    } else if (type === 'NAT') {
      answer = { min: parseFloat(fd.get('answer_min')), max: parseFloat(fd.get('answer_max')) };
    }

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
      // 1. Save Image to IndexedDB
      const id = 'custom_' + Date.now();
      await Storage.saveImage(id, file);

      // 2. Save Metadata to LocalStorage
      const meta = {
        id: id,
        qno: 'Custom',
        image: id, // We will intercept this in exam.js/results.js
        type: type,
        marks: marks,
        section: fd.get('section'),
        tag: fd.get('tag'),
        answer: answer
      };
      
      const customQs = Storage.getCustomQs();
      customQs.push(meta);
      Storage.setCustomQs(customQs);

      State.refreshQuestions(); // Reload state
      
      UI.toast('Question added successfully!', 'ok');
      form.reset();
      updateAnsFields(); // reset dropdowns
    } catch (err) {
      console.error(err);
      UI.toast('Failed to save question.', 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Question';
    }
  }

  // We need a helper to resolve custom image IDs to Blob URLs
  async function resolveImages(questions) {
    for (const q of questions) {
      if (q.id.startsWith('custom_')) {
        try {
          const blob = await Storage.getImage(q.id);
          if (blob) q.image = URL.createObjectURL(blob);
        } catch (e) {
          console.error('Failed to load image for', q.id, e);
        }
      }
    }
  }

  window.AddQuestions = { renderPage, resolveImages };
})();