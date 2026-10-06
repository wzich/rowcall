const demo = document.querySelector(".demo-section");
const replay = document.querySelector("#replay");
const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
function play() {
  demo.classList.remove("playing");
  if (!motion.matches) {
    void demo.offsetWidth;
    demo.classList.add("playing");
  }
}
replay.hidden = motion.matches;
replay.addEventListener("click", play);
motion.addEventListener("change", () => {
  replay.hidden = motion.matches;
  play();
});
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (entry.target === demo) play();
      else entry.target.classList.add("visible");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.15 });
  observer.observe(demo);
  for (const section of document.querySelectorAll(".reveal")) {
    section.classList.add("ready");
    observer.observe(section);
  }
}
for (const button of document.querySelectorAll("[data-copy]")) {
  if (!navigator.clipboard) continue;
  button.hidden = false;
  button.addEventListener("click", async () => {
    const command = document.getElementById(button.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(command);
      button.textContent = "Copied";
      document.querySelector("#copy-status").textContent = "Command copied.";
      setTimeout(() => {
        button.textContent = "Copy";
      }, 2000);
    } catch {
      document.querySelector("#copy-status").textContent =
        "Could not copy. Select the command and copy it manually.";
    }
  });
}
