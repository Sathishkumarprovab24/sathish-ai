const chatForm = document.getElementById('chat-form');
const questionInput = document.getElementById('question');
const imageInput = document.getElementById('imageInput');
const filePreview = document.getElementById('file-preview');
const chatContainer = document.getElementById('chat-container');
const removeWelcomeMessage = document.getElementById('sathishai');
const loginModal = document.getElementById('login-modal');
const registerModal = document.getElementById('register-modal');
const openLoginModalButton = document.getElementById('open-login-modal');
const closeLoginModalButton = document.getElementById('close-login-modal');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const openRegisterModalButton = document.getElementById('open-register-modal');
const closeRegisterModalButton = document.getElementById('close-register-modal');
const backToLoginModalButton = document.getElementById('back-to-login-modal');
const profileModal = document.getElementById('profile-modal');
const closeProfileModalButton = document.getElementById('close-profile-modal');
const profileUsername = document.getElementById('profile-username');
const profileEmail = document.getElementById('profile-email');
const profileAvatar = document.getElementById('profile-avatar');
const logoutButton = document.getElementById('logout-button');
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const interviewHistoryList = document.getElementById('interview-history');
const newChatButton = document.getElementById('new-chat-button');
const sidebarProfileButton = document.getElementById('sidebar-profile');
const sidebarAvatar = document.getElementById('sidebar-avatar');
const sidebarUsername = document.getElementById('sidebar-username');
const sidebarPlan = document.getElementById('sidebar-plan');

let combinedLog = [];
let localPlaceholders = [];
let selectedConversationId = null;
let currentConversationId = null;
let hasUserMessagesInCurrentChat = false;
// 'chat' or 'interview'; sent with each message so the server picks the right instructions
let currentMode = 'chat';
// Recent turns of the open conversation, sent so the AI remembers context
let conversationHistory = [];
const MAX_HISTORY_MESSAGES = 12;
const MAX_ATTACHMENT_MB = 10;
let isWaitingForAnswer = false;

// Animated "SK AI is thinking…" bubble shown while waiting for an answer.
// The status text changes on long waits; call .remove() when the answer arrives.
function showTypingIndicator(firstLabel) {
  const message = document.createElement('div');
  message.className = 'message ai-message typing-message';
  message.setAttribute('role', 'status');
  message.innerHTML = `
    <div class="bubble typing-bubble">
      <span class="typing-avatar" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9z"/></svg>
      </span>
      <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="typing-label"></span>
    </div>`;
  const label = message.querySelector('.typing-label');
  label.textContent = firstLabel;
  chatContainer.appendChild(message);
  removeWelcomeMessage?.remove();

  const timers = [
    setTimeout(() => { label.textContent = 'Still working on it…'; }, 4000),
    setTimeout(() => { label.textContent = 'Almost there…'; }, 10000),
  ];

  return {
    remove() {
      timers.forEach(clearTimeout);
      message.remove();
    },
  };
}

// What to ask when the user sends files without typing anything
function defaultQuestionFor(imageFiles, documentFiles) {
  if (documentFiles.length > 0) return 'Please read the attached document and summarise the key points.';
  if (imageFiles.length > 0) return 'Please describe and analyse the attached image.';
  return '';
}
const chatSubmitButton = document.querySelector('.chat-submit');

