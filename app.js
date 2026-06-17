(function () {
  const body = document.body;
  const header = document.querySelector("[data-header]");
  const menuButton = document.querySelector("[data-menu-button]");
  const menuClose = document.querySelector("[data-menu-close]");
  const menuOverlay = document.querySelector("[data-menu-overlay]");
  const mobileMenu = document.querySelector("[data-mobile-menu]");
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function setMenu(open) {
    body.classList.toggle("menu-open", open);
    menuButton?.setAttribute("aria-expanded", String(open));
    menuButton?.setAttribute("aria-label", open ? "Zamknij menu" : "Otwórz menu");
    mobileMenu?.setAttribute("aria-hidden", String(!open));

    if (open) {
      menuClose?.focus();
    } else if (document.activeElement === menuClose) {
      menuButton?.focus();
    }
  }

  menuButton?.addEventListener("click", () => {
    setMenu(!body.classList.contains("menu-open"));
  });

  menuClose?.addEventListener("click", () => setMenu(false));
  menuOverlay?.addEventListener("click", () => setMenu(false));

  mobileMenu?.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => setMenu(false));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && body.classList.contains("menu-open")) {
      setMenu(false);
    }
  });

  function updateHeader() {
    header?.classList.toggle("is-scrolled", window.scrollY > 24);
  }

  updateHeader();
  window.addEventListener("scroll", updateHeader, { passive: true });

  document.querySelectorAll(".faq-item button").forEach((button) => {
    button.addEventListener("click", () => {
      const wasOpen = button.getAttribute("aria-expanded") === "true";

      document.querySelectorAll(".faq-item button").forEach((otherButton) => {
        const answer = document.getElementById(otherButton.getAttribute("aria-controls"));
        otherButton.setAttribute("aria-expanded", "false");
        if (answer) answer.hidden = true;
      });

      if (!wasOpen) {
        const answer = document.getElementById(button.getAttribute("aria-controls"));
        button.setAttribute("aria-expanded", "true");
        if (answer) answer.hidden = false;
      }
    });
  });

  const revealItems = document.querySelectorAll(".reveal");

  if (prefersReducedMotion || !("IntersectionObserver" in window)) {
    revealItems.forEach((item) => item.classList.add("is-visible"));
  } else {
    const revealObserver = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -35px" },
    );

    revealItems.forEach((item) => revealObserver.observe(item));
  }

  const navLinks = document.querySelectorAll(".desktop-nav a");
  const trackedSections = Array.from(navLinks)
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);

  if ("IntersectionObserver" in window) {
    const navObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          navLinks.forEach((link) => {
            link.classList.toggle("active", link.getAttribute("href") === `#${entry.target.id}`);
          });
        });
      },
      { rootMargin: "-32% 0px -58%", threshold: 0 },
    );

    trackedSections.forEach((section) => navObserver.observe(section));
  }

  document.querySelectorAll("[data-year]").forEach((element) => {
    element.textContent = new Date().getFullYear();
  });

  if (window.lucide) {
    window.lucide.createIcons({
      attrs: {
        "stroke-width": 1.7,
      },
    });
  }
})();
