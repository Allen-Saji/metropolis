import { useEffect, type RefObject } from "react";

export function useHeroMotion(heroRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;

    const visibility = new IntersectionObserver(([entry]) => {
      hero.dataset.active = entry?.isIntersecting ? "true" : "false";
    }, { threshold: 0.02 });
    visibility.observe(hero);

    const finePointer = window.matchMedia("(pointer: fine) and (prefers-reduced-motion: no-preference)");
    if (!finePointer.matches) return () => visibility.disconnect();

    let frame = 0;
    let x = 0;
    let y = 0;
    const paint = () => {
      hero.style.setProperty("--hero-shift-x", `${x}px`);
      hero.style.setProperty("--hero-shift-y", `${y}px`);
      frame = 0;
    };
    const onMove = (event: PointerEvent) => {
      const bounds = hero.getBoundingClientRect();
      x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 14;
      y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 10;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onLeave = () => {
      x = 0;
      y = 0;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    hero.addEventListener("pointermove", onMove, { passive: true });
    hero.addEventListener("pointerleave", onLeave);
    return () => {
      visibility.disconnect();
      hero.removeEventListener("pointermove", onMove);
      hero.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(frame);
    };
  }, [heroRef]);
}

export function useSiteMotion() {
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) return;

    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-revealed");
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    const targets = document.querySelectorAll<HTMLElement>("[data-reveal]");
    for (const target of targets) {
      if (target.getBoundingClientRect().top < window.innerHeight * 0.88) continue;
      target.classList.add("reveal-pending");
      observer.observe(target);
    }

    const progress = document.querySelector<HTMLElement>(".scroll-progress");
    let frame = 0;
    const updateProgress = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      progress?.style.setProperty("transform", `scaleX(${scrollable > 0 ? window.scrollY / scrollable : 0})`);
      frame = 0;
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(updateProgress);
    };
    updateProgress();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);
}
