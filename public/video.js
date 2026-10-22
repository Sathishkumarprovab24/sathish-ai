// Video creator page: form -> POST /api/video -> poll progress -> show the finished video
(() => {
  const videoForm = document.getElementById('video-form');
  const videoPromptInput = document.getElementById('video-prompt');
  const resultsEl = document.getElementById('video-results');
  const POLL_MS = 3000;

  // Each stage's share of the progress bar
  const STAGES = {
    planning: { start: 0, span: 5 },
    images: { start: 5, span: 45 },
    rendering: { start: 50, span: 45 },
    joining: { start: 95, span: 5 },
    done: { start: 100, span: 0 },
  };

  function createJobCard(prompt, minutes) {
    const card = document.createElement('div');
    card.className = 'video-job tool-card';
    card.innerHTML = `
      <div class="video-job-prompt"></div>
      <div class="video-job-title">Making your video...</div>
      <div class="video-job-step">Starting...</div>
      <div class="video-progress"><div class="video-progress-bar"></div></div>`;
    card.querySelector('.video-job-prompt').textContent = `${minutes} min · ${prompt}`;
    resultsEl.prepend(card);

    return {
      root: card,
      title: card.querySelector('.video-job-title'),
      step: card.querySelector('.video-job-step'),
      bar: card.querySelector('.video-progress-bar'),
    };
  }

  function progressPercent(job) {
    const stage = STAGES[job.status] || STAGES.planning;
    const fraction = job.total ? job.done / job.total : 0;
    return Math.round(stage.start + stage.span * fraction);
  }

  function showError(view, message) {
    view.title.textContent = 'Video could not be made';
    view.step.textContent = message;
    view.bar.parentElement.remove();
  }

  function showVideo(view, job) {
    view.title.textContent = job.title || 'Your video';
    view.step.remove();
    view.bar.parentElement.remove();

    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.src = job.videoUrl;

    const download = document.createElement('a');
    download.href = job.videoUrl;
    download.download = `${(job.title || 'video').replace(/[^\w\- ]+/g, '').trim() || 'video'}.mp4`;
    download.textContent = 'Download video';

    view.root.append(video, download);
  }

  async function pollJob(jobId, view) {
    try {
      const response = await fetch(`/api/video/${encodeURIComponent(jobId)}`, { credentials: 'same-origin' });
      const job = await response.json();
      if (!response.ok) throw new Error(job.error || 'Lost track of the video job.');

      if (job.title) view.title.textContent = `Making "${job.title}"...`;
      const count = job.total && ['images', 'rendering'].includes(job.status) ? ` (${job.done}/${job.total})` : '';
      view.step.textContent = `${job.step}${count}`;
      view.bar.style.width = `${progressPercent(job)}%`;

      if (job.status === 'done') return showVideo(view, job);
      if (job.status === 'error') return showError(view, job.error || 'Something went wrong.');
    } catch (error) {
      console.error('Video poll error:', error);
      return showError(view, error.message);
    }

    setTimeout(() => pollJob(jobId, view), POLL_MS);
  }

  videoForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const prompt = videoPromptInput.value.trim();
    const minutes = Number(document.getElementById('video-minutes').value);
    const voice = document.getElementById('video-voice').checked;
    if (!prompt) return;

    videoPromptInput.value = '';
    const view = createJobCard(prompt, minutes);

    try {
      const response = await fetch('/api/video', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, minutes, voice }),
      });
      const data = await response.json();
      if (data.code === 'LOGIN_REQUIRED') {
        showError(view, 'Please log in to create more videos.');
        document.getElementById('open-login-modal')?.click();
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Unable to start the video.');
      pollJob(data.jobId, view);
    } catch (error) {
      console.error('Video start error:', error);
      showError(view, error.message);
    }
  });
})();
