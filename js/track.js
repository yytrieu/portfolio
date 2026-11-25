/* ==========================================================================
   Projekt-Track: vier Ansichten nebeneinander, Screens rasten ein

   Aufbau:

     [ Ansicht 1 ][ Ansicht 2 ][ Ansicht 3 ][ Ansicht 4 ]   <- 400vw breite Spur

   Die vier Ansichten stehen wie in der Live-Version nebeneinander in einer
   400vw breiten Spur. Sichtbar ist immer genau eine: die Spur wird per
   transform: translate3d(-i * 100vw, 0, 0) verschoben (CSS-Transition in
   css/track.css laesst sie gleiten).

   Was diese Datei macht:

   1. SCREENS - ein Screen ist eine Sektionsgrenze (plus der Seitenanfang).
      Nachdem das Scrollen ruht, rastet die Seite auf die naechste Kante ein
      (bis zur halben Fensterhoehe Abstand). Innerhalb langer gepinnter
      Strecken (Hero, Graph, Curtain, Musik) gibt es keine Kante, dort steht
      der Inhalt frei.

   2. TRACK-ENDE - die letzte Sektion eines Tracks ist die letzte Seite.
      Weiterscrollen nach unten ist dort hart gesperrt (Mausrad wird
      abgefangen, sonst wird die Position zurueckgezogen). Der WEITER-Pfeil
      erscheint auf dieser Seite und gleitet zur ersten Seite des naechsten
      Tracks. Der ZURUECK-Pfeil auf der ersten Seite springt auf die letzte
      Seite des vorigen Tracks.

   3. SCROLL-TECHNIK - die Ansichten liegen visuell nebeneinander, in der
      Scrollspur aber untereinander: js setzt margin-top, damit die
      Scrollposition eindeutig sagt, welche Ansicht vorne ist. Die
      sticky-Pins der Abschnitte bleiben davon unberuehrt (nachgemessen).

   4. SCREEN-EVENT - bei jedem Screenwechsel schickt diese Datei
      "track:screen" mit { top }. js/script.js haengt daran das Abspielen der
      Titelsequenzen: sie laufen nur, solange ihr eigener Screen aktiv ist,
      und enden sofort beim Wechsel.

   5. JUMP-EVENT - setzt diese Datei die Scrollposition selbst (Einrasten,
      WEITER/ZURUECK-Pfeil, Tief-Link, Zurueckziehen an der harten Grenze),
      schickt sie "track:jump" mit { top }. Das ist ein Sprung, kein
      Scrollen: die Menueleiste (js/topbar.js) nimmt ihn nur als neue Basis,
      statt ihn als "nach oben gescrollt" zu lesen. Sonst faehrt sie beim
      Gummiband am Seitenende aus und legt sich ueber den Titel.

   Oeffentliche API:
     window.TurnTrack.init()
     window.TurnTrack.index              - aktive Ansicht (0 ... 3)
     window.TurnTrack.pan / .hold        - immer 0 (Reste der alten Mechanik)
     window.TurnTrack.instance.goTo(i, "next"|"prev")
     window.TurnTrack.instance.nextScreen()  - eine Screen-Kante mit Inhalt
                                               weiter; leere Buehnen wie
                                               #weiter werden uebersprungen
     window.TurnTrack.instance.tops      - Oberkanten der Ansichten
     window.TurnTrack.instance.screenTop - Oberkante des aktiven Screens
   ========================================================================== */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* So viele Pixel unterhalb der Ansichtsgrenze gelten als "erste Seite" -
     dort erscheint der Zurueck-Pfeil. */
  var START_ZONE = 0.45;

  /* Einrasten: Abstand bis zur naechsten Kante, der noch eingezogen wird
     (Anteil der Fensterhoehe). */
  var SNAP_RATIO = 0.5;

  /* Ruhezeit nach dem letzten Scroll-Event, bevor eingerastet wird. */
  var SNAP_IDLE = 150;

  /* Solange laeuft kein Einrasten (programmatische Spruenge). */
  var PROGRAMMATIC = 1000;

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /* Meldet einen Sprung, den diese Datei selbst ausfuehrt: Einrasten,
     WEITER/ZURUECK-Pfeil, Tief-Link und das Zurueckziehen an der harten
     Grenze. Wer auf Scrollrichtung reagiert (js/topbar.js), nimmt das nur
     als neue Basis - sonst liest er den Sprung als Scrollen des Nutzers
     und faehrt z. B. beim Gummiband am Seitenende wieder ein, mitten in
     den Seitentitel hinein. */
  function announceJump(top) {
    document.dispatchEvent(new CustomEvent("track:jump", { detail: { top: top } }));
  }

  function init() {
    var track = document.getElementById("track");
    if (!track) return null;

    var panels = Array.prototype.slice.call(track.querySelectorAll(".track__panel"));
    if (!panels.length) return null;

    var current = -1;
    var currentScreen = null;
    var tops = [];        // Oberkanten der Ansichten (Dokumentkoordinaten)
    var lastPage = [];    // Oberkante der letzten Sektion je Ansicht
    var limits = [];      // Scroll-Grenze je Ansicht (letzte Seite)
    var lines = [];       // Snap-Kanten (absolute y), sortiert
    var emptyLines = {};  // Kanten, die nur zu inhaltsleeren Buehnen gehoeren

    var rafPending = false;
    var snapTimer = 0;
    var programmaticUntil = 0;
    var scrollAnim = 0;      // laufende eigene Scroll-Animation (Snap)

    var prevBtn = document.querySelector('[data-viewnav="prev"]');
    var nextBtn = document.querySelector('[data-viewnav="next"]');

    function vh() { return window.innerHeight || document.documentElement.clientHeight; }
    function scrollTop() { return window.scrollY || window.pageYOffset || 0; }

    /* Eigene Scroll-Animation statt behavior:"smooth": die native Animation
       laesst sich nicht zuverlaessig abbrechen, und ein Sprung (goTo)
       waehrend einer laufenden weichen Bewegung landet neben dem Ziel. Hier
       wird pro Frame gescrollt - abbrechbar, exakt, ohne Nachlauf. */
    function cancelScrollAnim() {
      if (scrollAnim) cancelAnimationFrame(scrollAnim);
      scrollAnim = 0;
    }

    function animateTo(target, dur) {
      cancelScrollAnim();
      var from = scrollTop();
      var dist = target - from;

      /* Mit Lenis uebernimmt die Scroll-Schicht die Animation: sie bringt die
         Daempfung schon mit, ein zweiter eigener rAF-Scroll wuerde gegen sie
         arbeiten. programmaticUntil wird vorher gesetzt, damit maybeSnap die
         eigenen Scroll-Events nicht als Nutzereingabe missdeutet. */
      if (window.SmoothScroll && window.SmoothScroll.enabled) {
        programmaticUntil = Date.now() + dur + 250;
        if (Math.abs(dist) < 2 || reduceMotion) {
          window.SmoothScroll.to(target, { immediate: true });
        } else {
          window.SmoothScroll.to(target, { duration: dur / 1000 });
        }
        announceJump(target);
        return;
      }

      if (Math.abs(dist) < 2 || reduceMotion) {
        window.scrollTo(0, Math.round(target));
        announceJump(target);
        return;
      }

      programmaticUntil = Date.now() + dur + 250;
      var t0 = 0;
      var expected = from;

      function frame(ts) {
        /* Hat jemand anderes gescrollt (Touch, Tastatur, ein Skript), hat
           diese Animation verloren - sie darf die Position nicht
           zurueckziehen. */
        if (Math.abs(scrollTop() - expected) > 3) { scrollAnim = 0; return; }

        if (!t0) t0 = ts;
        var u = Math.min(1, (ts - t0) / dur);
        var e = 1 - Math.pow(1 - u, 3);   // ease-out: weich ankommen
        expected = Math.round(from + dist * e);
        window.scrollTo(0, expected);
        announceJump(expected);
        if (u < 1) { scrollAnim = requestAnimationFrame(frame); return; }
        scrollAnim = 0;
        window.scrollTo(0, Math.round(target));
        announceJump(target);
      }

      scrollAnim = requestAnimationFrame(frame);
    }

    /* Exakt auf eine Position setzen: ein einzelnes scrollTo kann waehrend
       einer laufenden Scroll-Animation um ein paar Pixel daneben landen,
       deshalb wird in den naechsten Frames nachgezogen. */
    function landOn(target) {
      cancelScrollAnim();
      var goal = Math.round(target);

      /* Mit Lenis landet scrollTo exakt; das Nachfassen ueber mehrere Frames
         ist nur fuer die native Animation noetig. */
      if (window.SmoothScroll && window.SmoothScroll.enabled) {
        window.SmoothScroll.to(goal, { immediate: true });
        announceJump(goal);
        return;
      }

      window.scrollTo(0, goal);
      announceJump(goal);

      var tries = 0;
      function check() {
        if (tries++ > 6) return;
        if (Math.abs(scrollTop() - goal) <= 1) return;
        window.scrollTo(0, goal);
        announceJump(goal);
        requestAnimationFrame(check);
      }
      requestAnimationFrame(check);
    }

    /* ---------- messen --------------------------------------------------- */

    /* Inhaltsleer heisst: kein Element-Kind mit messbarer Hoehe und kein
       Text darin. Genau so sehen die Uebergangs-Buehnen aus (.placeholder,
       .seam): eine halbe Bildschirmhoehe Verlauf, sonst nichts. */
    function isEmptySection(sec) {
      var kids = sec.children;
      for (var c = 0; c < kids.length; c++) {
        if (kids[c].getBoundingClientRect().height > 1) return false;
      }
      return sec.textContent.trim() === "";
    }

    /* Oberkanten, Snap-Kanten und Scroll-Grenzen. Die Ansichten bekommen
       ihren vertikalen Platz per margin-top (nicht transform - ein
       transform wuerde die sticky-Pins verschieben).

       WICHTIG: die Margins duerfen dafuer NICHT auf 0 gesetzt werden.
       offsetHeight ist die Rahmen-Hoehe und enthaelt den Margin ohnehin
       nicht; das Zuruecksetzen aller Margins hat die Ansichten dagegen
       kurzzeitig uebereinandergelegt. Die Dokumenthoehe schrumpfte dabei
       auf die Hoehe der ersten Ansicht, der Browser klemmte die
       Scrollposition auf deren Ende, und der dadurch ausgeloeste
       Scroll-Event rastete in js/track.js auf Ansicht 0 ein - der Klick
       auf einen Phasen-Tab in "ai solution" sprang so zu Projekt 1
       (dasselbe bei jedem Fenster-Resize). */
    function measure() {
      var i, j;

      var y = 0;
      for (i = 0; i < panels.length; i++) {
        tops[i] = Math.round(y);
        panels[i].style.marginTop = tops[i] + "px";
        y += panels[i].offsetHeight;
      }

      var st = scrollTop();
      var lineSet = {};
      var emptyAt = {};    // y -> 1: hier beginnt eine inhaltsleere Sektion
      var contentAt = {};  // y -> 1: hier beginnt eine Sektion mit Inhalt
      lines = [];
      emptyLines = {};
      var pageEnd = [];

      /* Seitenanfang ist auch ein Screen (Hero). */
      lineSet[0] = 1;
      lines.push(0);

      for (i = 0; i < panels.length; i++) {
        /* Nur DIREKTE Sektionen einer Ansicht sind Screens. In .ot-notes
           stehen die beiden Textbloecke selbst in <section>-Elementen
           (.ot-block) - das ist Inhalt, kein Screen. Vorher wurden sie
           mitgezaehlt: sie legten Snap-Kanten mitten in "behind the
           scenes" an und machten dessen Oberkante unerreichbar (die
           letzte Seite landete auf 13347 statt auf 12933, der Titel stand
           ueber dem Bild). */
        var secs = [];
        for (var p0 = 0; p0 < panels[i].children.length; p0++) {
          if (panels[i].children[p0].tagName === "SECTION" &&
              !panels[i].children[p0].hasAttribute("data-track-skip")) {
            secs.push(panels[i].children[p0]);
          }
        }
        var top = tops[i];
        var end = tops[i];

        for (j = 0; j < secs.length; j++) {
          var r = secs[j].getBoundingClientRect();
          var sTop = Math.round(r.top + st);
          var sEnd = Math.round(r.bottom + st);
          if (!lineSet[sTop]) { lineSet[sTop] = 1; lines.push(sTop); }
          if (isEmptySection(secs[j])) emptyAt[sTop] = 1;
          else contentAt[sTop] = 1;
          if (sTop > top) top = sTop;

          /* Inhaltsende der Sektion: das Ende des letzten sichtbaren
             Kindes. Sektionen haben oft unten Luft (Padding) - die wuerde
             den letzten Screen schwarz auslaufen lassen. Sticky-/fixed-
             Kinder zaehlen nicht: ihr Rechteck zeigt die gepinnte Position,
             nicht die Stelle im Dokument; eine Sektion, die nur aus einem
             gepinnten Kind besteht, faellt auf ihre eigene Unterkante
             zurueck. */
          var kids = secs[j].children;
          var sContent = null;
          for (var c = 0; c < kids.length; c++) {
            var ck = kids[c];
            var cpos = window.getComputedStyle(ck).position;
            if (cpos === "sticky" || cpos === "fixed") continue;
            var ckr = ck.getBoundingClientRect();
            if (ckr.height <= 1) continue;
            var cEnd = Math.round(ckr.bottom + st);
            if (sContent === null || cEnd > sContent) sContent = cEnd;
          }
          if (sContent !== null && sContent > tops[i]) {
            if (sContent > end) end = sContent;
          } else if (sEnd > end) {
            end = sEnd;
          }
        }

        if (!lineSet[tops[i]]) { lineSet[tops[i]] = 1; lines.push(tops[i]); }

        lastPage[i] = top;
        pageEnd[i] = end;
      }

      /* Eine Kante gilt nur dann als leer, wenn dort keine Sektion mit
         Inhalt beginnt: lineSet ist dedupliziert, zwei Sektionen koennen
         also dieselbe Kante belegen - dann gewinnt der Inhalt. */
      for (var e in emptyAt) {
        if (!contentAt[e]) emptyLines[e] = 1;
      }

      /* Scroll-Grenze: die letzte Seite ist der letzte Screen des Tracks.

         Passt dessen Inhalt in einen Bildschirm (pageEnd - lastPage <=
         Fensterhoehe), dann steht der ganze Screen da, sobald seine
         Oberkante einrastet - Grenze = lastPage. Die fruehere Rechnung
         pageEnd - Fensterhoehe zog bei Sektionen mit Luft unter dem Inhalt
         (z. B. .ot-notes mit 14vh Padding) weiter nach oben: "behind the
         scenes" hing dann 118 px ueber dem Bild, der vorige Outtakes-Screen
         stand am oberen Rand und der Rahmen des Kastens lag auf der unteren
         Bildschirmkante.

         Passt der Inhalt nicht in einen Screen (z. B. eine gepinnte Buehne
         am Track-Ende), bleibt es beim Ausrichten des Inhaltsendes
         (pageEnd - Fensterhoehe): so bleibt unten nichts abgeschnitten und
         es entsteht kein Leerraum. Im letzten Track begrenzt das Dokument
         selbst. */
      for (i = 0; i < panels.length; i++) {
        if (i === panels.length - 1) {
          limits[i] = Infinity;
          continue;
        }
        if (pageEnd[i] - lastPage[i] <= vh() + 1) {
          limits[i] = lastPage[i];
        } else {
          limits[i] = pageEnd[i] - vh();
        }
        /* Nie vor den Anfang des Tracks und nie hinter das Track-Ende. */
        limits[i] = Math.max(limits[i], tops[i]);
        if (tops[i + 1] !== undefined) limits[i] = Math.min(limits[i], tops[i + 1] - 1);
      }

      /* Snap-Kanten jenseits der Grenze sind unerreichbar (die Grenze zieht
         zurueck) - sie wuerden nur gegen die Grenze ruckeln. Die Grenze
         selbst ist dagegen eine Kante: dort steht die letzte Seite. */
      var trackOf = function (y) {
        var k = 0;
        for (var n = 0; n < tops.length; n++) if (tops[n] <= y + 2) k = n;
        return k;
      };
      lines = lines.filter(function (y) {
        var k = trackOf(y);
        return limits[k] === Infinity || y <= limits[k];
      });
      for (i = 0; i < panels.length; i++) {
        if (limits[i] !== Infinity && !lineSet[limits[i]]) {
          lines.push(limits[i]);
        }
      }

      lines.sort(function (a, b) { return a - b; });
    }

    /* ---------- Ansicht / Screen ---------------------------------------- */

    /* Horizontale Verschiebung der Spur: Ansicht 0 = "none", sonst
       -i * 100vw. Die Transition auf .track animiert das Gleiten. */
    function applyPan(i) {
      var next = i <= 0 ? "none" : "translate3d(" + (-i * 100) + "vw, 0, 0)";
      if (track.style.transform !== next) track.style.transform = next;
    }

    function setActive(i) {
      if (i === current) return;
      current = i;

      panels.forEach(function (el, n) {
        el.classList.toggle("is-current", n === i);
      });

      applyPan(i);

      /* Nur die sichtbare Ansicht darf Ton haben. */
      if (window.SerumVideo) window.SerumVideo.setAudible(i === 1);
    }

    /* Welche Ansicht ist aktiv? Die, deren Oberkante als letzte ueber der
       aktuellen Scrollposition liegt. */
    function indexAt(y) {
      var k = 0;
      for (var i = 0; i < tops.length; i++) {
        if (tops[i] <= y + 2) k = i;
      }
      return k;
    }

    /* Aktiver Screen = letzte Snap-Kante ueber der Scrollposition. */
    function screenAt(y) {
      var s = lines[0];
      for (var i = 0; i < lines.length; i++) {
        if (lines[i] <= y + 2) s = lines[i];
        else break;
      }
      return s;
    }

    function syncScreen(y) {
      var s = screenAt(y);
      if (s === currentScreen) return;
      currentScreen = s;
      document.dispatchEvent(new CustomEvent("track:screen", { detail: { top: s } }));
    }

    /* ---------- Pfeile --------------------------------------------------- */

    function syncArrows(k, y) {
      var h = vh();
      var firstPage = k > 0 && y <= tops[k] + h * START_ZONE;
      /* Der WEITER-Pfeil erscheint, sobald die letzte Seite des Tracks
         erreicht ist - das ist die Scroll-Grenze dieses Tracks. */
      var lastPageReached = k < panels.length - 1 &&
                            limits[k] !== Infinity &&
                            y >= limits[k] - 1;

      if (prevBtn) {
        prevBtn.classList.toggle("is-visible", firstPage);
        prevBtn.setAttribute("aria-hidden", firstPage ? "false" : "true");
        prevBtn.tabIndex = firstPage ? 0 : -1;
      }
      if (nextBtn) {
        nextBtn.classList.toggle("is-visible", lastPageReached);
        nextBtn.setAttribute("aria-hidden", lastPageReached ? "false" : "true");
        nextBtn.tabIndex = lastPageReached ? 0 : -1;
      }
    }

    /* ---------- Wechsel --------------------------------------------------- */

    /* Wechsel in Ansicht i. "next" landet auf der ersten Seite, "prev" auf
       der letzten Seite des Ziel-Tracks. Die Scrollposition springt sofort
       (die Zielseite ist beim Sprung noch ausserhalb des Bildes), sichtbar
       gleitet nur die Spur. */
    function goTo(i, dir) {
      if (i < 0 || i >= panels.length) return;

      var target = (dir === "prev" && limits[i] !== Infinity) ? limits[i] : tops[i];

      programmaticUntil = Date.now() + PROGRAMMATIC;
      landOn(target);

      setActive(i);
      syncArrows(i, target);
      syncScreen(target);
      update();
    }

    /* Eine Screen-Kante weiter (Weiter-scrollen-Knopf am Graph-Ende).
       Leere Buehnen werden uebersprungen. Fuer das freie Scrollen bleibt
       so eine Buehne eine Kante wie jede andere - dort soll der Verlauf
       einrasten -, der Knopf soll aber auf einer Kante landen, auf der
       auch etwas zu sehen ist. Sonst steht der Klick auf einer leeren
       Flaeche und der naechste Screen beginnt erst darunter. */
    function nextScreen() {
      var y = scrollTop();
      var k = indexAt(y);
      var target = null;

      for (var i = 0; i < lines.length; i++) {
        if (lines[i] <= y + 2) continue;
        if (emptyLines[lines[i]]) continue;
        target = lines[i];
        break;
      }
      if (target === null) return;

      var lim = limits[k];
      if (lim !== Infinity && target > lim) target = lim;

      programmaticUntil = Date.now() + 1200;
      animateTo(target, 520);
    }

    /* ---------- Einrasten ------------------------------------------------ */

    function maybeSnap() {
      if (Date.now() < programmaticUntil) return;

      var y = scrollTop();
      var k = indexAt(y);
      var lim = limits[k];
      var reach = vh() * SNAP_RATIO;
      var best = null;
      var bestD = reach + 1;

      for (var i = 0; i < lines.length; i++) {
        var d = Math.abs(lines[i] - y);
        if (d <= reach && d < bestD) { bestD = d; best = lines[i]; }
      }
      if (best === null) return;

      if (lim !== Infinity && best > lim) best = lim;
      if (Math.abs(best - y) < 2) return;

      programmaticUntil = Date.now() + PROGRAMMATIC;
      animateTo(best, 320);
    }

    /* ---------- Scroll-Zustand ------------------------------------------ */

    function update() {
      rafPending = false;

      var y = scrollTop();
      var k = indexAt(y);
      var lim = limits[k];

      /* Harte Grenze am Ende eines Tracks: keine Position hinter der
         letzten Seite. Beim Hochscrollen ueber eine Track-Grenze zieht das
         auf die letzte Seite des vorigen Tracks (die Spur gleitet dabei
         nach links). Verschiebt sich die Grenze durch neue Inhaltshoehen
         (Phasen-Tab), ist das hier nur noch die Sicherheitsleine: die
         Phasen-Panels halten ihre Hoehe (js/serum-phases.js, reserveHeight),
         damit die Grenze beim Klick nicht wandert und nichts springt. */
      if (lim !== Infinity && y > lim + 0.5) {
        y = lim;
        if (window.SmoothScroll && window.SmoothScroll.enabled) {
          window.SmoothScroll.to(Math.round(lim), { immediate: true });
        } else {
          try {
            window.scrollTo({ top: Math.round(lim), behavior: "auto" });
          } catch (e) {
            window.scrollTo(0, Math.round(lim));
          }
        }
        /* Das Zurueckziehen an die Grenze ist ein Sprung, kein Scrollen
           des Nutzers (siehe announceJump oben). */
        announceJump(lim);
      }

      setActive(k);
      syncArrows(k, y);
      syncScreen(y);
    }

    function schedule() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(update);
    }

    function onScroll() {
      schedule();
      clearTimeout(snapTimer);
      snapTimer = setTimeout(maybeSnap, SNAP_IDLE);
    }

    /* Mausrad am Track-Ende abfangen: sonst wuerde der Browser weiter-
       scrollen und die Position erst im naechsten Frame zurueckziehen. */
    function onWheel(e) {
      if (e.defaultPrevented || e.ctrlKey) return;
      /* Eigene Snap-Animation hat Vorrang: sie laeuft nur wenige
         hundert Millisekunden und wird vom naechsten Rad-Ereignis
         abgebrochen, damit der Nutzer sofort wieder die Kontrolle hat. */
      cancelScrollAnim();
      var y = scrollTop();
      var k = indexAt(y);
      var lim = limits[k];
      if (lim === Infinity) return;
      if (e.deltaY > 0 && y >= lim - 1) {
        /* Mit Lenis gibt es kein zweites preventDefault: die Scroll-Schicht
           hat das Rad-Ereignis bereits virtualisiert. Stattdessen wird die
           Position aktiv an der Track-Grenze festgehalten. */
        if (window.SmoothScroll && window.SmoothScroll.enabled) {
          window.SmoothScroll.to(lim, { immediate: true });
        } else {
          e.preventDefault();
        }
        syncArrows(k, y);
      }
    }

    /* Tief-Links (#serum, #curtain-view, ...) sollen weiter funktionieren. */
    function jumpForHash() {
      var hash = window.location.hash;
      if (!hash || hash.length < 2) return;
      var target = document.getElementById(hash.slice(1));
      if (!target) return;
      var y = Math.max(0, Math.round(target.getBoundingClientRect().top + scrollTop()));
      if (window.SmoothScroll && window.SmoothScroll.enabled) {
        window.SmoothScroll.to(y, { immediate: true });
      } else {
        window.scrollTo(0, y);
      }
      announceJump(y);
    }

    /* ---------- Verdrahtung --------------------------------------------- */

    if (prevBtn) prevBtn.addEventListener("click", function () {
      goTo(indexAt(scrollTop()) - 1, "prev");
    });
    if (nextBtn) nextBtn.addEventListener("click", function () {
      goTo(indexAt(scrollTop()) + 1, "next");
    });

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: false });
    /* Auch Touch, Tastatur und Klicks uebernehmen sofort die Kontrolle:
       eine laufende Einrast-Animation wird abgebrochen. */
    ["touchstart", "pointerdown", "keydown"].forEach(function (evt) {
      window.addEventListener(evt, cancelScrollAnim, { passive: true });
    });

    window.addEventListener("resize", function () {
      measure();
      schedule();
    });

    window.addEventListener("load", function () {
      measure();
      schedule();
    });

    window.addEventListener("hashchange", function () {
      measure();
      jumpForHash();
      schedule();
    });

    if ("ResizeObserver" in window) {
      var ro = new ResizeObserver(function () {
        measure();
        schedule();
      });
      panels.forEach(function (el) { ro.observe(el); });
    }

    /* Pfeiltasten: eine Ansicht weiter (wie die Pfeil-Knoepfe). */
    window.addEventListener("keydown", function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      var t = e.target;
      if (t && t.matches && (t.matches("input, textarea, select") || t.isContentEditable)) return;
      /* Regler (z. B. die Fortschrittsleiste des Soundtracks) bedienen
         sich mit den Pfeiltasten selbst. */
      if (t && t.closest && t.closest('[role="slider"]')) return;
      var k = indexAt(scrollTop());
      if (e.key === "ArrowRight") {
        if (k + 1 >= panels.length) return;
        e.preventDefault();
        goTo(k + 1, "next");
      } else {
        if (k <= 0) return;
        e.preventDefault();
        goTo(k - 1, "prev");
      }
    });

    /* ---------- Start ---------------------------------------------------- */

    measure();
    jumpForHash();

    /* Beim Laden (auch mit wiederhergestellter Scrollposition) soll die
       Spur sofort stehen und nicht erst hereingleiten. */
    track.style.transition = "none";
    syncScreen(scrollTop());
    update();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { track.style.transition = ""; });
    });

    var api = {
      goTo: goTo,
      nextScreen: nextScreen,
      get index() { return current; },
      get tops() { return tops.slice(); },
      get lastPage() { return lastPage.slice(); },
      get limits() { return limits.slice(); },
      get screenTop() { return currentScreen; }
    };

    window.TurnTrack.instance = api;

    try {
      Object.defineProperty(window.TurnTrack, "index", {
        get: function () { return current; }, configurable: true
      });
      /* Reste der alten Schwenk-Mechanik: js/script.js und js/curtain.js
         lesen sie als Versatz. Ohne Schwenk sind sie 0. */
      Object.defineProperty(window.TurnTrack, "pan", {
        get: function () { return 0; }, configurable: true
      });
      Object.defineProperty(window.TurnTrack, "hold", {
        get: function () { return 0; }, configurable: true
      });
    } catch (e) {}

    return api;
  }

  window.TurnTrack = { init: init };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();