function createConversationId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `c_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
}

const authState = {
  authenticated: false,
  username: '',
  email: '',
  guestMessageCount: 0,
  guestMessageLimit: 3,
  history: [],
};

function addPlaceholderConversation(conversationId) {
  if (!conversationId) return;
  if (localPlaceholders.some((entry) => entry.conversationId === conversationId)) return;

  localPlaceholders.push({
    username: authState.username || 'guest',
    conversationId,
    question: '',
    answer: 'Hello! I am ready to help. Ask me anything to start a new conversation.',
    createdAt: new Date().toISOString(),
  });
}

function getGuestHistory() {
  try {
    const stored = localStorage.getItem('guestHistory');
    if (!stored) return [];
    return JSON.parse(stored);
  } catch (error) {
    console.error('Failed to load guest history:', error);
    return [];
  }
}

function saveGuestHistory() {
  if (authState.authenticated) {
    localStorage.removeItem('guestHistory');
    return;
  }

  try {
    localStorage.setItem('guestHistory', JSON.stringify(authState.history));
  } catch (error) {
    console.error('Failed to save guest history:', error);
  }
}

function loadGuestHistory() {
  if (authState.authenticated) {
    authState.history = [];
    localStorage.removeItem('guestHistory');
    return;
  }

  authState.history = getGuestHistory();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

questionInput.focus();
loadSession();

const selectedFiles = [];
const previewUrls = [];

function updateFileInput() {
  if (!imageInput) return;

  const dataTransfer = new DataTransfer();
  selectedFiles.forEach((file) => dataTransfer.items.add(file));
  imageInput.files = dataTransfer.files;
}

function clearFilePreview() {
  if (!imageInput || !filePreview) return;
  imageInput.value = '';
  selectedFiles.length = 0;
  filePreview.innerHTML = '';
  filePreview.hidden = true;
  chatForm?.classList.remove('has-files');

  previewUrls.forEach((url) => URL.revokeObjectURL(url));
  previewUrls.length = 0;
}

function renderFilePreview() {
  if (!filePreview) return;

  if (selectedFiles.length === 0) {
    clearFilePreview();
    return;
  }

  filePreview.innerHTML = '';
  previewUrls.forEach((url) => URL.revokeObjectURL(url));
  previewUrls.length = 0;

  selectedFiles.forEach((file, index) => {
    const previewItem = document.createElement('div');
    previewItem.className = 'preview-item';

    if (file.type.startsWith('image/')) {
      const img = document.createElement('img');
      const url = URL.createObjectURL(file);
      previewUrls.push(url);
      img.src = url;
      img.alt = file.name || 'Selected attachment preview';
      img.addEventListener('click', () => openImageViewer(url, img.alt));
      previewItem.appendChild(img);
    } else {
      previewItem.classList.add('preview-file');

      const icon = document.createElement('span');
      icon.className = 'preview-file-icon';
      icon.textContent = (file.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();

      const info = document.createElement('span');
      info.className = 'preview-file-info';

      const name = document.createElement('span');
      name.className = 'preview-file-name';
      name.textContent = file.name;

      const type = document.createElement('span');
      type.className = 'preview-file-type';
      type.textContent = file.type === 'application/pdf' ? 'PDF' : 'File';

      info.append(name, type);
      previewItem.append(icon, info);
    }

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'preview-remove';
    removeButton.title = 'Remove attachment';
    removeButton.setAttribute('aria-label', 'Remove attachment');
    removeButton.textContent = '×';
    removeButton.addEventListener('click', () => {
      selectedFiles.splice(index, 1);
      updateFileInput();
      renderFilePreview();
    });

    previewItem.appendChild(removeButton);
    filePreview.appendChild(previewItem);
  });

  filePreview.hidden = false;
  chatForm?.classList.add('has-files');
}

// Full-size image viewer for attachment previews and images in chat messages
const imageViewer = document.createElement('div');
imageViewer.className = 'image-viewer';
imageViewer.hidden = true;
imageViewer.innerHTML = '<button type="button" class="image-viewer-close" aria-label="Close image">×</button><img alt="">';
document.body.appendChild(imageViewer);

function openImageViewer(src, alt) {
  const img = imageViewer.querySelector('img');
  img.src = src;
  img.alt = alt || 'Image preview';
  imageViewer.hidden = false;
}

function closeImageViewer() {
  imageViewer.hidden = true;
  imageViewer.querySelector('img').removeAttribute('src');
}

imageViewer.addEventListener('click', (event) => {
  if (event.target.tagName !== 'IMG') closeImageViewer();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !imageViewer.hidden) closeImageViewer();
});

chatContainer?.addEventListener('click', (event) => {
  const img = event.target.closest('.message-attachment img');
  if (img) openImageViewer(img.src, img.alt);
});

imageInput?.addEventListener('change', () => {
  if (!imageInput) return;

  const incomingFiles = Array.from(imageInput.files || []);
  incomingFiles.forEach((file) => {
    const exists = selectedFiles.some((existing) =>
      existing.name === file.name &&
      existing.size === file.size &&
      existing.lastModified === file.lastModified
    );
    if (!exists) {
      selectedFiles.push(file);
    }
  });

  updateFileInput();
  renderFilePreview();
});

questionInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (typeof chatForm.requestSubmit === 'function') {
      chatForm.requestSubmit();
    } else {
      chatForm.submit();
    }
  }
});

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isWaitingForAnswer) return;

  const question = questionInput.value.trim();
  const filesToSend = Array.from(selectedFiles);
  const imageFiles = filesToSend.filter((file) => file.type.startsWith('image/'));
  const documentFiles = filesToSend.filter((file) => !file.type.startsWith('image/'));

  if (!question && filesToSend.length === 0) return;

  // Same limit as the server, checked here so the user gets a clear message straight away
  const tooBig = filesToSend.find((file) => file.size > MAX_ATTACHMENT_MB * 1024 * 1024);
  if (tooBig) {
    addSystemMessage(`"${tooBig.name}" is larger than ${MAX_ATTACHMENT_MB} MB. Please choose a smaller file.`);
    return;
  }

  if (!currentConversationId) {
    currentConversationId = createConversationId();
  }

  hasUserMessagesInCurrentChat = true;
  const imageAttachments = await Promise.all(
    imageFiles.map(async (file) => ({
      name: file.name,
      type: file.type,
      dataUrl: await fileToDataUrl(file),
    }))
  );

  const documentAttachments = documentFiles.map((file) => ({ name: file.name, type: file.type, size: file.size }));
  addMessage('user', question || ' ', [...imageAttachments, ...documentAttachments]);
  questionInput.value = '';
  clearFilePreview();

  // Typing indicator until the answer arrives; also blocks a second send meanwhile
  const typing = showTypingIndicator(documentFiles.length > 0 ? 'Reading your document…' : 'SK AI is thinking…');
  isWaitingForAnswer = true;
  chatSubmitButton?.classList.add('is-waiting');
  scrollToBottom();

  try {
    const requestBody = new FormData();
    requestBody.append('question', question || defaultQuestionFor(imageFiles, documentFiles));
    requestBody.append('conversationId', currentConversationId);
    requestBody.append('mode', currentMode);
    requestBody.append('history', JSON.stringify(conversationHistory.slice(-MAX_HISTORY_MESSAGES)));
    filesToSend.forEach((file) => requestBody.append('attachments', file));

    const response = await fetch('/api/chat', {
      method: 'POST',
      credentials: 'same-origin',
      body: requestBody,
    });

    const data = await response.json();
    typing.remove();

    if (!response.ok) {
      if (data.code === 'LOGIN_REQUIRED') {
        removeLastUserMessage(question);
        questionInput.value = question;
        addSystemMessage(`You have reached the ${authState.guestMessageLimit} message limit. Please log in to continue chatting.`);
        await loadSession();
        openModal(loginModal);
        loginForm?.elements.username?.focus();
        return;
      }

      const requestError = new Error(data.error || 'Network response was not ok');
      requestError.serverMessage = data.error;
      throw requestError;
    }

    addMessage('ai', data.answer);
    appendSources(data.sources);
    // The server may switch a chat into interview mode; keep it there for follow-up messages
    if (data.mode) currentMode = data.mode;
    conversationHistory.push(
      // Keep any document text in memory so follow-up questions about the PDF still work
      { role: 'user', content: [question || defaultQuestionFor(imageFiles, documentFiles), data.documentContext].filter(Boolean).join('\n\n') },
      { role: 'assistant', content: data.answer }
    );
    selectedConversationId = currentConversationId;

    await loadSession();
    scrollToBottom();
  } catch (error) {
    typing.remove();
    // Show the server's message when it has one (e.g. file too big), otherwise a generic one
    addMessage('ai', error.serverMessage || 'Sorry, something went wrong. Please try again.');
    scrollToBottom();
    console.error(error);
  } finally {
    isWaitingForAnswer = false;
    chatSubmitButton?.classList.remove('is-waiting');
  }
});

openLoginModalButton?.addEventListener('click', () => {
  if (authState.authenticated) {
    loadProfile();
    openModal(profileModal);
    return;
  }

  openModal(loginModal);
  loginForm?.elements.username?.focus();
});

closeLoginModalButton?.addEventListener('click', closeLoginModal);
closeRegisterModalButton?.addEventListener('click', closeRegisterModal);
closeProfileModalButton?.addEventListener('click', closeProfileModal);

loginModal?.addEventListener('click', (event) => {
  if (event.target === loginModal) {
    closeLoginModal();
  }
});

registerModal?.addEventListener('click', (event) => {
  if (event.target === registerModal) {
    closeRegisterModal();
  }
});

profileModal?.addEventListener('click', (event) => {
  if (event.target === profileModal) {
    closeProfileModal();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && loginModal && !loginModal.hidden) {
    closeLoginModal();
  }

  if (event.key === 'Escape' && registerModal && !registerModal.hidden) {
    closeRegisterModal();
  }

  if (event.key === 'Escape' && profileModal && !profileModal.hidden) {
    closeProfileModal();
  }
});

loginForm?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(loginForm);
  const payload = Object.fromEntries(formData.entries());

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      addSystemMessage(data.error || 'Unable to login.');
      return;
    }

    closeLoginModal();
    loginForm.reset();
    startFreshChat();
    await loadSession();
    await loadProfile();
    // openModal(profileModal);
  } catch (error) {
    addSystemMessage('Unable to login right now. Please try again.');
    console.error(error);
  }
});

registerForm?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(registerForm);
  const payload = Object.fromEntries(formData.entries());

  try {
    const response = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      addSystemMessage(data.error || 'Unable to register.');
      return;
    }

    closeRegisterModal();
    registerForm.reset();
    startFreshChat();
    await loadSession();
    await loadProfile();
    openModal(profileModal);
  } catch (error) {
    addSystemMessage('Unable to register right now. Please try again.');
    console.error(error);
  }
});

openRegisterModalButton?.addEventListener('click', () => {
  closeLoginModal();
  openModal(registerModal);
  registerForm?.elements.username?.focus();
});

backToLoginModalButton?.addEventListener('click', () => {
  closeRegisterModal();
  openModal(loginModal);
  loginForm?.elements.username?.focus();
});

logoutButton?.addEventListener('click', async () => {
  try {
    const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) {
      throw new Error('Logout failed');
    }

    authState.authenticated = false;
    authState.username = '';
    authState.email = '';
    authState.history = [];
    updateProfileView();
    updateLoginButtonState();
    startFreshChat();
    await loadSession();
    closeProfileModal();
    addSystemMessage('You have been logged out successfully.');
  } catch (error) {
    addSystemMessage('Unable to logout right now. Please try again.');
    console.error(error);
  }
});

function addMessage(sender, text) {
  const message = document.createElement('div');
  message.className = `message ${sender}-message`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (sender === 'ai') {
    renderAiAnswer(bubble, text);
  } else {
    bubble.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
  }

  if (arguments.length > 2 && Array.isArray(arguments[2]) && arguments[2].length > 0) {
    const attachments = document.createElement('div');
    attachments.className = 'message-attachments';

    arguments[2].forEach((attachment) => {
      if (!attachment) return;
      const isImage = (attachment.type || '').startsWith('image/');

      if (isImage && attachment.dataUrl) {
        const attachmentItem = document.createElement('div');
        attachmentItem.className = 'message-attachment';
        const image = document.createElement('img');
        image.src = attachment.dataUrl;
        image.alt = attachment.name || 'Uploaded image';
        attachmentItem.appendChild(image);
        attachments.appendChild(attachmentItem);
        return;
      }

      // PDFs and other documents show as a file card
      if (!isImage && attachment.name) {
        const card = document.createElement('div');
        card.className = 'message-file';
        const icon = document.createElement('span');
        icon.className = 'message-file-icon';
        icon.textContent = (attachment.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
        const info = document.createElement('span');
        info.className = 'message-file-info';
        const name = document.createElement('strong');
        name.textContent = attachment.name;
        const meta = document.createElement('small');
        const sizeKb = Math.max(1, Math.round((attachment.size || 0) / 1024));
        meta.textContent = `${attachment.type === 'application/pdf' ? 'PDF' : 'File'} · ${sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb} KB`}`;
        info.append(name, meta);
        card.append(icon, info);
        attachments.appendChild(card);
      }
    });

    if (attachments.childElementCount > 0) {
      // Images sit above the message text, like ChatGPT
      bubble.prepend(attachments);
    }
  }

  message.appendChild(bubble);
  chatContainer.appendChild(message);
  removeWelcomeMessage?.remove();
}

