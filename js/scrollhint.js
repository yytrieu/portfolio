/* ==========================================================================
   Hinweis "Weiter scrollen" unten rechts

   Was er leistet: solange die Seite noch weitergeht, steht unten rechts
   ein kleiner Hinweis darauf. Er ist beim Laden sofort da, tritt waehrend
   einer Bewegung zurueck und kommt eine Sekunde nach der letzten Bewegung
   wieder - so stoert er das Scrollen und erinnert danach ruhig daran,
   dass es weitergeht.

   Wann er NICHT steht:
     - am Ende des Wegs, wenn es nichts mehr zu scrollen gibt,
     - solange der Tor-Knopf am Graph-Ende (#scrollBtn, js/script.js)
       sichtbar ist: er traegt dieselbe Aufforderung und ist dort der
       einzige Weg weiter. Zwei gleiche Beschriftungen nebeneinander
       lesen sich wie ein Fehler.

   "Weitergehen" ist nicht nur das Dokumentende: js/track.js zieht am
   Ende eines Tracks zusaetzlich eine harte Grenze (limits) - am Graph-
   Ende ist das das geschlossene Tor. Beide Grenzen werden abgefragt,
   sonst verspraeche der Hinweis einen Weg, den es nicht gibt.

   Stile: css/scrollhint.css. Aufgebaut wird der Hinweis hier, damit die
   Seiten-Markup-Dateien unveraendert bleiben (wie js/tools.js mit den
   Sprechblaettern).
   ========================================================================== */
