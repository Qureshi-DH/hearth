// Everything here is an extra. Without it the page still reads top to bottom:
// every deploy option shows, the screens scroll and each one links to its
// image, and the feed in the hero shows its first entry.
;(() => {
  const root = document.documentElement
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)")
  const systemDark = matchMedia("(prefers-color-scheme: dark)")

  // ---------- theme ----------

  const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : systemDark.matches)

  // <picture> follows the system theme on its own. Once somebody picks a
  // theme here, the dark screenshots follow the pick instead.
  const syncPictures = () => {
    const media = root.dataset.theme
      ? root.dataset.theme === "dark"
        ? "all"
        : "not all"
      : "(prefers-color-scheme: dark)"
    for (const source of document.querySelectorAll("source[data-dark]")) {
      source.media = media
    }
  }

  const themeButton = document.querySelector(".theme-btn")
  const labelTheme = () => {
    if (themeButton) {
      themeButton.setAttribute(
        "aria-label",
        isDark() ? "Use the light theme" : "Use the dark theme",
      )
    }
  }

  themeButton?.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark"
    root.dataset.theme = next
    try {
      localStorage.setItem("hearth-theme", next)
    } catch {
      // Storage blocked. The choice lasts until the page closes.
    }
    syncPictures()
    labelTheme()
  })
  systemDark.addEventListener("change", labelTheme)
  syncPictures()
  labelTheme()

  // ---------- the feed over the hero phone ----------
  // Twice through, then it rests on the first entry, so nothing on the page
  // keeps moving for somebody reading further down.

  const feed = document.querySelector(".feed")
  if (feed && feed.children.length > 1) {
    const entries = [...feed.children]
    const total = entries.length * 2
    let shown = 0
    let steps = 0
    let timer = 0
    let inView = true

    const show = (index) => {
      entries[shown].classList.remove("on")
      shown = index
      entries[shown].classList.add("on")
    }

    const stop = () => {
      clearInterval(timer)
      timer = 0
    }

    const run = () => {
      stop()
      if (reduceMotion.matches || !inView || document.hidden || steps >= total) return
      timer = setInterval(() => {
        steps += 1
        show(steps >= total ? 0 : (shown + 1) % entries.length)
        if (steps >= total) stop()
      }, 3200)
    }

    new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting
      run()
    }).observe(feed)
    document.addEventListener("visibilitychange", run)
    reduceMotion.addEventListener("change", run)
  }

  // ---------- deploy tabs ----------

  const tabs = document.querySelector(".tabs")
  if (tabs) {
    const buttons = [...tabs.querySelectorAll(".tablist button")]
    const panels = buttons.map((button) => document.getElementById(button.dataset.panel))

    tabs.querySelector(".tablist").setAttribute("role", "tablist")
    buttons.forEach((button, i) => {
      button.setAttribute("role", "tab")
      button.id = `tab-${button.dataset.panel}`
      button.setAttribute("aria-controls", button.dataset.panel)
      panels[i].setAttribute("role", "tabpanel")
      panels[i].setAttribute("aria-labelledby", button.id)
      panels[i].tabIndex = 0
    })

    const select = (index, focus) => {
      buttons.forEach((button, i) => {
        const on = i === index
        button.setAttribute("aria-selected", on ? "true" : "false")
        button.tabIndex = on ? 0 : -1
        panels[i].hidden = !on
      })
      if (focus) buttons[index].focus()
    }

    buttons.forEach((button, i) => {
      button.addEventListener("click", () => select(i, false))
      button.addEventListener("keydown", (event) => {
        const last = buttons.length - 1
        const to = {
          ArrowRight: i === last ? 0 : i + 1,
          ArrowLeft: i === 0 ? last : i - 1,
          Home: 0,
          End: last,
        }[event.key]
        if (to === undefined) return
        event.preventDefault()
        select(to, true)
      })
    })

    const fromHash = () => {
      const index = panels.findIndex((panel) => `#${panel.id}` === location.hash)
      if (index >= 0) select(index, false)
      return index
    }
    if (fromHash() < 0) select(0, false)
    addEventListener("hashchange", fromHash)
  }

  // ---------- copy buttons ----------
  // The Clipboard API exists only on https and localhost. Elsewhere the
  // buttons stay hidden and the commands are there to select by hand.

  if (navigator.clipboard?.writeText) {
    for (const button of document.querySelectorAll(".copy")) {
      const label = button.querySelector("span")
      button.hidden = false
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copy)
          label.textContent = "Copied"
        } catch {
          label.textContent = "Select it instead"
        }
        setTimeout(() => {
          label.textContent = "Copy"
        }, 2000)
      })
    }
  }

  // ---------- screens strip and viewer ----------
  // The strip scrolls without this, and each screen is a link to its own
  // image, so all this adds is the buttons and a viewer that stays on the page.

  const strip = document.querySelector(".strip")
  const viewer = document.querySelector(".viewer")
  if (strip && viewer && typeof viewer.showModal === "function") {
    const shots = [...strip.querySelectorAll(".shot")]
    const image = viewer.querySelector("img")
    const caption = viewer.querySelector("figcaption")
    let index = 0

    for (const button of document.querySelectorAll("[data-dir]")) {
      button.addEventListener("click", () => {
        strip.scrollBy({
          left: Number(button.dataset.dir) * strip.clientWidth * 0.8,
          behavior: reduceMotion.matches ? "auto" : "smooth",
        })
      })
    }

    const show = (next) => {
      index = (next + shots.length) % shots.length
      const shot = shots[index]
      image.src = shot.getAttribute("href")
      image.alt = shot.querySelector("img").alt
      caption.textContent = shot.dataset.caption
    }

    shots.forEach((shot, i) => {
      shot.addEventListener("click", (event) => {
        event.preventDefault()
        show(i)
        viewer.showModal()
      })
    })

    for (const button of viewer.querySelectorAll("[data-step]")) {
      button.addEventListener("click", () => show(index + Number(button.dataset.step)))
    }
    viewer.querySelector(".close").addEventListener("click", () => viewer.close())
    viewer.addEventListener("click", (event) => {
      if (event.target === viewer || event.target.classList.contains("viewer-inner")) {
        viewer.close()
      }
    })
    viewer.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") show(index - 1)
      if (event.key === "ArrowRight") show(index + 1)
    })
  }
})()