// AI answers arrive as Markdown: render it (headings, lists, tables, code) and sanitize the HTML.
// Falls back to plain text if the libraries failed to load.
function renderAiAnswer(bubble, text) {
  const markdown = String(text || '');
  if (!window.marked || !window.DOMPurify) {
    bubble.innerHTML = escapeHtml(markdown).replace(/\n/g, '<br>');
    return;
  }

  const content = document.createElement('div');
  content.className = 'markdown';
  content.innerHTML = DOMPurify.sanitize(marked.parse(markdown, { gfm: true, breaks: true }));

  // Wide tables scroll sideways instead of squashing the text
  content.querySelectorAll('table').forEach((table) => {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.appendChild(table);
  });

  content.querySelectorAll('a').forEach((link) => {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });

  content.querySelectorAll('pre').forEach((pre) => {
    pre.appendChild(createCopyButton(() => pre.querySelector('code')?.textContent || pre.textContent, 'code-copy'));
  });

  groupQuestionCards(content);

  bubble.classList.add('ai-rich');
  bubble.appendChild(content);

  const actions = document.createElement('div');
  actions.className = 'answer-actions';
  actions.appendChild(createCopyButton(() => markdown, 'answer-copy', 'Copy'));
  bubble.appendChild(actions);
}

// Long Q&A answers (3+ "### " headings) become collapsible cards so the page stays easy to scan
function groupQuestionCards(content) {
  const headings = Array.from(content.querySelectorAll(':scope > h3'));
  if (headings.length < 3) return;

  headings.forEach((heading, index) => {
    const card = document.createElement('details');
    card.className = 'qa-card';
    if (index === 0) card.open = true;

    const summary = document.createElement('summary');
    summary.innerHTML = heading.innerHTML;
    card.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'qa-body';
    let next = heading.nextElementSibling;
    while (next && !(next.tagName === 'H3' || next.tagName === 'H2' || next.tagName === 'HR')) {
      const following = next.nextElementSibling;
      body.appendChild(next);
      next = following;
    }
    if (next?.tagName === 'HR') next.remove();

    card.appendChild(body);
    heading.replaceWith(card);
  });
}