(function () {
  "use strict";

  /* Ruhezeit, nach der der Hinweis nach einer Bewegung wieder erscheint. */
  var IDLE_MS = 1000;

  /* So viele Pixel vor der Grenze gilt der Weg schon als zu Ende. Ohne
     diesen Abstand flackerte der Hinweis am Schluss: das Einrasten aus
     js/track.js bleibt ein bis zwei Pixel vor der Kante stehen. */
  var END_GAP = 4;

  var el = null;
  var idleTimer = 0;
  var visible = false;

  function scrollTop() { return window.scrollY || window.pageYOffset || 0; }

  /* Die hintere Grenze des Wegs: das Dokumentende und davor die harte
     Grenze des aktiven Tracks aus js/track.js. */
  function maxScrollY() {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    var t = window.TurnTrack && window.TurnTrack.instance;
    if (!t || !t.limits || !t.tops) return max;

    var y = scrollTop();
    var tops = t.tops;
    var k = 0;
    for (var i = 0; i < tops.length; i++) {
      if (tops[i] <= y + 2) k = i;
    }
    var lim = t.limits[k];
    if (typeof lim === "number" && lim < max) max = lim;
    return max;
  }

  function canScrollFurther() {
    return scrollTop() < maxScrollY() - END_GAP;
  }

  /* Am Graph-Ende traegt der Tor-Knopf genau dieselbe Beschriftung
     (#scrollBtn, js/script.js). Er zaehlt aber nur, wenn er wirklich im
     Bild steht: js/script.js laesst ihn sichtbar, solange der Canvas am
     Ende steht und die Buehne das Bild beruehrt - dann kann der Knopf
     trotzdem schon unter dem Bild liegen. Dort waere der Hinweis sonst
     grundlos unterdrueckt, obwohl die Seite weiterscrollt. */
  function gateTakesOver() {
    var gate = document.getElementById("scrollBtn");
    if (!gate || !gate.classList.contains("is-visible")) return false;
    var r = gate.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }

  /* Das Tor kann auch ohne Scroll-Ereignis aufgehen: js/script.js schaltet
     den Knopf beim Ziehen am Canvas oder nach einem Resize ein. Dann darf
     der Hinweis nicht auf die naechste Ruhezeit warten - sonst stuenden
     zwei gleiche Aufforderungen gleichzeitig im Bild. */
  function watchGate() {
    var gate = document.getElementById("scrollBtn");
    if (!gate || !window.MutationObserver) return;
    new MutationObserver(function () {
      if (gateTakesOver()) setVisible(false);
    }).observe(gate, { attributes: true, attributeFilter: ["class"] });
  }

  function shouldShow() {
    return canScrollFurther() && !gateTakesOver();
  }

  /* Unten rechts steht schon Bedienbares: der runde Ton-Knopf des Heros
     (.sound-toggle), der Ton-Knopf des Musik-Abschnitts (#musicAudio, auf
     hochkant gestellten Bildschirmen liegt er in derselben Ecke), auf
     schmalen Bildschirmen der Pfeil der Projekt-Navigation
     (.viewnav__btn--next, css/viewnav.css) und der "Nach oben"-Verweis der
     Endkarte. Der Hinweis rueckt darueber, statt darauf zu liegen.
     Gemessen statt gerechnet: die Hoehe dieser Elemente haengt an der
     Schriftgroesse der Seite, und der Ton-Knopf des Heros wandert beim
     Abloesen des Heros nach oben aus dem Bild. */
  var CORNER = ".sound-toggle, #musicAudio, .viewnav__btn--next, .endcard__foot";
  var CORNER_GAP = 12;

  /* Abstand der Oberkante des hoechsten Ecken-Elements von der Unterkante
     des Fensters; 0, wenn dort nichts steht. Nur die untere Haelfte und
     nur die rechte Seite zaehlen - mitten im Bild oder oben rechts stoert
     nichts. Die Deckkraft zaehlt bewusst nicht: auch ein Element, das
     gerade einblendet, besetzt die Ecke schon. */
  function cornerTop() {
    var found = document.querySelectorAll(CORNER);
    var top = 0;

    for (var i = 0; i < found.length; i++) {
      var node = found[i];
      var cs = getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden") continue;

      var r = node.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
      if (r.top < window.innerHeight / 2) continue;
      if (r.right < window.innerWidth * .6) continue;

      var d = window.innerHeight - r.top;
      if (d > top) top = d;
    }
    return top;
  }

  function syncPlacement() {
    if (!el) return;
    var corner = cornerTop();
    /* Ohne Ecken-Element gilt wieder der Abstand aus dem Stylesheet. */
    if (!corner) { el.style.removeProperty("--scrollhint-bottom"); return; }
    el.style.setProperty("--scrollhint-bottom", Math.round(corner + CORNER_GAP) + "px");
  }

  function setVisible(on) {
    if (!el || on === visible) return;
    visible = on;
    el.classList.toggle("is-visible", on);
  }

  /* Eine Bewegung auf dem Schirm: der Hinweis tritt zurueck und kommt
     erst wieder, wenn eine Sekunde lang nichts mehr passiert. Das gilt
     auch fuer das Einrasten und die weichen Spruenge aus js/track.js -
     sie schicken waehrenddessen Scroll-Events, der Hinweis kommt also
     erst nach dem Ankommen zurueck.

     Rad und Wischen zaehlen mit, obwohl sie die Seite nicht immer
     bewegen: ueber dem Graph schiebt das Rad den Canvas (js/script.js),
     der Bildschirminhalt laeuft also weiter, waehrend die Scrollposition
     steht. Genau dann soll der Hinweis nicht stehen bleiben. */
  function onMove() {
    setVisible(false);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, IDLE_MS);
  }

  function onIdle() {
    idleTimer = 0;
    syncPlacement();
    setVisible(shouldShow());
  }

  /* Ohne Bewegung neu bewerten (Laden, Fenstergroesse, Screen-Wechsel):
     waehrend einer laufenden Ruhezeit bleibt der Hinweis weg. */
  function recheck() {
    if (!shouldShow()) { setVisible(false); return; }
    if (idleTimer) return;
    syncPlacement();
    setVisible(true);
  }

  function build() {
    el = document.createElement("div");
    el.className = "scrollhint";
    /* Reine Anzeige: die Aufforderung wiederholt nur, was Rad, Pfeiltasten
       und der Tor-Knopf ohnehin tun - Screenreader sollen sie nicht
       vorlesen, und klickbar ist sie nicht (pointer-events: none). */
    el.setAttribute("aria-hidden", "true");

    /* Drei weisse Chevrons, Animation in css/scrollhint.css */
    for (var i = 0; i < 3; i++) {
      var ns = "http://www.w3.org/2000/svg";
      var svg = document.createElementNS(ns, "svg");
      svg.setAttribute("class", "scrollhint__chev");
      svg.setAttribute("viewBox", "0 0 48 28");
      var p = document.createElementNS(ns, "path");
      p.setAttribute("d", "M4 4l20 20L44 4");
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "currentColor");
      p.setAttribute("stroke-width", "4");
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      svg.appendChild(p);
      el.appendChild(svg);
    }
    document.body.appendChild(el);
  }

  build();
  watchGate();

  window.addEventListener("scroll", onMove, { passive: true });
  window.addEventListener("wheel", onMove, { passive: true });
  window.addEventListener("touchmove", onMove, { passive: true });
  /* Grenzen und Tor-Zustand haengen an der Fenstergroesse (js/track.js
     misst dann neu), am Screen-Wechsel und am Ende des Ladens (Bilder,
     Videos und der Graph bestimmen die Dokumenthoehe mit). */
  window.addEventListener("resize", recheck);
  window.addEventListener("orientationchange", recheck);
  window.addEventListener("load", recheck);
  document.addEventListener("track:screen", recheck);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", recheck);
  }

  /* Ganz am Anfang sofort da: noch ohne jede Bewegung, also ohne
     Ruhezeit. */
  recheck();
})();
