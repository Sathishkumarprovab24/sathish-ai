// Library page: the user's images, videos and files (created in the app, attached in chat or uploaded)
(() => {
  const grid = document.getElementById('library-grid');
  const status = document.getElementById('library-status');
  const searchInput = document.getElementById('library-search');
  const uploadInput = document.getElementById('library-upload-input');
  const tabs = document.querySelectorAll('.tool-tab[data-library]');
  if (!grid) return;

  let items = [];
  let activeType = 'all';

  const SOURCE_LABELS = {
    'image-creator': 'Image creator',
    'video-creator': 'Video creator',
    chat: 'Chat upload',
    upload: 'Uploaded',
  };

  function setStatus(text, isError = false) {
    status.hidden = !text;
    status.textContent = text || '';
    status.className = isError ? 'tool-status tool-error' : 'tool-status';
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function loadLibrary() {
    setStatus('Loading your library...');
    try {
      const response = await fetch('/api/library', { credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load your library.');
      items = data.items || [];
      setStatus('');
      render();
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  function render() {
    const term = searchInput.value.trim().toLowerCase();
    const visible = items.filter((item) =>
      (activeType === 'all' || item.type === activeType) &&
      (!term || item.name.toLowerCase().includes(term))
    );

    grid.innerHTML = '';
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'library-empty';
      empty.innerHTML = term
        ? '<strong>No matches</strong><span>Try a different search.</span>'
        : '<strong>Nothing here yet</strong><span>Images and videos you create, files you attach in chat, and uploads will appear here.</span>';
      grid.appendChild(empty);
      return;
    }

    visible.forEach((item) => grid.appendChild(createCard(item)));
  }

  function createCard(item) {
    const card = document.createElement('article');
    card.className = `library-card library-${item.type}`;
    card.tabIndex = 0;

    const preview = document.createElement('div');
    preview.className = 'library-preview';

    if (item.type === 'image') {
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = item.name;
      img.loading = 'lazy';
      preview.appendChild(img);
    } else if (item.type === 'video') {
      // "#t=1" makes the browser show a frame from 1s in as the thumbnail
      const video = document.createElement('video');
      video.src = `${item.url}#t=1`;
      video.preload = 'metadata';
      video.muted = true;
      preview.appendChild(video);
      const play = document.createElement('span');
      play.className = 'library-play';
      play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
      preview.appendChild(play);
    } else {
      preview.innerHTML = '<span class="library-file-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg><b>PDF</b></span>';
    }

    const info = document.createElement('div');
    info.className = 'library-info';
    const name = document.createElement('strong');
    name.textContent = item.name;
    name.title = item.name;
    const meta = document.createElement('span');
    meta.textContent = [`Added ${formatDate(item.createdAt)}`, formatSize(item.size), SOURCE_LABELS[item.source]]
      .filter(Boolean)
      .join(' · ');
    info.append(name, meta);

    card.append(preview, info, createMenu(item));
    card.addEventListener('click', (event) => {
      if (!event.target.closest('.library-menu')) openItem(item);
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') openItem(item);
    });
    return card;
  }

  function createMenu(item) {
    const wrap = document.createElement('div');
    wrap.className = 'library-menu';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'library-menu-toggle';
    toggle.setAttribute('aria-label', 'More options');
    toggle.textContent = '⋯';

    const menu = document.createElement('div');
    menu.className = 'library-menu-list';
    menu.hidden = true;

    const download = document.createElement('a');
    download.href = item.url;
    download.download = item.name;
    download.textContent = 'Download';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'library-delete';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => deleteItem(item));

    menu.append(download, remove);
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      document.querySelectorAll('.library-menu-list').forEach((list) => {
        if (list !== menu) list.hidden = true;
      });
      menu.hidden = !menu.hidden;
    });

    wrap.append(toggle, menu);
    return wrap;
  }

  function openItem(item) {
    if (item.type === 'image' && typeof window.openImageViewer === 'function') {
      window.openImageViewer(item.url, item.name);
    } else {
      window.open(item.url, '_blank', 'noopener');
    }
  }

  async function deleteItem(item) {
    if (!window.confirm(`Delete "${item.name}" from your library? This cannot be undone.`)) return;
    try {
      const response = await fetch(`/api/library/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to delete this item.');
      items = items.filter((existing) => existing.id !== item.id);
      render();
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  uploadInput?.addEventListener('change', async () => {
    const files = Array.from(uploadInput.files || []);
    if (files.length === 0) return;

    const body = new FormData();
    files.forEach((file) => body.append('files', file));
    setStatus(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}...`);

    try {
      const response = await fetch('/api/library', { method: 'POST', credentials: 'same-origin', body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Upload failed.');
      items = [...data.items, ...items];
      setStatus('');
      render();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      uploadInput.value = '';
    }
  });

  tabs.forEach((tab) => tab.addEventListener('click', () => {
    activeType = tab.dataset.library;
    tabs.forEach((other) => {
      const active = other === tab;
      other.classList.toggle('active', active);
      other.setAttribute('aria-selected', String(active));
    });
    render();
  }));

  searchInput?.addEventListener('input', render);

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.library-menu')) {
      document.querySelectorAll('.library-menu-list').forEach((list) => { list.hidden = true; });
    }
  });

  // Reload whenever the Library page is opened so new images/videos show up
  document.addEventListener('sk:tool-open', (event) => {
    if (event.detail === 'library') loadLibrary();
  });
})();
