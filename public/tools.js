// Separate tool pages (Interview prep, Image creator, Video creator, Job search, Travel deals).
// Each page replaces the chat view while it is open; New chat or a Recents item goes back to chat.
(() => {
  const chatView = [document.getElementById('chat-container'), document.getElementById('chat-form')];
  const panels = document.querySelectorAll('.tool-panel');
  const toolButtons = document.querySelectorAll('.nav-item[data-tool]');

  function showTool(name) {
    if (name !== 'library') window.openAdvancedSection?.();
    chatView.forEach((el) => { if (el) el.hidden = true; });
    panels.forEach((panel) => { panel.hidden = panel.dataset.panel !== name; });
    toolButtons.forEach((button) => button.classList.toggle('active', button.dataset.tool === name));
    document.dispatchEvent(new CustomEvent('sk:tool-open', { detail: name }));
    document.querySelector(`.tool-panel[data-panel="${name}"] input, .tool-panel[data-panel="${name}"] textarea`)?.focus();
  }

  function showChat() {
    panels.forEach((panel) => { panel.hidden = true; });
    chatView.forEach((el) => { if (el) el.hidden = false; });
    toolButtons.forEach((button) => button.classList.remove('active'));
  }

  window.SKTools = { showTool, showChat };

  toolButtons.forEach((button) => button.addEventListener('click', () => showTool(button.dataset.tool)));
  document.getElementById('new-chat-button')?.addEventListener('click', showChat);
  ['history-list', 'interview-history'].forEach((id) => {
    document.getElementById(id)?.addEventListener('click', (event) => {
      if (event.target.closest('.history-item') && !event.target.closest('.history-pin')) showChat();
    });
  });

  function requireLogin(message) {
    document.getElementById('open-login-modal')?.click();
    return message || 'Please log in to continue.';
  }

  // ---------- Link cards (job search + travel) ----------
  function renderLinks(container, heading, links) {
    container.innerHTML = '';
    const title = document.createElement('h3');
    title.className = 'link-results-title';
    title.textContent = heading;

    const grid = document.createElement('div');
    grid.className = 'link-grid';
    links.forEach(({ name, hint, url }) => {
      const card = document.createElement('a');
      card.className = 'link-card';
      card.href = url;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';

      const label = document.createElement('strong');
      label.textContent = name;
      const sub = document.createElement('span');
      sub.textContent = hint;
      const arrow = document.createElement('span');
      arrow.className = 'link-card-arrow';
      arrow.textContent = '↗';

      card.append(label, sub, arrow);
      grid.appendChild(card);
    });

    container.append(title, grid);
  }

  const enc = encodeURIComponent;
  const slug = (text) => String(text).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // ---------- Job search ----------
  document.getElementById('jobs-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const role = form.role.value.trim();
    const location = form.location.value.trim();
    const experience = form.experience.value;
    if (!role) return;

    const naukriPath = location ? `${slug(role)}-jobs-in-${slug(location)}` : `${slug(role)}-jobs`;
    const naukriExp = experience !== '' ? `?experience=${experience}` : '';
    const where = location ? ` in ${location}` : '';

    renderLinks(document.getElementById('jobs-results'), `${role} jobs${where}`, [
      { name: 'LinkedIn', hint: 'Professional network jobs', url: `https://www.linkedin.com/jobs/search/?keywords=${enc(role)}&location=${enc(location)}` },
      { name: 'Naukri', hint: "India's largest job site", url: `https://www.naukri.com/${naukriPath}${naukriExp}` },
      { name: 'Indeed', hint: 'Jobs from many company sites', url: `https://in.indeed.com/jobs?q=${enc(role)}&l=${enc(location)}` },
      { name: 'Glassdoor', hint: 'Jobs with salary & reviews', url: `https://www.glassdoor.co.in/Job/jobs.htm?sc.keyword=${enc(role)}&locKeyword=${enc(location)}` },
      { name: 'Foundit', hint: 'Formerly Monster India', url: `https://www.foundit.in/srp/results?query=${enc(role)}&locations=${enc(location)}` },
      { name: 'Google Jobs', hint: 'Combines listings from across the web', url: `https://www.google.com/search?q=${enc(`${role} jobs${where}`)}&ibp=htl;jobs` },
    ]);
  });

  // ---------- Travel deals ----------
  const travelForm = document.getElementById('travel-form');
  const travelTabs = document.querySelectorAll('.tool-tab[data-travel]');
  const today = new Date().toISOString().slice(0, 10);
  travelForm?.querySelectorAll('input[type="date"]').forEach((input) => { input.min = today; });

  function setTravelMode(mode) {
    travelForm.dataset.mode = mode;
    travelTabs.forEach((tab) => {
      const active = tab.dataset.travel === mode;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    travelForm.querySelectorAll('[data-show]').forEach((field) => {
      field.hidden = !field.dataset.show.split(' ').includes(mode);
    });
    travelForm.querySelectorAll(`[data-label-${mode}]`).forEach((label) => {
      label.textContent = label.getAttribute(`data-label-${mode}`);
    });
    // Only the visible fields are required
    travelForm.from.required = mode === 'flights';
    travelForm.to.required = mode === 'flights';
    travelForm.city.required = mode !== 'flights';
    travelForm.end.required = mode !== 'flights';
    document.getElementById('travel-results').innerHTML = '';
  }

  travelTabs.forEach((tab) => tab.addEventListener('click', () => setTravelMode(tab.dataset.travel)));

  function flightLinks(from, to, date, people) {
    const [y, m, d] = date.split('-');
    const ddmmyyyy = `${d}/${m}/${y}`;
    return [
      { name: 'Google Flights', hint: 'Compares many airlines & agents', url: `https://www.google.com/travel/flights?q=${enc(`Flights from ${from} to ${to} on ${date} for ${people} adults one way`)}` },
      { name: 'Skyscanner', hint: 'Price comparison site', url: `https://www.skyscanner.co.in/transport/flights/${from.toLowerCase()}/${to.toLowerCase()}/${y.slice(2)}${m}${d}/?adultsv2=${people}` },
      { name: 'Kayak', hint: 'Price comparison site', url: `https://www.kayak.co.in/flights/${from}-${to}/${date}/${people}adults` },
      { name: 'MakeMyTrip', hint: 'Indian booking site', url: `https://www.makemytrip.com/flight/search?itinerary=${from}-${to}-${ddmmyyyy}&tripType=O&paxType=A-${people}_C-0_I-0&cabinClass=E` },
      { name: 'Cleartrip', hint: 'Indian booking site', url: `https://www.cleartrip.com/flights/results?adults=${people}&childs=0&infants=0&class=Economy&depart_date=${ddmmyyyy}&from=${from}&to=${to}` },
      { name: 'ixigo', hint: 'Indian comparison site', url: `https://www.ixigo.com/search/result/flight?from=${from}&to=${to}&date=${d}${m}${y}&adults=${people}&children=0&infants=0&class=e` },
    ];
  }

  function hotelLinks(city, start, end, people) {
    return [
      { name: 'Google Hotels', hint: 'Compares prices across sites', url: `https://www.google.com/travel/search?q=${enc(`hotels in ${city} from ${start} to ${end} for ${people} adults`)}` },
      { name: 'Booking.com', hint: 'Hotels & homes', url: `https://www.booking.com/searchresults.html?ss=${enc(city)}&checkin=${start}&checkout=${end}&group_adults=${people}&no_rooms=1` },
      { name: 'Kayak', hint: 'Price comparison site', url: `https://www.kayak.co.in/hotels/${enc(city)}/${start}/${end}/${people}adults` },
      { name: 'Expedia', hint: 'Hotels & packages', url: `https://www.expedia.co.in/Hotel-Search?destination=${enc(city)}&startDate=${start}&endDate=${end}&adults=${people}` },
      { name: 'Airbnb', hint: 'Homes & apartments', url: `https://www.airbnb.co.in/s/${enc(city)}/homes?checkin=${start}&checkout=${end}&adults=${people}` },
      { name: 'MakeMyTrip', hint: 'Indian booking site', url: `https://www.google.com/search?q=${enc(`makemytrip hotels in ${city}`)}` },
    ];
  }

  function carLinks(city, start, end) {
    return [
      { name: 'Kayak Cars', hint: 'Compares rental companies', url: `https://www.kayak.co.in/cars/${enc(city)}/${start}/${end}` },
      { name: 'Expedia Cars', hint: 'Rental car deals', url: `https://www.expedia.co.in/carsearch?locn=${enc(city)}&date1=${start}&date2=${end}` },
      { name: 'Google', hint: 'Local rental companies & reviews', url: `https://www.google.com/search?q=${enc(`car rental in ${city} ${start} to ${end}`)}` },
      { name: 'Zoomcar', hint: 'Self-drive cars (India)', url: `https://www.google.com/search?q=${enc(`zoomcar self drive ${city}`)}` },
      { name: 'Savaari', hint: 'Cabs with driver (India)', url: `https://www.google.com/search?q=${enc(`savaari car rental ${city}`)}` },
    ];
  }

  travelForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const mode = travelForm.dataset.mode;
    const start = travelForm.start.value;
    const end = travelForm.end.value;
    const people = travelForm.people.value;
    const results = document.getElementById('travel-results');

    if (mode !== 'flights' && end && end <= start) {
      results.innerHTML = '<p class="tool-error">The end date must be after the start date.</p>';
      return;
    }

    if (mode === 'flights') {
      const from = travelForm.from.value.trim().toUpperCase();
      const to = travelForm.to.value.trim().toUpperCase();
      renderLinks(results, `Flights ${from} → ${to} on ${start}`, flightLinks(from, to, start, people));
    } else if (mode === 'hotels') {
      const city = travelForm.city.value.trim();
      renderLinks(results, `Hotels in ${city}, ${start} to ${end}`, hotelLinks(city, start, end, people));
    } else {
      const city = travelForm.city.value.trim();
      renderLinks(results, `Car rental in ${city}, ${start} to ${end}`, carLinks(city, start, end));
    }
  });

  // ---------- Image creator ----------
  document.getElementById('image-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = document.getElementById('image-status');
    const results = document.getElementById('image-results');
    const button = form.querySelector('button[type="submit"]');
    const count = Number(form.count.value);

    status.hidden = false;
    status.className = 'tool-status';
    status.textContent = `Creating ${count} image${count > 1 ? 's' : ''}... this can take up to a minute.`;
    button.disabled = true;

    try {
      const response = await fetch('/api/image', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: form.prompt.value.trim(), style: form.style.value, count }),
      });
      const data = await response.json();
      if (data.code === 'LOGIN_REQUIRED') throw new Error(requireLogin('Please log in to create more images.'));
      if (!response.ok) throw new Error(data.error || 'Unable to create images.');

      status.hidden = true;
      data.images.forEach((url) => {
        const card = document.createElement('figure');
        card.className = 'image-card';
        const img = document.createElement('img');
        img.src = url;
        img.alt = form.prompt.value.trim();
        img.loading = 'lazy';
        const download = document.createElement('a');
        download.href = url;
        download.download = '';
        download.textContent = 'Download';
        card.append(img, download);
        results.prepend(card);
      });
    } catch (error) {
      status.className = 'tool-status tool-error';
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  // Click a created image to see it full size (viewer lives in script.js)
  document.getElementById('image-results')?.addEventListener('click', (event) => {
    const img = event.target.closest('.image-card img');
    if (img && typeof window.openImageViewer === 'function') window.openImageViewer(img.src, img.alt);
  });

  // ---------- Interview prep: step-by-step chat (role -> experience -> type -> skills -> output) ----------
  const interviewMessages = document.getElementById('interview-messages');
  const interviewChips = document.getElementById('interview-chips');
  const interviewForm = document.getElementById('interview-input-form');
  const interviewInput = document.getElementById('interview-input');

  const EXPERIENCE_OPTIONS = ['Fresher', '1-3 years', '3-5 years', '5+ years'];
  const TYPE_OPTIONS = ['Technical', 'HR / Behavioural', 'Mixed (technical + HR)'];
  const OUTPUT_OPTIONS = ['Questions & answers', 'Mock interview'];

  const INTERVIEW_STEPS = [
    {
      key: 'role',
      ask: 'What are you preparing for? Type a job role or technology, e.g. "PHP", "Python Developer" or "HR Executive".',
      placeholder: 'e.g. PHP interview prep',
    },
    {
      key: 'experience',
      ask: (a) => `Great, ${a.role} it is. How much experience do you have?`,
      options: EXPERIENCE_OPTIONS,
      placeholder: 'Choose above or type, e.g. 2 years',
    },
    {
      key: 'type',
      ask: 'Which type of interview should I prepare you for?',
      options: TYPE_OPTIONS,
      placeholder: 'Choose above or type your own',
    },
    {
      key: 'skills',
      ask: (a) => `Any specific skills or topics to focus on? For ${a.role}, e.g. frameworks, databases or concepts. Or skip.`,
      options: ['Skip'],
      placeholder: 'e.g. Laravel, MySQL, OOP',
    },
    {
      key: 'output',
      ask: 'All set! What would you like?',
      options: OUTPUT_OPTIONS,
      placeholder: 'Choose an option above',
    },
  ];

  let interviewStep = 0;
  let interviewAnswers = {};

  // "php interview prep" -> "PHP"; "interview questions for python developer" -> "Python Developer"
  function cleanRole(text) {
    const cleaned = text
      .replace(/\b(interview|interviews|prep|preparation|prepare|questions?|and|answers?|for|practice|mock|help|me|my|a|an|the|i|want|to)\b/gi, ' ')
      .replace(/[^\w+#.\s/-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned
      .split(' ')
      .map((word) => (word.length <= 3 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
      .join(' ');
  }

  function addWizardMessage(sender, text) {
    const message = document.createElement('div');
    message.className = `message ${sender}-message`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    message.appendChild(bubble);
    interviewMessages.appendChild(message);
    interviewMessages.scrollTop = interviewMessages.scrollHeight;
  }

  function askCurrentStep() {
    const step = INTERVIEW_STEPS[interviewStep];
    addWizardMessage('ai', typeof step.ask === 'function' ? step.ask(interviewAnswers) : step.ask);
    interviewInput.placeholder = step.placeholder;

    interviewChips.innerHTML = '';
    (step.options || []).forEach((option) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'wizard-chip';
      chip.textContent = option;
      chip.addEventListener('click', () => handleInterviewAnswer(option));
      interviewChips.appendChild(chip);
    });
    interviewInput.focus();
  }

  function resetInterviewWizard() {
    interviewStep = 0;
    interviewAnswers = {};
    interviewMessages.innerHTML = '';
    interviewInput.value = '';
    askCurrentStep();
  }

  function finishInterviewWizard() {
    const { role, experience, type, skills, output } = interviewAnswers;
    const profile = `Role: ${role}. Experience: ${experience}. Interview type: ${type}.` +
      (skills ? ` Focus skills: ${skills}.` : '');

    const message = output === 'Mock interview'
      ? `Start a mock interview for me. ${profile} Ask me one question at a time and wait for my answer.`
      : `Give me the 10 most likely ${type} interview questions for a ${experience} ${role} candidate, ` +
        `with strong sample answers written at the level expected for ${experience} experience. ${profile}`;

    showChat();
    window.SKChat?.startModeChat('interview', message);
    resetInterviewWizard();
  }

  function handleInterviewAnswer(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return;
    const step = INTERVIEW_STEPS[interviewStep];

    if (step.key === 'role') {
      const role = cleanRole(text);
      addWizardMessage('user', text);
      if (!role) {
        addWizardMessage('ai', 'Please tell me the job role or technology, e.g. "PHP Developer".');
        return;
      }
      interviewAnswers.role = role;
    } else if (step.key === 'output') {
      // Only the two choices make sense here; match typed text loosely
      const choice = /mock/i.test(text) ? 'Mock interview' : /q|answer/i.test(text) ? 'Questions & answers' : null;
      addWizardMessage('user', text);
      if (!choice) {
        addWizardMessage('ai', 'Please choose "Questions & answers" or "Mock interview".');
        return;
      }
      interviewAnswers.output = choice;
    } else {
      addWizardMessage('user', text);
      interviewAnswers[step.key] = step.key === 'skills' && /^skip$/i.test(text) ? '' : text;
    }

    interviewInput.value = '';
    interviewStep += 1;
    if (interviewStep >= INTERVIEW_STEPS.length) {
      finishInterviewWizard();
    } else {
      askCurrentStep();
    }
  }

  interviewForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    handleInterviewAnswer(interviewInput.value);
  });
  document.getElementById('interview-restart')?.addEventListener('click', resetInterviewWizard);

  if (interviewMessages) resetInterviewWizard();
})();
