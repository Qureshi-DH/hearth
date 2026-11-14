// Loaded in <head> without defer, so a page switched to dark stays dark on
// the next visit instead of flashing light first. The "js" class lets the
// menu and the deploy tabs collapse, so the menu button is wired here too:
// it has to open even if the deferred script never arrives.
;(function () {
  var root = document.documentElement
  root.classList.add("js")
  try {
    var saved = localStorage.getItem("hearth-theme")
    if (saved === "light" || saved === "dark") root.dataset.theme = saved
  } catch (error) {
    // Storage blocked. The system theme applies.
  }

  document.addEventListener("DOMContentLoaded", function () {
    var nav = document.querySelector(".nav")
    var button = document.querySelector(".menu-btn")
    if (!nav || !button) return
    var setOpen = function (open) {
      nav.classList.toggle("open", open)
      button.setAttribute("aria-expanded", open ? "true" : "false")
    }
    button.addEventListener("click", function () {
      setOpen(!nav.classList.contains("open"))
    })
    nav.querySelectorAll(".nav-links a").forEach(function (link) {
      link.addEventListener("click", function () {
        setOpen(false)
      })
    })
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") setOpen(false)
    })
  })
})()
