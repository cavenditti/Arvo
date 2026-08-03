const header = document.querySelector('[data-header]');
const year = document.querySelector('[data-year]');
if (year) year.textContent = String(new Date().getFullYear());

const syncHeader = () => header?.classList.toggle('scrolled', window.scrollY > 24);
syncHeader();
window.addEventListener('scroll', syncHeader, { passive: true });

const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const ambientVideos = document.querySelectorAll('[data-ambient-video]');

const syncAmbientVideo = () => {
  ambientVideos.forEach((video) => {
    if (motionPreference.matches) {
      video.pause();
      return;
    }

    const playback = video.play();
    playback?.catch(() => {});
  });
};

syncAmbientVideo();
motionPreference.addEventListener?.('change', syncAmbientVideo);