// Live search sources shown as small links under the latest AI answer
function appendSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return;
  const bubbles = chatContainer.querySelectorAll('.ai-message .bubble.ai-rich');
  const bubble = bubbles[bubbles.length - 1];
  if (!bubble) return;

  const wrap = document.createElement('div');
  wrap.className = 'answer-sources';
  const label = document.createElement('span');
  label.className = 'answer-sources-label';
  label.textContent = 'Live sources';
  wrap.appendChild(label);

  sources.forEach((source) => {
    let host = '';
    try { host = new URL(source.url).hostname.replace(/^www\./, ''); } catch (error) { return; }
    const link = document.createElement('a');
    link.className = 'source-chip';
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = source.title || host;
    link.title = host;
    wrap.appendChild(link);
  });

  bubble.insertBefore(wrap, bubble.querySelector('.answer-actions'));
}

function createCopyButton(getText, className, label = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.setAttribute('aria-label', 'Copy');
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>${label ? `<span>${label}</span>` : ''}`;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getText());
      button.classList.add('copied');
      const span = button.querySelector('span');
      if (span) span.textContent = 'Copied';
      setTimeout(() => {
        button.classList.remove('copied');
        if (span) span.textContent = label;
      }, 1500);
    } catch (error) {
      console.error('Copy failed:', error);
    }
  });
  return button;
}

function addSystemMessage(text) {
  const alreadyShown = Array.from(chatContainer.querySelectorAll('.system-message .bubble'))
    .some((bubble) => bubble.textContent === text);

  if (alreadyShown) return;

  addMessage('system', text);
}

function removeLastUserMessage(text) {
  const userMessages = Array.from(chatContainer.querySelectorAll('.user-message'));
  const lastUserMessage = userMessages[userMessages.length - 1];

  if (!lastUserMessage) return;

  if (lastUserMessage.textContent?.trim() === text) {
    lastUserMessage.remove();
  }
}

function scrollToBottom() {
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function closeLoginModal() {
  if (!loginModal) return;

  loginModal.hidden = true;
  restoreBodyScroll();
}

function closeRegisterModal() {
  if (!registerModal) return;

  registerModal.hidden = true;
  restoreBodyScroll();
}

function closeProfileModal() {
  if (!profileModal) return;

  profileModal.hidden = true;
  restoreBodyScroll();
}

function openModal(modal) {
  if (!modal) return;

  modal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function restoreBodyScroll() {
  const isAnyModalOpen =
    (loginModal && !loginModal.hidden) ||
    (registerModal && !registerModal.hidden) ||
    (profileModal && !profileModal.hidden);

  document.body.style.overflow = isAnyModalOpen ? 'hidden' : '';
}

function updateInputAvailability() {
  if (!questionInput || !chatSubmitButton) return;

  const limitReached = !authState.authenticated && authState.guestMessageCount >= authState.guestMessageLimit;
  questionInput.disabled = limitReached;
  chatSubmitButton.disabled = limitReached;
  questionInput.placeholder = limitReached ? 'Login to continue chatting' : 'Ask SK AI Assistant';

  if (limitReached) {
    addSystemMessage(`You have reached the ${authState.guestMessageLimit} message limit. Please log in to continue chatting.`);
    openModal(loginModal);
  }
}

async function loadSession() {
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    if (!response.ok) return;

    const data = await response.json();
    authState.authenticated = data.authenticated;
    authState.username = data.username;
    authState.email = data.email;
    authState.guestMessageCount = data.guestMessageCount;
    authState.guestMessageLimit = data.guestMessageLimit;
    updateLoginButtonState();
    updateProfileView();
    authState.history = [];
    updateInputAvailability();
    await loadCombinedLog();
  } catch (error) {
    console.error('Session error:', error);
  }
}

async function loadProfile() {
  try {
    const response = await fetch('/api/profile', { credentials: 'same-origin' });
    if (!response.ok) return;

    const data = await response.json();
    authState.username = data.username;
    authState.email = data.email;
    updateProfileView();
  } catch (error) {
    console.error('Profile error:', error);
  }
}


// Tool menus are only for logged-in users; guests get general chat only
function updateToolAccess() {
  const loggedIn = authState.authenticated;
  document.querySelectorAll('.nav-item[data-tool], [data-requires-login]').forEach((el) => {
    el.hidden = !loggedIn;
  });
  if (!loggedIn) window.SKTools?.showChat();
}

function updateLoginButtonState() {
  updateToolAccess();
  if (!openLoginModalButton) return;

  openLoginModalButton.textContent = authState.authenticated
    ? authState.username || 'Logged In'
    : 'Login';
}


newChatButton?.addEventListener('click', async () => {
  try {
    // Only create a new chat if current one has messages
    if (currentConversationId && !hasUserMessagesInCurrentChat) {
      return;
    }

    startFreshChat();
    questionInput.focus();
  } catch (err) {
    console.error('New chat create error:', err);
  }
});

// Clears the screen and starts a new conversation (New chat, login, register, logout)
function startFreshChat() {
  currentConversationId = null;
  selectedConversationId = null;
  hasUserMessagesInCurrentChat = false;
  currentMode = 'chat';
  conversationHistory = [];
  localPlaceholders = [];
  chatContainer.innerHTML = '';
  questionInput.value = '';
  clearFilePreview();
  document.querySelectorAll('.history-item.selected').forEach((el) => el.classList.remove('selected'));
  addMessage('ai', 'Hello! I am ready to help. Ask me anything to start a new conversation.');
  scrollToBottom();
}

async function loadCombinedLog() {
  try {
    const resp = await fetch('/chat-log');
    if (!resp.ok) return;
    const text = await resp.text();
    // server may return JSON array or empty
    let data = [];
    try { data = JSON.parse(text || '[]'); } catch (e) { data = []; }
    combinedLog = Array.isArray(data) ? data : [];
    // Ignore any metadata-only conversation records and entries without a valid conversation id
    combinedLog = combinedLog.filter((entry) => {
      return entry.conversationId && entry.conversationId !== 'default' && entry.type !== 'conversation';
    });
    combinedLog = combinedLog.concat(localPlaceholders);
    renderCombinedLog();
  } catch (err) {
    console.error('Failed to load combined log:', err);
  }
}

// Interview chats are listed under the Interview prep menu; everything else goes in Recents
function renderCombinedLog() {
  if (!historyList) return;
  historyList.innerHTML = '';
  if (interviewHistoryList) {
    interviewHistoryList.innerHTML = '';
    interviewHistoryList.hidden = true;
  }

  if (!authState.authenticated) {
    historyEmpty.textContent = 'Log in to see your chat history.';
    historyEmpty.hidden = false;
    return;
  }

  // Group entries by valid conversationId only
  const convMap = new Map();
  combinedLog.forEach((entry) => {
    if (!entry.conversationId || entry.conversationId === 'default') {
      return;
    }
    const cid = entry.conversationId;
    if (!convMap.has(cid)) convMap.set(cid, []);
    convMap.get(cid).push(entry);
  });

  // Build list of conversations with metadata (latest timestamp and preview)
  const convs = Array.from(convMap.entries()).map(([cid, entries]) => {
    const sorted = entries.slice().sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
    const hasMessages = sorted.some((entry) => entry.type !== 'conversation');
    if (!hasMessages) return null;
    const latest = sorted[sorted.length - 1];
    const meta = sorted.find(e => e.type === 'conversation') || {};
    const firstMessage = sorted.find((entry) => entry.type !== 'conversation' && (entry.question || entry.answer)) || null;
    const mode = sorted.some((entry) => entry.mode === 'interview') ? 'interview' : 'chat';
    const preview = firstMessage?.question || firstMessage?.answer || latest?.question || latest?.answer || '';
    return {
      conversationId: cid,
      mode,
      title: mode === 'interview' ? interviewTitle(preview) : (meta.title || preview || 'New chat'),
      lastAt: latest?.createdAt || (meta.createdAt) || Date.now(),
      entries: sorted,
    };
  }).filter(Boolean);

  // Pinned chats first, then by lastAt desc
  const pinned = getPinnedChats();
  convs.sort((a,b) => {
    const pinDiff = Number(pinned.includes(b.conversationId)) - Number(pinned.includes(a.conversationId));
    return pinDiff || new Date(b.lastAt) - new Date(a.lastAt);
  });

  const interviewConvs = convs.filter((conv) => conv.mode === 'interview');
  const generalConvs = convs.filter((conv) => conv.mode !== 'interview');

  if (interviewHistoryList) {
    interviewConvs.forEach((conv) => interviewHistoryList.appendChild(createHistoryItem(conv, pinned)));
    interviewHistoryList.hidden = interviewConvs.length === 0 || document.querySelector('.nav-item[data-tool="interview"]')?.hidden;
  }

  generalConvs.forEach((conv) => historyList.appendChild(createHistoryItem(conv, pinned)));
  historyEmpty.textContent = 'No chats yet. Start chatting to see them here.';
  historyEmpty.hidden = generalConvs.length > 0;

}

// "Start a mock interview for me. Role: PHP. Experience: 5+ years. Interview type: Technical." -> "PHP · 5+ years · Technical"
function interviewTitle(text) {
  const role = text.match(/Role:\s*([^.]+)\./i)?.[1];
  if (!role) return text;
  const experience = text.match(/Experience:\s*([^.]+)\./i)?.[1];
  const type = text.match(/Interview type:\s*([^.(]+)/i)?.[1]?.trim();
  const kind = /mock interview/i.test(text) ? 'Mock' : 'Q&A';
  return [role, experience, type, kind].filter(Boolean).join(' · ');
}

function createHistoryItem(conv, pinned) {
  const li = document.createElement('li');
  li.className = 'history-item';
  li.title = new Date(conv.lastAt).toLocaleString();
  if (conv.conversationId === currentConversationId || conv.conversationId === selectedConversationId) {
    li.classList.add('selected');
  }
  if (pinned.includes(conv.conversationId)) {
    li.classList.add('pinned');
  }

  const title = document.createElement('div');
  title.className = 'history-title';
  title.textContent = String(conv.title);

  const pinButton = document.createElement('button');
  pinButton.type = 'button';
  pinButton.className = 'history-pin';
  pinButton.setAttribute('aria-label', li.classList.contains('pinned') ? 'Unpin chat' : 'Pin chat');
  pinButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4Z"/></svg>';
  pinButton.addEventListener('click', (event) => {
    event.stopPropagation();
    togglePinnedChat(conv.conversationId);
    renderCombinedLog();
  });

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'history-pin history-delete';
  deleteButton.setAttribute('aria-label', 'Delete chat');
  deleteButton.title = 'Delete chat';
  deleteButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
  deleteButton.addEventListener('click', (event) => {
    event.stopPropagation();
    deleteConversation(conv.conversationId);
  });

  li.append(title, pinButton, deleteButton);
  li.addEventListener('click', () => {
    selectedConversationId = conv.conversationId;
    currentConversationId = conv.conversationId;
    document.querySelectorAll('.history-item.selected').forEach((el) => el.classList.remove('selected'));
    li.classList.add('selected');
    openConversation(conv.conversationId);
  });

  return li;
}

// Hides the chat right away; the server keeps it for 10 days before removing it for good
async function deleteConversation(conversationId) {
  if (!window.confirm('Delete this chat?')) return;

  const previousLog = combinedLog;
  const previousPlaceholders = localPlaceholders;
  combinedLog = combinedLog.filter((entry) => entry.conversationId !== conversationId);
  localPlaceholders = localPlaceholders.filter((entry) => entry.conversationId !== conversationId);

  if (getPinnedChats().includes(conversationId)) {
    togglePinnedChat(conversationId);
  }

  const wasOpen = conversationId === currentConversationId || conversationId === selectedConversationId;
  if (wasOpen) {
    currentConversationId = null;
    selectedConversationId = null;
    hasUserMessagesInCurrentChat = false;
    chatContainer.innerHTML = '';
    addMessage('ai', 'Hello! I am ready to help. Ask me anything to start a new conversation.');
  }
  renderCombinedLog();

  // Placeholder chats were never saved on the server, so there is nothing to delete there
  const savedOnServer = previousLog.some((entry) => entry.conversationId === conversationId && entry.question);
  if (!savedOnServer) return;

  try {
    const response = await fetch(`/api/conversation/${encodeURIComponent(conversationId)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Delete failed with status ${response.status}`);
    }
  } catch (error) {
    console.error('Delete conversation error:', error);
    combinedLog = previousLog;
    localPlaceholders = previousPlaceholders;
    renderCombinedLog();
    window.alert('Unable to delete this chat right now. Please try again.');
  }
}

function getPinnedChats() {
  try {
    const stored = JSON.parse(localStorage.getItem('pinnedChats') || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch (error) {
    return [];
  }
}

function togglePinnedChat(conversationId) {
  const pinned = getPinnedChats();
  const next = pinned.includes(conversationId)
    ? pinned.filter((id) => id !== conversationId)
    : [conversationId, ...pinned];
  try {
    localStorage.setItem('pinnedChats', JSON.stringify(next));
  } catch (error) {
    console.error('Failed to save pinned chats:', error);
  }
}

function openConversation(conversationId) {
  const entries = combinedLog.filter(e => (e.conversationId || 'default') === conversationId).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (!entries || entries.length === 0) return;
  chatContainer.innerHTML = '';
  conversationHistory = [];
  currentMode = entries.find((entry) => entry.mode)?.mode || 'chat';
  entries.forEach((entry) => {
    if (entry.type === 'conversation') return; // skip meta
    if (entry.question) addMessage('user', entry.question);
    if (entry.answer) addMessage('ai', entry.answer);
    if (entry.question && entry.answer) {
      conversationHistory.push({ role: 'user', content: entry.question }, { role: 'assistant', content: entry.answer });
    }
  });
  hasUserMessagesInCurrentChat = true;
  scrollToBottom();
}

function updateProfileView() {
  if (profileUsername) {
    profileUsername.textContent = authState.username || '-';
  }

  if (profileEmail) {
    profileEmail.textContent = authState.email || '-';
  }

  if (profileAvatar) {
    profileAvatar.textContent = (authState.username || 'S').charAt(0).toUpperCase();
  }

  if (sidebarUsername) {
    sidebarUsername.textContent = authState.authenticated ? authState.username || 'User' : 'Guest';
  }

  if (sidebarPlan) {
    sidebarPlan.textContent = authState.authenticated ? 'Free' : 'Login to save chats';
  }

  if (sidebarAvatar) {
    const name = authState.authenticated ? authState.username || 'U' : 'G';
    sidebarAvatar.textContent = name.slice(0, 2).toUpperCase();
  }
}



// Collapsible sidebar sections; ones with data-remember keep their open/closed state per browser
function setSectionOpen(toggle, open) {
  const body = document.getElementById(toggle.dataset.target);
  toggle.setAttribute('aria-expanded', String(open));
  if (body) body.hidden = !open;
}

document.querySelectorAll('.section-toggle').forEach((toggle) => {
  const key = toggle.dataset.remember;
  if (key) {
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) setSectionOpen(toggle, saved === 'true');
    } catch (error) {
      // Storage can be blocked (private mode); keep the default state
    }
  }

  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    setSectionOpen(toggle, open);
    if (key) {
      try {
        localStorage.setItem(key, String(open));
      } catch (error) {
        // Not critical if the choice can't be remembered
      }
    }
  });
});

// Opening a tool or interview chat from elsewhere (e.g. "+" menu) should reveal the Advanced section
function openAdvancedSection() {
  const toggle = document.querySelector('.section-toggle[data-target="advanced-body"]');
  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') setSectionOpen(toggle, true);
}

sidebarProfileButton?.addEventListener('click', () => {
  openLoginModalButton?.click();
});

// Eye button next to each password field toggles between hidden and visible text
document.querySelectorAll('.password-toggle').forEach((toggle) => {
  toggle.addEventListener('click', () => {
    const input = toggle.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    input.focus();
  });
});

const composerPlus = document.getElementById('composer-plus');
const composerMenu = document.getElementById('composer-menu');
const composerMic = document.getElementById('composer-mic');

function setComposerMenuOpen(open) {
  if (!composerMenu || !composerPlus) return;
  composerMenu.hidden = !open;
  composerPlus.setAttribute('aria-expanded', String(open));
}

composerPlus?.addEventListener('click', (event) => {
  event.stopPropagation();
  setComposerMenuOpen(composerMenu.hidden);
});

composerMenu?.addEventListener('click', (event) => {
  const item = event.target.closest('.composer-menu-item');
  if (!item) return;
  if (item.dataset.action === 'upload') imageInput?.click();
  setComposerMenuOpen(false);
});

document.addEventListener('click', (event) => {
  if (composerMenu && !composerMenu.hidden && !composerMenu.contains(event.target)) {
    setComposerMenuOpen(false);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setComposerMenuOpen(false);
});

// Voice input via the browser's Web Speech API (button stays hidden if unsupported)
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition && composerMic) {
  const recognition = new SpeechRecognition();
  recognition.interimResults = false;
  let listening = false;

  composerMic.hidden = false;
  composerMic.addEventListener('click', () => {
    if (listening) {
      recognition.stop();
      return;
    }
    recognition.lang = navigator.language || 'en-US';
    recognition.start();
  });

  recognition.addEventListener('start', () => {
    listening = true;
    composerMic.classList.add('listening');
  });

  recognition.addEventListener('end', () => {
    listening = false;
    composerMic.classList.remove('listening');
  });

  recognition.addEventListener('result', (event) => {
    const transcript = Array.from(event.results).map((result) => result[0].transcript).join(' ');
    questionInput.value = `${questionInput.value} ${transcript}`.trim();
    questionInput.focus();
  });
}

// Lets tool pages (e.g. Interview prep) open a fresh chat in a special mode and send its first message
window.SKChat = {
  startModeChat(mode, firstMessage) {
    startFreshChat();
    currentMode = mode;
    questionInput.value = firstMessage;
    if (typeof chatForm.requestSubmit === 'function') chatForm.requestSubmit();
    else chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
  },
};
