"use strict";
// Freaky Tiki browser client: a screen, not a referee. It sends joins/moves
// and draws whatever view the server sends. Playing hands are BLIND - even
// yours - so the server only ever sends counts for them. Stacking hands and
// the middle stack are face up and public.
const $ = (id) => document.getElementById(id);
let ws = null;
let myName = null;
let practice = null;          // the running practice room, or null
let lastLobbyView = null;     // newest lobby view from the real server

function log(line) { try { console.debug("[freaky-tiki]", line); } catch (e) { /* no console */ } }
// Messages show ON the table once you are in a room (a toast that fades),
// and under the form on the join screen before that.
let errorTimer = null;
// Touch devices tap, everything else clicks - word the hints to match.
const touchLike = () => (window.matchMedia
  ? matchMedia("(pointer: coarse)").matches   // the primary input is a finger
  : "ontouchstart" in window);
const shedVerb = () => (touchLike() ? "Tap" : "Click");
const rankLabel = (card) => (card ? (card.startsWith("joker") ? "Joker" : card.split("_of_")[0]) : "?");
const VAR_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
function cardRankGap(a, b) {
  if (!a || !b || a.startsWith("joker") || b.startsWith("joker")) return null;
  const va = VAR_RANKS.indexOf(a.split("_of_")[0]);
  const vb = VAR_RANKS.indexOf(b.split("_of_")[0]);
  if (va < 0 || vb < 0) return null;
  const d = Math.abs(va - vb);
  return Math.min(d, 13 - d);
}

function showError(text, sticky) {
  const inGame = !$("game-box").hidden;
  $("join-error").textContent = inGame ? "" : (text || "");
  $("error").textContent = inGame ? (text || "") : "";
  clearTimeout(errorTimer);
  if (text && inGame && !sticky) errorTimer = setTimeout(() => { $("error").textContent = ""; }, 5200);
}
const CARD_V = "?v=2";
const cardSrc = (name) => "/assets/cards/" + name + ".png" + CARD_V;
function cardImg(name, onClick, cls) {
  const img = document.createElement("img");
  img.src = cardSrc(name);
  img.alt = name; img.title = name;
  if (cls) img.className = cls;
  if (onClick) img.addEventListener("click", onClick);
  return img;
}
// A keycap for a keyboard hint: digits get a narrow, tall tile; words
// (SPACE) get a wider one. The text is the bare key name.
function keyHint(label) {
  const h = document.createElement("span");
  h.className = "key-hint " + (/^[0-9A-Za-z]$/.test(label) ? "key-num" : "key-wide");
  h.textContent = label;
  return h;
}
// Number-key stacking: every face-up stacking card gets a key ([1], [2], …
// counting from your own hand first, then counterclockwise around the
// table). stackKeys maps
// the key label to the move target; rebuilt on every render.
let stackKeys = {};
// ------------------------------------------------------------ hold-to-grab
// Lifting a card is a HOLD, never a click. Hold a stacking card (or its
// number key) - or your playing pile (or the P key) - for a beat (0.1s) and
// the card lifts. KEEP holding to keep it: let go of the key or the pointer
// and it drops straight back where it was. To put it down on the middle,
// press SPACE (or let go of the pointer over the middle stack). A plain
// click or tap does nothing, so every play and stack is deliberate.
const HOLD_MS = 0;
const GRAB_LIMIT_MS = 5000;   // stacking cards only: the server frees a grabbed card after 5s
let grab = null;          // {kind:"stack", owner, slot, card, since} | {kind:"play", since}
let grabClone = null;     // the card image following the pointer (mouse/touch grabs)
let grabKey = null;       // the keyboard key that is holding the card, if any
let keyHoldTimer = null, keyHoldTarget = null;
let renderedAt = 0;
const PLAY_KEY = "play|me";
const grabKeyOf = (g) => (g.kind === "play" ? PLAY_KEY : g.owner + "|" + g.slot);
const GRAB_PHASES = ["open", "stacked", "stacker_start", "freaky"];
// Other players' grabs from the view. My own grab is tracked locally (and
// instantly): the echo of it from the server must never keep a slot looking
// "held" after I have let go.
function otherGrabs(view) {
  const out = {};
  for (const [g, gr] of Object.entries((view && view.grabs) || {})) if (g !== myName) out[g] = gr;
  return out;
}

let currentPlayerColors = {};
let preferredColor = 0;
try {
  const savedCol = localStorage.getItem("ft_pref_color");
  if (savedCol !== null && !Number.isNaN(Number(savedCol))) {
    preferredColor = ((Number(savedCol) % 8) + 8) % 8;
  }
} catch (e) { /* private mode */ }
function playerIndex(player, playersList) {
  if (player && Object.prototype.hasOwnProperty.call(currentPlayerColors, player)) {
    const c = Number(currentPlayerColors[player]);
    if (!Number.isNaN(c)) return ((c % 8) + 8) % 8;
  }
  if (player && player === myName) return preferredColor;
  const list = playersList || [];
  const i = list.indexOf(player);
  if (i < 0) return 0;
  if (myName && list.includes(myName)) {
    const others = list.filter((p) => p !== myName);
    const oIdx = others.indexOf(player);
    const avail = [0, 1, 2, 3, 4, 5, 6, 7].filter((c) => c !== preferredColor);
    if (oIdx >= 0 && oIdx < avail.length) return avail[oIdx];
  }
  return ((i % 8) + 8) % 8;
}
function handSrc(player, playersList) {
  // The grabbing hand is a sprite in the grabber's own colourway.
  return "/assets/hand_" + playerIndex(player, playersList) + ".png";
}
const GRAB_COLORS = ["#F4B942", "#FF69B4", "#00E5FF", "#BEF264", "#C8A2FF", "#FF7043", "#78FFEB", "#FFF082"];

// A grabbed card exists in exactly ONE place on the screen: floating.
// Its slot keeps only a dashed ghost outline, and the floating card -
// the real card image, lifted and bobbing, wearing the grabber's hand -
// is what every player sees. Floats are reconciled on every render, and
// the warning shake lands on the float as the grab runs out of time.
const grabFloats = new Map();   // "owner|slot" (or PLAY_KEY) -> floating card element
function slotWrapEl(owner, slot) {
  const seat = seatEl(owner);
  if (!seat) return null;
  return seat.querySelectorAll(".backs > *")[slot] || null;
}
function positionFloat(key, el) {
  let wrap;
  if (key.startsWith("play|")) {   // a lifted playing card hovers over its owner's pile
    const seat = seatEl(key === PLAY_KEY ? myName : key.slice(5));
    wrap = seat && (seat.querySelector(".pilewrap img") || seat.querySelector(".pilewrap"));
  } else {
    const [owner, slot] = key.split("|");
    wrap = slotWrapEl(owner, Number(slot));
  }
  if (!wrap) return false;
  const r = wrap.getBoundingClientRect();
  // Centre the float on the slot, at the card's true size: offsetWidth is
  // the unrotated layout width (a rotated seat's bounding box transposes
  // width/height and would stretch the card), and cards are 128x176.
  const w = wrap.offsetWidth || r.width;
  const h = w * (176 / 128);
  el.style.width = w + "px";
  el.style.left = (r.left + r.width / 2 - w / 2) + "px";
  el.style.top = (r.top + r.height / 2 - h / 2 - 12) + "px";
  return true;
}
function makeFloat(key, grabber, card, playersList) {
  const el = document.createElement("div");
  el.className = "grab-float";
  el.dataset.grabber = grabber;
  const im = document.createElement("img");
  im.className = "grab-float-card";
  im.src = cardSrc(card);
  im.alt = card.replace(/_/g, " ");
  im.style.outlineColor = GRAB_COLORS[playerIndex(grabber, playersList)];
  const badge = document.createElement("img");
  badge.className = "hand-badge";
  badge.src = handSrc(grabber, playersList);
  badge.alt = "";
  el.append(im, badge);
  fxLayer().append(el);
  grabFloats.set(key, el);
  return el;
}
function removeFloat(key) {
  const el = grabFloats.get(key);
  if (el) { el.remove(); grabFloats.delete(key); }
}
function syncGrabFloats(view) {
  const playersList = view && view.playing_counts ? Object.keys(view.playing_counts) : [];
  const wanted = new Map();
  for (const [g, gr] of Object.entries(otherGrabs(view)))
    wanted.set(gr.slot === -1 ? "play|" + g : gr.owner + "|" + gr.slot,
               { grabber: g, card: gr.card });
  if (grab) wanted.set(grabKeyOf(grab),
    { grabber: myName, card: grab.kind === "play" ? "card_back" : grab.card });
  for (const key of wanted.keys()) {
    if (key.startsWith("play|")) continue;   // piles show the lift themselves
    const [o, sl] = key.split("|");
    const w = slotWrapEl(o, Number(sl));
    if (w) w.classList.add("grabbed-slot");
  }
  for (const [key, w] of wanted) {
    if (w.grabber === myName && grabClone) { removeFloat(key); continue; }  // my drag clone IS the one instance
    let el = grabFloats.get(key);
    if (!el) el = makeFloat(key, w.grabber, w.card, playersList);
    else {
      const im = el.querySelector(".grab-float-card");
      if (w.card && !im.src.includes("/" + w.card + ".png")) im.src = cardSrc(w.card);
      if (el.dataset.grabber !== w.grabber) {
        el.dataset.grabber = w.grabber;
        el.querySelector(".hand-badge").src = handSrc(w.grabber, playersList);
        im.style.outlineColor = GRAB_COLORS[playerIndex(w.grabber, playersList)];
      }
    }
    if (!positionFloat(key, el)) removeFloat(key);
  }
  for (const key of [...grabFloats.keys()]) if (!wanted.has(key)) removeFloat(key);
}

// Redraw the table from the newest view: whatever a cancelled grab left
// half-hidden (a slot ghost, a hidden card image) comes straight back.
function refreshTable() {
  if (practice) { practiceRender(); return; }
  if (prevView && prevView.started) render(prevView, true);
}
// target: {kind:"stack", owner, slot} or {kind:"play"}; viaKey: the keyboard
// key doing the holding (letting go of it puts the card back).
let dealingUntil = 0;
let playLockedUntil = 0;
let dealReveal = { pilesAt: {}, slotsAt: {} };
function isPileHiddenMidDeal(view, player) {
  if (view && view.tut_dealing) return true;
  const now = Date.now();
  return now < dealingUntil && now < (dealReveal.pilesAt[player] || dealingUntil);
}
function isSlotHiddenMidDeal(view, player, slot) {
  if (view && view.tut_dealing) return true;
  const now = Date.now();
  return now < dealingUntil && now < (dealReveal.slotsAt[player + "|" + slot] || dealingUntil);
}
let lastPlaySentAt = 0;
const PLAY_COOLDOWN_MS = 650;
let tutReloading = false;
let cooldownTrack = { stackSeq: null, stackStartAt: 0, paceKey: null, paceStartAt: 0 };
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (typeof stopFreakyThudLoop === "function") stopFreakyThudLoop();
    if (typeof stopEndScreenSfx === "function") stopEndScreenSfx();
    return;
  }
  const fx = $("fx");
  if (fx) {
    if (fx.getAnimations) fx.getAnimations({ subtree: true }).forEach((a) => { try { a.cancel(); } catch (e) {} });
    fx.innerHTML = "";
  }
  const ov = $("big-overlay");
  if (ov) ov.hidden = true;
  if (typeof clearTimeout === "function" && typeof midHoldTimer !== "undefined") clearTimeout(midHoldTimer);
  if (typeof midHold !== "undefined") { midHold = null; midHoldTimer = null; }
  dealingUntil = 0;
  playLockedUntil = 0;
  refreshTable();
});
function isFinishedPlayer() {
  const v = (practice && practice.game) ? practiceView() : prevView;
  return !!(v && Array.isArray(v.finished) && myName && v.finished.includes(myName));
}
function canPlayNow() {
  if (isFinishedPlayer()) return false;
  const now = Date.now();
  if (now < dealingUntil || now < playLockedUntil) return false;
  if (now - lastPlaySentAt < PLAY_COOLDOWN_MS) return false;
  if (practice && practice.kind === "tutorial" && practice.tut) {
    const t = practice.tut, step = TUT_STEPS[t.step];
    if (t.dealing || t.done || t.retry || t.phase === "intro" || (step && step.info) || (t.step === 0 && !t.dealt)) return false;
  } else if (practice && practice.kind !== "solo" && practice.done) {
    return false;
  }
  return true;
}
function practiceAllowedMove(move) {
  if (!practice || practice.kind === "tutorial" || practice.kind === "solo") return true;
  if (practice.done) return false;
  if (!move) return false;
  switch (practice.kind) {
    case "turns": return move.type === "play";
    case "stack": return move.type === "stack";
    case "freaky": return move.type === "play" || move.type === "freaky";
    case "slap": return move.type === "slap_press" || move.type === "slap_choose";
    default: return true;
  }
}
function tutAllowedMove(move) {
  if (!practice || practice.kind !== "tutorial" || !practice.tut) return true;
  const t = practice.tut, g = practice.game, me = myName;
  if (t.dealing || t.done || t.retry || t.phase === "intro") return false;
  if (!move) return false;
  const top = g.middle.length ? g.middle[g.middle.length - 1] : null;
  switch (t.step) {
    case 2: return move.type === "play";
    case 3: {
      if (move.type !== "stack" || move.owner !== me) return false;
      const c = g.stacking[me] && g.stacking[me][move.slot];
      return !!(c && top && pWithin(c, top));
    }
    case 4: return move.type === "stack" && move.owner === me;
    case 5: {
      if (move.type !== "stack" || move.owner !== P_BOTS[0]) return false;
      const c = g.stacking[P_BOTS[0]] && g.stacking[P_BOTS[0]][move.slot];
      return !!(c && top && pWithin(c, top));
    }
    case 6: return g.phase === "freaky" ? move.type === "freaky" : move.type === "play";
    case 7: return g.phase === "freaky" && move.type === "shed";
    case 8:
      if (g.phase === "joker") return move.type === "slap_press";
      if (g.phase === "joker_choose") return move.type === "slap_choose";
      return false;
    case 9:
      if (g.phase === "joker") return move.type === "slap_press";
      if (g.phase === "joker_choose") return move.type === "slap_choose";
      if (move.type !== "stack" || move.owner !== me) return false;
      return pIsJoker(g.stacking[me] && g.stacking[me][move.slot]);
    case 10: {
      if (move.type !== "stack" || move.owner !== me) return false;
      const c = g.stacking[me] && g.stacking[me][move.slot];
      return !!(c && top && pWithin(c, top));
    }
    default: return false;
  }
}
function tutAllowedGrab(target) {
  if (!practice) return true;
  if (!target) return false;
  const mv = target.kind === "play" ? { type: "play" } : { type: "stack", owner: target.owner, slot: target.slot };
  if (practice.kind === "tutorial") return tutAllowedMove(mv);
  return practiceAllowedMove(mv);
}
function activateGrab(target, viaKey) {
  const v = prevView;
  if (!v || !v.started || !GRAB_PHASES.includes(v.phase) || !canPlayNow()) return;
  if (!tutAllowedGrab(target)) { showError(practice && practice.kind === "tutorial" ? "Follow the current tutorial step!" : "Focus on this practice drill's skill!"); return; }
  if (target.kind === "play") {
    if (!(v.your_playing_count > 0)) return;
    if (v.phase === "freaky") {
      showError("Finish the Freaky Tiki before playing from your pile.");
      return;
    }
    if (v.phase === "open" && v.turn_player && v.turn_player !== myName) {
      showError("It is not your turn.");
      return;
    }
    if (v.phase === "stacked") {
      showError((v.stackers || []).includes(myName)
        ? "Wait for play cooldown"
        : "Only a player who stacked can start the next turn.");
      return;
    }
    if (v.phase === "stacker_start" && !(v.stackers || []).includes(myName)) {
      showError("Only a player who stacked can start the next turn.");
      return;
    }
    cancelGrab({ refresh: false });
    grab = { kind: "play", since: Date.now(), card: "card_back" };
    grabKey = viaKey || null;
    // Tell the table: the card is in my hand now. It floats over my pile
    // on every screen, and my pile count drops by one while I hold it.
    send({ type: "grab", owner: myName, slot: -1 });
    const pw = seatEl(myName) && seatEl(myName).querySelector(".pilewrap");
    if (pw) {
      const wasLifted = pw.classList.contains("pile-lifted");
      pw.classList.add("pile-lifted");
      const b = pw.querySelector(".pile-count");
      const baseCount = (v.playing_counts && v.playing_counts[myName] != null)
        ? v.playing_counts[myName] : (v.your_playing_count || 0);
      if (b && !wasLifted) { b.textContent = Math.max(0, baseCount - 1); b.classList.add("lifted"); }
    }
    syncGrabFloats(v);
    playCardLiftSfx();
    vibrate(12);
    return;
  }
  // Someone else is already holding that card: hands off entirely.
  if (Object.values(otherGrabs(v)).some((x) => x.owner === target.owner && x.slot === target.slot)) return;
  cancelGrab({ refresh: false });
  grab = { kind: "stack", owner: target.owner, slot: target.slot, since: Date.now(),
           card: v.stacking_hands && v.stacking_hands[target.owner]
             ? v.stacking_hands[target.owner][target.slot] : null };
  grabKey = viaKey || null;
  // Tell the table: the card is in MY hand now - it floats on every screen
  // and nobody else can take it (for up to 5 seconds).
  send({ type: "grab", owner: grab.owner, slot: grab.slot });
  // The original leaves its slot at once: the floating card (or, when
  // dragging, the clone under my pointer) is the only copy on screen.
  const w = slotWrapEl(target.owner, target.slot);
  if (w) {
    w.classList.add("grabbed-slot");
    const im = w.querySelector("img");
    if (im) im.style.visibility = "hidden";   // until the next render makes it a ghost
  }
  syncGrabFloats(v);
  playCardLiftSfx();
  vibrate(12);
}
// Put the lifted card back (key released, pointer let go away from the
// middle, Esc, window blur, time up, or the card moved under me).
function cancelGrab(opts) {
  const had = grab;
  if ($("ring")) $("ring").classList.remove("circle-hover");
  if (grab) {
    removeFloat(grabKeyOf(grab));
    if (grab.kind === "stack") {
      const w = slotWrapEl(grab.owner, grab.slot);
      if (w) w.classList.remove("grabbed-slot");
    }
  }
  grab = null; grabKey = null;
  if (grabClone) { grabClone.remove(); grabClone = null; }
  if (had) send({ type: "release_grab" });
  if (had && !(opts && opts.refresh === false)) refreshTable();
}
function commitGrab() {
  const g = grab;
  if (!g) return;
  const midTop = prevView && prevView.middle_top;
  if (g.kind === "stack" && !midTop && (!g.card || !pIsJoker(g.card))) {
    cancelGrab();
    showError("Cannot stack a non-Joker card on an empty table.");
    return;
  }
  cancelGrab({ refresh: false });
  if (g.kind === "play") {
    playSfx("flip");
    vibrate(18);
    lastLocalSfx = { name: "flip", at: Date.now() };
    send({ type: "move", move: { type: "play" } });
  } else {
    if (midTop && g.card && pWithin(g.card, midTop)) {
      playSfx("stack");
      vibrate([22, 24, 28]);
      lastLocalVibAt = Date.now();
      lastLocalSfx = { name: "stack", at: Date.now() };
    }
    send({ type: "move", move: { type: "stack", owner: g.owner, slot: g.slot } });
  }
  // If the server turns the move down (an error, no new view), the card must
  // not stay missing: redraw unless a fresh view arrived meanwhile.
  const t0 = Date.now();
  setTimeout(() => { if (renderedAt < t0) refreshTable(); }, 800);
}
function overMiddle(x, y) {
  const ring = $("ring");
  if (ring) {
    const rr = ring.getBoundingClientRect();
    const rad = Math.min(window.innerWidth * 0.34, 250) / 2;
    const cx = rr.left + rr.width / 2;
    const cy = rr.top + rr.height / 2;
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy <= rad * rad) return true;
  }
  const c = $("table-center");
  if (!c) return false;
  const b = c.getBoundingClientRect();
  return x >= b.left - 24 && x <= b.right + 24 && y >= b.top - 24 && y <= b.bottom + 24;
}
const sameTarget = (g, t) => !!g && g.kind === t.kind
  && (t.kind === "play" || (g.owner === t.owner && g.slot === t.slot));
// Pointer holds (mouse or touch): hold the card for a beat to lift it, drag
// it, and let go over the middle to put it down - let go anywhere else and
// it goes back. Used for stacking cards and for your own playing pile.
let lastPointerTap = { key: null, at: 0 };
let lastKeyTap = { key: null, at: 0 };
const DOUBLE_TAP_MS = 360;
function doubleTapEnabled() { return !!(prevView && prevView.double_tap_play); }
function quickPlayTarget(target) {
  const v = prevView;
  if (!v || !v.started || !GRAB_PHASES.includes(v.phase) || !canPlayNow()) return;
  if (!tutAllowedGrab(target)) { showError(practice && practice.kind === "tutorial" ? "Follow the current tutorial step!" : "Focus on this practice drill's skill!"); return; }
  if (target.kind === "play") {
    if (!(v.your_playing_count > 0)) return;
    if (v.phase === "freaky") { showError("Finish the Freaky Tiki before playing from your pile."); return; }
    if (v.phase === "open" && v.turn_player && v.turn_player !== myName) { showError("It is not your turn."); return; }
    if (v.phase === "stacked") {
      showError((v.stackers || []).includes(myName) ? "Wait for play cooldown" : "Only a player who stacked can start the next turn.");
      return;
    }
    if (v.phase === "stacker_start" && !(v.stackers || []).includes(myName)) {
      showError("Only a player who stacked can start the next turn.");
      return;
    }
    cancelGrab({ refresh: false });
    playSfx("flip");
    vibrate(18);
    lastLocalSfx = { name: "flip", at: Date.now() };
    lastPlaySentAt = Date.now();
    send({ type: "move", move: { type: "play" } });
    return;
  }
  if (Object.values(otherGrabs(v)).some((x) => x.owner === target.owner && x.slot === target.slot)) return;
  const card = v.stacking_hands && v.stacking_hands[target.owner] ? v.stacking_hands[target.owner][target.slot] : null;
  if (!card) return;
  const midTop = v.middle_top;
  if (!midTop && !pIsJoker(card)) { showError("Cannot stack a non-Joker card on an empty table."); return; }
  cancelGrab({ refresh: false });
  if (midTop && pWithin(card, midTop)) {
    playSfx("stack");
    vibrate([22, 24, 28]);
    lastLocalVibAt = Date.now();
    lastLocalSfx = { name: "stack", at: Date.now() };
  }
  send({ type: "move", move: { type: "stack", owner: target.owner, slot: target.slot } });
}
function attachHold(el, target, title) {
  el.classList.add("stackable");
  el.title = title;
  el.addEventListener("pointerdown", (e) => {
    if (e.button > 0 || !canPlayNow()) return;
    e.preventDefault();
    if (doubleTapEnabled()) {
      const tKey = target.kind === "play" ? "play" : (target.owner + "|" + target.slot);
      const nowMs = Date.now();
      if (lastPointerTap.key === tKey && nowMs - lastPointerTap.at <= DOUBLE_TAP_MS) {
        lastPointerTap = { key: null, at: 0 };
        quickPlayTarget(target);
        return;
      }
      lastPointerTap = { key: tKey, at: nowMs };
    }
    let dragClone = null;
    const r = el.getBoundingClientRect();
    activateGrab(target);
    if (sameTarget(grab, target)) {
      dragClone = document.createElement("div");
      dragClone.className = "fly grab-clone";
      dragClone._born = Date.now();
      const cim = document.createElement("img");
      cim.src = el.src; cim.alt = "";
      cim.style.width = r.width + "px"; cim.style.display = "block";
      const cbadge = document.createElement("img");
      cbadge.className = "hand-badge";
      const curView = (practice && practice.game) ? practiceView() : prevView;
      const plist = curView && curView.playing_counts ? Object.keys(curView.playing_counts) : [];
      cbadge.src = handSrc(myName, plist);
      cbadge.alt = "";
      dragClone.style.outlineColor = GRAB_COLORS[playerIndex(myName, plist)];
      dragClone.append(cim, cbadge);
      dragClone.style.left = r.left + "px"; dragClone.style.top = r.top + "px";
      fxLayer().append(dragClone);
      grabClone = dragClone;
      removeFloat(grabKeyOf(grab));   // the clone under my pointer is now the one instance
    }
    const move = (ev) => {
      if (dragClone) {
        dragClone.style.left = (ev.clientX - dragClone.offsetWidth / 2) + "px";
        dragClone.style.top = (ev.clientY - dragClone.offsetHeight / 2) + "px";
        if ($("ring") && ev.clientX != null) $("ring").classList.toggle("circle-hover", overMiddle(ev.clientX, ev.clientY));
      }
    };
    const up = (ev) => {
      if ($("ring")) $("ring").classList.remove("circle-hover");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (dragClone) {
        dragClone.remove();
        if (grabClone === dragClone) grabClone = null;
        dragClone = null;
        if (sameTarget(grab, target) && ev.type === "pointerup"
            && ev.clientX != null && overMiddle(ev.clientX, ev.clientY)) commitGrab();
        else cancelGrab();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
}

function stackingRow(view, player, hints) {
  // Stacking cards are grabbed: hold one (or its number key) to pick it up.
  const row = document.createElement("div");
  row.className = "backs";
  const vg = otherGrabs(view);
  view.stacking_hands[player].forEach((name, slot) => {
    const held = name && (Object.values(vg).some((x) => x.owner === player && x.slot === slot)
      || (grab && grab.kind === "stack" && grab.owner === player && grab.slot === slot));
    if (held) {
      // The card itself is floating in the grabber's hand - the slot
      // keeps only a dashed ghost, so the card exists exactly once.
      const wrap = document.createElement("span");
      wrap.className = "stack-wrap grabbed-slot";
      row.append(wrap);
    } else if (name) {
      const isMidDeal = isSlotHiddenMidDeal(view, player, slot);
      const wrap = document.createElement("span");
      wrap.className = "stack-wrap" + (isMidDeal ? " empty-slot-box" : "");
      const im = cardImg(name, null, "stacking");
      im.dataset.slot = slot;
      if (isMidDeal) im.style.visibility = "hidden";
      if (!Array.isArray(view.finished) || !view.finished.includes(myName)) {
        attachHold(im, { kind: "stack", owner: player, slot }, "Hold to lift it (keep holding), then press SPACE or let go over the middle");
      }
      wrap.append(im);
      const label = hints && hints.get(player + "|" + slot);
      if (label) {
        wrap.append(keyHint(label));
      }
      row.append(wrap);
    } else {
      const s = document.createElement("span");
      s.className = "stack-wrap empty-slot-box";
      s.dataset.slot = slot;
      row.append(s);
    }
  });
  return row;
}

// ------------------------------------------------------------ animations
let prevView = null;
let fastBotsAnim = false;
let midHold = null, midHoldTimer = null;
const MID_HOLD_MS = 660;
function midHoldActive() { return !!midHold && Date.now() < midHold.until; }
function releaseMidHold() {
  midHold = null; midHoldTimer = null;
  const el = document.querySelector("#table-center .middle-top");
  const v = prevView;
  if (el && v && v.middle_top) { el.src = cardSrc(v.middle_top); el.alt = el.title = v.middle_top; }
}
function startMidHold(prevTop) {
  const holdMs = fastBotsAnim ? 150 : MID_HOLD_MS;
  midHold = { card: midHoldActive() ? midHold.card : prevTop, until: Date.now() + holdMs };
  clearTimeout(midHoldTimer);
  midHoldTimer = setTimeout(releaseMidHold, holdMs + 10);
}
const reduceMotion = false;

function rectOf(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
}
function cardRectOf(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width) return null;
  const w = el.offsetWidth || r.width;
  const h = el.offsetHeight || r.height;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const sc = el.closest && el.closest(".seat-cards");
  const rot = sc && sc.dataset.rot ? Number(sc.dataset.rot) : 0;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rot };
}
function snapshotRects() {
  const gw = giveawayFloatEl && giveawayFloatEl.querySelector(".middle-top");
  const dc = giveawayDrag && giveawayDrag.clone && giveawayDrag.clone.querySelector(".middle-top");
  const s = {
    piles: {}, slots: {}, sheds: {},
    giveaway: rectOf(dc || gw),
    center: rectOf(document.querySelector("#table-center .middle-top") || document.querySelector("#table-center img") || dc || gw),
  };
  document.querySelectorAll(".seat").forEach((seat) => {
    const p = seat.dataset.player;
    s.piles[p] = cardRectOf(seat.querySelector(".seat-pile"));
    s.slots[p] = [...seat.querySelectorAll(".backs > *")].map((el) => cardRectOf(el.querySelector("img") || el));
    const sh = seat.querySelector(".shed-pile");
    s.sheds[p] = cardRectOf(sh ? sh.querySelector("img") : null);
  });
  const zoneImg = document.querySelector("#shed-zone img");
  if (zoneImg && myName && cardRectOf(zoneImg)) s.sheds[myName] = cardRectOf(zoneImg);
  return s;
}
function fxLayer() {
  let l = document.getElementById("fx");
  if (!l) { l = document.createElement("div"); l.id = "fx"; document.body.append(l); }
  return l;
}
function flyCard(from, to, cardName, opts = {}) {
  if (!from || !to || reduceMotion) return;
  const spdScale = fastBotsAnim ? 0.28 : 1;
  const delay = Math.round((opts.delay || 0) * spdScale);
  const dur = Math.max(120, Math.round((opts.duration || (opts.spin ? 980 : 650)) * spdScale));
  const wrap = document.createElement("div");
  wrap.className = "fly";
  wrap._born = Date.now();
  const img = document.createElement("img");
  img.src = cardSrc(opts.flip ? "card_back" : cardName);
  img.style.cssText = "width:100%;height:100%;display:block;border-radius:inherit;object-fit:contain;";
  wrap.append(img);
  if (opts.hideEl) opts.hideEl.style.visibility = "hidden";
  if (opts.hideAlso) opts.hideAlso.style.visibility = "hidden";
  const fw = from.w || 48, fh = from.h || Math.round(fw * (88 / 64));
  const tw = to.w || fw, th = to.h || Math.round(tw * (88 / 64));
  const rot = opts.flip ? 0 : (Math.random() * 10 - 5);
  const fromRot = from.rot || 0;
  const baseToRot = to.rot !== undefined ? to.rot : rot;
  const deltaRot = ((baseToRot - fromRot + 540) % 360) - 180;
  const toRot = fromRot + deltaRot;
  wrap.style.left = from.x + "px"; wrap.style.top = from.y + "px";
  wrap.style.width = fw + "px"; wrap.style.height = fh + "px";
  wrap.style.transform = `rotate(${fromRot}deg)`;
  if (delay > 0) {
    wrap.style.visibility = "hidden";
    setTimeout(() => { if (wrap.isConnected) wrap.style.visibility = ""; }, delay);
  }
  fxLayer().append(wrap);
  const anim = wrap.animate([
    { left: from.x + "px", top: from.y + "px", width: fw + "px", height: fh + "px", transform: `rotate(${fromRot}deg)` },
    { left: to.x + "px", top: to.y + "px", width: tw + "px", height: th + "px", transform: `rotate(${toRot}deg)` },
  ], { duration: dur, delay, easing: "cubic-bezier(.22,.68,.3,1)", fill: "forwards" });
  if (opts.flip) {
    const midOp = opts.semiTransparent ? 0.65 : 1;
    img.animate([
      { transform: "scaleX(1)", opacity: opts.semiTransparent ? 0.85 : 1 },
      { transform: "scaleX(0)", opacity: midOp, offset: .5 },
      { transform: "scaleX(1)", opacity: 1 }
    ], { duration: dur, delay, easing: "ease-in-out" });
    setTimeout(() => { img.src = cardSrc(cardName); }, delay + Math.round(dur * 0.5));
  }
  anim.onfinish = () => wrap.remove();
  setTimeout(() => wrap.remove(), delay + dur + 350);
  if (opts.hideEl) setTimeout(() => {
    opts.hideEl.style.visibility = "";
    if (opts.hideEl.parentElement) {
      opts.hideEl.parentElement.classList.remove("empty-slot-box");
      const kh = opts.hideEl.parentElement.querySelector(".key-hint");
      if (kh) kh.style.visibility = "";
    }
  }, delay + dur + 10);
  if (opts.hideAlso) setTimeout(() => { opts.hideAlso.style.visibility = ""; }, delay + dur + 10);
}
function flyStack(from, to, topCard, n, hideEl) {
  const k = Math.max(1, Math.min(n || 1, 5));
  for (let i = k - 1; i >= 0; i--)
    flyCard({ x: from.x + i * 3, y: from.y - i * 3, w: from.w, h: from.h }, to,
            i === 0 ? (topCard || "card_back") : "card_back",
            { delay: (k - 1 - i) * 45, hideEl: i === 0 ? hideEl : null });
}
function seatEl(player) {
  return [...document.querySelectorAll(".seat")].find((s) => s.dataset.player === player) || null;
}
function slotImgEl(owner, slot) {
  const seat = seatEl(owner);
  if (!seat) return null;
  const cell = seat.querySelectorAll(".backs > *")[slot];
  return cell ? (cell.tagName === "IMG" ? cell : cell.querySelector("img")) : null;
}
function pileImgEl(player) {
  const seat = seatEl(player);
  return seat ? seat.querySelector(".seat-pile") : null;
}
function grabHand(fromRect, viaRect, toRect, actor, playersList) {
  if (!fromRect || !viaRect || !toRect || reduceMotion) return;
  const h = document.createElement("img");
  h.className = "grab-hand";
  h.src = handSrc(actor, playersList);
  h.alt = "";
  h._born = Date.now();
  const mid = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const a = mid(fromRect), b = mid(viaRect), c = mid(toRect);
  h.style.left = a.x + "px"; h.style.top = a.y + "px";
  fxLayer().append(h);
  const spdScale = fastBotsAnim ? 0.28 : 1;
  const d1 = Math.max(60, Math.round(190 * spdScale));
  const d2 = Math.max(120, Math.round(640 * spdScale));
  const dl = Math.round(170 * spdScale);
  h.animate([
    { left: a.x + "px", top: a.y + "px", transform: "translate(-50%,-50%) scale(.7)", opacity: 0 },
    { left: b.x + "px", top: b.y + "px", transform: "translate(-50%,-50%) scale(1.15)", opacity: 1 },
  ], { duration: d1, easing: "ease-out", fill: "forwards" });
  const follow = h.animate([
    { left: b.x + "px", top: b.y + "px", opacity: 1 },
    { left: c.x + "px", top: c.y + "px", opacity: 0 },
  ], { duration: d2, delay: dl, easing: "cubic-bezier(.25,.7,.3,1)", fill: "forwards" });
  follow.onfinish = () => h.remove();
  setTimeout(() => h.remove(), dl + d2 + 120);
}

let bigTimer = null;
const BIG_ART = {
  freaky: "/assets/tiki.png",
  joker: "/assets/cards/joker_red.png?v=2",
  slap: "/assets/hand_0.png",
  win: "/assets/ico_crown.png",
  start: "/assets/tiki.png",
};
function bigEvent(text, cls, holdMs, artSrc) {
  if (reduceMotion) return;
  const ov = $("big-overlay"), w = $("big-word"), bt = $("big-tiki");
  if (bt && (artSrc || BIG_ART[cls])) bt.src = artSrc || BIG_ART[cls];
  w.textContent = text;
  ov.className = "";
  void ov.offsetWidth;
  ov.hidden = false;
  ov.className = "show " + (cls || "");
  clearTimeout(bigTimer);
  const ms = fastBotsAnim ? Math.min(holdMs || 1250, 380) : (holdMs || 1250);
  bigTimer = setTimeout(() => { ov.hidden = true; }, ms);
}
function playParticleBurstSfx(count = 26) {
  if (document.hidden || !sfxOn || sfxVol <= 0) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (!sfxCtx) return;
    if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    const puffs = Math.max(3, Math.min(7, Math.round(count / 4)));
    const sr = sfxCtx.sampleRate;
    const baseT = sfxCtx.currentTime;
    for (let i = 0; i < puffs; i++) {
      const t = baseT + i * 0.032 + Math.random() * 0.014;
      const dur = 0.03 + Math.random() * 0.022;
      const len = Math.max(1, Math.floor(sr * dur));
      const buf = sfxCtx.createBuffer(1, len, sr);
      const data = buf.getChannelData(0);
      for (let j = 0; j < len; j++) {
        data[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / len, 2.1);
      }
      const src = sfxCtx.createBufferSource();
      src.buffer = buf;
      const bp = sfxCtx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 2100 + Math.random() * 2500;
      bp.Q.value = 1.4;
      const gain = sfxCtx.createGain();
      gain.gain.value = sfxVol * (0.14 - i * 0.012);
      src.connect(bp).connect(gain).connect(sfxCtx.destination);
      src.start(t);
    }
  } catch (e) { /* audio unsupported */ }
}
function particles(rect, count = 26, color = null) {
  if (!rect || reduceMotion) return;
  playParticleBurstSfx(count);
  const colors = ["#ffc7d6", "#fcefb4", "#bfead5", "#dccbfa", "#f4b942", "#ff8fab"];
  const cx = Math.round(rect.x + rect.w / 2), cy = Math.round(rect.y + rect.h / 2);
  for (let i = 0; i < count; i++) {
    const p = document.createElement("div");
    p.className = "particle";
    const size = [5, 7, 9][i % 3];
    p.style.width = p.style.height = size + "px";
    p.style.left = cx + "px"; p.style.top = cy + "px";
    p.style.background = color ? (i % 5 === 0 ? "#fff8dc" : color) : colors[i % colors.length];
    p.style.opacity = "1";
    p.style.boxShadow = "0 0 0 2px #150e1c";
    fxLayer().append(p);
    const ang = (Math.PI * 2 * i) / count + (Math.random() * 0.32 - 0.16);
    const dist = 68 + Math.random() * 125;
    const dx = Math.round(Math.cos(ang) * dist);
    const dy = Math.round(Math.sin(ang) * dist - 42);
    const midX = Math.round(dx * 0.65);
    const midY = Math.round(dy * 0.65);
    const endY = dy + 88;
    const a = p.animate([
      { transform: "translate(-50%,-50%) scale(1.1)", opacity: 1 },
      { transform: `translate(calc(-50% + ${midX}px), calc(-50% + ${midY}px)) scale(1)`, opacity: 1, offset: 0.58 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${endY}px)) scale(0)`, opacity: 1 },
    ], { duration: 540 + (i % 4) * 65, easing: "cubic-bezier(.15,.65,.35,1)", fill: "forwards" });
    a.onfinish = () => p.remove();
    setTimeout(() => p.remove(), 1100);
  }
}
function fireworks(rect, color, bursts = 3, silent = false, container = null) {
  if (!rect || reduceMotion) return;
  const host = container || fxLayer();
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  for (let b = 0; b < bursts; b++) {
    setTimeout(() => {
      if (container && !container.isConnected) return;
      const ox = cx + (b === 0 ? 0 : (Math.random() * 44 - 22));
      const oy = cy + (b === 0 ? 0 : (Math.random() * 34 - 17));
      const ring = document.createElement("div");
      ring.className = "fw-ring";
      ring.style.left = ox + "px"; ring.style.top = oy + "px";
      ring.style.width = ring.style.height = "24px";
      ring.style.borderColor = color;
      ring.style.boxShadow = `0 0 18px ${color}`;
      host.append(ring);
      const ra = ring.animate([
        { transform: "translate(-50%,-50%) scale(.2)", opacity: 1 },
        { transform: "translate(-50%,-50%) scale(4.4)", opacity: 0 },
      ], { duration: 680, easing: "cubic-bezier(.15,.7,.3,1)", fill: "forwards" });
      ra.onfinish = () => ring.remove();
      setTimeout(() => ring.remove(), 800);
      const count = 24;
      for (let i = 0; i < count; i++) {
        const sp = document.createElement("div");
        sp.className = "fw-spark";
        const size = 5 + Math.random() * 5;
        const sparkColor = i % 5 === 0 ? "#fff8dc" : color;
        sp.style.width = sp.style.height = size + "px";
        sp.style.left = ox + "px"; sp.style.top = oy + "px";
        sp.style.background = sparkColor;
        sp.style.boxShadow = `0 0 10px ${color}, 0 0 4px #fff`;
        host.append(sp);
        const ang = (Math.PI * 2 * i) / count + (Math.random() * 0.22 - 0.11);
        const dist = container ? (48 + Math.random() * 78) : (85 + Math.random() * 145);
        const dx = Math.cos(ang) * dist;
        const dy = Math.sin(ang) * dist;
        const sa = sp.animate([
          { transform: "translate(-50%,-50%) scale(1.2)", opacity: 1 },
          { transform: `translate(calc(-50% + ${dx * 0.65}px), calc(-50% + ${dy * 0.65}px)) scale(1)`, opacity: 1, offset: 0.55 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 42}px)) scale(.25)`, opacity: 0 },
        ], { duration: 850 + Math.random() * 350, easing: "cubic-bezier(.15,.65,.35,1)", fill: "forwards" });
        sa.onfinish = () => sp.remove();
        setTimeout(() => sp.remove(), 1400);
      }
      if (!silent) playSfx("firework");
    }, b * 240);
  }
}
function screenShake(level = false) {
  if (reduceMotion) return;
  const a = $("arena");
  if (!a) return;
  const mode = level === true ? "light" : (level === "heavy" || level === "light" ? level : "normal");
  const cls = mode === "light" ? "screen-shake-light" : (mode === "heavy" ? "screen-shake-heavy" : "screen-shake");
  const ms = mode === "light" ? 280 : (mode === "heavy" ? 620 : 550);
  a.classList.remove("scenery-enter", "screen-shake", "screen-shake-light", "screen-shake-heavy");
  void a.offsetWidth;
  a.classList.add(cls);
  setTimeout(() => a.classList.remove(cls), ms);
}

// ------------------------------------------------------------ stack messages
// Up to three previous stack messages stay visible above the current message,
// and each message fades away smoothly on its own timer.
const MAX_PREV_STACK_MSGS = 3;   // 3 previous + 1 current = 4 messages max
function clearStackMsgs() {
  const box = $("stack-msg");
  if (!box) return;
  box.replaceChildren();
  box.hidden = true;
}
function updateStackMsgAges() {
  const box = $("stack-msg");
  if (!box) return;
  const items = [...box.querySelectorAll(".stack-msg-item")];
  if (!items.length) { box.hidden = true; return; }
  box.hidden = false;
  const n = items.length;
  items.forEach((item, idx) => {
    const age = n - 1 - idx;   // 0 = current (bottom), 1..3 = previous (above)
    if (age === 0) {
      item.classList.add("current");
      item.classList.remove("prev");
      item.removeAttribute("data-age");
    } else {
      item.classList.remove("current");
      item.classList.add("prev");
      item.setAttribute("data-age", String(Math.min(age, MAX_PREV_STACK_MSGS)));
    }
  });
}
function stackMsg(text, kind) {
  const box = $("stack-msg");
  if (!box) return;
  // Keep at most MAX_PREV_STACK_MSGS existing items so adding the new
  // current message leaves up to 3 previous messages above it.
  const existing = [...box.querySelectorAll(".stack-msg-item")];
  while (existing.length > MAX_PREV_STACK_MSGS) {
    const oldest = existing.shift();
    if (oldest) oldest.remove();
  }
  const item = document.createElement("div");
  item.className = "stack-msg-item current " + (kind || "stack");
  item.textContent = text;
  box.append(item);
  updateStackMsgAges();
  const lifeMs = kind === "miss" ? 4800 : kind === "grace" ? 4200 : 2600;
  setTimeout(() => {
    if (item.isConnected) {
      item.remove();
      updateStackMsgAges();
    }
  }, lifeMs);
}
function missVignette() {
  const el = $("miss-vignette");
  if (!el || reduceMotion) return;
  el.hidden = false;
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  setTimeout(() => { el.hidden = true; }, 950);
}
let varTimer = null;
function hideVarReplay() {
  clearTimeout(varTimer);
  varTimer = null;
  const box = $("var-replay");
  if (box) {
    box.hidden = true;
    box.classList.remove("var-playing");
  }
}
if ($("var-close")) $("var-close").addEventListener("click", hideVarReplay);
function showVarReplay({ player, card, target, taken, players }) {
  const box = $("var-replay");
  if (!box) return;
  clearTimeout(varTimer);
  const tiki = $("var-tiki");
  if (tiki) tiki.src = player ? tikiSrc(player, players) : "/assets/tiki.png";
  if ($("var-player")) $("var-player").textContent = player || "Player";
  const handEl = $("var-hand");
  if (handEl) handEl.src = player ? handSrc(player, players) : "/assets/hand_0.png";
  if ($("var-card-rank")) $("var-card-rank").textContent = card ? rankLabel(card) : "?";
  if ($("var-target-rank")) $("var-target-rank").textContent = target ? rankLabel(target) : "Empty";
  const cardEl = $("var-card");
  if (cardEl) {
    cardEl.src = cardSrc(card || "card_back");
    cardEl.style.outlineColor = player ? GRAB_COLORS[playerIndex(player, players)] : "#ff5c5c";
  }
  const targetEl = $("var-target");
  if (targetEl) {
    targetEl.src = cardSrc(target || "blank_front");
    targetEl.style.opacity = target ? "" : ".4";
  }
  const gap = cardRankGap(card, target);
  if ($("var-detail")) {
    let reasonText;
    if (!target) reasonText = `${rankLabel(card)} on empty middle`;
    else if (!card) reasonText = `Took middle stack (${rankLabel(target)})`;
    else if (gap === null) reasonText = `${rankLabel(card)} vs ${rankLabel(target)} (Joker)`;
    else reasonText = `${rankLabel(card)} vs ${rankLabel(target)} (off by ${gap} rank${gap === 1 ? "" : "s"})`;
    const takeText = taken ? ` — took ${taken} card${taken === 1 ? "" : "s"}` : "";
    $("var-detail").textContent = `${reasonText}${takeText}`;
  }
  box.classList.remove("var-playing");
  box.hidden = false;
  void box.offsetWidth;
  if (!reduceMotion) box.classList.add("var-playing");
  varTimer = setTimeout(hideVarReplay, 4800);
}
function stackEventFx(old, v) {
  if (!old || !old.started || !v.started || old.phase === "over" || document.hidden) return;
  if (old.middle_count === 0 && v.middle_count > 0) hideVarReplay();
  const midDelta = v.middle_count - old.middle_count;
  const players = Object.keys(v.playing_counts || {});
  const emptied = [];
  for (const p of players) {
    const a = (old.stacking_hands || {})[p] || [], b = (v.stacking_hands || {})[p] || [];
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      if (a[i] && !b[i]) emptied.push({ owner: p, card: a[i] });
  }
  if (midDelta > 0 && emptied.length && old.middle_top) {
    let targetCard = old.middle_top;
    emptied.forEach((em) => {
      stackMsg(`Stack! ${rankLabel(em.card)} on ${rankLabel(targetCard)}`, "stack");
      targetCard = em.card;
    });
    const actor = (v.last_stack && (!old.last_stack || v.last_stack.seq !== old.last_stack.seq))
      ? v.last_stack.player
      : ((v.stackers || []).filter((p) => !(old.stackers || []).includes(p))[0]
        || (v.stackers || [])[v.stackers.length - 1]);
    const stackColor = actor ? GRAB_COLORS[playerIndex(actor, players)] : null;
    if (Date.now() - lastLocalVibAt > 700) vibrate([22, 24, 28]);
    if (!reduceMotion) setTimeout(() => {
      const c = document.querySelector("#table-center .middle-top");
      if (c) { c.classList.remove("card-drop"); void c.offsetWidth; c.classList.add("card-drop"); }
      particles(snapshotRects().center, 14, stackColor);
    }, 660);
  } else if ((v.last_miss && (!old.last_miss || v.last_miss.seq !== old.last_miss.seq))
             || (v.middle_count === 0 && old.phase !== "joker_choose" && old.phase !== "joker" && (midDelta < 0 || emptied.length))) {
    const lm = (v.last_miss && (!old.last_miss || v.last_miss.seq !== old.last_miss.seq)) ? v.last_miss : null;
    const dst = (lm && lm.player) || players.find((p) => ((v.playing_counts[p] || 0) - (old.playing_counts[p] || 0)) > 0);
    const who = dst ? `${dst}: ` : "";
    const recentPending = (pendingStack && Date.now() - pendingStack.at < 4000) ? pendingStack : null;
    const attemptedCard = (lm && lm.card) || (emptied.length ? emptied[0].card : (recentPending ? recentPending.card : null));
    const targetCard = (lm && lm.target) || old.middle_top || (recentPending ? recentPending.target : null);
    pendingStack = null;
    const taken = (lm && lm.taken) || (dst
      ? Math.max(1, (v.playing_counts[dst] || 0) - (old.playing_counts[dst] || 0))
      : Math.max(1, (old.middle_count || 0) + (attemptedCard ? 1 : 0)));
    if (lm && lm.during_joker && attemptedCard) {
      stackMsg(`${who}Mistake during Joker — ${rankLabel(attemptedCard)} stays in the middle stack`, "miss");
    } else if (attemptedCard) {
      const reason = targetCard
        ? `${who}${rankLabel(attemptedCard)} isn't within 1 of ${rankLabel(targetCard)} — took middle stack`
        : `${who}Can't stack ${rankLabel(attemptedCard)} on an empty middle`;
      stackMsg(reason, "miss");
      showVarReplay({ player: dst, card: attemptedCard, target: targetCard, taken, players });
    } else if (midDelta < 0) {
      stackMsg(dst ? `${dst} picked up the middle stack` : "Middle stack picked up", "miss");
      showVarReplay({ player: dst, card: null, target: targetCard, taken, players });
    }
    missVignette();
    screenShake();
    playSfx("miss");
    vibrate([90, 45, 110]);
  }
}

let giveawayDrag = null;          // active drag state while slap winner drags the middle stack
let lastGiveawayDropRect = null;  // rect where the slap winner dropped the stack

function animateDiff(old, v, oldR) {
  if (document.hidden || !old || !old.started || !v.started || old.phase === "over" || reduceMotion) return;
  requestAnimationFrame(() => {
    const newR = snapshotRects();
    const players = Object.keys(v.playing_counts);
    const dCount = (p) => (v.playing_counts[p] || 0) - (old.playing_counts[p] || 0);
    const midDelta = v.middle_count - old.middle_count;
    const emptied = [], filled = [];
    for (const p of players) {
      const a = old.stacking_hands[p] || [], b = v.stacking_hands[p] || [];
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] && !b[i]) emptied.push({ owner: p, slot: i, card: a[i] });
        if (!a[i] && b[i]) filled.push({ owner: p, slot: i, card: b[i] });
      }
    }
    // Never hide the middle stack during a Joker slap or Joker giveaway!
    const isJokerPhase = v.phase === "joker" || v.phase === "joker_choose";
    const centerEl = (midHoldActive() || isJokerPhase) ? null : document.querySelector("#table-center .middle-top");
    if (midDelta > 0) {
      if (emptied.length) {
        const s = emptied[0];
        const from = oldR.slots[s.owner] && oldR.slots[s.owner][s.slot];
        flyCard(from, newR.center, s.card, { hideEl: centerEl });
        const actor = (v.last_stack && (!old.last_stack || v.last_stack.seq !== old.last_stack.seq))
          ? v.last_stack.player
          : ((v.stackers || []).filter((p) => !(old.stackers || []).includes(p))[0]
            || (v.stackers || [])[v.stackers.length - 1]);
        if (actor) grabHand(oldR.piles[actor], from, newR.center, actor, Object.keys(v.playing_counts || {}));
        if (!(actor === myName && lastLocalSfx.name === "stack" && Date.now() - lastLocalSfx.at < 700)) playSfx("stack");
      } else {
        const src = players.find((p) => dCount(p) < 0);
        if (src) flyCard(oldR.piles[src], newR.center, v.middle_top, { flip: true, hideEl: centerEl });
        if (!(src === myName && lastLocalSfx.name === "flip" && Date.now() - lastLocalSfx.at < 700)) playSfx("flip");
      }
    }
    // 2) The whole middle stack was given away / picked up (slap choice,
    //    out-of-turn or wrong-stack penalty): it flies to its new owner.
    if (midDelta < 0 && v.middle_count === 0) {
      const dst = players.find((p) => dCount(p) > 0);
      const fromRect = lastGiveawayDropRect || oldR.giveaway || oldR.center;
      lastGiveawayDropRect = null;
      if (dst && fromRect) {
        flyStack(fromRect, newR.piles[dst], old.middle_top, -midDelta,
                 (old.playing_counts[dst] || 0) === 0 ? pileImgEl(dst) : null);
      }

    }
    // 3) Replacement cards fly from the stacker's pile into emptied slots.
    if (!old.awaiting_deal && midDelta >= 0 && filled.length > 0 && filled.length <= 6) {
      const actor = (v.last_stack && (!old.last_stack || v.last_stack.seq !== old.last_stack.seq)) ? v.last_stack.player : null;
      const fallbackSrc = players.find((p) => dCount(p) < 0);
      const src = (actor && dCount(actor) < 0) ? actor : fallbackSrc;
      if (src) {
        const fromRect = oldR.piles[src] || newR.piles[src] || cardRectOf(seatEl(src) && seatEl(src).querySelector(".pilewrap"));
        for (const f of filled) {
          const toRect = (newR.slots[f.owner] && newR.slots[f.owner][f.slot]) || cardRectOf(slotImgEl(f.owner, f.slot));
          if (fromRect && toRect) {
            flyCard(fromRect, toRect, f.card || "card_back", { flip: true, semiTransparent: true, delay: 0, duration: 650, hideEl: slotImgEl(f.owner, f.slot) });
          }
        }
      }
    }
    // 4) Freaky Tiki sheds fly from each shedder's pile to their shed pile.
    if (old.phase === "freaky" && v.phase === "freaky" && v.freaky && old.freaky) {
      for (const p of players) {
        const d = (v.freaky.shed_counts[p] || 0) - (old.freaky.shed_counts[p] || 0);
        if (d <= 0) continue;
        const seat = seatEl(p);
        const shedEl = (p === myName && document.querySelector("#shed-zone img"))
          || (seat ? seat.querySelector(".shed-pile img") : null);
        const shedTo = newR.sheds[p] || newR.piles[p];
        const fromPile = oldR.piles[p];
        const alignedTo = (shedTo && fromPile) ? { ...shedTo, rot: fromPile.rot } : shedTo;
        for (let i = 0; i < Math.min(d, 3); i++)
          flyCard(fromPile, alignedTo, "card_back",
                  { delay: i * 90, hideEl: i === 0 ? shedEl : null });
      }
    }
    // 5) The call: every shed card sweeps across to the caller.
    if (old.phase === "freaky" && v.phase !== "freaky" && old.freaky) {
      stopFreakyThudLoop();
      if (Date.now() - lastLocalFreakyAt > 900) playBigFreakyThud();
      const caller = old.freaky.player;
      let anyShed = false;
      for (const p of players) {
        const n = old.freaky.shed_counts[p] || 0;
        if (n > 0) anyShed = true;
        for (let i = 0; i < Math.min(n, 4); i++)
          flyCard(oldR.sheds[p] || oldR.piles[p], newR.piles[caller], "card_back", { delay: i * 80 });
      }
      if (anyShed) {
        bigEvent("FREAKY TIKI!", "freaky");
        vibrate([40, 30, 40, 30, 75]);
      }
    }
    if (v.phase === "freaky" && old.phase !== "freaky") {
      startFreakyThudLoop();
      vibrate([45, 35, 65]);
    }
    // 6) Joker drama: JOKER! fills the screen as it lands, and the winning
    //    slap is a cutscene - SLAP! overlay, particle burst, screen shake.
    if (v.phase === "joker" && old.phase !== "joker") {
      bigEvent("JOKER!", "joker");
      playJokerLaughSfx();
      vibrate([60, 40, 80, 40, 90]);
      const cimg = document.querySelector("#table-center .middle-top");
      if (cimg) { cimg.classList.add("shake"); setTimeout(() => cimg.classList.remove("shake"), 600); }
    }
    if (old.phase === "joker" && (v.phase === "joker_choose" || v.phase === "over")) {
      const slapWinner = (v.joker && v.joker.winner) || (v.finished && v.finished[v.finished.length - 1]);
      bigEvent("SLAP!", "slap", undefined, slapWinner ? handSrc(slapWinner, players) : BIG_ART.slap);
      if (Date.now() - lastLocalSlapFinalAt > 600) playSlapHitSfx(true, 1);
      vibrate([85, 35, 120]);
      particles(newR.center);
      screenShake("heavy");
    }
    // 7) Winning / finishing: launch the winning player's color fireworks
    //    directly from the card they placed on the middle stack.
    const newlyFinished = (v.finished || []).filter((p) => !(old.finished || []).includes(p));
    if (newlyFinished.length) {
      const origin = newR.center || oldR.center;
      newlyFinished.forEach((p) => {
        const color = GRAB_COLORS[playerIndex(p, players)];
        fireworks(origin, color, v.finished[0] === p ? 4 : 2);
      });
      playSfx("win");
      vibrate(v.finished[0] === myName ? [70, 40, 90, 40, 110, 50, 160] : [50, 35, 80]);
    }
    if (myName && !old.finished.includes(myName) && v.finished.includes(myName)) {
      bigEvent(v.finished[0] === myName ? "YOU WIN!" : "YOU FINISHED!", "win", 1800);
    }
  });
}

function cleanupGiveawayDrag() {
  if (!giveawayDrag) return;
  if (giveawayDrag.cleanup) giveawayDrag.cleanup();
  if (giveawayDrag && giveawayDrag.clone) giveawayDrag.clone.remove();
  giveawayDrag = null;
}

// Dragging the middle stack to its new owner after a Joker slap: the slap
// winner grabs the stack (pointer down on the middle card) and drops it on
// a player's seat (your own seat to take it yourself).
function setupStackDrag(view) {
  if (!view || view.phase !== "joker_choose" || !view.joker || view.joker.winner !== myName) {
    cleanupGiveawayDrag();
    return;
  }
  const img = document.querySelector("#table-center .middle-top");
  if (!img) return;
  img.classList.add("draggable-stack");
  img.title = "Drag the stack onto a player (or click a player's seat)!";

  // Also allow clicking a valid target seat directly in joker_choose
  document.querySelectorAll(".seat").forEach((s) => {
    const p = s.dataset.player;
    if (view.joker.targets.includes(p)) {
      s.classList.add("drop-hint");
      s.addEventListener("click", () => {
        if (prevView && prevView.phase === "joker_choose" && prevView.joker && prevView.joker.winner === myName && !giveawayDrag) {
          send({ type: "move", move: { type: "slap_choose", target: p } });
        }
      });
    } else if (!s.classList.contains("finished") && !s.classList.contains("dropped")) {
      s.classList.add("drop-blocked");
      s.title = `${p} cannot receive the Joker stack 3 times in a row`;
      s.addEventListener("click", () => {
        if (prevView && prevView.phase === "joker_choose" && prevView.joker && prevView.joker.winner === myName && !giveawayDrag) {
          showError(`${p} cannot receive the Joker stack 3 times in a row — choose someone else.`);
        }
      });
    }
  });

  // If the user is already actively dragging the giveaway stack across a
  // server broadcast (e.g. giveaway_hold echo), keep the active drag intact.
  if (giveawayDrag) return;

  img.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    const stackEl = img.closest(".middle-stack") || img;
    const countEl = document.querySelector("#table-center .count");
    const r = stackEl.getBoundingClientRect();
    const w = r.width || 96, h = r.height || 132;

    // IMPORTANT: Clone stackEl BEFORE setting stackEl.style.visibility = "hidden"
    // so the clone never inherits visibility: hidden!
    const clone = stackEl.cloneNode(true);
    clone._born = Date.now();
    clone.removeAttribute("id");
    clone.style.visibility = "visible";
    clone.classList.remove("held-away");
    clone.classList.add("fly", "drag-clone", "drag-stack");
    clone.querySelectorAll("img").forEach((cim) => { cim.style.visibility = "visible"; });
    const cTop = clone.querySelector(".middle-top");
    if (cTop) cTop.classList.remove("draggable-stack");
    if (view.middle_count >= 1) {
      const b = document.createElement("span");
      b.className = "drag-stack-count";
      b.textContent = `Middle stack: ${view.middle_count}`;
      clone.append(b);
    }
    const cbadge = document.createElement("img");
    cbadge.className = "hand-badge";
    cbadge.src = handSrc(myName, Object.keys(view.playing_counts || {}));
    cbadge.alt = "";
    clone.append(cbadge);
    clone.style.width = w + "px";
    clone.style.height = h + "px";
    clone.style.left = (e.clientX != null ? e.clientX - w / 2 : r.left) + "px";
    clone.style.top = (e.clientY != null ? e.clientY - h / 2 : r.top) + "px";
    fxLayer().append(clone);

    // Now hide the stationary stack in the center while the clone is carried.
    stackEl.style.visibility = "hidden";
    if (countEl) countEl.style.visibility = "hidden";

    const seatAt = (x, y) => {
      let found = null;
      document.querySelectorAll(".seat").forEach((s) => {
        const b = s.getBoundingClientRect();
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) found = s;
      });
      return found;
    };

    const move = (ev) => {
      if (!giveawayDrag || !giveawayDrag.clone) return;
      giveawayDrag.clone.style.left = (ev.clientX - w / 2) + "px";
      giveawayDrag.clone.style.top = (ev.clientY - h / 2) + "px";
      const s = seatAt(ev.clientX, ev.clientY);
      const rawP = s ? s.dataset.player : null;
      const validTargets = (prevView && prevView.joker && prevView.joker.targets) || view.joker.targets || [];
      const hotP = (rawP && validTargets.includes(rawP)) ? rawP : null;
      giveawayDrag.hotPlayer = hotP;
      document.querySelectorAll(".seat").forEach((seat) => {
        seat.classList.toggle("drop-hot", seat.dataset.player === hotP);
      });
    };

    const detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };

    const up = (ev) => {
      detach();
      const s = (ev && ev.clientX != null) ? seatAt(ev.clientX, ev.clientY) : null;
      const targetPlayer = s && s.dataset.player;
      const validTargets = (prevView && prevView.joker && prevView.joker.targets) || view.joker.targets || [];
      const isValidDrop = targetPlayer && validTargets.includes(targetPlayer);

      if (isValidDrop && clone.isConnected) {
        lastGiveawayDropRect = rectOf(clone);
      }
      clone.remove();
      giveawayDrag = null;

      document.querySelectorAll(".seat").forEach((x) => x.classList.remove("drop-hot"));
      const liveStack = document.querySelector("#table-center .middle-stack");
      const liveCount = document.querySelector("#table-center .count");

      if (isValidDrop) {
        send({ type: "move", move: { type: "slap_choose", target: targetPlayer } });
        // Safety fallback if the server does not respond within 800ms
        const t0 = Date.now();
        setTimeout(() => { if (renderedAt < t0) refreshTable(); }, 800);
      } else {
        if (targetPlayer && !(view.finished || []).includes(targetPlayer) && !(view.dropped || []).includes(targetPlayer)) {
          showError(`${targetPlayer} cannot receive the Joker stack 3 times in a row — choose someone else.`);
        }
        if (liveStack) liveStack.style.visibility = "";
        if (liveCount) liveCount.style.visibility = "";
        send({ type: "giveaway_release" });
      }
    };

    giveawayDrag = { clone, w, h, hotPlayer: null, cleanup: detach };
    send({ type: "giveaway_hold" });
    document.querySelectorAll(".seat").forEach((s) => { if (view.joker.targets.includes(s.dataset.player)) s.classList.add("drop-hint"); });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
}

function tikiSrc(player, playersList) {
  return "/assets/tiki_" + playerIndex(player, playersList) + ".png";
}

function render(view, keepError) {
  fastBotsAnim = !!(view && view.started && view.fast_bots);
  currentPlayerColors = (view && view.player_colors) ? view.player_colors : {};
  const oldView = prevView;
  const oldRects = snapshotRects();
  document.querySelectorAll(".fly").forEach((el) => {
    if (el._born && !el.classList.contains("drag-clone") && Date.now() - el._born > 2500) el.remove();
  });
  if (grab && (!GRAB_PHASES.includes(view.phase)
      || (grab.kind === "play" && !(view.your_playing_count > 0))))
    cancelGrab({ refresh: false });
  if (giveawayDrag && (view.phase !== "joker_choose" || !view.joker || view.joker.winner !== myName))
    cleanupGiveawayDrag();

  const tikiBox = $("tiki-box"), tiki = $("tiki");
  const inFreaky = !!view.started && view.phase === "freaky";
  tikiBox.hidden = !inFreaky;
  if (inFreaky && (!oldView || oldView.phase !== "freaky")) {
    tiki.classList.remove("tiki-pop");
    void tiki.offsetWidth;
    tiki.classList.add("tiki-pop");
  }
  const enteringGame = $("game-box").hidden;
  $("join-box").hidden = true;
  $("game-box").hidden = false;
  if (enteringGame) triggerPageBlur($("game-box"));
  document.body.classList.add("in-game");
  if ($("disconnect-bar")) $("disconnect-bar").hidden = true;
  if (!keepError) showError("");
  renderedAt = Date.now();
  syncChatVisibility(!!view.practice);
  if (!view.practice && Array.isArray(view.chat)) {
    chatMessages = view.chat.slice();
    renderChatLog();
  }
  if (!view.started) {
    cleanupGiveawayDrag();
    clearStackMsgs();
    $("coach").hidden = true;
    $("action-info").textContent = "";
    if ($("fast-bots-btn")) $("fast-bots-btn").hidden = true;
    if ($("hud-top")) $("hud-top").classList.add("in-lobby");
    if ($("lobby-code-box")) $("lobby-code-box").hidden = false;
    if ($("lobby-hud-code")) $("lobby-hud-code").textContent = view.room || "----";
    if ($("lobby-privacy-box")) {
      const isPub = !!view.public;
      $("lobby-privacy-box").hidden = false;
      $("lobby-privacy-box").classList.toggle("is-public", isPub);
      $("lobby-privacy-box").classList.toggle("is-private", !isPub);
      if ($("lobby-hud-privacy")) $("lobby-hud-privacy").textContent = isPub ? "Public" : "Private";
    }
    const wBanner = $("lobby-waiting-banner");
    const dblWrap = $("lobby-dblclick-wrap");
    const dblChk = $("lobby-dblclick");
    const dblStat = $("lobby-dblclick-status");
    const rulesBox = $("lobby-rules");
    if (rulesBox) rulesBox.hidden = true;
    if (dblWrap) dblWrap.hidden = true;
    if (dblStat) dblStat.hidden = true;
    if ($("lobby-leave")) $("lobby-leave").hidden = false;
    if (view.waiting_room) {
      $("status").textContent = `Room ${view.room} - Waiting Room (host ${view.host} will admit you between games)`;
      if (wBanner) {
        wBanner.hidden = false;
        wBanner.textContent = `You are in the waiting room for ${view.room}.` +
          (view.game_in_progress ? " A game is currently in progress." : ` Waiting for host ${view.host} to admit you for the next game.`);
      }
      $("start").hidden = true;
    } else if (view.admitted_next_game) {
      $("status").textContent = `Room ${view.room} - Admitted for the next game! Host: ${view.host}`;
      if (wBanner) {
        wBanner.hidden = false;
        wBanner.textContent = `Admitted! Waiting for host ${view.host} to start the next game.`;
      }
      $("start").hidden = true;
    } else {
      if (wBanner) wBanner.hidden = true;
      $("status").textContent =
        `Room ${view.room} - waiting for players.` +
        (view.you_are_host ? " You are the host." : ` Host: ${view.host}`);
      $("start").hidden = !view.you_are_host;
      $("start").disabled = !view.can_start;
      $("start").textContent = view.can_start ? "Start game" : "Start game (need 2+ players)";
    }
    renderWaitingRoomPanel($("lobby-waiting-room"), view);
    syncSpeechBubbles();
    $("ring").querySelectorAll(".seat").forEach((s) => s.remove());
    $("table-center").replaceChildren();
    const layer = $("lobby-tikis");
    layer.replaceChildren();
    const nPlayers = view.players.length;
    const clusterCoords = (idx, total) => {
      if (total <= 1) return { dx: 0, dy: 0 };
      if (total === 2) return { dx: idx === 0 ? -96 : 96, dy: 0 };
      const ang = (Math.PI * 2 * idx) / total - Math.PI / 2;
      const lw = layer.clientWidth || 720;
      const lh = layer.clientHeight || 260;
      const maxRx = Math.max(90, Math.floor(lw / 2) - 72);
      const maxRy = Math.max(48, Math.floor(lh / 2) - 66);
      const rx = Math.min(maxRx, 72 + total * 22);
      const ry = Math.min(maxRy, 44 + total * 5);
      return { dx: Math.round(Math.cos(ang) * rx), dy: Math.round(Math.sin(ang) * ry) };
    };
    view.players.forEach((p, i) => {
      const slot = document.createElement("div");
      slot.className = "lobby-cluster-slot";
      const pos = clusterCoords(i, nPlayers);
      slot.style.left = `calc(50% + ${pos.dx}px)`;
      slot.style.top = `calc(50% + ${pos.dy}px)`;
      const chip = document.createElement("div");
      chip.className = "lobby-player";
      chip.dataset.player = p;
      chip.style.animationDelay = (i * 0.37) + "s";
      const tikiWrap = document.createElement("div");
      tikiWrap.className = "lobby-tiki-wrap";
      const img = document.createElement("img");
      img.src = tikiSrc(p, view.players);
      img.alt = p;
      tikiWrap.append(img);
      if (p === view.host) {
        const cr = document.createElement("img");
        cr.className = "lobby-host-crown";
        cr.src = "/assets/ico_crown.png";
        cr.alt = "Host";
        tikiWrap.append(cr);
      }
      const nm = document.createElement("div");
      nm.className = "lobby-name";
      nm.textContent = p + (p === myName ? " (you)" : "");
      chip.append(tikiWrap, nm);
      slot.append(chip);
      layer.append(slot);
    });
    const botsBox = $("lobby-bots");
    if (botsBox) {
      const botsHost = $("lobby-bots-host");
      const addBtn = $("lobby-add-bot");
      const remBtn = $("lobby-remove-bot");
      const diffBtn = $("lobby-bot-diff");
      const botsStat = $("lobby-bots-status");
      const botCount = (view.bots || []).length;
      const maxPlayers = view.max_players || 8;
      const canManageBots = !!view.you_are_host && !view.waiting_room && !view.admitted_next_game;
      botsBox.hidden = !!view.waiting_room;
      if (botsHost) botsHost.hidden = !canManageBots;
      if (addBtn) addBtn.disabled = (view.players || []).length >= maxPlayers;
      if (remBtn) remBtn.disabled = botCount <= 0;
      if (diffBtn) {
        const d = view.bot_difficulty || "easy";
        diffBtn.dataset.diff = d;
        diffBtn.textContent = "Bot level: " + (d === "hard" ? "Hard" : "Easy");
        diffBtn.disabled = botCount <= 0;
      }
      if (botsStat) {
        botsStat.hidden = canManageBots || botCount <= 0;
        if (botCount > 0) {
          const diffLabel = (view.bot_difficulty || "easy") === "hard" ? "Hard" : "Easy";
          botsStat.textContent = `Bots: ${botCount} (${diffLabel})`;
        }
      }
    }
    const picker = $("lobby-color-picker");
    if (picker) {
      picker.replaceChildren();
      const myColor = playerIndex(myName, view.players);
      for (let c = 0; c < GRAB_COLORS.length; c++) {
        const sw = document.createElement("button");
        sw.type = "button";
        sw.className = "lobby-color-swatch" + (c === myColor ? " active selected" : "");
        sw.style.backgroundColor = GRAB_COLORS[c];
        sw.title = `Select color ${c + 1}`;
        sw.setAttribute("aria-label", `Select color ${c + 1}`);
        sw.addEventListener("click", () => send({ type: "set_color", color: c }));
        picker.append(sw);
      }
    }
    $("lobby-layer").hidden = false;
    if (typeof updateHandCursorAppearance === "function") updateHandCursorAppearance(view.players);
    prevView = view;
    return;
  }
  let lobbyTikiRects = null;
  const wasTutReload = tutReloading;
  tutReloading = false;
  const gameJustStarted = !!view.started && view.phase !== "over" && !wasTutReload && (!oldView || !oldView.started || oldView.phase === "over");
  if (gameJustStarted && document.activeElement && isTextInput(document.activeElement) && !document.activeElement.closest("#chat-panel")) {
    try { document.activeElement.blur(); } catch (e) { /* ignore */ }
  }
  if (gameJustStarted && !reduceMotion) {
    const arena = $("arena");
    if (!oldView || !oldView.started) {
      const rects = {};
      document.querySelectorAll("#lobby-tikis .lobby-player").forEach((chip) => {
        const pName = chip.dataset.player;
        const im = chip.querySelector("img");
        if (pName && im) { const rc = rectOf(im); if (rc) rects[pName] = rc; }
      });
      if (Object.keys(rects).length) lobbyTikiRects = rects;
      const lobbyEl = $("lobby-layer");
      if (arena && lobbyEl && !lobbyEl.hidden) {
        const ghost = lobbyEl.cloneNode(true);
        ghost.removeAttribute("id");
        ghost.style.pointerEvents = "none";
        ghost.style.zIndex = "30";
        const gt = ghost.querySelector("#lobby-tikis");
        if (gt) gt.remove();
        const actionsEl = ghost.querySelector("#lobby-actions");
        const rawExitEls = actionsEl ? [...actionsEl.children] : [...ghost.children];
        ghost.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
        arena.append(ghost);
        const exitEls = rawExitEls
          .filter((el) => !el.hidden && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden")
          .map((el) => ({ el, bottom: el.getBoundingClientRect().bottom }))
          .sort((a, b) => b.bottom - a.bottom);
        if (exitEls.length) {
          const stepMs = 95;
          const durMs = 1050;
          exitEls.forEach(({ el }, idx) => {
            const baseT = getComputedStyle(el).transform;
            const prefix = (baseT && baseT !== "none") ? baseT + " " : "";
            el.animate([
              { opacity: 1, transform: `${prefix}scale(1)` },
              { opacity: 0, transform: `${prefix}scale(0.84)` }
            ], { duration: durMs, delay: idx * stepMs, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "forwards" });
            playBreathePopSfx(idx * stepMs, "out", idx);
          });
          const totalMs = (exitEls.length - 1) * stepMs + durMs + 60;
          setTimeout(() => ghost.remove(), totalMs);
        } else {
          const outAnim = ghost.animate([
            { opacity: 1, transform: "scale(1)" },
            { opacity: 0, transform: "scale(0.84)" }
          ], { duration: 1050, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "forwards" });
          playBreathePopSfx(0, "out", 0);
          outAnim.onfinish = () => ghost.remove();
          setTimeout(() => ghost.remove(), 1100);
        }
      }
    }
    if (arena) {
      arena.classList.remove("scenery-enter");
      void arena.offsetWidth;
      arena.classList.add("scenery-enter");
    }
  }
  $("start").hidden = true;
  if ($("lobby-leave")) $("lobby-leave").hidden = true;
  $("lobby-layer").hidden = true;
  if ($("hud-top")) $("hud-top").classList.remove("in-lobby");
  if ($("lobby-code-box")) $("lobby-code-box").hidden = true;
  if ($("lobby-privacy-box")) $("lobby-privacy-box").hidden = true;
  if (!view.practice && practice) endPractice(true);
  $("coach").hidden = !view.practice;
  if (view.phase === "joker_choose" && midHoldActive()) {
    clearTimeout(midHoldTimer);
    midHold = null;
    midHoldTimer = null;
  } else if (oldView && oldView.started && oldView.phase !== "over" && !reduceMotion
      && oldView.middle_top && view.middle_count > oldView.middle_count
      && view.phase !== "joker_choose") {
    startMidHold(oldView.middle_top);
  }
  const myTurn = view.turn_player === myName;
  const diffTag = view.bot_difficulty ? ` (${view.bot_difficulty === "hard" ? "Hard" : "Easy"} bots)` : "";
  const roomLabel = (view.practice ? "Practice room" : "Room " + view.room) + diffTag;
  $("status").innerHTML = myTurn
    ? roomLabel + ' - <span class="turn">YOUR TURN</span>'
    : view.turn_player ? `${roomLabel} - waiting for ${view.turn_player}` : roomLabel;
  if (view.finished && view.finished.length) $("status").innerHTML += ` - finished: ${view.finished.join(", ")}`;
  if (view.waiting_players && view.waiting_players.length) $("status").innerHTML += ` • ${view.waiting_players.length} waiting`;
  renderActions(view, oldView);
  const willDeal = !!(oldView && oldView.awaiting_deal && !view.awaiting_deal && !reduceMotion);
  if (willDeal) dealingUntil = Date.now() + 2000;
  renderRing(view, canGoSet(view), lobbyTikiRects, gameJustStarted);
  syncSpeechBubbles();
  if (willDeal) {
    runMultiDealAnimation(view);
  }

  setupStackDrag(view);
  stackEventFx(oldView, view);
  animateDiff(oldView, view, oldRects);
  prevView = view;
  syncGrabs(view);
  syncGrabFloats(view);
  syncGiveawayFloat(view);
}

// While the slap winner carries the middle stack, it floats - bobbing,
// wearing the winner's hand - over the winner's seat on every other
// screen, clamped inside the arena so it never disappears off-screen.
let giveawayFloatEl = null, giveawayFloatHolder = null;
function syncGiveawayFloat(view) {
  const holder = view && view.started && view.phase === "joker_choose"
    ? (view.giveaway_holder || null) : null;
  if (!holder || holder === myName || !view.middle_top) {
    if (giveawayFloatEl) { giveawayFloatEl.remove(); giveawayFloatEl = null; giveawayFloatHolder = null; }
    return;
  }
  const seat = seatEl(holder);
  const anchor = seat && (seat.querySelector(".seat-cards") || seat);
  if (!anchor) return;
  if (!giveawayFloatEl || giveawayFloatHolder !== holder) {
    if (giveawayFloatEl) giveawayFloatEl.remove();
    const el = document.createElement("div");
    el.className = "giveaway-float";
    el.dataset.holder = holder;
    const ms = document.createElement("div");
    ms.className = "middle-stack";
    const layers = Math.min(3, view.middle_count);
    for (let i = layers - 1; i >= 1; i--) {
      const g = cardImg("blank_front");
      g.className = "peek";
      g.style.transform = `translate(${-5 * i}px, ${-4 * i}px) rotate(${-5 * i}deg)`;
      g.style.zIndex = String(layers - i);
      ms.append(g);
    }
    const top = cardImg(view.middle_top);
    top.className = "middle-top";
    ms.append(top);
    const badge = document.createElement("span");
    badge.className = "drag-stack-count";
    badge.textContent = `Middle stack: ${view.middle_count}`;
    const hand = document.createElement("img");
    hand.className = "hand-badge";
    hand.src = handSrc(holder, Object.keys(view.playing_counts || {}));
    hand.alt = "";
    el.append(ms, badge, hand);
    fxLayer().append(el);
    giveawayFloatEl = el; giveawayFloatHolder = holder;
  }
  const r = anchor.getBoundingClientRect();
  const arenaEl = $("arena");
  const ar = arenaEl ? arenaEl.getBoundingClientRect() : { left: 10, top: 10, right: innerWidth - 10, bottom: innerHeight - 10 };
  const acx = (ar.left + ar.right) / 2, acy = (ar.top + ar.bottom) / 2;
  const scx = r.left + r.width / 2, scy = r.top + r.height / 2;
  // Pull slightly toward the center of the table from the holder's seat
  // and clamp strictly inside the arena so top seats never clip off-screen.
  const targetX = scx + (acx - scx) * 0.28 - 32;
  const targetY = scy + (acy - scy) * 0.28 - 44;
  const clampedX = Math.max(ar.left + 16, Math.min(ar.right - 84, targetX));
  const clampedY = Math.max(ar.top + 54, Math.min(ar.bottom - 124, targetY));
  giveawayFloatEl.style.left = clampedX + "px";
  giveawayFloatEl.style.top = clampedY + "px";
}

// ------------------------------------------------------------- shared grabs
const grabSeen = {};
function syncGrabs(view) {
  const vg = view.grabs || {};
  for (const g of Object.keys(grabSeen))
    if (!vg[g] || vg[g].owner !== grabSeen[g].owner || vg[g].slot !== grabSeen[g].slot)
      delete grabSeen[g];
  for (const [g, gr] of Object.entries(vg))
    if (!grabSeen[g])
      grabSeen[g] = { since: Date.now() - (gr.age_ms || 0), owner: gr.owner, slot: gr.slot };
  if (grab && grab.kind === "stack") {
    const mine = vg[myName];
    const slotCard = view.stacking_hands && view.stacking_hands[grab.owner]
      ? view.stacking_hands[grab.owner][grab.slot] : undefined;
    const takenByOther = Object.entries(vg).some(([g, x]) =>
      g !== myName && x.owner === grab.owner && x.slot === grab.slot);
    if (slotCard !== grab.card || takenByOther
        || (mine && (mine.owner !== grab.owner || mine.slot !== grab.slot)))
      cancelGrab();
  }
}
setInterval(() => {
  const now = Date.now();
  const ages = new Map();
  if (grab && grab.kind === "stack") ages.set(grabKeyOf(grab), now - grab.since);
  for (const [g, t] of Object.entries(grabSeen))
    if (g !== myName) ages.set(t.owner + "|" + t.slot, now - t.since);
  for (const [key, age] of ages) {
    const el = (grab && key === grabKeyOf(grab) && grabClone)
      ? grabClone : grabFloats.get(key);
    if (el) {
      const shaking = age >= 2000;
      el.classList.toggle("grab-shaking", shaking);
      el.classList.toggle("grab-shake-1", age >= 2000 && age < 3000);
      el.classList.toggle("grab-shake-2", age >= 3000 && age < 4000);
      el.classList.toggle("grab-shake-3", age >= 4000);
      if (shaking) {
        const t = Math.max(0, Math.min(1, (age - 2000) / (GRAB_LIMIT_MS - 2000)));
        el.style.setProperty("--amp", (2.5 + t * 10.5).toFixed(1) + "px");
        el.style.setProperty("--rot", (1.5 + t * 7.5).toFixed(1) + "deg");
      } else {
        el.style.removeProperty("--amp");
        el.style.removeProperty("--rot");
      }
    }
  }
  for (const [key, el] of grabFloats) positionFloat(key, el);
  if (giveawayFloatEl && prevView) syncGiveawayFloat(prevView);
  if (grab && grab.kind === "stack" && now - grab.since > GRAB_LIMIT_MS) cancelGrab();
}, 50);

function canGoSet(view) {
  const active = Object.keys(view.playing_counts).filter((p) => !view.finished.includes(p));
  switch (view.phase) {
    case "open": return new Set(view.turn_player ? [view.turn_player] : []);
    case "stacked": case "stacker_start": return new Set(view.stackers || []);
    case "freaky": case "joker": return new Set(active);
    case "joker_choose": return new Set(view.joker && view.joker.winner ? [view.joker.winner] : []);
    default: return new Set();
  }
}

function renderRing(view, canGo, lobbyTikiRects = null, gameJustStarted = false) {
  const ring = $("ring");
  ring.querySelectorAll(".seat").forEach((s) => s.remove());
  const center = $("table-center");
  center.replaceChildren();
  const slapping = view.phase === "joker" && !!view.joker;
  center.classList.toggle("slappable", slapping);
  if (view.middle_top) {
    const ms = document.createElement("div");
    ms.className = "middle-stack";
    if (view.giveaway_holder && view.giveaway_holder !== myName) ms.classList.add("held-away");
    if (giveawayDrag) ms.style.visibility = "hidden";
    const layers = Math.min(3, view.middle_count);
    for (let i = layers - 1; i >= 1; i--) {
      const g = cardImg("blank_front");
      g.className = "peek";
      g.style.transform = `translate(${-5 * i}px, ${-4 * i}px) rotate(${-5 * i}deg)`;
      g.style.zIndex = String(layers - i);
      ms.append(g);
    }
    const shownTop = (midHoldActive() && view.middle_count > 0 && view.phase !== "joker_choose")
      ? midHold.card : view.middle_top;
    const top = cardImg(shownTop);
    const jokerSlapper = view.joker && (view.joker.winner || view.joker.last_slapper);
    const slapOwned = view.phase === "joker_choose" && !!view.joker;
    top.className = "middle-top" + (slapping ? " slap-me" : slapOwned ? " slap-owned" : "") + ((slapping || slapOwned) && jokerSlapper ? " slap-colored" : "");
    if ((slapping || slapOwned) && jokerSlapper) {
      top.style.setProperty("--slap-color", GRAB_COLORS[playerIndex(jokerSlapper, Object.keys(view.playing_counts))]);
    }
    ms.append(top);
    center.append(ms);
    const c = document.createElement("span");
    if (slapping) {
      c.className = "slap-prompt";
      c.textContent = `SLAP! click me - ${view.joker.your_presses}/${view.joker.your_threshold}`;
    } else {
      c.className = "count";
      c.textContent = `Middle stack: ${view.middle_count}`;
      if (giveawayDrag) c.style.visibility = "hidden";
    }
    center.append(c);
    const spaceKey = keyHint("space");
    spaceKey.classList.add("inline");
    center.append(document.createElement("br"), spaceKey);
  } else if (view.tut_deck_showcase) {
    const wrap = document.createElement("div");
    wrap.className = "tut-deck-showcase";
    const fan = document.createElement("div");
    fan.className = "tut-deck-fan";
    if (view.tut_dealing) fan.style.visibility = "hidden";
    const deck54 = pFullDeck54();
    const total = deck54.length;
    deck54.forEach((name, idx) => {
      const im = cardImg(name, null, "tut-fan-card");
      const row = Math.floor(idx / 18); // 3 compact arcs of 18 cards
      const col = idx % 18;
      const frac = (col / 17) - 0.5;
      const tx = Math.round(frac * 150);
      const ty = Math.round((row - 1) * 34 + Math.abs(frac) * 18);
      const rot = (frac * 36).toFixed(1);
      im.style.setProperty("--tx", tx + "px");
      im.style.setProperty("--ty", ty + "px");
      im.style.setProperty("--rot", rot + "deg");
      im.style.zIndex = String(idx + 1);
      im.style.animationDelay = (idx * 16) + "ms";
      fan.append(im);
    });
    const lbl = document.createElement("span");
    lbl.className = "count";
    lbl.textContent = `${total}-card deck (52 + 2 Jokers)`;
    wrap.append(fan, lbl);
    wrap.title = "Click to shuffle & deal";
    wrap.addEventListener("click", () => {
      if (practice && practice.kind === "tutorial" && practice.tut && practice.tut.step === 0 && !practice.tut.dealt && !practice.tut.dealing) {
        runTutShuffleAndDeal();
      }
    });
    center.append(wrap);
  } else if (view.awaiting_deal) {
    const isHost = view.host === myName;
    const wrap = document.createElement("div");
    wrap.className = "tut-deck-showcase" + (isHost ? "" : " not-host");
    const fan = document.createElement("div");
    fan.className = "tut-deck-fan";
    const deck54 = pFullDeck54();
    deck54.forEach((name, idx) => {
      const im = cardImg(name, null, "tut-fan-card");
      const row = Math.floor(idx / 18);
      const col = idx % 18;
      const frac = (col / 17) - 0.5;
      const tx = Math.round(frac * 150);
      const ty = Math.round((row - 1) * 34 + Math.abs(frac) * 18);
      const rot = (frac * 36).toFixed(1);
      im.style.setProperty("--tx", tx + "px");
      im.style.setProperty("--ty", ty + "px");
      im.style.setProperty("--rot", rot + "deg");
      im.style.zIndex = String(idx + 1);
      im.style.animationDelay = (idx * 16) + "ms";
      fan.append(im);
    });
    const lbl = document.createElement("span");
    lbl.className = "count";
    lbl.textContent = isHost ? `Click or press D to deal (${deck54.length} cards)` : `Waiting for ${view.host} to deal…`;
    wrap.append(fan, lbl);
    if (isHost) {
      wrap.title = "Click or press D to deal out all the cards";
      wrap.addEventListener("click", () => { playDealPopSfx(0, 0, "shuffle"); vibrate(18); send({ type: "deal" }); });
    }
    center.append(wrap);
  }
  const enterTargets = [];
  if (gameJustStarted && !reduceMotion && center.firstChild) {
    enterTargets.push({ el: center, base: "translate(-50%, -50%)" });
  }
  const players = Object.keys(view.playing_counts);
  const n = players.length;
  const myIdx = players.indexOf(myName);
  const hints = new Map();
  stackKeys = {};
  let counter = 0;
  for (let i = 0; i < n; i++) {
    const p = players[(((myIdx - i) % n) + n) % n];
    view.stacking_hands[p].forEach((name, slot) => {
      counter += 1;
      const label = counter <= 8 ? String(counter) : null;
      if (name && label) { hints.set(p + "|" + slot, label); stackKeys[label] = { owner: p, slot }; }
    });
  }
  const phoneCornerMap = {
    5: [[50, 86], [16, 60], [18, 15], [82, 15], [84, 60]],
    6: [[50, 86], [15, 60], [18, 15], [50, 12], [82, 15], [85, 60]],
    7: [[50, 86], [15, 64], [15, 38], [20, 14], [80, 14], [85, 38], [85, 64]],
    8: [[50, 86], [15, 64], [15, 38], [18, 14], [50, 11], [82, 14], [85, 38], [85, 64]],
  };
  players.forEach((player, k) => {
    const aw = ring.clientWidth || 0, ah = ring.clientHeight || 0;
    const phoneW = aw > 0 && aw <= 620;
    const halfW = phoneW ? 74 : 112, halfH = phoneW ? 72 : 104;
    const rxEdge = aw >= 200 ? Math.max(32, Math.min(44, 50 - (halfW / aw) * 100 - 1.5)) : 41;
    const ryEdge = ah >= 200 ? Math.max(22, Math.min(35, 50 - (halfH / ah) * 100 - 1.5)) : 32;
    const angDeg = 90 + (k - myIdx) * (360 / n);
    const rot = (k - myIdx) * (360 / n);
    const ang = angDeg * Math.PI / 180;
    const isDisc = Array.isArray(view.disconnected) && view.disconnected.includes(player);
    const isDropped = Array.isArray(view.dropped) && view.dropped.includes(player);
    const seat = document.createElement("div");
    seat.className = "seat" + (player === myName ? " me" : "")
      + (canGo.has(player) ? " can-go" : "")
      + (view.finished.includes(player) ? " finished" : "")
      + (isDisc ? " disconnected" : "")
      + (isDropped ? " dropped" : "")
      + (giveawayDrag && view.joker && view.joker.targets && view.joker.targets.includes(player) ? " drop-hint" : "")
      + (giveawayDrag && giveawayDrag.hotPlayer === player ? " drop-hot" : "");
    seat.dataset.player = player;
    seat.style.setProperty("--seat-color", GRAB_COLORS[playerIndex(player, players)]);
    const rel = ((k - myIdx) % n + n) % n;
    const cornerPos = (phoneW && phoneCornerMap[n]) ? phoneCornerMap[n][rel] : null;
    if (cornerPos) {
      seat.style.left = cornerPos[0] + "%";
      seat.style.top = cornerPos[1] + "%";
    } else {
      seat.style.left = (50 + rxEdge * Math.cos(ang)) + "%";
      seat.style.top = (50 + ryEdge * Math.sin(ang)) + "%";
    }
    const sideSeat = Math.abs(Math.cos(ang)) > Math.abs(Math.sin(ang));
    const phoneSide = sideSeat && window.matchMedia
      && matchMedia("(max-width: 600px)").matches;
    const turnWhole = !cornerPos && phoneSide && players.length === 4;
    if (turnWhole && aw >= 200) {
      const rxTurn = Math.max(40, Math.min(46, 50 - (40 / aw) * 100 - 1.5));
      seat.style.left = (50 + rxTurn * Math.cos(ang)) + "%";
    }
    const effRot = (cornerPos || (phoneSide && !turnWhole)) ? 0 : rot;
    const cards = document.createElement("div");
    cards.className = "seat-cards";
    cards.dataset.rot = String(effRot);
    cards.style.transform = `rotate(${effRot}deg)`;
    const stackEl = stackingRow(view, player, hints);
    const shedN = (view.phase === "freaky" && view.freaky)
      ? (view.freaky.shed_counts[player] || 0) : 0;
    const iCanShed = player === myName && view.phase === "freaky" && view.freaky
      && view.freaky.player !== myName && !view.finished.includes(player);
    let shedEl = null;
    if (iCanShed) {
      const zone = document.createElement("div");
      zone.id = "shed-zone";
      zone.className = "shed-pile";
      zone.title = `${shedVerb()} here (or press S) to shed your top card`;
      zone.addEventListener("click", () => { playSfx("shed"); vibrate(16); send({ type: "move", move: { type: "shed" } }); });
      if (shedN > 0) {
        zone.append(cardImg("card_back"));
        const zb = document.createElement("span");
        zb.className = "pile-count"; zb.textContent = shedN;
        zone.append(zb);
      }
      const lab = document.createElement("span");
      lab.className = "shed-label";
      lab.textContent = touchLike() ? "tap to shed" : "click to shed";
      zone.append(lab);
      zone.append(keyHint("S"));
      shedEl = zone;
    } else if (shedN > 0) {
      const sp = document.createElement("div");
      sp.className = "shed-pile";
      sp.append(cardImg("card_back"));
      const b = document.createElement("span");
      b.className = "pile-count"; b.textContent = shedN;
      sp.append(b);
      shedEl = sp;
    }
    const pw = document.createElement("div");
    pw.className = "pilewrap";
    const lifted = player === myName
      ? !!(grab && grab.kind === "play")
      : !!((view.grabs || {})[player] && view.grabs[player].slot === -1);
    if (lifted) pw.classList.add("pile-lifted");
    const shown = view.playing_counts[player] - (lifted ? 1 : 0);
    if (view.phase === "stacked") {
      const dur = Math.max(0.1, Number(view.stack_delay_dur || 2.0));
      const seq = (view.last_stack && view.last_stack.seq != null) ? view.last_stack.seq : "s";
      const left = Math.max(0, Number(view.stack_delay_left || 0));
      if (left > 0.02 && cooldownTrack.stackSeq !== seq) {
        cooldownTrack.stackSeq = seq;
        cooldownTrack.stackStartAt = Date.now() - Math.max(0, dur - left) * 1000;
      }
      if ((view.stackers || []).includes(player) && view.playing_counts[player] > 0 && shown > 0 && cooldownTrack.stackSeq === seq) {
        const elapsed = (Date.now() - cooldownTrack.stackStartAt) / 1000;
        if (elapsed < dur) {
          pw.classList.add("stack-cooldown");
          pw.style.setProperty("--cd-dur", dur + "s");
          pw.style.setProperty("--cd-delay", (-elapsed).toFixed(3) + "s");
        }
      }
    } else {
      cooldownTrack.stackSeq = null;
      if (view.phase === "open" && view.turn_player) {
        const pDur = Math.max(0.05, Number(view.pace_dur || 0.65));
        const pKey = view.turn_player + "|" + view.middle_count + "|" + (view.playing_counts[view.turn_player] || 0);
        const pLeft = Math.max(0, Number(view.pace_left || 0));
        if (pLeft > 0.02 && cooldownTrack.paceKey !== pKey) {
          cooldownTrack.paceKey = pKey;
          cooldownTrack.paceStartAt = Date.now() - Math.max(0, pDur - pLeft) * 1000;
        }
        if (player === view.turn_player && view.playing_counts[player] > 0 && shown > 0 && cooldownTrack.paceKey === pKey) {
          const elapsed = (Date.now() - cooldownTrack.paceStartAt) / 1000;
          if (elapsed < pDur) {
            pw.classList.add("stack-cooldown");
            pw.style.setProperty("--cd-dur", pDur + "s");
            pw.style.setProperty("--cd-delay", (-elapsed).toFixed(3) + "s");
          }
        }
      }
    }
    const isMidDeal = isPileHiddenMidDeal(view, player);
    if (view.playing_counts[player] > 0) {
      let pim = null;
      if (shown > 0) {
        if (isMidDeal) {
          const emptyRect = document.createElement("span");
          emptyRect.className = "pile-empty-slot";
          emptyRect.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:0;";
          pw.append(emptyRect);
        }
        pim = cardImg("card_back");
        pim.className = "seat-pile";
        pim.style.position = "relative";
        pim.style.zIndex = "1";
        if (isMidDeal) pim.style.visibility = "hidden";
        pw.append(pim);
      } else {
        const gh = document.createElement("span");
        gh.className = "seat-pile pile-ghost";
        pw.append(gh);
      }
      const badge = document.createElement("span");
      badge.className = "pile-count" + (lifted ? " lifted" : "");
      badge.textContent = shown;
      if (isMidDeal) badge.style.visibility = "hidden";
      const maxCards = Math.max(12, Math.ceil(54 / Math.max(2, n)));
      const ratio = Math.min(1, Math.max(0, shown / maxCards));
      badge.style.backgroundColor = `rgb(255, ${Math.round(249 - ratio * 42)}, ${Math.round(214 - ratio * 140)})`;
      pw.append(badge);
      if (player === myName && pim && !lifted) {
        pim.classList.add("clickable");
        attachHold(pim, { kind: "play" }, "Hold to lift your top card (keep holding), then press SPACE or let go over the middle");
        const kh = keyHint("D");
        if (isMidDeal) kh.style.visibility = "hidden";
        pw.append(kh);
      }
    } else {
      const s = document.createElement("span");
      s.className = "pile-empty-slot";
      pw.append(s);
    }
    cards.append(pw);
    if (shedEl) cards.append(shedEl);
    cards.append(stackEl);
    if (effRot % 360 !== 0)
      cards.querySelectorAll(".pile-count, .key-hint").forEach((el) => {
        el.style.transform = (el.classList.contains("key-hint") ? "translateX(-50%) " : "")
          + `rotate(${-effRot}deg)`;
      });
    seat.append(cards);
    const idRow = document.createElement("div");
    idRow.className = "seat-id";
    const tk = document.createElement("img");
    tk.className = "seat-tiki";
    tk.src = tikiSrc(player, players);
    tk.alt = "";
    const plate = document.createElement("div");
    plate.className = "plate";
    if (player === myName) {
      const st = document.createElement("img");
      st.className = "inline-ico";
      st.src = "/assets/ico_star.png";
      st.alt = "";
      plate.append(st, " ");
    }
    plate.append(document.createTextNode(player));
    idRow.append(tk, plate);
    if (isDisc) {
      const disc = document.createElement("img");
      disc.className = "seat-disc-ico";
      disc.src = "/assets/ico_disconnected.png";
      disc.alt = "Disconnected";
      disc.title = "Disconnected";
      idRow.append(disc);
    }
    seat.append(idRow);
    if (typeof updateHandCursorAppearance === "function") updateHandCursorAppearance(players);
    ring.append(seat);
    if (gameJustStarted && !reduceMotion) {
      enterTargets.push({ el: cards, base: `rotate(${effRot}deg)` });
      enterTargets.push({ el: idRow, base: "" });
      if (lobbyTikiRects && lobbyTikiRects[player]) {
        const srcR = lobbyTikiRects[player];
        const dstR = rectOf(tk);
        if (dstR) {
          const dx = (srcR.x + srcR.w / 2) - (dstR.x + dstR.w / 2);
          const dy = (srcR.y + srcR.h / 2) - (dstR.y + dstR.h / 2);
          tk.animate([
            { transform: `translate(${dx}px, ${dy}px) scale(1.22)`, opacity: 0.75 },
            { transform: "translate(0, 0) scale(1)", opacity: 1 }
          ], { duration: 1050, easing: "cubic-bezier(.22, 1, .36, 1)" });
        }
      }
    }

    // Ensure the name tag (.seat-id) is always separated below the rotated
    // visual bounding box of .seat-cards and never clips behind cards or
    // outside the table border.
    const rad = (effRot * Math.PI) / 180;
    const cw = cards.offsetWidth || (player === myName ? 210 : 184);
    const ch = Math.max(cards.offsetHeight || 0, player === myName ? 106 : 78);
    const visH = cw * Math.abs(Math.sin(rad)) + ch * Math.abs(Math.cos(rad));
    const visW = cw * Math.abs(Math.cos(rad)) + ch * Math.abs(Math.sin(rad));
    const extraY = Math.max(0, (visH - ch) / 2);
    const clearGap = phoneW ? 12 : 16;
    cards.style.marginTop = Math.ceil(extraY) + "px";
    idRow.style.marginTop = Math.ceil(extraY + clearGap) + "px";

    if (aw > 0 && ah > 0) {
      const fullW = Math.max(seat.offsetWidth || 0, visW + 20);
      const fullH = seat.offsetHeight || (visH + clearGap + 44);
      const padX = phoneW ? 6 : 12;
      const padTop = phoneW ? 8 : 14;
      const padBot = phoneW ? 8 : 12;
      const halfSW = Math.min(aw / 2 - 4, fullW / 2 + padX);
      const halfSH = Math.min(ah / 2 - 4, fullH / 2);
      const rawX = (parseFloat(seat.style.left) / 100) * aw;
      const rawY = (parseFloat(seat.style.top) / 100) * ah;
      const clampedX = Math.max(halfSW, Math.min(aw - halfSW, rawX));
      const clampedY = Math.max(halfSH + padTop, Math.min(ah - halfSH - padBot, rawY));
      seat.style.left = (clampedX / aw) * 100 + "%";
      seat.style.top = (clampedY / ah) * 100 + "%";
    }
  });
  if (gameJustStarted && !reduceMotion && enterTargets.length) {
    enterTargets
      .map((item) => ({ ...item, bottom: item.el.getBoundingClientRect().bottom }))
      .sort((a, b) => b.bottom - a.bottom)
      .forEach((item, idx) => {
        const prefix = item.base ? item.base + " " : "";
        item.el.animate([
          { opacity: 0, transform: `${prefix}scale(0.84)` },
          { opacity: 1, transform: `${prefix}scale(1)` }
        ], {
          duration: 1200,
          delay: 220 + idx * 100,
          easing: "cubic-bezier(.22, 1, .36, 1)",
          fill: "backwards"
        });
        playBreathePopSfx(220 + idx * 100, "in", idx);
      });
  }
}

let lastPhase = "open";
let lbDelayTimer = null;
let useCircularDeal = false;
function runMultiDealAnimation(view) {
  const ringEl = $("ring");
  const rr = ringEl ? ringEl.getBoundingClientRect() : null;
  const cx = rr && rr.width ? (rr.left + rr.width / 2) : (innerWidth / 2);
  const cy = rr && rr.height ? (rr.top + rr.height / 2) : (innerHeight / 2);
  const fromR = { x: cx - 32, y: cy - 44, w: 64, h: 88 };
  const dealPlayers = Object.keys(view.playing_counts || {});
  const getPileImg = (p) => { const s = seatEl(p); return s && s.querySelector(".seat-pile"); };
  const getPileBadge = (p) => { const s = seatEl(p); return s && s.querySelector(".pilewrap .pile-count"); };
  const getPileRect = (p) => {
    const s = seatEl(p);
    return cardRectOf(getPileImg(p) || (s && s.querySelector(".pilewrap"))) || fromR;
  };
  const getSlotImg = (p, slot) => {
    const s = seatEl(p);
    const list = s ? [...s.querySelectorAll(".backs .stack-wrap img")] : [];
    return list[slot] || null;
  };
  const getSlotRect = (p, slot) => cardRectOf(getSlotImg(p, slot)) || getPileRect(p);
  const pileImgs = dealPlayers.map((p) => getPileImg(p));
  const pileBadges = dealPlayers.map((p) => getPileBadge(p));
  const pileHints = dealPlayers.map((p) => {
    const pSeat = seatEl(p);
    return pSeat && pSeat.querySelector(".pilewrap .key-hint");
  });
  const slotImgs = dealPlayers.map((p) => {
    const pSeat = seatEl(p);
    return pSeat ? [...pSeat.querySelectorAll(".backs .stack-wrap img")] : [];
  });
  pileImgs.forEach((im) => { if (im) im.style.visibility = "hidden"; });
  pileBadges.forEach((b) => { if (b) b.style.visibility = "hidden"; });
  pileHints.forEach((h) => { if (h) h.style.visibility = "hidden"; });
  slotImgs.forEach((arr) => arr.forEach((im) => { if (im) im.style.visibility = "hidden"; }));
  setTimeout(() => {
    pileImgs.forEach((im) => { if (im) im.style.visibility = ""; });
    pileBadges.forEach((b) => { if (b) b.style.visibility = ""; });
    pileHints.forEach((h) => { if (h) h.style.visibility = ""; });
    document.querySelectorAll(".pilewrap .pile-empty-slot").forEach((el) => el.remove());
  }, Math.max(2500, (dealPlayers.length * 1100) + 2800));

  const stage = document.createElement("div");
  stage.className = "tut-shuffle-stage";
  stage.style.left = cx + "px";
  stage.style.top = cy + "px";
  ["left", "right"].forEach((side) => {
    const half = document.createElement("div");
    half.className = "tut-shuffle-half " + side;
    for (let i = 0; i < 6; i++) {
      const im = cardImg("card_back");
      im.style.left = "16px";
      im.style.top = (i * -1.5) + "px";
      half.append(im);
    }
    stage.append(half);
  });
  fxLayer().append(stage);
  playDealPopSfx(0, 0, "shuffle");
  vibrate(18);

  useCircularDeal = !useCircularDeal;
  const circularMode = useCircularDeal;
  const cardDur = 950;
  const dealStartMs = 680;

  if (circularMode) {
    const radius = 84;
    const circleDelay = dealStartMs;
    const streamStartMs = circleDelay + 820;
    const perPlayerCards = 4;
    const perCardDelay = 85;
    const perPlayerPause = 150;
    let totalCards = 0;
    dealPlayers.forEach((p) => {
      const stackN = ((view.stacking_hands && view.stacking_hands[p]) || []).filter(Boolean).length;
      totalCards += perPlayerCards + stackN;
    });
    const circleCount = Math.max(12, totalCards);
    let totalStackCards = 0;
    const streamDur = dealPlayers.reduce((acc, p) => {
      const stackN = ((view.stacking_hands && view.stacking_hands[p]) || []).filter(Boolean).length;
      totalStackCards += stackN;
      return acc + (perPlayerCards + stackN) * perCardDelay + perPlayerPause;
    }, 0);
    const stackStartOffset = streamDur + cardDur + 80;
    const stackStepMs = 115;
    const stackDur = 620;
    const totalDur = streamStartMs + stackStartOffset + totalStackCards * stackStepMs + stackDur + 120;
    const dealBaseAt = Date.now();
    dealingUntil = dealBaseAt + totalDur;
    playLockedUntil = dealBaseAt + totalDur + 1400;
    dealReveal = { pilesAt: {}, slotsAt: {} };

    setTimeout(() => {
      stage.remove();
      const ringWrap = document.createElement("div");
      ringWrap.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;width:0;height:0;z-index:42;pointer-events:none;`;
      const ringCards = [];
      for (let i = 0; i < circleCount; i++) {
        const ang = (Math.PI * 2 * i) / circleCount;
        const im = cardImg("card_back");
        im.style.cssText = "position:absolute;left:-22px;top:-30px;width:44px;height:60px;border-radius:5px;box-shadow:0 3px 8px rgba(0,0,0,.45);";
        ringWrap.append(im);
        const tx = Math.cos(ang) * radius;
        const ty = Math.sin(ang) * radius;
        const deg = (ang * 180 / Math.PI) + 90;
        im.animate([
          { transform: "translate(0px,0px) rotate(0deg) scale(0.7)", opacity: 0.2 },
          { transform: `translate(${tx.toFixed(1)}px,${ty.toFixed(1)}px) rotate(${deg.toFixed(1)}deg) scale(1)`, opacity: 1 }
        ], { duration: 480, delay: i * 14, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" });
        ringCards.push(im);
      }
      fxLayer().append(ringWrap);
      ringWrap.animate([
        { transform: "rotate(0deg)" },
        { transform: "rotate(360deg)" }
      ], { duration: 820 + streamDur + 120, easing: "linear", fill: "forwards" });
      playDealPopSfx(120, 1, "deal");

      setTimeout(() => {
        let cursorMs = 0;
        let cardSeq = 0;
        const peelFromCircle = (toRect, cardName, opts = {}) => {
          const tx = toRect.x + toRect.w / 2;
          const ty = toRect.y + toRect.h / 2;
          let bestIdx = 0;
          let bestDist = Infinity;
          let bestBr = null;
          for (let i = 0; i < ringCards.length; i++) {
            const c = ringCards[i];
            if (!c || !c.isConnected) continue;
            const br = c.getBoundingClientRect();
            if (!br || !br.width) continue;
            const d = Math.hypot((br.left + br.width / 2) - tx, (br.top + br.height / 2) - ty);
            if (d < bestDist) { bestDist = d; bestIdx = i; bestBr = br; }
          }
          const rc = ringCards.length ? ringCards.splice(bestIdx, 1)[0] : null;
          let fromR2 = { x: cx - 22, y: cy - 30, w: 48, h: 66 };
          if (rc && rc.isConnected) {
            const br = bestBr || rc.getBoundingClientRect();
            if (br && br.width) fromR2 = { x: br.left, y: br.top, w: br.width, h: br.height };
            rc.remove();
          }
          flyCard(fromR2, toRect, cardName, { ...opts, delay: 0, duration: cardDur });
        };

        dealPlayers.forEach((p, pIdx) => {
          const stackHands = (view.stacking_hands && view.stacking_hands[p]) || [];
          const playerCardCount = perPlayerCards + stackHands.filter(Boolean).length;
          dealReveal.pilesAt[p] = dealBaseAt + streamStartMs + cursorMs + cardDur;
          for (let k = 0; k < playerCardCount; k++) {
            const d = cursorMs + k * perCardDelay;
            const isFirst = k === 0;
            setTimeout(() => {
              peelFromCircle(getPileRect(p), "card_back", {
                hideEl: isFirst ? getPileImg(p) : null,
                hideAlso: isFirst ? getPileBadge(p) : null,
              });
              playSfx("stack");
              if (k === 0) vibrate(10);
            }, d);
          }
          cursorMs += playerCardCount * perCardDelay + perPlayerPause;
        });
        let sIdx = 0;
        const maxSlots = Math.max(1, ...dealPlayers.map((p) => ((view.stacking_hands && view.stacking_hands[p]) || []).length));
        for (let slot = 0; slot < maxSlots; slot++) {
          for (let pIdx = 0; pIdx < dealPlayers.length; pIdx++) {
            const p = dealPlayers[pIdx];
            const cname = view.stacking_hands && view.stacking_hands[p] && view.stacking_hands[p][slot];
            if (cname) {
              const sDelay = stackStartOffset + sIdx * stackStepMs;
              dealReveal.slotsAt[p + "|" + slot] = dealBaseAt + streamStartMs + sDelay + stackDur;
              setTimeout(() => {
                flyCard(getPileRect(p), getSlotRect(p, slot), cname, { flip: true, delay: 0, duration: stackDur, hideEl: getSlotImg(p, slot) });
              }, sDelay);
              setTimeout(() => playSfx("stack"), sDelay + stackDur);
              sIdx++;
            }
          }
        }
        setTimeout(() => { ringWrap.remove(); }, cursorMs + 80);
        setTimeout(() => {
          playDealPopSfx(0, totalCards, "land");
          vibrate([20, 24, 24]);
          const starter = view.turn_player || dealPlayers[0];
          if (starter) {
            playLockedUntil = Date.now() + 1400;
            bigEvent(`${starter} starts`, "start", 1400);
          } else {
            playLockedUntil = 0;
          }
        }, stackStartOffset + sIdx * stackStepMs + stackDur);
      }, 820);
    }, dealStartMs);
    return;
  }

  const pileThrows = Math.max(dealPlayers.length * 3, 16);
  const pileDelayStep = 95;
  const stackDelayBase = (pileThrows - 1) * pileDelayStep + cardDur + 80;
  const stackDelayStep = 115;
  const stackDur = 620;
  let totalStackCards = 0;
  dealPlayers.forEach((p) => { totalStackCards += ((view.stacking_hands && view.stacking_hands[p]) || []).filter(Boolean).length; });
  const dealBaseAt = Date.now();
  dealingUntil = dealBaseAt + dealStartMs + stackDelayBase + totalStackCards * stackDelayStep + stackDur + 120;
  playLockedUntil = dealingUntil + 1400;
  dealReveal = { pilesAt: {}, slotsAt: {} };

  setTimeout(() => {
    stage.remove();
    for (let i = 0; i < pileThrows; i++) {
      const pIdx = i % dealPlayers.length;
      const p = dealPlayers[pIdx];
      const d = i * pileDelayStep;
      const isFirstForPlayer = i < dealPlayers.length;
      if (isFirstForPlayer) {
        dealReveal.pilesAt[p] = dealBaseAt + dealStartMs + d + cardDur;
      }
      setTimeout(() => {
        flyCard(fromR, getPileRect(p), "card_back", {
          delay: 0,
          duration: cardDur,
          hideEl: isFirstForPlayer ? getPileImg(p) : null,
          hideAlso: isFirstForPlayer ? getPileBadge(p) : null,
        });
        playSfx("stack");
        if (i % Math.max(1, dealPlayers.length) === 0) vibrate(10);
      }, d);
    }
    let sIdx = 0;
    const maxSlots = Math.max(1, ...dealPlayers.map((p) => ((view.stacking_hands && view.stacking_hands[p]) || []).length));
    for (let slot = 0; slot < maxSlots; slot++) {
      for (let pIdx = 0; pIdx < dealPlayers.length; pIdx++) {
        const p = dealPlayers[pIdx];
        const cname = view.stacking_hands && view.stacking_hands[p] && view.stacking_hands[p][slot];
        if (cname) {
          const sDelay = stackDelayBase + sIdx * stackDelayStep;
          dealReveal.slotsAt[p + "|" + slot] = dealBaseAt + dealStartMs + sDelay + stackDur;
          setTimeout(() => {
            flyCard(getPileRect(p), getSlotRect(p, slot), cname, { flip: true, delay: 0, duration: stackDur, hideEl: getSlotImg(p, slot) });
          }, sDelay);
          setTimeout(() => playSfx("stack"), sDelay + stackDur);
          sIdx++;
        }
      }
    }
    setTimeout(() => {
      playDealPopSfx(0, sIdx, "land");
      vibrate([20, 24, 24]);
      const starter = view.turn_player || dealPlayers[0];
      if (starter) {
        playLockedUntil = Date.now() + 1400;
        bigEvent(`${starter} starts`, "start", 1400);
      } else {
        playLockedUntil = 0;
      }
    }, stackDelayBase + sIdx * stackDelayStep + stackDur);
  }, dealStartMs);
}

function renderActions(view, oldView) {
  lastPhase = view.phase;
  const info = $("action-info"), box = $("tiki-box");
  info.textContent = "";
  const fastBtn = $("fast-bots-btn");
  if (fastBtn) {
    const bots = Array.isArray(view.bots) ? view.bots : [];
    const dropped = Array.isArray(view.dropped) ? view.dropped : [];
    const fin = Array.isArray(view.finished) ? view.finished : [];
    const allP = Array.isArray(view.players) ? view.players : Object.keys(view.playing_counts || {});
    const humans = allP.filter((p) => !bots.includes(p) && !dropped.includes(p));
    const canFast = !!(view.started && view.phase !== "over" && view.host === myName && bots.length > 0 && humans.length > 0 && humans.every((p) => fin.includes(p)));
    fastBtn.hidden = !canFast;
    if (canFast) {
      fastBtn.classList.toggle("active", !!view.fast_bots);
      fastBtn.textContent = view.fast_bots ? "Turbo bots: ON" : "Speed up bots";
    }
  }
  if (typeof renderKeyDebug === "function") renderKeyDebug();
  if (oldView && oldView.started && view.started && oldView.phase !== "over" && (oldView.middle_count || 0) > 0 && (view.middle_count || 0) === 0) {
    playPickupSfx();
  }
  if (view.phase !== "freaky") {
    stopFreakyThudLoop();
    box.classList.remove("callable");
    fpActive = false; fpReset();
  }
  if (view.phase === "over") {
    $("status").innerHTML = `Winner: ${view.ranking[0]} - ranking: ${view.ranking.join(", ")} - losers: ${view.losers.join(", ")}`;
    const justEnded = !!(oldView && oldView.started && oldView.phase !== "over");
    if (justEnded && !reduceMotion) {
      if (!lbDelayTimer && $("leaderboard").hidden) {
        lbDelayTimer = setTimeout(() => {
          lbDelayTimer = null;
          if (prevView && prevView.phase === "over") showLeaderboard(prevView);
        }, 2100);
      }
    } else if (!lbDelayTimer) {
      showLeaderboard(view);
    }
    return;
  }
  clearTimeout(lbDelayTimer); lbDelayTimer = null;
  $("leaderboard").hidden = true;
  lbShownFor = null;
  stopEndScreenSfx();
  if (view.last_drop && view.last_drop.seq > lastDropSeq) {
    lastDropSeq = view.last_drop.seq;
    const d = view.last_drop;
    const cardTxt = d.cards > 0
      ? `their ${d.cards} card${d.cards === 1 ? "" : "s"} went to the bottom of the middle stack`
      : "they had no cards left";
    pushStackMsg(`${d.player} was kicked for inactivity — ${cardTxt}`, "miss");
    showError(`${d.player} disconnected for too long and was removed — ${cardTxt}.`, true);
  }
  const updateDecisionTimer = (key, label, rawLeft) => {
    const jt = $("joker-timer");
    if (!jt) return;
    if (!key || rawLeft == null) {
      jt.hidden = true;
      jt.classList.remove("urgent");
      jt.dataset.timerKey = "";
      jt.dataset.lastTick = "";
      return;
    }
    const left = Math.max(0, Number(rawLeft));
    const secs = Math.max(0, Math.ceil(left));
    const total = Math.max(10, left);
    if (jt.dataset.timerKey !== key) {
      jt.dataset.timerKey = key;
      jt.dataset.lastTick = "";
      const elapsed = Math.max(0, total - left);
      jt.innerHTML = `<div class="joker-timer-clock" style="--jt-dur:${total}s;--jt-delay:-${elapsed.toFixed(3)}s"></div><span class="joker-timer-lbl"></span>`;
    }
    if (jt.dataset.lastTick !== String(secs) && secs > 0) {
      jt.dataset.lastTick = String(secs);
      playClockTickSfx(secs <= 3);
    }
    const lbl = jt.querySelector(".joker-timer-lbl");
    if (lbl) lbl.textContent = `${label}: ${secs}s`;
    jt.hidden = false;
    jt.classList.toggle("urgent", secs <= 3);
  };
  if (view.phase === "freaky" && view.freaky) {
    const f = view.freaky;
    const shed = Object.values(f.shed_counts).reduce((a, b) => a + b, 0);
    const mine = f.player === myName;
    updateDecisionTimer("freaky|" + f.player + "|" + view.middle_count, "Auto", f.seconds_left);
    if (mine) {
      if (!box.classList.contains("callable")) fpReset();
      box.classList.add("callable");
      fpActive = true;
      $("tiki-label").textContent = `Click me! ${fpStep}/${FP_CLICKS}`;
      info.textContent = `You matched the top card! Click the tiki ${FP_CLICKS} times to call it before everyone sheds onto you - ${f.seconds_left}s`;
    } else {
      box.classList.remove("callable");
      fpActive = false;
      $("tiki-label").textContent = `${f.player} must call it`;
      info.textContent = `${f.player} has to call Freaky Tiki - shed fast: ${shedVerb().toLowerCase()} your dotted box! ${shed} card(s) shed - ${f.seconds_left}s`;
    }
    return;
  }
  if (view.phase === "joker_choose" && view.joker && view.joker.seconds_left != null) {
    updateDecisionTimer("joker|" + view.joker.winner + "|" + view.middle_count, "Choose", view.joker.seconds_left);
  } else if (view.phase === "open" && view.standstill && view.standstill.seconds_left != null) {
    updateDecisionTimer("standstill|" + view.middle_count, "No moves", view.standstill.seconds_left);
  } else {
    updateDecisionTimer(null, "", null);
  }
  if ((view.phase === "joker" || view.phase === "joker_choose") && view.joker) {
    const j = view.joker;
    if (view.phase === "joker") {
      info.textContent =
        `JOKER by ${j.placer}${j.from_stacking ? " (from their stacking hand)" : ""} - slap it! Click the middle stack or mash SPACE: ${j.your_presses}/${j.your_threshold}`;
    } else if (j.winner === myName) {
      const allP = Array.isArray(view.players) ? view.players : Object.keys(view.playing_counts || {});
      const activeP = allP.filter((p) => !(view.finished || []).includes(p) && !(view.dropped || []).includes(p));
      const blocked = activeP.filter((p) => !(j.targets || []).includes(p));
      info.textContent = blocked.length
        ? `You slapped first! Drag the middle stack onto a player (${blocked.join(", ")} can't get it 3 times in a row).`
        : "You slapped first! Drag the middle stack onto a player to give it to them.";
    } else {
      info.textContent = `${j.winner} slapped first and is choosing who gets the stack…`;
    }
    return;
  }
  if (view.phase === "open" && view.standstill && view.standstill.seconds_left != null) {
    info.textContent = `No legal moves left! Everyone still holding cards loses in ${Math.ceil(view.standstill.seconds_left)}s…`;
    return;
  }
  if (view.awaiting_deal) {
    info.textContent = view.host === myName
      ? "Click the deck in the middle to deal out the cards!"
      : `Waiting for ${view.host} to deal the cards…`;
  } else if (view.phase === "stacked") info.textContent = view.stackers.length
    ? `Stacked by ${view.stackers.join(", ")} - a stacker starts the next turn after 2 quiet seconds`
    : "Stacked (no playing cards left to start) - play resumes after 2 quiet seconds";
  else if (view.phase === "stacker_start") info.textContent =
    view.stackers.includes(myName) ? "You stacked - you may start the next turn now" : `Waiting for a stacker (${view.stackers.join(", ")}) to start the next turn`;
  else if (view.phase === "open" && view.turn_player === myName && view.your_playing_count > 0)
    info.textContent = "Lift your pile (hold it, or hold P), then drop it on the middle - SPACE, or let go over the stack";
}

function wsSend(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
let pendingStack = null;
function send(obj) {
  if (obj && obj.type === "move" && obj.move && obj.move.type === "stack"
      && prevView && prevView.started && prevView.stacking_hands) {
    const c = (prevView.stacking_hands[obj.move.owner] || [])[obj.move.slot];
    if (c && prevView.middle_top)
      pendingStack = { card: c, target: prevView.middle_top, at: Date.now() };
  }
  if (practice) practiceSend(obj); else wsSend(obj);
}
function graceSaveCheck(errText) {
  if (pendingStack && errText && errText.includes("grace period")
      && Date.now() - pendingStack.at < 3000) {
    const wasValid = pWithin(pendingStack.card, pendingStack.target);
    const msg = wasValid
      ? `Middle card just changed before your ${rankLabel(pendingStack.card)} landed - grace period saved you`
      : `Stack Miss! ${rankLabel(pendingStack.card)} on ${rankLabel(pendingStack.target)} - the grace period saved you`;
    stackMsg(msg, "grace");
    vibrate([15, 25, 15]);
    pendingStack = null;
    return true;
  }
  pendingStack = null;
  return false;
}

function renderWaitingRoomPanel(container, view) {
  if (!container) return;
  const waiting = (view && view.waiting_players) || [];
  container.replaceChildren();
  if (!waiting.length) { container.hidden = true; return; }
  container.hidden = false;
  const isHost = view && view.host === myName;
  const head = document.createElement("div");
  head.className = "waiting-room-head";
  const title = document.createElement("span");
  title.className = "waiting-room-title";
  title.textContent = `Waiting room (${waiting.length})`;
  head.append(title);
  if (isHost && waiting.length > 1) {
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "waiting-admit-all";
    allBtn.textContent = "Admit all";
    allBtn.addEventListener("click", () => send({ type: "admit", admit_all: true }));
    head.append(allBtn);
  }
  const list = document.createElement("div");
  list.className = "waiting-room-list";
  waiting.forEach((p) => {
    const chip = document.createElement("div");
    chip.className = "waiting-chip";
    const nm = document.createElement("span");
    nm.textContent = p + (p === myName ? " (you)" : "");
    chip.append(nm);
    if (isHost) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "waiting-admit-btn";
      btn.textContent = "Admit";
      btn.addEventListener("click", () => send({ type: "admit", target: p }));
      chip.append(btn);
    }
    list.append(chip);
  });
  container.append(head, list);
}

let lastJoinMsg = null;
let intentionalLeave = false;
function loadLastSession() {
  try {
    const raw = localStorage.getItem("ft_last_session");
    if (!raw) return null;
    const s = JSON.parse(raw);
    return (s && s.room && s.name) ? s : null;
  } catch (e) { return null; }
}
function saveLastSession(room, name) {
  try { localStorage.setItem("ft_last_session", JSON.stringify({ room, name })); } catch (e) { /* private mode */ }
}
function clearLastSession() {
  try { localStorage.removeItem("ft_last_session"); } catch (e) { /* private mode */ }
}
function syncRejoinHome() {
  const btn = $("rejoin-home");
  if (!btn) return;
  const s = loadLastSession();
  if (s) {
    btn.hidden = false;
    btn.textContent = `Rejoin ${s.room} (${s.name})`;
    fetch(`/api/room/${encodeURIComponent(s.room)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d && d.exists === false) {
          clearLastSession();
          if (lastJoinMsg && lastJoinMsg.room === s.room) lastJoinMsg = null;
          btn.hidden = true;
        }
      })
      .catch(() => {});
  } else {
    btn.hidden = true;
  }
}
syncRejoinHome();

let chatMessages = [];
let chatOpen = false;
let chatUnread = 0;
const speechBubbles = new Map();
function syncSpeechBubbles() {
  const now = Date.now();
  document.querySelectorAll(".speech-bubble").forEach((el) => el.remove());
  for (const [player, entry] of [...speechBubbles.entries()]) {
    if (!entry || now >= entry.expiresAt) {
      if (entry && entry.timer) clearTimeout(entry.timer);
      speechBubbles.delete(player);
      continue;
    }
    const host = document.querySelector(`.seat[data-player="${CSS.escape(player)}"]`) ||
                 document.querySelector(`.lobby-player[data-player="${CSS.escape(player)}"]`);
    if (!host) continue;
    const b = document.createElement("div");
    b.className = "speech-bubble";
    if (host.classList.contains("seat") && parseFloat(host.style.top || "50") < 26) {
      b.classList.add("below");
    }
    b.textContent = entry.text;
    host.append(b);
  }
}
function showSpeechBubble(player, text) {
  if (!player || !text || document.hidden) return;
  const prev = speechBubbles.get(player);
  if (prev && prev.timer) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    speechBubbles.delete(player);
    syncSpeechBubbles();
  }, 4500);
  speechBubbles.set(player, { text, expiresAt: Date.now() + 4500, timer });
  syncSpeechBubbles();
}

function renderChatLog() {
  const logEl = $("chat-log");
  if (!logEl) return;
  logEl.replaceChildren();
  if (!chatMessages.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.textContent = "No messages yet";
    logEl.append(empty);
    return;
  }
  chatMessages.forEach((m) => {
    const row = document.createElement("div");
    row.className = "chat-msg";
    const sender = document.createElement("span");
    sender.className = "chat-sender";
    const cIdx = ((Number(m.color) || 0) % GRAB_COLORS.length + GRAB_COLORS.length) % GRAB_COLORS.length;
    sender.style.color = GRAB_COLORS[cIdx];
    sender.textContent = (m.sender || "Player") + ":";
    const body = document.createElement("span");
    body.className = "chat-text";
    body.textContent = m.text || "";
    row.append(sender, body);
    logEl.append(row);
  });
  logEl.scrollTop = logEl.scrollHeight;
}

function updateChatUnreadBadge() {
  const badge = $("chat-unread");
  if (!badge) return;
  badge.textContent = String(chatUnread);
  badge.hidden = chatOpen || chatUnread <= 0;
}

function setChatOpen(open) {
  chatOpen = !!open;
  if ($("chat-panel")) $("chat-panel").hidden = !chatOpen;
  if ($("chat-toggle")) {
    $("chat-toggle").hidden = chatOpen;
    $("chat-toggle").setAttribute("aria-expanded", chatOpen ? "true" : "false");
  }
  if (chatOpen) {
    chatUnread = 0;
    updateChatUnreadBadge();
    renderChatLog();
    if ($("chat-input")) $("chat-input").focus();
  } else {
    updateChatUnreadBadge();
  }
}

function syncChatVisibility(isPractice) {
  const box = $("chat-box");
  if (!box) return;
  const show = !isPractice && !$("game-box").hidden;
  box.hidden = !show;
  if (show) {
    if ($("chat-panel")) $("chat-panel").hidden = !chatOpen;
    if ($("chat-toggle")) $("chat-toggle").hidden = chatOpen;
    updateChatUnreadBadge();
  }
}

function appendChatMessage(item) {
  if (!item || !item.text) return;
  chatMessages.push(item);
  if (chatMessages.length > 60) chatMessages.shift();
  if (!chatOpen && item.sender !== myName) chatUnread += 1;
  updateChatUnreadBadge();
  renderChatLog();
  showSpeechBubble(item.sender, item.text);
}

if ($("chat-toggle")) $("chat-toggle").addEventListener("click", () => setChatOpen(true));
if ($("chat-close")) $("chat-close").addEventListener("click", () => setChatOpen(false));
if ($("chat-form")) $("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const inp = $("chat-input");
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) return;
  wsSend({ type: "chat", text });
  inp.value = "";
});

function connect(joinMsg) {
  intentionalLeave = false;
  if (ws && ws.readyState < 2) { try { ws.close(); } catch (e) { /* ignore */ } }
  if (!joinMsg.solo) {
    lastJoinMsg = { type: "join", room: joinMsg.room, name: joinMsg.name };
    saveLastSession(joinMsg.room, joinMsg.name);
    syncRejoinHome();
  } else {
    lastJoinMsg = null;
  }
  if ($("disconnect-bar")) $("disconnect-bar").hidden = true;
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  ws = new WebSocket(proto + location.host + "/ws");
  ws.addEventListener("open", () => {
    if ($("disconnect-bar")) $("disconnect-bar").hidden = true;
    send({ ...joinMsg, preferred_color: preferredColor });
    log(`Joined room ${joinMsg.room} as ${myName}`);
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "error") { if (!graceSaveCheck(msg.error)) showError(msg.error); else showError(""); if (!practice) refreshTable(); log("Error: " + msg.error); return; }
    if (msg.type === "key_debug") { recordKeyDebug("SRV", msg.action || `${msg.key || "?"} (${msg.code || ""})`, msg.phase); return; }
    if (msg.type === "chat") { if (msg.message) appendChatMessage(msg.message); return; }
    if (!msg.view.started) lastLobbyView = msg.view;
    if (practice) {
      if (msg.view.started) { endPractice(); render(msg.view); }
      else { refreshCoachReal(); }
      return;
    }
    render(msg.view); log(msg.type + " update received");
  });
  ws.addEventListener("close", () => {
    log("Disconnected from server.");
    if (!intentionalLeave && !$("game-box").hidden) {
      if (lastJoinMsg && $("disconnect-bar")) {
        $("disconnect-msg").textContent = `Disconnected from ${lastJoinMsg.room}.`;
        $("disconnect-bar").hidden = false;
      } else {
        showError("Disconnected. To get your seat back, rejoin with the SAME name and room code.", true);
      }
    }
  });
}
window.addEventListener("pagehide", () => {
  if (ws && ws.readyState < 2) { try { ws.close(1000, "pagehide"); } catch (e) { /* ignore */ } }
});
window.addEventListener("beforeunload", () => {
  if (ws && ws.readyState < 2) { try { ws.close(1000, "unload"); } catch (e) { /* ignore */ } }
});

if ($("rejoin-home")) $("rejoin-home").addEventListener("click", () => {
  const s = loadLastSession();
  if (!s) return;
  myName = s.name;
  if ($("name")) $("name").value = s.name;
  if ($("room")) $("room").value = s.room;
  connect({ type: "join", room: s.room, name: s.name });
});
if ($("rejoin-btn")) $("rejoin-btn").addEventListener("click", () => {
  const s = lastJoinMsg || loadLastSession();
  if (!s) return;
  myName = s.name;
  connect({ type: "join", room: s.room, name: s.name });
});
if ($("disconnect-home")) $("disconnect-home").addEventListener("click", () => leaveToHome());

function loadPublicRooms() {
  const list = $("public-rooms-list");
  if (!list) return;
  list.innerHTML = '<div class="public-rooms-empty">Loading public rooms…</div>';
  fetch("/api/rooms")
    .then((r) => r.ok ? r.json() : { rooms: [] })
    .then((data) => {
      const rooms = (data && data.rooms) || [];
      list.replaceChildren();
      if (!rooms.length) {
        const empty = document.createElement("div");
        empty.className = "public-rooms-empty";
        empty.textContent = "No public rooms open right now";
        list.append(empty);
        return;
      }
      rooms.forEach((rm) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "public-room-item";
        const left = document.createElement("span");
        left.className = "public-room-code";
        left.textContent = rm.code;
        const act = document.createElement("span");
        act.className = "public-room-join";
        act.textContent = "Join";
        const right = document.createElement("span");
        right.className = "public-room-meta";
        const cap = rm.max_players ? `/${rm.max_players}` : "";
        right.textContent = `Host: ${rm.host || "?"} • ${rm.players}${cap} player${rm.players === 1 ? "" : "s"}${rm.started ? " • In game" : ""}`;
        row.append(left, act, right);
        row.addEventListener("click", () => {
          if ($("room")) $("room").value = rm.code;
          const nm = ($("name") && $("name").value.trim()) || "";
          if (!nm) {
            showError("Enter your name first.");
            if ($("name")) $("name").focus();
            return;
          }
          myName = nm;
          connect({ type: "join", room: rm.code, name: myName });
        });
        list.append(row);
      });
    })
    .catch(() => {
      list.innerHTML = '<div class="public-rooms-empty">Could not load public rooms</div>';
    });
}
const PRESET_ROOM_CODES = [
  "TIKI", "TKI2", "TKI3", "TKI4", "TKI5",
  "TKI6", "TKI7", "TKI8", "TKI9", "FRKY", "FRKI",
  "GUHH", "SGMA", "SUSY", "SUSY", "BAKA", "SUSS", 
  "NOAH", "JAME", "ERIC", "ASLI", "AMYS", "NTHN", 
  "ICDN", "MRMA", "JITT", "SXSV", "MONY", "HHID",
  "BLEH", "BLUH", "ILYJ", "ILYN", "ILYE", "ILYL",
  "LDFB", "BLIK", "NTCE", "FRKB", "SIGH", "YUMM"
];
const skippedRoomCodes = new Set();
function genRoomCode(excludeSet) {
  const blocked = excludeSet instanceof Set ? excludeSet : new Set(excludeSet ? [excludeSet] : []);
  const availablePresets = PRESET_ROOM_CODES.filter((code) => !blocked.has(code));
  if (availablePresets.length && Math.random() < 0.80) {
    return availablePresets[Math.floor(Math.random() * availablePresets.length)];
  }
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (let attempt = 0; attempt < 64; attempt++) {
    let out = "";
    for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
    if (!blocked.has(out)) return out;
  }
  let out = "";
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
let roomCodeReqSeq = 0;
function assignNextRoomCode(excludeCode) {
  const el = $("create-room-code");
  if (!el) return;
  const ex = (excludeCode || "").trim().toUpperCase();
  if (ex) skippedRoomCodes.add(ex);
  const reqId = ++roomCodeReqSeq;
  const excludeList = [...skippedRoomCodes].join(",");
  const qs = excludeList ? `?exclude=${encodeURIComponent(excludeList)}` : "";
  fetch(`/api/next_room_code${qs}`)
    .then((r) => r.ok ? r.json() : null)
    .then((data) => {
      if (reqId !== roomCodeReqSeq) return;
      el.textContent = (data && data.code) ? data.code : genRoomCode(skippedRoomCodes);
    })
    .catch(() => {
      if (reqId !== roomCodeReqSeq) return;
      el.textContent = genRoomCode(skippedRoomCodes);
    });
}
function setMpTab(mode) {
  const showJoin = mode === "join";
  const showCreate = mode === "create";
  if ($("mp-join-tab")) $("mp-join-tab").classList.toggle("active", showJoin);
  if ($("mp-create-tab")) $("mp-create-tab").classList.toggle("active", showCreate);
  if ($("mp-join-panel")) $("mp-join-panel").hidden = !showJoin;
  if ($("mp-create-panel")) $("mp-create-panel").hidden = !showCreate;
  showError("");
  if (showCreate) {
    if ($("create-public")) $("create-public").checked = true;
    assignNextRoomCode();
  } else if (showJoin) {
    loadPublicRooms();
  }
}
let _pageBlurInit = false;
function triggerPageBlur(targetEl) {
  if (reduceMotion) return;
  let veil = document.getElementById("page-blur-veil");
  if (!veil) {
    veil = document.createElement("div");
    veil.id = "page-blur-veil";
    veil.setAttribute("aria-hidden", "true");
    document.body.append(veil);
  }
  veil.classList.remove("active");
  void veil.offsetWidth;
  veil.classList.add("active");
  if (targetEl) {
    targetEl.classList.remove("page-blur-in");
    void targetEl.offsetWidth;
    targetEl.classList.add("page-blur-in");
    clearTimeout(targetEl._blurInTimer);
    targetEl._blurInTimer = setTimeout(() => targetEl.classList.remove("page-blur-in"), 260);
  }
}
function clearHomeDissolve(el) {
  if (!el) return;
  clearTimeout(el._dissolveTimer);
  el._dissolveTimer = null;
  if (el._dissolveAnim) {
    try { el._dissolveAnim.cancel(); } catch (e) {}
    el._dissolveAnim = null;
  }
  el.style.position = "";
  el.style.left = "";
  el.style.top = "";
  el.style.width = "";
  el.style.margin = "";
  el.style.pointerEvents = "";
  el.style.zIndex = "";
}
function showHomeSubpage(page, skipBlur = false) {
  const joinBox = $("join-box");
  const pages = [$("home-menu"), $("multiplayer-view"), $("practice-view")];
  const outgoing = pages.find((el) => el && !el.hidden && !el._dissolvingOut) || null;
  const target = page === "multiplayer" ? $("multiplayer-view")
    : page === "practice" ? $("practice-view") : $("home-menu");
  const shouldCrossDissolve = _pageBlurInit && !skipBlur && !reduceMotion && outgoing && outgoing !== target && joinBox && !joinBox.hidden;

  // Clean up any other stale dissolving pages
  pages.forEach((el) => {
    if (!el || el === target) return;
    if (shouldCrossDissolve && el === outgoing) return;
    el._dissolvingOut = false;
    clearHomeDissolve(el);
    el.hidden = true;
  });

  if (shouldCrossDissolve) {
    const isFixed = getComputedStyle(outgoing).position === "fixed";
    const jr = joinBox.getBoundingClientRect();
    const r = outgoing.getBoundingClientRect();
    outgoing._dissolvingOut = true;
    clearHomeDissolve(outgoing);
    outgoing.style.pointerEvents = "none";
    if (!isFixed && r.width && r.height) {
      outgoing.style.position = "absolute";
      outgoing.style.left = (r.left - jr.left) + "px";
      outgoing.style.top = (r.top - jr.top) + "px";
      outgoing.style.width = r.width + "px";
      outgoing.style.margin = "0";
      outgoing.style.zIndex = "2";
    }
    const finishOut = () => {
      outgoing._dissolvingOut = false;
      clearHomeDissolve(outgoing);
      outgoing.hidden = true;
    };
    outgoing._dissolveAnim = outgoing.animate([
      { opacity: 1 },
      { opacity: 0 },
    ], { duration: 260, easing: "ease-out", fill: "forwards" });
    outgoing._dissolveAnim.onfinish = finishOut;
    outgoing._dissolveTimer = setTimeout(finishOut, 290);
  }

  if (target) {
    target._dissolvingOut = false;
    clearHomeDissolve(target);
    target.hidden = false;
  }
  _pageBlurInit = true;
  showError("");
  if (page === "menu") {
    syncRejoinHome();
    if (typeof applyHomeBtnPositions === "function") applyHomeBtnPositions();
  } else if (page === "multiplayer") {
    skippedRoomCodes.clear();
    if ($("create-room-code")) $("create-room-code").textContent = "";
    setMpTab(null);
    if ($("name") && !$("name").value.trim()) $("name").focus();
  } else if (page === "practice") {
    if ($("practice-name") && !$("practice-name").value.trim() && $("name") && $("name").value.trim()) {
      $("practice-name").value = $("name").value.trim();
    }
  }

  if (shouldCrossDissolve && target) {
    target._dissolveAnim = target.animate([
      { opacity: 0 },
      { opacity: 1 },
    ], { duration: 260, easing: "ease-out" });
    target._dissolveTimer = setTimeout(() => { target._dissolveAnim = null; }, 280);
  }
}
if ($("home-multiplayer")) $("home-multiplayer").addEventListener("click", () => showHomeSubpage("multiplayer"));
if ($("home-practice")) $("home-practice").addEventListener("click", () => showHomeSubpage("practice"));
if ($("mp-back")) $("mp-back").addEventListener("click", () => showHomeSubpage("menu"));
if ($("practice-back")) $("practice-back").addEventListener("click", () => showHomeSubpage("menu"));
if ($("mp-join-tab")) $("mp-join-tab").addEventListener("click", () => {
  setMpTab("join");
  setTimeout(() => { if ($("room")) $("room").focus(); }, 0);
});
if ($("mp-create-tab")) $("mp-create-tab").addEventListener("click", () => {
  setMpTab("create");
  setTimeout(() => { if ($("create-room")) $("create-room").focus(); }, 0);
});
if ($("name")) $("name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if ($("mp-join-tab")) $("mp-join-tab").focus();
  }
});
if ($("room")) $("room").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if ($("join")) $("join").click();
  }
});
["create-public", "create-private"].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if ($("create-room")) $("create-room").focus();
    }
  });
});
if ($("refresh-rooms")) $("refresh-rooms").addEventListener("click", loadPublicRooms);
if ($("regen-room-code")) $("regen-room-code").addEventListener("click", () => {
  const cur = $("create-room-code") ? $("create-room-code").textContent : "";
  assignNextRoomCode(cur);
});
$("join").addEventListener("click", () => {
  myName = $("name").value.trim();
  const room = $("room").value.trim().toUpperCase();
  if (!myName || !room) { showError("Enter your name and a room code."); return; }
  connect({ type: "join", room, name: myName });
});
if ($("create-room")) $("create-room").addEventListener("click", () => {
  myName = $("name").value.trim();
  if (!myName) { showError("Enter your name first."); if ($("name")) $("name").focus(); return; }
  const codeEl = $("create-room-code");
  let room = (codeEl ? codeEl.textContent : "").trim().toUpperCase();
  if (!room) { room = genRoomCode(skippedRoomCodes); if (codeEl) codeEl.textContent = room; }
  const isPublic = $("create-public") ? $("create-public").checked : true;
  connect({ type: "join", room, name: myName, create: true, public: isPublic });
});
$("solo").addEventListener("click", () => {
  myName = ($("practice-name") && $("practice-name").value.trim()) || ($("name") && $("name").value.trim()) || "You";
  const room = "SOLO-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  const difficulty = ($("bot-difficulty") && $("bot-difficulty").dataset.diff) || "easy";
  const double_tap_play = !!($("solo-dblclick") && $("solo-dblclick").checked);
  connect({ type: "join", room, name: myName, solo: true, bots: Number($("bot-count").value), difficulty, double_tap_play });
});
if ($("bot-difficulty")) $("bot-difficulty").addEventListener("click", (e) => {
  const b = e.currentTarget;
  const next = b.dataset.diff === "hard" ? "easy" : "hard";
  b.dataset.diff = next;
  b.textContent = next === "hard" ? "Hard (fast & smart)" : "Easy (relaxed)";
});
if ($("lobby-dblclick")) $("lobby-dblclick").addEventListener("change", (e) => {
  send({ type: "set_rule", double_tap_play: e.target.checked });
});
if ($("lobby-add-bot")) $("lobby-add-bot").addEventListener("click", () => send({ type: "add_bot" }));
if ($("lobby-remove-bot")) $("lobby-remove-bot").addEventListener("click", () => send({ type: "remove_bot" }));
if ($("lobby-bot-diff")) $("lobby-bot-diff").addEventListener("click", (e) => {
  const next = e.currentTarget.dataset.diff === "hard" ? "easy" : "hard";
  send({ type: "set_rule", bot_difficulty: next });
});
$("start").addEventListener("click", () => send({ type: "start" }));
if ($("lobby-leave")) $("lobby-leave").addEventListener("click", () => leaveToHome(false));
if ($("fast-bots-btn")) $("fast-bots-btn").addEventListener("click", () => {
  if (practice) {
    practice.fastBots = !practice.fastBots;
    if (practice.game) practice.game.fastBots = !!practice.fastBots;
    if (practice.fastBots) { practice.bot.quietUntil = 0; practice.bot.next = {}; }
    practiceRender();
  } else {
    wsSend({ type: "set_fast_bots", enabled: !(prevView && prevView.fast_bots) });
  }
});
// Hover near top/bottom edge of leaderboard to scroll smoothly when site scroll is disabled
(() => {
  const lb = $("leaderboard");
  if (!lb) return;
  let lbScrollVel = 0, lbRaf = null;
  const step = () => {
    if (lb.hidden || lbScrollVel === 0) { lbRaf = null; return; }
    lb.scrollTop += lbScrollVel;
    lbRaf = requestAnimationFrame(step);
  };
  lb.addEventListener("mousemove", (e) => {
    if (lb.hidden) { lbScrollVel = 0; return; }
    const r = lb.getBoundingClientRect();
    const edge = 76;
    if (e.clientY < r.top + edge) {
      const ratio = 1 - Math.max(0, e.clientY - r.top) / edge;
      lbScrollVel = -Math.round(3 + ratio * 11);
    } else if (e.clientY > r.bottom - edge) {
      const ratio = 1 - Math.max(0, r.bottom - e.clientY) / edge;
      lbScrollVel = Math.round(3 + ratio * 11);
    } else {
      lbScrollVel = 0;
    }
    if (lbScrollVel !== 0 && !lbRaf) lbRaf = requestAnimationFrame(step);
  });
  lb.addEventListener("mouseleave", () => { lbScrollVel = 0; });
})();

// ------------------------------------------------------------- leaderboard
let lbShownFor = null;
let lastDropSeq = 0;
let endSfxActive = false, endFireAudio = null, endLavaTimer = null, endLavaRumble = null, endFireworksTimer = null;
let endFireworkBurstTimers = [];
function stopEndScreenSfx() {
  endSfxActive = false;
  clearTimeout(endLavaTimer);
  endLavaTimer = null;
  clearInterval(endFireworksTimer);
  endFireworksTimer = null;
  endFireworkBurstTimers.forEach((id) => clearTimeout(id));
  endFireworkBurstTimers = [];
  if (endLavaRumble) {
    try { endLavaRumble.src.stop(); } catch (e) { /* ignore */ }
    try { endLavaRumble.gain.disconnect(); } catch (e) { /* ignore */ }
    endLavaRumble = null;
  }
  if (endFireAudio) {
    try { endFireAudio.pause(); endFireAudio.currentTime = 0; } catch (e) { /* ignore */ }
  }
}
let lbWinnerColors = ["#ffcf4a"];
function playStandingsFireworkSfx(launchMs = 420, variant = 0) {
  if (!endSfxActive || !sfxOn || sfxVol <= 0 || document.hidden) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (!sfxCtx) return;
    if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    const t0 = sfxCtx.currentTime;
    const launchSec = Math.max(0.26, launchMs / 1000);
    const tBurst = t0 + launchSec;
    const pitchJitter = 0.9 + Math.random() * 0.22;

    // 1) Pre-explosion launch sound (3 distinct variations: whistle, zip, mortar whoosh)
    if (variant === 0) {
      // Rising rocket whistle + airy whoosh
      const wh = sfxCtx.createOscillator();
      const whG = sfxCtx.createGain();
      wh.type = "sine";
      wh.frequency.setValueAtTime(520 * pitchJitter, t0);
      wh.frequency.exponentialRampToValueAtTime(1420 * pitchJitter, tBurst - 0.03);
      whG.gain.setValueAtTime(0.0005, t0);
      whG.gain.linearRampToValueAtTime(Math.max(0.008, sfxVol * 0.12), t0 + launchSec * 0.35);
      whG.gain.exponentialRampToValueAtTime(0.0005, tBurst);
      wh.connect(whG).connect(sfxCtx.destination);
      wh.start(t0);
      wh.stop(tBurst + 0.02);
    } else if (variant === 1) {
      // Bright bottle-rocket zip
      const zip = sfxCtx.createOscillator();
      const zipG = sfxCtx.createGain();
      zip.type = "triangle";
      zip.frequency.setValueAtTime(640 * pitchJitter, t0);
      zip.frequency.exponentialRampToValueAtTime(1750 * pitchJitter, tBurst - 0.02);
      zipG.gain.setValueAtTime(0.0005, t0);
      zipG.gain.linearRampToValueAtTime(Math.max(0.007, sfxVol * 0.10), t0 + 0.06);
      zipG.gain.exponentialRampToValueAtTime(0.0005, tBurst);
      zip.connect(zipG).connect(sfxCtx.destination);
      zip.start(t0);
      zip.stop(tBurst + 0.02);
    } else {
      // Soft mortar tube thump before rising air whoosh
      const th = sfxCtx.createOscillator();
      const thG = sfxCtx.createGain();
      th.type = "sine";
      th.frequency.setValueAtTime(135 * pitchJitter, t0);
      th.frequency.exponentialRampToValueAtTime(52 * pitchJitter, t0 + 0.11);
      thG.gain.setValueAtTime(0.001, t0);
      thG.gain.linearRampToValueAtTime(Math.max(0.012, sfxVol * 0.22), t0 + 0.008);
      thG.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.13);
      th.connect(thG).connect(sfxCtx.destination);
      th.start(t0);
      th.stop(t0 + 0.14);
    }
    // Filtered rising noise whoosh for all launch variants
    const wLen = Math.max(1, Math.floor(sfxCtx.sampleRate * launchSec));
    const wBuf = sfxCtx.createBuffer(1, wLen, sfxCtx.sampleRate);
    const wData = wBuf.getChannelData(0);
    for (let i = 0; i < wLen; i++) {
      const p = i / wLen;
      wData[i] = (Math.random() * 2 - 1) * Math.sin(p * Math.PI);
    }
    const wSrc = sfxCtx.createBufferSource();
    wSrc.buffer = wBuf;
    const wBp = sfxCtx.createBiquadFilter();
    wBp.type = "bandpass";
    wBp.Q.value = variant === 2 ? 1.8 : 3.2;
    wBp.frequency.setValueAtTime(700 * pitchJitter, t0);
    wBp.frequency.exponentialRampToValueAtTime(2200 * pitchJitter, tBurst);
    const wGain = sfxCtx.createGain();
    wGain.gain.setValueAtTime(Math.max(0.006, sfxVol * 0.11), t0);
    wSrc.connect(wBp).connect(wGain).connect(sfxCtx.destination);
    wSrc.start(t0);

    // 2) Main firework explosion pop/boom (pitched per variant)
    const boom = sfxCtx.createOscillator();
    const boomG = sfxCtx.createGain();
    boom.type = variant === 2 ? "sine" : "triangle";
    const fStart = (variant === 2 ? 130 : variant === 1 ? 175 : 150) * pitchJitter;
    boom.frequency.setValueAtTime(fStart, tBurst);
    boom.frequency.exponentialRampToValueAtTime(34, tBurst + 0.24);
    boomG.gain.setValueAtTime(0.001, tBurst);
    boomG.gain.linearRampToValueAtTime(Math.max(0.015, sfxVol * (variant === 2 ? 0.30 : 0.24)), tBurst + 0.008);
    boomG.gain.exponentialRampToValueAtTime(0.0005, tBurst + 0.28);
    boom.connect(boomG).connect(sfxCtx.destination);
    boom.start(tBurst);
    boom.stop(tBurst + 0.30);

    const bDur = variant === 2 ? 0.42 : 0.32;
    const bLen = Math.max(1, Math.floor(sfxCtx.sampleRate * bDur));
    const bBuf = sfxCtx.createBuffer(1, bLen, sfxCtx.sampleRate);
    const bData = bBuf.getChannelData(0);
    for (let i = 0; i < bLen; i++) bData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bLen, 1.8);
    const bSrc = sfxCtx.createBufferSource();
    bSrc.buffer = bBuf;
    const bLp = sfxCtx.createBiquadFilter();
    bLp.type = "lowpass";
    bLp.frequency.setValueAtTime((variant === 1 ? 2600 : 1900) * pitchJitter, tBurst);
    bLp.frequency.exponentialRampToValueAtTime(280, tBurst + bDur);
    const bGain = sfxCtx.createGain();
    bGain.gain.setValueAtTime(Math.max(0.012, sfxVol * 0.22), tBurst);
    bGain.gain.exponentialRampToValueAtTime(0.0005, tBurst + bDur);
    bSrc.connect(bLp).connect(bGain).connect(sfxCtx.destination);
    bSrc.start(tBurst);

    // 3) Sparkling crackle pops trailing after the burst
    const crackles = variant === 1 ? 6 : 4;
    for (let i = 0; i < crackles; i++) {
      const ct = tBurst + 0.11 + Math.random() * 0.36;
      const cLen = Math.max(1, Math.floor(sfxCtx.sampleRate * 0.022));
      const cBuf = sfxCtx.createBuffer(1, cLen, sfxCtx.sampleRate);
      const cData = cBuf.getChannelData(0);
      for (let j = 0; j < cLen; j++) cData[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / cLen, 2.2);
      const cSrc = sfxCtx.createBufferSource();
      cSrc.buffer = cBuf;
      const cHp = sfxCtx.createBiquadFilter();
      cHp.type = "bandpass";
      cHp.frequency.value = 1800 + Math.random() * 2400;
      cHp.Q.value = 2.0;
      const cGain = sfxCtx.createGain();
      cGain.gain.setValueAtTime(Math.max(0.006, sfxVol * (0.11 + Math.random() * 0.07)), ct);
      cGain.gain.exponentialRampToValueAtTime(0.0005, ct + 0.022);
      cSrc.connect(cHp).connect(cGain).connect(sfxCtx.destination);
      cSrc.start(ct);
    }
  } catch (e) { /* audio unsupported */ }
}
function launchStandingsFireworks() {
  const lb = $("leaderboard");
  const podium = $("lb-podium");
  const fxHost = podium && podium.querySelector(".lb-podium-fx");
  if (!lb || lb.hidden || !podium || !fxHost || document.hidden) return;
  const w = podium.clientWidth, h = podium.clientHeight;
  if (!w || !h) return;
  const colors = lbWinnerColors.length ? lbWinnerColors : ["#ffcf4a"];
  const c = colors[Math.floor(Math.random() * colors.length)];
  const tx = w * (0.16 + Math.random() * 0.68);
  const ty = h * (0.14 + Math.random() * 0.40);
  const variant = Math.floor(Math.random() * 3);
  const launchMs = variant === 1 ? 340 : variant === 2 ? 480 : 420;
  // NOTE: Never use the old flat firework.wav ("psh psh") here — use our varied
  // synthesized launch-and-burst firework audio synced to the rising rocket + burst.
  playStandingsFireworkSfx(launchMs, variant);
  const trail = document.createElement("div");
  trail.className = "fw-spark";
  trail.style.width = "4px";
  trail.style.height = "8px";
  trail.style.left = tx + "px";
  trail.style.top = (h + 4) + "px";
  trail.style.background = "#fff8dc";
  trail.style.boxShadow = `0 0 8px ${c}, 0 6px 8px ${c}`;
  fxHost.append(trail);
  const ta = trail.animate([
    { top: (h + 4) + "px", opacity: 0.95, transform: "translate(-50%,-50%) scaleY(1.3)" },
    { top: ty + "px", opacity: 1, transform: "translate(-50%,-50%) scaleY(0.8)" },
  ], { duration: launchMs, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" });
  ta.onfinish = () => trail.remove();
  setTimeout(() => trail.remove(), launchMs + 120);
  const tid = setTimeout(() => {
    if (!endSfxActive || !fxHost.isConnected || lb.hidden) return;
    fireworks({ x: tx - 16, y: ty - 16, w: 32, h: 32 }, c, 1, true, fxHost);
  }, launchMs);
  endFireworkBurstTimers.push(tid);
}
function playLavaBubbleSfx() {
  if (!endSfxActive || !sfxOn || sfxVol <= 0) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (!sfxCtx) return;
    if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    const t = sfxCtx.currentTime;
    const osc = sfxCtx.createOscillator();
    const gain = sfxCtx.createGain();
    const f0 = 78 + Math.random() * 68;
    const dur = 0.14 + Math.random() * 0.12;
    osc.type = "sine";
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * (1.85 + Math.random() * 0.55), t + dur);
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(Math.max(0.008, sfxVol * 0.16), t + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    osc.connect(gain).connect(sfxCtx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  } catch (e) { /* audio unsupported */ }
}
function scheduleLavaBubble() {
  if (!endSfxActive) return;
  playLavaBubbleSfx();
  endLavaTimer = setTimeout(scheduleLavaBubble, 260 + Math.random() * 520);
}
function startEndScreenSfx() {
  stopEndScreenSfx();
  if (!sfxOn) return;
  preloadSfx();
  endSfxActive = true;
  try {
    if (!endFireAudio) {
      endFireAudio = new Audio("/assets/sfx/freesound_community-burning-fire-6936.mp3");
      endFireAudio.loop = true;
    }
    endFireAudio.volume = Math.max(0, Math.min(0.28, sfxVol * 0.28));
    endFireAudio.currentTime = 0;
    endFireAudio.play().catch(() => {});
  } catch (e) { /* audio unsupported */ }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (sfxCtx) {
      if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
      const len = sfxCtx.sampleRate * 2;
      const buf = sfxCtx.createBuffer(1, len, sfxCtx.sampleRate);
      const data = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        last = (last + 0.025 * (Math.random() * 2 - 1)) / 1.025;
        data[i] = last * 3.2;
      }
      const src = sfxCtx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const lp = sfxCtx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 135;
      const gain = sfxCtx.createGain();
      gain.gain.value = Math.max(0.01, sfxVol * 0.22);
      src.connect(lp).connect(gain).connect(sfxCtx.destination);
      src.start();
      endLavaRumble = { src, gain };
    }
  } catch (e) { /* audio unsupported */ }
  scheduleLavaBubble();
}
function showLeaderboard(view) {
  const lbCode = $("lb-room-code");
  if (lbCode) {
    const showCode = !!(view && view.room && !view.practice);
    lbCode.hidden = !showCode;
    if (showCode) lbCode.textContent = `Room ${view.room}`;
  }
  const medalSrcs = ["/assets/ico_medal_1.png", "/assets/ico_medal_2.png", "/assets/ico_medal_3.png"];
  const placeLabels = ["1st Place", "2nd Place", "3rd Place"];
  const allPlayers = view.playing_counts
    ? Object.keys(view.playing_counts)
    : [...(view.ranking || []), ...(view.losers || [])];
  const pedSlots = allPlayers.length <= 4 ? 1 : allPlayers.length <= 6 ? 2 : 3;

  // 1) Visual Tiki Podium: 1st only (2-4p), 1st & 2nd (5-6p), 1st/2nd/3rd (7-8p)
  const podium = $("lb-podium");
  if (podium) {
    podium.replaceChildren();
    const podiumFx = document.createElement("div");
    podiumFx.className = "lb-podium-fx";
    podiumFx.setAttribute("aria-hidden", "true");
    podium.append(podiumFx);
    const topPodium = (view.ranking || []).slice(0, pedSlots);
    lbWinnerColors = topPodium.length
      ? topPodium.map((p) => GRAB_COLORS[playerIndex(p, allPlayers)])
      : ["#ffcf4a"];
    const podiumOrder = topPodium.length >= 3 ? [1, 0, 2]
      : topPodium.length === 2 ? [1, 0]
      : topPodium.length === 1 ? [0] : [];
    podiumOrder.forEach((rankIdx) => {
      const p = topPodium[rankIdx];
      if (!p) return;
      const slot = document.createElement("div");
      slot.className = `lb-podium-slot rank-${rankIdx + 1}` + (p === myName ? " you" : "");
      const wrap = document.createElement("div");
      wrap.className = "lb-podium-tiki-wrap";
      const crown = document.createElement("span");
      crown.className = "lb-podium-crown";
      const cm = document.createElement("img");
      cm.className = "inline-ico";
      cm.src = medalSrcs[rankIdx];
      cm.alt = "";
      crown.append(cm, ` ${placeLabels[rankIdx]}`);
      const nm = document.createElement("div");
      nm.className = "lb-podium-name";
      nm.textContent = `${p}${p === myName ? " (you)" : ""}`;
      const tk = document.createElement("img");
      tk.className = "lb-podium-tiki";
      tk.src = tikiSrc(p, allPlayers);
      tk.alt = p;
      tk.style.animationDelay = (rankIdx * 0.22).toFixed(2) + "s";
      wrap.append(crown, nm, tk);
      const ped = document.createElement("div");
      ped.className = "lb-pedestal";
      const pedImg = document.createElement("img");
      pedImg.className = "lb-pedestal-img";
      pedImg.src = `/assets/lb_pedestal_${rankIdx + 1}.png`;
      pedImg.alt = `#${rankIdx + 1}`;
      ped.append(pedImg);
      slot.append(wrap, ped);
      podium.append(slot);
    });
  }

  // 2) Full Ranked List of ALL players with persistent stats
  const list = $("lb-list");
  list.replaceChildren();
  const statsMap = view.player_stats || {};
  const rankedAll = [
    ...(view.ranking || []).map((p, i) => ({ player: p, rank: i + 1, loser: false })),
    ...(view.losers || []).map((p) => ({ player: p, rank: null, loser: true })),
  ];
  const prevRosterNames = rankedAll.map((r) => r.player);
  const nextRosterNames = Array.isArray(view.all_players) ? view.all_players : prevRosterNames;
  const allDisplayPlayers = [...new Set([...allPlayers, ...nextRosterNames])];
  rankedAll.forEach(({ player: p, rank, loser }) => {
    const removedNext = !nextRosterNames.includes(p);
    const li = document.createElement("li");
    if (p === myName) li.classList.add("you");
    if (removedNext) li.classList.add("removed-next");
    const badge = document.createElement("span");
    badge.className = "lb-rank-badge";
    const bm = document.createElement("img");
    bm.className = "inline-ico";
    bm.src = loser ? "/assets/lb_flame.png" : ((rank <= pedSlots && medalSrcs[rank - 1]) ? medalSrcs[rank - 1] : "/assets/ico_star.png");
    bm.alt = "";
    badge.append(bm, loser ? " Pit" : ` #${rank}`);
    const tk = document.createElement("img");
    tk.className = "lb-row-tiki";
    tk.src = tikiSrc(p, allDisplayPlayers);
    tk.alt = p;
    const infoWrap = document.createElement("div");
    infoWrap.className = "lb-row-info";
    const nm = document.createElement("span");
    nm.className = "lb-row-name";
    nm.textContent = `${p}${p === myName ? " (you)" : ""}`;
    const ps = statsMap[p] || { losses: 0, p1: 0, p2: 0, p3: 0 };
    const statsLine = document.createElement("span");
    statsLine.className = "lb-row-stats";
    const addStat = (label, cls) => {
      const sp = document.createElement("span");
      sp.className = "lb-stat-pill " + cls;
      sp.textContent = label;
      statsLine.append(sp);
    };
    addStat(`1st: ${ps.p1 || 0}`, "gold");
    if (pedSlots >= 2) addStat(`2nd: ${ps.p2 || 0}`, "silver");
    if (pedSlots >= 3) addStat(`3rd: ${ps.p3 || 0}`, "bronze");
    addStat(`Losses: ${ps.losses || 0}`, "loss");
    if (loser) {
      const playLeft = (view.playing_counts && view.playing_counts[p]) || 0;
      const stackLeft = (view.stacking_hands && view.stacking_hands[p]) ? view.stacking_hands[p].filter(Boolean).length : 0;
      addStat(`Cards left: ${playLeft + stackLeft}`, "cards");
    }
    if (removedNext) {
      addStat("Removed for next game", "removed");
    }
    infoWrap.append(nm, statsLine);
    const st = document.createElement("span");
    st.className = "lb-row-status" + (removedNext ? " removed" : (loser ? " loser" : ""));
    st.textContent = removedNext ? "Removed" : (loser ? "In Lava" : (rank === 1 ? "Winner" : `Finished #${rank}`));
    li.append(badge, tk, infoWrap, st);
    list.append(li);
  });
  nextRosterNames.filter((p) => !prevRosterNames.includes(p)).forEach((p) => {
    const li = document.createElement("li");
    li.className = "added-next" + (p === myName ? " you" : "");
    const badge = document.createElement("span");
    badge.className = "lb-rank-badge";
    const bm = document.createElement("img");
    bm.className = "inline-ico";
    bm.src = "/assets/ico_star.png";
    bm.alt = "";
    badge.append(bm, " New");
    const tk = document.createElement("img");
    tk.className = "lb-row-tiki";
    tk.src = tikiSrc(p, allDisplayPlayers);
    tk.alt = p;
    const infoWrap = document.createElement("div");
    infoWrap.className = "lb-row-info";
    const nm = document.createElement("span");
    nm.className = "lb-row-name";
    nm.textContent = `${p}${p === myName ? " (you)" : ""}`;
    const ps = statsMap[p] || { losses: 0, p1: 0, p2: 0, p3: 0 };
    const statsLine = document.createElement("span");
    statsLine.className = "lb-row-stats";
    const addStat = (label, cls) => {
      const sp = document.createElement("span");
      sp.className = "lb-stat-pill " + cls;
      sp.textContent = label;
      statsLine.append(sp);
    };
    addStat(`1st: ${ps.p1 || 0}`, "gold");
    if (pedSlots >= 2) addStat(`2nd: ${ps.p2 || 0}`, "silver");
    if (pedSlots >= 3) addStat(`3rd: ${ps.p3 || 0}`, "bronze");
    addStat(`Losses: ${ps.losses || 0}`, "loss");
    addStat("Added for next game", "added");
    infoWrap.append(nm, statsLine);
    const st = document.createElement("span");
    st.className = "lb-row-status added";
    st.textContent = "Added";
    li.append(badge, tk, infoWrap, st);
    list.append(li);
  });

  // 3) Visual Losers Section in the molten lava pit (half-submerged with floating name tags)
  const losersEl = $("lb-losers");
  losersEl.replaceChildren();
  if (view.losers && view.losers.length) {
    const title = document.createElement("p");
    title.className = "lb-losers-title";
    title.textContent = "Volcano Pit";
    const grid = document.createElement("div");
    grid.className = "lb-losers-grid";
    view.losers.forEach((p, idx) => {
      const card = document.createElement("div");
      card.className = "lb-loser-card burning" + (p === myName ? " you" : "");
      const tag = document.createElement("div");
      tag.className = "lb-loser-float-tag";
      tag.style.animationDelay = (idx * 0.24).toFixed(2) + "s";
      const nm = document.createElement("span");
      nm.className = "lb-loser-name";
      nm.textContent = `${p}${p === myName ? " (you)" : ""}`;
      tag.append(nm);

      const avatarWrap = document.createElement("div");
      avatarWrap.className = "lb-loser-burn-wrap";
      const flames = document.createElement("div");
      flames.className = "lb-flames";
      flames.setAttribute("aria-hidden", "true");
      for (let f = 0; f < 3; f++) {
        const tongue = document.createElement("img");
        tongue.className = "lb-flame-sprite";
        tongue.src = "/assets/lb_flame.png";
        tongue.alt = "";
        tongue.style.animationDelay = ((idx * 0.17 + f * 0.14) % 0.6).toFixed(2) + "s";
        flames.append(tongue);
      }
      const tk = document.createElement("img");
      tk.className = "lb-loser-tiki";
      tk.src = tikiSrc(p, allPlayers);
      tk.alt = p;
      tk.style.animationDelay = (idx * 0.18).toFixed(2) + "s";
      const lavaSurface = document.createElement("div");
      lavaSurface.className = "lb-lava-surface";
      lavaSurface.setAttribute("aria-hidden", "true");
      avatarWrap.append(flames, tk, lavaSurface);

      card.append(tag, avatarWrap);
      grid.append(card);
    });
    losersEl.append(title, grid);
  }

  renderWaitingRoomPanel($("lb-waiting-room"), view);
  const iAmHost = view.host === myName;
  const isPractice = !!(practice && practice.game);
  const botsBox = $("lb-bots");
  if (botsBox) {
    const botsHost = $("lb-bots-host");
    const addBtn = $("lb-add-bot");
    const remBtn = $("lb-remove-bot");
    const diffBtn = $("lb-bot-diff");
    const botsStat = $("lb-bots-status");
    const botCount = (view.bots || []).length;
    const maxPlayers = view.max_players || 8;
    const nextPlayers = view.all_players || [];
    const canManageBots = iAmHost && !isPractice;
    botsBox.hidden = isPractice || (!canManageBots && botCount <= 0);
    if (botsHost) botsHost.hidden = !canManageBots;
    if (addBtn) addBtn.disabled = nextPlayers.length >= maxPlayers;
    if (remBtn) remBtn.disabled = botCount <= 0;
    if (diffBtn) {
      const d = view.bot_difficulty || "easy";
      diffBtn.dataset.diff = d;
      diffBtn.textContent = "Bot level: " + (d === "hard" ? "Hard" : "Easy");
      diffBtn.disabled = botCount <= 0;
    }
    if (botsStat) {
      botsStat.hidden = botCount <= 0;
      if (botCount > 0) {
        const diffLabel = (view.bot_difficulty || "easy") === "hard" ? "Hard" : "Easy";
        botsStat.textContent = `Bots: ${botCount} (${diffLabel})`;
      }
    }
  }
  const prevRoster = Object.keys(view.playing_counts || {});
  const nextRoster = view.all_players || prevRoster;
  const rosterChanged = nextRoster.length !== prevRoster.length || nextRoster.some((p) => !prevRoster.includes(p));
  $("lb-again").hidden = !iAmHost;
  $("lb-again").disabled = iAmHost && !isPractice && nextRoster.length < 2;
  $("lb-again").innerHTML = rosterChanged
    ? '<img class="btn-ico" src="/assets/lb_torch.gif" alt=""> Play next game'
    : '<img class="btn-ico" src="/assets/lb_torch.gif" alt=""> Play again — same players';
  $("lb-wait").textContent = iAmHost ? "" : `Waiting for ${view.host} to start the next game…`;
  const key = (view.ranking || []).join("|") + " vs " + (view.losers || []).join("|");
  if (lbShownFor !== key) {
    lbShownFor = key;
    $("board-peek").hidden = true;
    $("leaderboard").hidden = false;
    triggerPageBlur($("leaderboard"));
    startEndScreenSfx();
    clearInterval(endFireworksTimer);
    endFireworksTimer = null;
    const startBurstTimer = setTimeout(() => {
      if (!endSfxActive || $("leaderboard").hidden) return;
      for (let i = 0; i < 6; i++) {
        const bTid = setTimeout(() => {
          if (endSfxActive && !$("leaderboard").hidden) launchStandingsFireworks();
        }, i * 180);
        endFireworkBurstTimers.push(bTid);
      }
      endFireworksTimer = setInterval(launchStandingsFireworks, 2800);
    }, 5000);
    endFireworkBurstTimers.push(startBurstTimer);
  }
}
if ($("lb-add-bot")) $("lb-add-bot").addEventListener("click", () => send({ type: "add_bot" }));
if ($("lb-remove-bot")) $("lb-remove-bot").addEventListener("click", () => send({ type: "remove_bot" }));
if ($("lb-bot-diff")) $("lb-bot-diff").addEventListener("click", (e) => send({ type: "set_rule", bot_difficulty: e.currentTarget.dataset.diff === "hard" ? "easy" : "hard" }));
$("lb-again").addEventListener("click", () => { clearTimeout(lbDelayTimer); lbDelayTimer = null; stopEndScreenSfx(); $("board-peek").hidden = true; $("leaderboard").hidden = true; triggerPageBlur($("arena")); send({ type: "start" }); });
$("lb-close").addEventListener("click", () => {
  const stage = $("board-peek-stage");
  if (stage && $("ring")) {
    stage.replaceChildren();
    const decor = document.querySelector("#arena .table-decor");
    if (decor) stage.append(decor.cloneNode(true));
    const snap = $("ring").cloneNode(true);
    const tc = snap.querySelector("#table-center");
    if (tc) tc.classList.add("table-center");
    const tb = snap.querySelector("#tiki-box");
    if (tb) tb.remove();
    const sm = snap.querySelector("#stack-msg");
    if (sm) sm.remove();
    snap.removeAttribute("id");
    snap.className = "board-peek-ring";
    snap.style.transform = "";
    snap.style.position = "absolute";
    snap.style.inset = "0";
    snap.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
    stage.append(snap);
  }
  $("board-peek").hidden = false;
});
if ($("board-peek-close")) $("board-peek-close").addEventListener("click", () => { $("board-peek").hidden = true; });
$("lb-leave").addEventListener("click", () => leaveToHome());

// ---------------------------------------------------------------- tutorial
const TUT = [
  { t: `<img class="tut-title-tiki" src="/assets/tiki.png" alt="">Welcome to Freaky Tiki!`,
    b: `<div class="tut-lead"><b>Goal: get rid of ALL your cards first.</b> Players finish in order (1st, 2nd, 3rd…) and the game ends the moment only <b>2 players</b> still hold cards (or <b>3</b> in games of 6+). Anyone left holding cards loses.</div>
        <div class="tut-grid">
          <div class="tut-box"><div class="tut-box-h">Table banner</div><p>Always shows whose turn it is and what you can do right now.</p></div>
          <div class="tut-box"><div class="tut-box-h"><img class="inline-ico" src="/assets/ico_gear.png" alt=""> Settings</div><p>Toggle <b>keybind hints</b> on the table whenever you want keyboard shortcuts.</p></div>
        </div>` },
  { t: "Your two hands",
    b: `<div class="tut-compare">
          <div class="tut-card-demo">
            <img src="/assets/cards/card_back.png?v=2" alt="card back">
            <div><b>Playing pile (blind)</b><p>Face-down in front of you. Even you can't peek at the cards inside!</p></div>
          </div>
          <div class="tut-card-demo">
            <div class="tut-mini-pair"><img src="/assets/cards/9_of_hearts.png?v=2" alt="9"><img src="/assets/cards/J_of_clubs.png?v=2" alt="J"></div>
            <div><b>Stacking hand (face-up)</b><p>2 face-up cards beside your pile (1 in games of 5+). Public to everyone.</p></div>
          </div>
        </div>` },
  { t: "Taking your turn",
    b: `<div class="tut-steps">
          <div class="tut-step"><span class="tut-num">1</span><span><b>Hold</b> your playing pile (or hold <kbd>P</kbd>) to lift its top card.</span></div>
          <div class="tut-step"><span class="tut-num">2</span><span>Keep holding, then press <kbd>SPACE</kbd> or drag &amp; drop over the middle stack.</span></div>
          <div class="tut-step"><span class="tut-num">3</span><span>Let go anywhere else and it snaps back. Play passes clockwise.</span></div>
        </div>
        <div class="tut-callout">You can only play from your <b>Playing pile</b> on your own turn—out-of-turn plays are blocked.</div>` },
  { t: `<img class="tut-title-tiki" src="/assets/lb_torch.gif" alt="">Stacking - the fast bit`,
    b: `<div class="tut-strip">
          <img src="/assets/cards/9_of_hearts.png?v=2" alt="9">
          <span class="tut-op">→</span>
          <img class="tut-mid" src="/assets/cards/10_of_spades.png?v=2" alt="10">
          <span class="tut-op">←</span>
          <img src="/assets/cards/J_of_clubs.png?v=2" alt="J">
          <span class="tut-wrap-pill">K ↔ A wraps!</span>
        </div>
        <p>At <b>any</b> moment, if a face-up stacking card (yours or <b>anyone else's</b>) is within <b>±1 rank</b> of the middle card, hold it (or its <kbd>1</kbd>–<kbd>0</kbd> key) and drop with <kbd>SPACE</kbd>. While held, it floats for everyone to see for up to <b>5s</b>.</p>
        <div class="tut-callout">Empty slots refill from the stacker's pile. Stack wrong and <b>you</b> take the whole middle!</div>` },
  { t: `<img class="tut-title-tiki" src="/assets/tiki.png" alt="">Freaky Tiki!`,
    b: `<div class="tut-strip tut-tiki-strip">
          <img class="tut-tiki-icon" src="/assets/tiki.png" alt="Tiki">
          <div class="tut-pips"><i></i><i></i><i></i></div>
          <span class="tut-pips-lbl">3× click or <kbd>F</kbd></span>
        </div>
        <p>When your flipped card lands within <b>±1 rank</b> of the card underneath, the tiki pops up!</p>
        <div class="tut-grid">
          <div class="tut-box"><div class="tut-box-h">If it's YOU</div><p>Click the tiki (or press <kbd>F</kbd>) <b>3 times fast</b> before others shed onto you.</p></div>
          <div class="tut-box"><div class="tut-box-h">If it's SOMEONE ELSE</div><p>Click your <b>dotted box</b> (or mash <kbd>S</kbd>) to shed cards onto them!</p></div>
        </div>` },
  { t: `<img class="tut-title-tiki" src="/assets/cards/joker_red.png?v=2" alt="">Jokers - slap!`,
    b: `<div class="tut-strip">
          <img src="/assets/cards/joker_red.png?v=2" alt="Red Joker">
          <img src="/assets/cards/joker_black.png?v=2" alt="Black Joker">
          <div class="tut-slap-badge">Mash <kbd>SPACE</kbd> or click middle!</div>
        </div>
        <p>Flip a Joker and everyone races to slap the middle stack (<b>2 presses</b> wins). The winner drags the <b>whole middle stack</b> onto any player—yes, even you.</p>
        <div class="tut-callout">A Joker in a <b>stacking hand</b> can be played by its owner anytime, but they need <b>5 presses</b> to slap it!</div>` },
  { t: `<img class="tut-title-tiki" src="/assets/ico_crown.png" alt="">Winning`,
    b: `<div class="tut-lead">You finish the instant you have <b>zero cards in total</b>—playing pile and stacking hand both empty. Finished players are out and cannot be given cards.</div>
        <div class="tut-callout good">The winner starts the next game. Warm up with the <b>Guided tutorial</b> or <b>Practice rooms</b> anytime!</div>` },
];
let tutI = 0;
function tutRender() {
  $("tut-title").innerHTML = TUT[tutI].t;
  $("tut-body").innerHTML = TUT[tutI].b;
  const pill = $("tut-step-pill");
  if (pill) pill.textContent = `${tutI + 1} / ${TUT.length}`;
  $("tut-dots").innerHTML = TUT.map((_, i) =>
    `<button type="button" class="tut-dot ${i === tutI ? "on" : ""}" data-tut-i="${i}" aria-label="Go to page ${i + 1}"></button>`).join("");
  $("tut-dots").querySelectorAll("[data-tut-i]").forEach((b) =>
    b.addEventListener("click", () => { tutI = Number(b.dataset.tutI); tutRender(); }));
  $("tut-back").disabled = tutI === 0;
  $("tut-next").hidden = tutI === TUT.length - 1;
  $("tut-done").hidden = tutI !== TUT.length - 1;
}
function tutOpen() { tutI = 0; tutRender(); overlayHost().append($("tutorial")); $("tutorial").hidden = false; }
function tutClose() {
  $("tutorial").hidden = true;
  try { localStorage.setItem("ft_tut_seen", "1"); } catch (e) { /* private mode */ }
}
$("tut-back").addEventListener("click", () => { if (tutI > 0) { tutI--; tutRender(); } });
$("tut-next").addEventListener("click", () => { if (tutI < TUT.length - 1) { tutI++; tutRender(); } });
$("tut-done").addEventListener("click", tutClose);
$("how-to").addEventListener("click", tutOpen);

// ------------------------------------------------------------- table UI
function overlayHost() { return $("game-box").hidden ? document.body : $("arena"); }
function overlayOpen() { return ["settings", "leaderboard", "tutorial"].some((id) => !$(id).hidden); }

let showKeys = false;
try { showKeys = localStorage.getItem("ft_show_keys") === "1"; } catch (e) { /* private mode */ }
function applyShowKeys() {
  document.body.classList.toggle("show-keys", showKeys);
  $("opt-keys").checked = showKeys;
}
applyShowKeys();
$("opt-keys").addEventListener("change", (e) => {
  showKeys = e.target.checked;
  try { localStorage.setItem("ft_show_keys", showKeys ? "1" : "0"); } catch (err) { /* private mode */ }
  applyShowKeys();
});

let vibrateOn = true;
try { vibrateOn = localStorage.getItem("ft_vibrate") !== "0"; } catch (e) { /* private mode */ }
let lastLocalVibAt = 0;
let iosHapticLabel = null;
function ensureIosHaptic() {
  if (iosHapticLabel || typeof document === "undefined" || !document.body) return iosHapticLabel;
  const label = document.createElement("label");
  label.setAttribute("aria-hidden", "true");
  label.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0.001;pointer-events:none;overflow:hidden;";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("switch", "");
  input.tabIndex = -1;
  label.append(input);
  document.body.append(label);
  iosHapticLabel = label;
  return iosHapticLabel;
}
function isIosDevice() {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);
}
function iosHapticPulse() {
  if (!isIosDevice()) return;
  const lbl = ensureIosHaptic();
  if (lbl) {
    try {
      lbl.click();
      const inp = lbl.querySelector("input");
      if (inp && document.activeElement === inp) inp.blur();
    } catch (e) { /* unsupported */ }
  }
}
function vibrate(pattern) {
  if (!vibrateOn || reduceMotion) return;
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      if (navigator.vibrate(pattern)) return;
    } catch (e) { /* fall through to iOS switch fallback */ }
  }
  if (!isIosDevice()) return;
  // iOS Safari (17.4+) fallback: toggling an <input type="checkbox" switch> via its <label> triggers the Taptic Engine.
  const steps = Array.isArray(pattern) ? pattern : [Number(pattern) || 15];
  let delay = 0;
  for (let i = 0; i < steps.length; i++) {
    const dur = Math.max(0, Number(steps[i]) || 0);
    if (i % 2 === 0 && dur > 0) {
      const at = delay;
      if (at === 0) iosHapticPulse();
      else setTimeout(iosHapticPulse, at);
      if (dur >= 70) setTimeout(iosHapticPulse, at + 45);
    }
    delay += dur;
  }
}
if ($("opt-vibrate")) {
  $("opt-vibrate").checked = vibrateOn;
  $("opt-vibrate").addEventListener("change", (e) => {
    vibrateOn = e.target.checked;
    try { localStorage.setItem("ft_vibrate", vibrateOn ? "1" : "0"); } catch (err) { /* private mode */ }
    if (vibrateOn) vibrate(25);
  });
}

let sfxOn = true;
let sfxVol = 0.55;
try {
  const savedSfx = localStorage.getItem("ft_sfx");
  if (savedSfx !== null) sfxOn = savedSfx !== "0";
  const sv = localStorage.getItem("ft_sfx_vol");
  if (sv !== null && !Number.isNaN(Number(sv))) sfxVol = Math.max(0, Math.min(1, Number(sv) / 100));
} catch (e) { /* private mode */ }
function playButtonClickSfx() {
  if (!sfxOn || sfxVol <= 0) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (!sfxCtx) return;
    if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    const t = sfxCtx.currentTime;
    const osc = sfxCtx.createOscillator();
    const gain = sfxCtx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(310, t + 0.045);
    gain.gain.setValueAtTime(Math.max(0.008, sfxVol * 0.16), t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.connect(gain).connect(sfxCtx.destination);
    osc.start(t);
    osc.stop(t + 0.055);
  } catch (e) { /* audio unsupported */ }
}
function playButtonHoverSfx() {
  if (!sfxOn || sfxVol <= 0) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (!sfxCtx || sfxCtx.state !== "running") return;
    const t = sfxCtx.currentTime;
    const osc = sfxCtx.createOscillator();
    const gain = sfxCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(660, t);
    osc.frequency.exponentialRampToValueAtTime(790, t + 0.028);
    gain.gain.setValueAtTime(Math.max(0.003, sfxVol * 0.055), t);
    gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.032);
    osc.connect(gain).connect(sfxCtx.destination);
    osc.start(t);
    osc.stop(t + 0.035);
  } catch (e) { /* audio unsupported */ }
}
function playBreathePopSfx(delayMs = 0, kind = "in", idx = 0) {
  if (!sfxOn || sfxVol <= 0) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (!sfxCtx) return;
    if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    const t = sfxCtx.currentTime + Math.max(0, delayMs) / 1000;
    const osc = sfxCtx.createOscillator();
    const gain = sfxCtx.createGain();
    osc.type = "sine";
    if (kind === "out") {
      const base = Math.max(220, 420 - idx * 14);
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.exponentialRampToValueAtTime(base * 0.56, t + 0.048);
      gain.gain.setValueAtTime(0.0005, t);
      gain.gain.linearRampToValueAtTime(Math.max(0.005, sfxVol * 0.11), t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.055);
    } else {
      const base = Math.min(620, 320 + idx * 18);
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.exponentialRampToValueAtTime(base * 1.42, t + 0.052);
      gain.gain.setValueAtTime(0.0005, t);
      gain.gain.linearRampToValueAtTime(Math.max(0.005, sfxVol * 0.12), t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.06);
    }
    osc.connect(gain).connect(sfxCtx.destination);
    osc.start(t);
    osc.stop(t + 0.065);
  } catch (e) { /* audio unsupported */ }
}
function playDealPopSfx(delayMs = 0, step = 0, kind = "deal") {
  if (!sfxOn || sfxVol <= 0) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (!sfxCtx) return;
    if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    const t = sfxCtx.currentTime + Math.max(0, delayMs) / 1000;
    const osc = sfxCtx.createOscillator();
    const gain = sfxCtx.createGain();
    osc.type = "sine";
    if (kind === "land") {
      osc.frequency.setValueAtTime(440, t);
      osc.frequency.exponentialRampToValueAtTime(590, t + 0.055);
      gain.gain.setValueAtTime(0.0005, t);
      gain.gain.linearRampToValueAtTime(Math.max(0.005, sfxVol * 0.12), t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.062);
    } else if (kind === "shuffle") {
      osc.frequency.setValueAtTime(300, t);
      osc.frequency.exponentialRampToValueAtTime(420, t + 0.048);
      gain.gain.setValueAtTime(0.0005, t);
      gain.gain.linearRampToValueAtTime(Math.max(0.005, sfxVol * 0.10), t + 0.007);
      gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.054);
    } else {
      const base = 340 + (step % 8) * 20;
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.exponentialRampToValueAtTime(base * 1.44, t + 0.046);
      gain.gain.setValueAtTime(0.0005, t);
      gain.gain.linearRampToValueAtTime(Math.max(0.005, sfxVol * 0.105), t + 0.007);
      gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.054);
    }
    osc.connect(gain).connect(sfxCtx.destination);
    osc.start(t);
    osc.stop(t + 0.066);
  } catch (e) { /* audio unsupported */ }
}
let lastHoverBtn = null;
let lastHoverAt = 0;
document.addEventListener("pointerover", (e) => {
  if (e.pointerType === "touch") return;
  const btn = e.target && e.target.closest && e.target.closest("button:not(:disabled)");
  if (!btn) { lastHoverBtn = null; return; }
  if (btn === lastHoverBtn) return;
  lastHoverBtn = btn;
  const now = Date.now();
  if (now - lastHoverAt < 55) return;
  lastHoverAt = now;
  playButtonHoverSfx();
});
document.addEventListener("click", (e) => {
  const btn = e.target && e.target.closest && e.target.closest("button:not(:disabled)");
  if (btn) playButtonClickSfx();
});
const SFX_NAMES = ["flip", "stack", "miss", "tiki_tap", "freaky", "shed", "joker", "slap", "win", "firework"];
const SFX_FILES = {
  flip: "/assets/sfx/samples_sfx_card-place-1.wav",
  stack: "/assets/sfx/samples_sfx_card-place-1.wav",
  shed: "/assets/sfx/samples_sfx_card-place-2.wav",
  tiki_tap: "/assets/sfx/samples_sfx_footstep-wood-1.wav",
  slap: "/assets/sfx/samples_sfx_punch-hit.wav",
  joker: "/assets/sfx/samples_sfx_bell-ding.wav",
  miss: "/assets/sfx/miss.wav",
  freaky: "/assets/sfx/drum-roll.mp3",
  win: "/assets/sfx/fantasy-game-success-notification.mp3",
  firework: "/assets/sfx/firework.wav",
};
let sfxCtx = null;
const sfxBuffers = {};
const sfxCache = {};
let sfxPreloaded = false;
let lastLocalSfx = { name: null, at: 0 };
function trimAudioBuffer(ctx, buffer) {
  if (!ctx || !buffer || !buffer.length) return buffer;
  const sr = buffer.sampleRate;
  const chCount = buffer.numberOfChannels;
  let maxPeak = 0;
  for (let ch = 0; ch < chCount; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > maxPeak) maxPeak = a;
    }
  }
  if (maxPeak <= 0.001) return buffer;
  const thresh = Math.max(0.02, maxPeak * 0.12);
  let i0 = buffer.length;
  let i1 = -1;
  for (let ch = 0; ch < chCount; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i]) >= thresh) {
        if (i < i0) i0 = i;
        break;
      }
    }
    for (let i = data.length - 1; i >= 0; i--) {
      if (Math.abs(data[i]) >= thresh) {
        if (i > i1) i1 = i;
        break;
      }
    }
  }
  if (i1 <= i0) return buffer;
  const start = Math.max(0, i0 - Math.round(sr * 0.008));
  const end = Math.min(buffer.length, i1 + Math.round(sr * 0.035));
  const len = Math.max(1, end - start);
  const out = ctx.createBuffer(chCount, len, sr);
  // RMS loudness normalization so all sound effects sit in a comfortable, balanced range
  let sumSq = 0;
  for (let ch = 0; ch < chCount; ch++) {
    const src = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) { const s = src[start + i]; sumSq += s * s; }
  }
  const rms = Math.sqrt(sumSq / Math.max(1, len * chCount));
  const targetRms = 0.16;
  const normRms = rms > 0.004 ? Math.min(3.0, targetRms / rms) : 1;
  const normPeak = maxPeak > 0.001 ? (0.72 / maxPeak) : 1;
  const norm = Math.min(normRms, normPeak);
  const fadeIn = Math.min(Math.floor(len * 0.25), Math.round(sr * 0.005));
  const fadeOut = Math.min(Math.floor(len * 0.35), Math.round(sr * 0.015));
  for (let ch = 0; ch < chCount; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      let s = src[start + i] * norm;
      if (fadeIn > 0 && i < fadeIn) s *= i / fadeIn;
      if (fadeOut > 0 && i >= len - fadeOut) s *= (len - 1 - i) / fadeOut;
      dst[i] = Math.max(-1, Math.min(1, s));
    }
  }
  return out;
}
function preloadSfx() {
  if (sfxPreloaded || !sfxOn) return;
  sfxPreloaded = true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    if (!sfxCtx) sfxCtx = new AC();
    SFX_NAMES.forEach((name) => {
      fetch(SFX_FILES[name] || `/assets/sfx/${name}.wav`)
        .then((r) => r.arrayBuffer())
        .then((buf) => sfxCtx.decodeAudioData(buf))
        .then((decoded) => { sfxBuffers[name] = trimAudioBuffer(sfxCtx, decoded); })
        .catch(() => {});
    });
    fetch("/assets/sfx/Riffle.m4a")
      .then((r) => r.arrayBuffer())
      .then((buf) => sfxCtx.decodeAudioData(buf))
      .then((decoded) => { sfxBuffers.riffle = trimAudioBuffer(sfxCtx, decoded); })
      .catch(() => {});
  } catch (e) { /* audio unsupported */ }
}
function playPickupSfx() {
  if (document.hidden || !sfxOn || sfxVol <= 0) return;
  preloadSfx();
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (!sfxCtx) return;
    if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    if (sfxBuffers.riffle) {
      const src = sfxCtx.createBufferSource();
      src.buffer = sfxBuffers.riffle;
      src.playbackRate.value = 1.35;
      const gain = sfxCtx.createGain();
      gain.gain.value = Math.max(0, Math.min(1, sfxVol * 0.45));
      src.connect(gain).connect(sfxCtx.destination);
      src.start(0);
      return;
    }
    const now = sfxCtx.currentTime;
    const osc = sfxCtx.createOscillator();
    const g = sfxCtx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(240, now);
    osc.frequency.exponentialRampToValueAtTime(110, now + 0.14);
    g.gain.setValueAtTime(Math.max(0.008, sfxVol * 0.22), now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    osc.connect(g).connect(sfxCtx.destination);
    osc.start(now);
    osc.stop(now + 0.17);
  } catch (e) { /* audio unsupported */ }
}
const activeSfx = {};
let freakyThudTimer = null;
let freakyThudBeatTimers = [];
let lastLocalFreakyAt = 0;
function playThudSfx(volScale = 1, baseHz = 130.81) {
  if (!sfxOn || sfxVol <= 0) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (!sfxCtx) return;
    if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    const t = sfxCtx.currentTime;
    // Pitched wooden/log-drum fundamental
    const osc = sfxCtx.createOscillator();
    const gain = sfxCtx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(baseHz * 1.65, t);
    osc.frequency.exponentialRampToValueAtTime(baseHz, t + 0.024);
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(Math.max(0.01, sfxVol * 0.34 * volScale), t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.19);
    osc.connect(gain).connect(sfxCtx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
    // Warm octave overtone for musical resonance
    const ov = sfxCtx.createOscillator();
    const ovG = sfxCtx.createGain();
    ov.type = "sine";
    ov.frequency.setValueAtTime(baseHz * 2, t);
    ovG.gain.setValueAtTime(0.001, t);
    ovG.gain.linearRampToValueAtTime(Math.max(0.005, sfxVol * 0.16 * volScale), t + 0.004);
    ovG.gain.exponentialRampToValueAtTime(0.0005, t + 0.085);
    ov.connect(ovG).connect(sfxCtx.destination);
    ov.start(t);
    ov.stop(t + 0.095);
  } catch (e) { /* audio unsupported */ }
}
function playFreakyThudBatch() {
  freakyThudBeatTimers.forEach((id) => clearTimeout(id));
  freakyThudBeatTimers = [];
  const pattern = [
    { delay: 0, hz: 130.81, vol: 0.72 },
    { delay: 140, hz: 196.00, vol: 0.92 },
    { delay: 280, hz: 155.56, vol: 0.84 },
  ];
  pattern.forEach(({ delay, hz, vol }) => {
    if (delay === 0) playThudSfx(vol, hz);
    else freakyThudBeatTimers.push(setTimeout(() => { playThudSfx(vol, hz); }, delay));
  });
}
function startFreakyThudLoop() {
  if (freakyThudTimer) return;
  playFreakyThudBatch();
  freakyThudTimer = setInterval(playFreakyThudBatch, 1000);
}
function stopFreakyThudLoop() {
  if (freakyThudTimer) { clearInterval(freakyThudTimer); freakyThudTimer = null; }
  freakyThudBeatTimers.forEach((id) => clearTimeout(id));
  freakyThudBeatTimers = [];
}
function playBigFreakyThud() {
  stopFreakyThudLoop();
  if (!document.hidden) screenShake(true);
  if (document.hidden || !sfxOn || sfxVol <= 0) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (!sfxCtx) return;
    if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    const t = sfxCtx.currentTime;
    // 1) Deep sub-bass anchor on G2 (octave below G3)
    const sub = sfxCtx.createOscillator();
    const subG = sfxCtx.createGain();
    sub.type = "sine";
    sub.frequency.setValueAtTime(196.00, t);
    sub.frequency.exponentialRampToValueAtTime(98.00, t + 0.045);
    subG.gain.setValueAtTime(0.001, t);
    subG.gain.linearRampToValueAtTime(Math.max(0.015, sfxVol * 0.40), t + 0.006);
    subG.gain.exponentialRampToValueAtTime(0.0005, t + 0.30);
    sub.connect(subG).connect(sfxCtx.destination);
    sub.start(t);
    sub.stop(t + 0.31);
    // 2) Woody/tribal body pitched on G3 (196 Hz, highest note of the triad)
    const body = sfxCtx.createOscillator();
    const bodyG = sfxCtx.createGain();
    body.type = "triangle";
    body.frequency.setValueAtTime(196.00 * 1.65, t);
    body.frequency.exponentialRampToValueAtTime(196.00, t + 0.028);
    bodyG.gain.setValueAtTime(0.001, t);
    bodyG.gain.linearRampToValueAtTime(Math.max(0.012, sfxVol * 0.34), t + 0.005);
    bodyG.gain.exponentialRampToValueAtTime(0.0005, t + 0.26);
    body.connect(bodyG).connect(sfxCtx.destination);
    body.start(t);
    body.stop(t + 0.27);
    // 3) Low-passed drumhead transient
    const nLen = Math.max(1, Math.floor(sfxCtx.sampleRate * 0.05));
    const nBuf = sfxCtx.createBuffer(1, nLen, sfxCtx.sampleRate);
    const nData = nBuf.getChannelData(0);
    for (let i = 0; i < nLen; i++) nData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / nLen, 2.5);
    const nSrc = sfxCtx.createBufferSource();
    nSrc.buffer = nBuf;
    const lp = sfxCtx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 520;
    const nGain = sfxCtx.createGain();
    nGain.gain.value = sfxVol * 0.22;
    nSrc.connect(lp).connect(nGain).connect(sfxCtx.destination);
    nSrc.start(t);
  } catch (e) { /* audio unsupported */ }
}
let lastLocalSlapFinalAt = 0;
function playClockTickSfx(urgent = false) {
  if (document.hidden || !sfxOn || sfxVol <= 0) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (!sfxCtx) return;
    if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    const t = sfxCtx.currentTime;
    const osc = sfxCtx.createOscillator();
    const g = sfxCtx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(urgent ? 1280 : 940, t);
    osc.frequency.exponentialRampToValueAtTime(urgent ? 640 : 480, t + 0.025);
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(Math.max(0.012, sfxVol * (urgent ? 0.32 : 0.2)), t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.032);
    osc.connect(g).connect(sfxCtx.destination);
    osc.start(t);
    osc.stop(t + 0.035);
  } catch (e) { /* audio unsupported */ }
}
function playJokerLaughSfx() {
  if (document.hidden || !sfxOn || sfxVol <= 0) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (!sfxCtx) return;
    if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    const t0 = sfxCtx.currentTime;
    // Mischievous descending Joker cackle: 5 staccato formant bursts
    const pitches = [540, 495, 445, 395, 330];
    pitches.forEach((hz, i) => {
      const start = t0 + i * 0.082;
      const dur = i === pitches.length - 1 ? 0.14 : 0.068;
      const bp = sfxCtx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(hz * 2.1, start);
      bp.frequency.exponentialRampToValueAtTime(hz * 1.35, start + dur);
      bp.Q.value = 3.2;
      const g = sfxCtx.createGain();
      g.gain.setValueAtTime(0.001, start);
      g.gain.linearRampToValueAtTime(Math.max(0.015, sfxVol * (0.32 - i * 0.025)), start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, start + dur);
      bp.connect(g).connect(sfxCtx.destination);
      [hz, hz * 1.015].forEach((f) => {
        const osc = sfxCtx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(f * 1.08, start);
        osc.frequency.exponentialRampToValueAtTime(f * 0.88, start + dur);
        osc.connect(bp);
        osc.start(start);
        osc.stop(start + dur + 0.01);
      });
    });
  } catch (e) { /* audio unsupported */ }
}
function playSlapHitSfx(isFinal = false, progress = 0) {
  if (document.hidden || !sfxOn || sfxVol <= 0) return;
  preloadSfx();
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (!sfxCtx) return;
    if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    const t = sfxCtx.currentTime;
    if (isFinal) {
      // Final winning slap: full explosion boom + noise blast + low-end rumble
      const boom = sfxCtx.createOscillator();
      const boomG = sfxCtx.createGain();
      boom.type = "sine";
      boom.frequency.setValueAtTime(160, t);
      boom.frequency.exponentialRampToValueAtTime(22, t + 0.55);
      boomG.gain.setValueAtTime(0.001, t);
      boomG.gain.linearRampToValueAtTime(Math.max(0.02, sfxVol * 0.44), t + 0.008);
      boomG.gain.exponentialRampToValueAtTime(0.0005, t + 0.58);
      boom.connect(boomG).connect(sfxCtx.destination);
      boom.start(t);
      boom.stop(t + 0.60);

      const expDur = 0.68;
      const expLen = Math.max(1, Math.floor(sfxCtx.sampleRate * expDur));
      const expBuf = sfxCtx.createBuffer(1, expLen, sfxCtx.sampleRate);
      const expData = expBuf.getChannelData(0);
      for (let i = 0; i < expLen; i++) {
        const env = Math.pow(1 - i / expLen, 1.35);
        expData[i] = (Math.random() * 2 - 1) * env;
      }
      const expSrc = sfxCtx.createBufferSource();
      expSrc.buffer = expBuf;
      const expLp = sfxCtx.createBiquadFilter();
      expLp.type = "lowpass";
      expLp.Q.value = 1.4;
      expLp.frequency.setValueAtTime(3600, t);
      expLp.frequency.exponentialRampToValueAtTime(160, t + expDur);
      const expG = sfxCtx.createGain();
      expG.gain.setValueAtTime(Math.max(0.018, sfxVol * 0.38), t);
      expG.gain.exponentialRampToValueAtTime(0.0005, t + expDur);
      expSrc.connect(expLp).connect(expG).connect(sfxCtx.destination);
      expSrc.start(t);

      const crk = sfxCtx.createOscillator();
      const crkG = sfxCtx.createGain();
      crk.type = "sawtooth";
      crk.frequency.setValueAtTime(130, t);
      crk.frequency.exponentialRampToValueAtTime(28, t + 0.36);
      crkG.gain.setValueAtTime(0.001, t);
      crkG.gain.linearRampToValueAtTime(Math.max(0.012, sfxVol * 0.20), t + 0.006);
      crkG.gain.exponentialRampToValueAtTime(0.0005, t + 0.38);
      crk.connect(crkG).connect(sfxCtx.destination);
      crk.start(t);
      crk.stop(t + 0.40);
      return;
    }
    // 1) Sampled slap/punch layer
    if (sfxBuffers.slap) {
      const src = sfxCtx.createBufferSource();
      src.buffer = sfxBuffers.slap;
      src.playbackRate.value = 1.02 - progress * 0.08;
      const g = sfxCtx.createGain();
      g.gain.value = Math.max(0, Math.min(1, sfxVol * (0.44 + progress * 0.08)));
      src.connect(g).connect(sfxCtx.destination);
      src.start(t);
    }
    // 2) Heavy sub-bass table slam
    const sub = sfxCtx.createOscillator();
    const subG = sfxCtx.createGain();
    sub.type = "sine";
    sub.frequency.setValueAtTime(155, t);
    sub.frequency.exponentialRampToValueAtTime(34, t + 0.17);
    subG.gain.setValueAtTime(0.001, t);
    subG.gain.linearRampToValueAtTime(Math.max(0.015, sfxVol * (0.34 + progress * 0.08)), t + 0.005);
    subG.gain.exponentialRampToValueAtTime(0.0005, t + 0.18);
    sub.connect(subG).connect(sfxCtx.destination);
    sub.start(t);
    sub.stop(t + 0.19);
    // 3) Punchy mid-body slam
    const body = sfxCtx.createOscillator();
    const bodyG = sfxCtx.createGain();
    body.type = "triangle";
    body.frequency.setValueAtTime(210, t);
    body.frequency.exponentialRampToValueAtTime(58, t + 0.12);
    bodyG.gain.setValueAtTime(0.001, t);
    bodyG.gain.linearRampToValueAtTime(Math.max(0.015, sfxVol * 0.36), t + 0.004);
    bodyG.gain.exponentialRampToValueAtTime(0.0005, t + 0.13);
    body.connect(bodyG).connect(sfxCtx.destination);
    body.start(t);
    body.stop(t + 0.14);
    // 4) Sharp slap transient crack
    const nDur = 0.045;
    const nLen = Math.max(1, Math.floor(sfxCtx.sampleRate * nDur));
    const nBuf = sfxCtx.createBuffer(1, nLen, sfxCtx.sampleRate);
    const nData = nBuf.getChannelData(0);
    for (let i = 0; i < nLen; i++) nData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / nLen, 1.8);
    const nSrc = sfxCtx.createBufferSource();
    nSrc.buffer = nBuf;
    const bp = sfxCtx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1800;
    bp.Q.value = 1.0;
    const nG = sfxCtx.createGain();
    nG.gain.value = sfxVol * 0.42;
    nSrc.connect(bp).connect(nG).connect(sfxCtx.destination);
    nSrc.start(t);
    // 5) Punchy synth stab layer (rising pitch with progress)
    const synDur = 0.11;
    const synLp = sfxCtx.createBiquadFilter();
    synLp.type = "lowpass";
    synLp.Q.value = 2.8;
    synLp.frequency.setValueAtTime(3000, t);
    synLp.frequency.exponentialRampToValueAtTime(750, t + synDur);
    const synG = sfxCtx.createGain();
    synG.gain.setValueAtTime(0.001, t);
    synG.gain.linearRampToValueAtTime(Math.max(0.015, sfxVol * 0.22), t + 0.006);
    synG.gain.exponentialRampToValueAtTime(0.0005, t + synDur);
    synLp.connect(synG).connect(sfxCtx.destination);
    const synNotes = [220.00 * (1 + progress * 0.28), 329.63 * (1 + progress * 0.28)];
    synNotes.forEach((hz) => {
      const sOsc = sfxCtx.createOscillator();
      sOsc.type = "sawtooth";
      sOsc.frequency.setValueAtTime(hz, t);
      sOsc.connect(synLp);
      sOsc.start(t);
      sOsc.stop(t + synDur + 0.02);
    });
  } catch (e) { /* audio unsupported */ }
}
function triggerLocalSlapSfx() {
  const j = prevView && prevView.joker;
  const nextPress = j ? ((j.your_presses || 0) + 1) : 1;
  const thresh = (j && j.your_threshold) ? j.your_threshold : 2;
  const isFinal = nextPress >= thresh;
  if (isFinal) lastLocalSlapFinalAt = Date.now();
  playSlapHitSfx(isFinal, Math.min(1, nextPress / thresh));
  screenShake(isFinal ? "heavy" : "normal");
}
function playCardLiftSfx() {
  if (!sfxOn || sfxVol <= 0) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (!sfxCtx) return;
    if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    const t = sfxCtx.currentTime;
    const osc = sfxCtx.createOscillator();
    const oGain = sfxCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(240, t);
    osc.frequency.exponentialRampToValueAtTime(560, t + 0.038);
    oGain.gain.setValueAtTime(0.001, t);
    oGain.gain.linearRampToValueAtTime(Math.max(0.01, sfxVol * 0.24), t + 0.005);
    oGain.gain.exponentialRampToValueAtTime(0.0005, t + 0.044);
    osc.connect(oGain).connect(sfxCtx.destination);
    osc.start(t);
    osc.stop(t + 0.05);
  } catch (e) { /* audio unsupported */ }
}
function stopSfx(name) {
  const cur = activeSfx[name];
  if (!cur) return;
  activeSfx[name] = null;
  try {
    if (cur.src) { cur.src.stop(0); cur.src.disconnect(); }
    if (cur.gain) { cur.gain.disconnect(); }
    if (cur.el) { cur.el.pause(); cur.el.currentTime = 0; }
  } catch (e) { /* already stopped */ }
}
const SFX_GAIN = {
  flip: 0.48, stack: 0.48, shed: 0.46, tiki_tap: 0.44,
  joker: 0.44, miss: 0.48, freaky: 0.45, win: 0.46, firework: 0.36, slap: 0.46,
};
function playSfx(name) {
  if (document.hidden || !sfxOn) return;
  preloadSfx();
  if (name === "freaky") stopSfx("freaky");
  const vol = Math.max(0, Math.min(1, sfxVol * (SFX_GAIN[name] || 0.46)));
  try {
    if (name === "miss" && sfxCtx) {
      if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
      const t = sfxCtx.currentTime;
      const punch = sfxCtx.createOscillator();
      const punchG = sfxCtx.createGain();
      punch.type = "triangle";
      punch.frequency.setValueAtTime(145, t);
      punch.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      punchG.gain.setValueAtTime(0.001, t);
      punchG.gain.linearRampToValueAtTime(Math.max(0.012, sfxVol * 0.30), t + 0.005);
      punchG.gain.exponentialRampToValueAtTime(0.0005, t + 0.13);
      punch.connect(punchG).connect(sfxCtx.destination);
      punch.start(t);
      punch.stop(t + 0.14);
    }
    if (sfxCtx && sfxBuffers[name]) {
      if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
      const src = sfxCtx.createBufferSource();
      src.buffer = sfxBuffers[name];
      if (name === "flip") src.playbackRate.value = 0.72;
      const gain = sfxCtx.createGain();
      gain.gain.value = vol;
      src.connect(gain).connect(sfxCtx.destination);
      if (name === "freaky") {
        activeSfx.freaky = { src, gain };
        src.onended = () => { if (activeSfx.freaky && activeSfx.freaky.src === src) activeSfx.freaky = null; };
      }
      src.start(0);
      return;
    }
    let base = sfxCache[name];
    if (!base) {
      base = new Audio(SFX_FILES[name] || `/assets/sfx/${name}.wav`);
      base.volume = vol;
      sfxCache[name] = base;
    }
    const inst = base.cloneNode();
    inst.volume = vol;
    if (name === "flip") inst.playbackRate = 0.72;
    if (name === "freaky") {
      activeSfx.freaky = { el: inst };
      inst.addEventListener("ended", () => { if (activeSfx.freaky && activeSfx.freaky.el === inst) activeSfx.freaky = null; }, { once: true });
    }
    inst.play().catch(() => {});
  } catch (e) { /* audio unsupported */ }
}
window.addEventListener("pointerdown", preloadSfx, { once: true });
window.addEventListener("keydown", preloadSfx, { once: true });
function applySfx() {
  if ($("opt-sfx")) $("opt-sfx").checked = sfxOn;
  if ($("sfx-btn")) $("sfx-btn").classList.toggle("off", !sfxOn);
}
function setSfx(on, playConfirm) {
  sfxOn = !!on;
  try { localStorage.setItem("ft_sfx", sfxOn ? "1" : "0"); } catch (err) { /* private mode */ }
  applySfx();
  if (sfxOn) {
    preloadSfx();
    if (playConfirm) playSfx("stack");
    if ($("leaderboard") && !$("leaderboard").hidden) startEndScreenSfx();
  } else {
    stopFreakyThudLoop();
    stopSfx("freaky");
    stopEndScreenSfx();
  }
}
function toggleSfx() { setSfx(!sfxOn, true); }
applySfx();
if ($("opt-sfx")) $("opt-sfx").addEventListener("change", (e) => setSfx(e.target.checked, true));
if ($("sfx-btn")) $("sfx-btn").addEventListener("click", (e) => { e.currentTarget.blur(); toggleSfx(); });

const MUSIC_TRACKS = {
  phonk: "/assets/music/tiki_phonk.mp3",
  chill: [
    "/assets/music/alex-morgan-kitchen-cooking-show-music-583291.mp3",
    "/assets/music/danyvin-coffee-break-optimistic-positive-lofi-445744.mp3",
    "/assets/music/tokyorifft-blue-hawaiimy-molokai-girl-462808.mp3"
  ],
};
let musicOn = false;
let musicVol = 0.32;
try {
  musicOn = localStorage.getItem("ft_music") === "1";
  const mv = localStorage.getItem("ft_music_vol");
  if (mv !== null && !Number.isNaN(Number(mv))) musicVol = Math.max(0, Math.min(1, Number(mv) / 100));
} catch (e) { /* private mode */ }
let musicAudio = null, musicGain = null, musicSource = null;
let lastChillTrack = null;
function pickNextMusicTrack() {
  if (Math.random() < 0.10) return MUSIC_TRACKS.phonk;
  const pool = MUSIC_TRACKS.chill;
  const candidates = pool.length > 1 && lastChillTrack ? pool.filter((t) => t !== lastChillTrack) : pool;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  lastChillTrack = chosen;
  return chosen;
}
function connectMusicGain() {
  if (!musicAudio || musicSource) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    if (!sfxCtx) sfxCtx = new AC();
    musicSource = sfxCtx.createMediaElementSource(musicAudio);
    musicGain = sfxCtx.createGain();
    musicGain.gain.value = musicVol;
    musicSource.connect(musicGain).connect(sfxCtx.destination);
    musicAudio.volume = 1;
  } catch (e) { /* fallback to element.volume */ }
}
function ensureMusicAudio() {
  if (musicAudio) return musicAudio;
  musicAudio = new Audio();
  musicAudio.volume = musicVol;
  musicAudio.addEventListener("ended", () => {
    if (musicOn) playNextMusicTrack();
  });
  return musicAudio;
}
function syncMusicGain() {
  if (musicGain) musicGain.gain.value = musicVol;
  else if (musicAudio) musicAudio.volume = musicVol;
}
function playNextMusicTrack() {
  const a = ensureMusicAudio();
  connectMusicGain();
  if (sfxCtx && sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
  syncMusicGain();
  a.src = pickNextMusicTrack();
  a.currentTime = 0;
  a.play().catch(() => {});
}
function applyMusic() {
  if ($("opt-music")) $("opt-music").checked = musicOn;
  if ($("music-btn")) $("music-btn").classList.toggle("off", !musicOn);
}
function setMusic(on) {
  musicOn = !!on;
  try { localStorage.setItem("ft_music", musicOn ? "1" : "0"); } catch (err) { /* private mode */ }
  applyMusic();
  if (musicOn) {
    const a = ensureMusicAudio();
    connectMusicGain();
    if (sfxCtx && sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    syncMusicGain();
    if (a.src && a.paused && !a.ended) a.play().catch(() => {});
    else playNextMusicTrack();
  } else if (musicAudio) {
    musicAudio.pause();
  }
}
function toggleMusic() { setMusic(!musicOn); }
function skipMusicTrack() {
  if (!musicOn) {
    musicOn = true;
    try { localStorage.setItem("ft_music", "1"); } catch (err) { /* private mode */ }
    applyMusic();
  }
  playNextMusicTrack();
}
applyMusic();
if ($("opt-music")) $("opt-music").addEventListener("change", (e) => setMusic(e.target.checked));
if ($("music-btn")) $("music-btn").addEventListener("click", (e) => { e.currentTarget.blur(); toggleMusic(); });
function applyVolumes() {
  const sp = Math.round(sfxVol * 100);
  const mp = Math.round(musicVol * 100);
  if ($("vol-sfx")) $("vol-sfx").value = String(sp);
  if ($("vol-sfx-val")) $("vol-sfx-val").textContent = sp + "%";
  if ($("vol-music")) $("vol-music").value = String(mp);
  if ($("vol-music-val")) $("vol-music-val").textContent = mp + "%";
}
applyVolumes();
function onSfxSlider(e) {
  const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
  sfxVol = pct / 100;
  try { localStorage.setItem("ft_sfx_vol", String(pct)); } catch (err) { /* private mode */ }
  if (endFireAudio) endFireAudio.volume = Math.max(0, Math.min(0.32, sfxVol * 0.32));
  applyVolumes();
}
function onMusicSlider(e) {
  const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
  musicVol = pct / 100;
  try { localStorage.setItem("ft_music_vol", String(pct)); } catch (err) { /* private mode */ }
  syncMusicGain();
  applyVolumes();
}
if ($("vol-sfx")) { $("vol-sfx").addEventListener("input", onSfxSlider); $("vol-sfx").addEventListener("change", onSfxSlider); }
if ($("vol-music")) { $("vol-music").addEventListener("input", onMusicSlider); $("vol-music").addEventListener("change", onMusicSlider); }
function resumeMusicOnGesture() {
  if (sfxCtx && sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
  if (musicOn && (!musicAudio || musicAudio.paused)) setMusic(true);
}
window.addEventListener("pointerdown", resumeMusicOnGesture, { once: true });
window.addEventListener("keydown", resumeMusicOnGesture, { once: true });

// ---- Custom Freaky Tiki hand cursor (local native CSS cursor, zero delay) ----
let handCursorOn = true;
try {
  const savedHc = localStorage.getItem("ft_hand_cursor");
  if (savedHc !== null) handCursorOn = savedHc === "1";
} catch (e) { /* private mode */ }
const handCursorCache = {};
function buildHandCursorCss(color) {
  if (handCursorCache[color]) return handCursorCache[color];
  const size = 32;
  const half = size / 2;
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext("2d");
  if (ctx) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(half, half, 8, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(half, half, 8, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#1a0e08";
    ctx.stroke();
  }
  const val = `url("${cv.toDataURL("image/png")}") ${half} ${half}, auto`;
  handCursorCache[color] = val;
  return val;
}
function updateHandCursorAppearance(playersList) {
  const hc = $("hand-cursor");
  if (hc) hc.hidden = true;
  const active = handCursorOn && !touchLike();
  document.body.classList.toggle("hand-cursor-on", active);
  if ($("opt-hand-cursor")) $("opt-hand-cursor").checked = handCursorOn;
  if (!active) {
    document.body.style.removeProperty("--hand-cursor");
    return;
  }
  const v = (!$("game-box").hidden && practice && practice.game) ? practiceView() : prevView;
  const plist = (playersList && playersList.length) ? playersList
    : (v && v.playing_counts ? Object.keys(v.playing_counts)
      : (v && v.players ? v.players : []));
  const inGame = !$("game-box").hidden && myName && plist.length > 0;
  const idx = inGame ? playerIndex(myName, plist) : preferredColor;
  const color = GRAB_COLORS[idx % GRAB_COLORS.length];
  document.body.style.setProperty("--hand-cursor", buildHandCursorCss(color));
}
function renderSettingsColorPicker() {
  const box = $("settings-color-picker");
  if (!box) return;
  box.replaceChildren();
  GRAB_COLORS.forEach((hex, c) => {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "settings-color-swatch" + (preferredColor === c ? " selected" : "");
    sw.style.backgroundColor = hex;
    sw.title = `Color ${c + 1}`;
    sw.setAttribute("aria-label", `Choose color ${c + 1}`);
    sw.addEventListener("click", () => {
      preferredColor = c;
      try { localStorage.setItem("ft_pref_color", String(c)); } catch (err) { /* private mode */ }
      renderSettingsColorPicker();
      updateHandCursorAppearance();
      if (prevView && !prevView.started && !practice) {
        send({ type: "set_color", color: c });
      } else if (practice && practice.game) {
        practiceRender();
      }
    });
    box.append(sw);
  });
}
renderSettingsColorPicker();
updateHandCursorAppearance();
if ($("opt-hand-cursor")) $("opt-hand-cursor").addEventListener("change", (e) => {
  handCursorOn = e.target.checked;
  try { localStorage.setItem("ft_hand_cursor", handCursorOn ? "1" : "0"); } catch (err) { /* private mode */ }
  updateHandCursorAppearance();
});

// Developer mode removed

// ---- Table-click player-colored particles + quiet continuous firecracker ----
let tableSparkActive = false;
let tableSparkX = 0, tableSparkY = 0;
let tableSparkTimer = null;
let firecrackerTimer = null;
function myPlayerColor() {
  const inGame = !$("game-box").hidden;
  if (!inGame) return GRAB_COLORS[preferredColor % GRAB_COLORS.length];
  const view = (practice && practice.game) ? practiceView() : prevView;
  const players = view && view.playing_counts ? Object.keys(view.playing_counts)
    : (lastLobbyView && lastLobbyView.players ? lastLobbyView.players : []);
  const idx = players.length && myName ? playerIndex(myName, players) : preferredColor;
  return GRAB_COLORS[(idx >= 0 ? idx : preferredColor) % GRAB_COLORS.length];
}
function sparkFxLayer() {
  let l = document.getElementById("spark-fx");
  if (!l) { l = document.createElement("div"); l.id = "spark-fx"; document.body.append(l); }
  return l;
}
function spawnTableSpark(x, y, count = 4) {
  if (reduceMotion) return;
  const color = myPlayerColor();
  const layer = sparkFxLayer();
  for (let i = 0; i < count; i++) {
    const p = document.createElement("div");
    p.className = "particle";
    const size = 4 + Math.random() * 5;
    p.style.width = p.style.height = size + "px";
    p.style.left = (x + (Math.random() - 0.5) * 8) + "px";
    p.style.top = (y + (Math.random() - 0.5) * 8) + "px";
    p.style.background = color;
    p.style.boxShadow = `0 0 6px ${color}`;
    p.style.borderRadius = "0";
    layer.append(p);
    const ang = Math.random() * Math.PI * 2;
    const dist = 14 + Math.random() * 26;
    const dx = Math.round(Math.cos(ang) * dist), dy = Math.round(Math.sin(ang) * dist - 6);
    const a = p.animate([
      { transform: "translate(-50%,-50%) scale(1)", opacity: 0.98 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.5)`, opacity: 0 },
    ], { duration: 300, easing: "steps(6, end)", fill: "forwards" });
    a.onfinish = () => p.remove();
    setTimeout(() => p.remove(), 340);
  }
}
function firecrackerPop() {
  if (!sfxOn || sfxVol <= 0) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sfxCtx && AC) sfxCtx = new AC();
    if (!sfxCtx) return;
    if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    const dur = 0.032 + Math.random() * 0.025;
    const len = Math.max(1, Math.floor(sfxCtx.sampleRate * dur));
    const buf = sfxCtx.createBuffer(1, len, sfxCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, 2.2);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const src = sfxCtx.createBufferSource();
    src.buffer = buf;
    const bp = sfxCtx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1800 + Math.random() * 2600;
    bp.Q.value = 1.6;
    const gain = sfxCtx.createGain();
    gain.gain.value = sfxVol * (0.032 + Math.random() * 0.032);
    src.connect(bp).connect(gain).connect(sfxCtx.destination);
    src.start();
  } catch (e) { /* audio unsupported */ }
}
function scheduleFirecracker() {
  if (!tableSparkActive) return;
  firecrackerPop();
  firecrackerTimer = setTimeout(scheduleFirecracker, 28 + Math.random() * 44);
}
function stopTableSpark() {
  tableSparkActive = false;
  clearInterval(tableSparkTimer); tableSparkTimer = null;
  clearTimeout(firecrackerTimer); firecrackerTimer = null;
}
function startFirecrackerAt(x, y) {
  tableSparkActive = true;
  tableSparkX = x; tableSparkY = y;
  spawnTableSpark(tableSparkX, tableSparkY, 6);
  clearInterval(tableSparkTimer);
  tableSparkTimer = setInterval(() => {
    if (tableSparkActive) spawnTableSpark(tableSparkX, tableSparkY, 3);
  }, 55);
  clearTimeout(firecrackerTimer);
  scheduleFirecracker();
}
document.addEventListener("pointerdown", (e) => {
  if (e.button > 0) return;
  const interactiveSel = "button, input, select, textarea, a, label, [role='button'], .stackable, .seat-pile.clickable, .middle-top.draggable-stack, #tiki-box.callable, #shed-zone, .tut-deck-showcase:not(.not-host), #tut-intro-box, #tut-goal-box.clickable, #chat-box";
  if (e.target.closest && e.target.closest(interactiveSel)) return;
  if (prevView && prevView.phase === "joker" && $("table-center") && $("table-center").contains(e.target)) return;
  startFirecrackerAt(e.clientX, e.clientY);
});
window.addEventListener("pointermove", (ev) => {
  if (!tableSparkActive) return;
  tableSparkX = ev.clientX; tableSparkY = ev.clientY;
  spawnTableSpark(tableSparkX, tableSparkY, 2);
});
window.addEventListener("pointerup", stopTableSpark);
window.addEventListener("pointercancel", stopTableSpark);
window.addEventListener("blur", stopTableSpark);

// ---- Home Enter-key flow ----
if ($("name")) $("name").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); $("room").focus(); $("room").select(); }
});
if ($("room")) {
  $("room").addEventListener("input", () => { if ($("join")) $("join").classList.remove("join-ready"); });
  $("room").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      if ($("join") && !$("join").classList.contains("join-ready")) {
        $("join").classList.add("join-ready");
        $("join").focus();
      } else if ($("join")) {
        $("join").click();
      }
    }
  });
}
if ($("join")) {
  $("join").addEventListener("blur", () => $("join").classList.remove("join-ready"));
  $("join").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && $("join").classList.contains("join-ready")) {
      ev.preventDefault();
      $("join").click();
    }
  });
}
function setSettingsOpen(open) {
  const el = $("settings");
  if (!el) return;
  clearTimeout(el._fadeTimer);
  el._fadeTimer = null;
  if (el._fadeAnim) {
    try { el._fadeAnim.cancel(); } catch (e) {}
    el._fadeAnim = null;
  }
  if (open) {
    el._closing = false;
    el.style.pointerEvents = "";
    el.hidden = false;
    if (!reduceMotion) {
      el._fadeAnim = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
      el._fadeTimer = setTimeout(() => { el._fadeAnim = null; }, 220);
    }
  } else {
    if (el.hidden) return;
    if (reduceMotion) { el.hidden = true; el.style.pointerEvents = ""; return; }
    el._closing = true;
    el.style.pointerEvents = "none";
    const finish = () => {
      el._closing = false;
      if (el._fadeAnim) { try { el._fadeAnim.cancel(); } catch (e) {} el._fadeAnim = null; }
      el.style.pointerEvents = "";
      el.hidden = true;
    };
    el._fadeAnim = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "ease-out", fill: "forwards" });
    el._fadeAnim.onfinish = finish;
    el._fadeTimer = setTimeout(finish, 210);
  }
}
$("settings-btn").addEventListener("click", (e) => {
  e.currentTarget.blur();
  if ($("leave")) $("leave").hidden = $("game-box").hidden;
  const el = $("settings");
  setSettingsOpen(el.hidden || !!el._closing);
});
$("set-close").addEventListener("click", () => setSettingsOpen(false));
$("settings").addEventListener("click", (e) => {
  if (e.target === $("settings")) setSettingsOpen(false);
});
$("set-how").addEventListener("click", () => { setSettingsOpen(false); tutOpen(); });
function isNativeFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function isFullscreenActive() {
  return isNativeFullscreen() || document.body.classList.contains("pseudo-fs");
}
function syncFsLabel() {
  const active = isFullscreenActive();
  const label = active ? "Exit full screen" : "Full screen";
  if ($("set-fs")) $("set-fs").textContent = label;
  if ($("fs-btn")) {
    $("fs-btn").title = label;
    $("fs-btn").setAttribute("aria-label", label);
    const ico = $("fs-btn").querySelector("img");
    if (ico) ico.src = active ? "/assets/ico_minimize.png" : "/assets/ico_expand.png";
  }
}
function enterPseudoFs() {
  document.body.classList.add("pseudo-fs");
  setTimeout(() => { try { window.scrollTo(0, 1); } catch (e) { /* ignore */ } }, 60);
  syncFsLabel();
}
function toggleFullscreen() {
  if (isFullscreenActive()) {
    document.body.classList.remove("pseudo-fs");
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
    syncFsLabel();
    return;
  }
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (req) {
    try {
      const res = req.call(el);
      if (res && typeof res.then === "function") {
        res.then(syncFsLabel).catch(() => enterPseudoFs());
      } else {
        setTimeout(() => { if (!isNativeFullscreen()) enterPseudoFs(); else syncFsLabel(); }, 120);
      }
    } catch (e) {
      enterPseudoFs();
    }
  } else {
    enterPseudoFs();
  }
}
$("fs-btn").addEventListener("click", (e) => { e.currentTarget.blur(); toggleFullscreen(); });
$("set-fs").addEventListener("click", (e) => { e.currentTarget.blur(); toggleFullscreen(); });
document.addEventListener("fullscreenchange", syncFsLabel);
document.addEventListener("webkitfullscreenchange", syncFsLabel);

let exitAnimInFlight = false;
function resetPersistentUiAnims() {
  ["coach", "tut-intro-box", "tut-goal-box", "tiki-box"].forEach((id) => {
    const el = $(id);
    if (el && el.getAnimations) el.getAnimations().forEach((a) => { try { a.cancel(); } catch (e) {} });
  });
}
function animateArenaExit(onDone) {
  if (reduceMotion || exitAnimInFlight || !$("game-box") || $("game-box").hidden) {
    resetPersistentUiAnims();
    onDone();
    return;
  }
  const targets = [];
  document.querySelectorAll("#ring .seat, #table-center > *, #coach:not([hidden]), #tiki-box:not([hidden]), #tut-goal-box:not([hidden]), #tut-intro-box:not([hidden])").forEach((el) => {
    if (getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden") {
      targets.push({ el, bottom: el.getBoundingClientRect().bottom });
    }
  });
  if (!targets.length) { resetPersistentUiAnims(); onDone(); return; }
  exitAnimInFlight = true;
  targets.sort((a, b) => b.bottom - a.bottom);
  const stepMs = 45;
  const durMs = 340;
  const anims = [];
  targets.forEach(({ el }, idx) => {
    const baseT = getComputedStyle(el).transform;
    const prefix = (baseT && baseT !== "none") ? baseT + " " : "";
    anims.push(el.animate([
      { opacity: 1, transform: `${prefix}scale(1)` },
      { opacity: 0, transform: `${prefix}scale(0.84)` }
    ], { duration: durMs, delay: idx * stepMs, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "forwards" }));
    playBreathePopSfx(idx * stepMs, "out", idx);
  });
  const totalMs = (targets.length - 1) * stepMs + durMs + 30;
  setTimeout(() => {
    exitAnimInFlight = false;
    onDone();
    // Cancel fill-forwards animations so persistent elements (#coach, #tut-intro-box, #tut-goal-box, #tiki-box)
    // are never stuck at opacity: 0 the next time the player enters a tutorial or practice room.
    anims.forEach((a) => { try { a.cancel(); } catch (e) {} });
    resetPersistentUiAnims();
  }, totalMs);
}
function finalizeLeaveToHome() {
  intentionalLeave = true;
  lastJoinMsg = null;
  clearTimeout(lbDelayTimer); lbDelayTimer = null;
  stopEndScreenSfx();
  cancelGrab({ refresh: false });
  cleanupGiveawayDrag();
  clearStackMsgs();
  hideVarReplay();
  if (practice) endPractice(true);
  if (ws) { try { ws.close(); } catch (e) { /* already gone */ } ws = null; }
  prevView = null;
  currentPlayerColors = {};
  lbShownFor = null;
  stackKeys = {};
  stopTableSpark();
  if ($("ring")) $("ring").style.transform = "";
  document.querySelectorAll(".seat").forEach((s) => s.remove());
  $("table-center").replaceChildren();
  ["settings", "leaderboard", "board-peek", "tutorial", "big-overlay", "coach", "tut-intro-box", "tut-goal-box", "tiki-box", "disconnect-bar", "joker-timer", "key-debug", "chat-box", "game-box"].forEach((id) => { if ($(id)) $(id).hidden = true; });
  chatMessages = [];
  chatUnread = 0;
  for (const entry of speechBubbles.values()) { if (entry && entry.timer) clearTimeout(entry.timer); }
  speechBubbles.clear();
  syncSpeechBubbles();
  setChatOpen(false);
  renderChatLog();
  document.body.classList.remove("in-game", "pseudo-fs");
  if ($("hand-cursor")) $("hand-cursor").hidden = true;
  syncFsLabel();
  syncRejoinHome();
  setTimeout(syncRejoinHome, 300);
  $("join-box").hidden = false;
  showHomeSubpage("menu", true);
  triggerPageBlur($("join-box"));
  showError("");
  log("Returned to Home");
}
function leaveToHome(instant = false) {
  const runExit = () => {
    if (instant === true || !$("leaderboard").hidden || !$("lobby-layer").hidden) {
      finalizeLeaveToHome();
      return;
    }
    animateArenaExit(finalizeLeaveToHome);
  };
  const settingsEl = $("settings");
  if (instant !== true && !reduceMotion && settingsEl && !settingsEl.hidden) {
    const card = settingsEl.querySelector(".panel") || settingsEl;
    settingsEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-out", fill: "forwards" });
    card.animate([{ transform: "scale(1)" }, { transform: "scale(0.95)" }], { duration: 200, easing: "ease-out", fill: "forwards" });
    setTimeout(() => {
      settingsEl.hidden = true;
      settingsEl.getAnimations().forEach((a) => a.cancel());
      card.getAnimations().forEach((a) => a.cancel());
      runExit();
    }, 205);
    return;
  }
  runExit();
}
$("leave").addEventListener("click", () => leaveToHome(false));

const FP_CLICKS = 3;
let fpStep = 0, fpActive = false;
function fpPaint() {
  document.querySelectorAll("#tiki-pips i").forEach((p, i) => p.classList.toggle("on", i < fpStep));
}
function fpReset() { fpStep = 0; fpPaint(); }
function fpPress() {
  if (!fpActive) return;
  fpStep++;
  fpPaint();
  playSfx("tiki_tap");
  vibrate(24);
  $("tiki-label").textContent = `Click me! ${fpStep}/${FP_CLICKS}`;
  const t = $("tiki");
  t.classList.remove("tiki-hit"); void t.offsetWidth; t.classList.add("tiki-hit");
  setTimeout(() => t.classList.remove("tiki-hit"), 220);
  if (fpStep >= FP_CLICKS) {
    fpActive = false;
    stopFreakyThudLoop();
    lastLocalFreakyAt = Date.now();
    playBigFreakyThud();
    send({ type: "move", move: { type: "freaky" } });
  }
}
$("tiki-box").addEventListener("pointerdown", (e) => {
  if (!$("tiki-box").classList.contains("callable")) return;
  e.preventDefault();
  fpPress();
});

$("table-center").addEventListener("pointerdown", (e) => {
  if (lastPhase !== "joker") return;
  e.preventDefault();
  triggerLocalSlapSfx();
  vibrate(28);
  send({ type: "move", move: { type: "slap_press" } });
});

let mHoldTimer = null, mHoldSkipped = false;
const M_SKIP_HOLD_MS = 5000;
function isTextInput(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toUpperCase();
  if (tag === "INPUT") {
    const t = (el.type || "text").toLowerCase();
    if (!["text", "search", "url", "tel", "email", "password", "number"].includes(t)) return false;
  } else if (!(tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable)) {
    return false;
  }
  if (el.closest && el.closest("[hidden]")) return false;
  return true;
}
document.addEventListener("pointerdown", (e) => {
  if (!isTextInput(e.target) && document.activeElement && isTextInput(document.activeElement)) {
    try { document.activeElement.blur(); } catch (err) { /* ignore */ }
  }
}, true);
function normGameKey(ev) {
  const k = (ev.key || "").toLowerCase();
  if (k === "p" || k === "m" || k === "n" || k === "d" || k === "f" || k === "s" || k === "escape" || /^[1-8]$/.test(k)) return k;
  const c = ev.code || "";
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit[1-8]$/.test(c)) return c.slice(5);
  if (/^Numpad[1-8]$/.test(c)) return c.slice(6);
  return k;
}
function startKeyHold(key, target) {
  clearTimeout(keyHoldTimer); keyHoldTimer = null;
  keyHoldTarget = key;
  if (HOLD_MS <= 0) activateGrab(target, key);
  else keyHoldTimer = setTimeout(() => activateGrab(target, key), HOLD_MS);
}
let keyDebugOn = false;
const KEY_DEBUG_PILLS = ["P", "S", "F", "SPACE", "1", "2", "3", "4", "5", "6", "7", "8", "M"];
const keyDebugLog = [];
const keyDebugActive = new Map();
function renderKeyDebug() {
  const box = $("key-debug");
  if (!box) return;
  const inGame = keyDebugOn && prevView && prevView.started && !$("game-box").hidden;
  box.hidden = !inGame;
  if (!inGame) return;
  const now = Date.now();
  for (const [k, exp] of keyDebugActive.entries()) { if (exp <= now) keyDebugActive.delete(k); }
  const pills = KEY_DEBUG_PILLS.map((lbl) => `<span class="key-debug-pill${keyDebugActive.has(lbl) ? " on" : ""}">${lbl}</span>`).join("");
  const rows = keyDebugLog.map((r) => `<div class="${r.warn ? "kd-warn" : ""}">${r.src}: ${r.text}</div>`).join("");
  box.innerHTML = `<div class="key-debug-keys">${pills}</div><div class="key-debug-log">${rows || "<div>Waiting for keys...</div>"}</div>`;
}
function recordKeyDebug(src, text, extra, warn) {
  if (!keyDebugOn) return;
  const line = extra ? `${text} [${extra}]` : text;
  keyDebugLog.unshift({ src, text: line, warn: !!warn });
  if (keyDebugLog.length > 5) keyDebugLog.length = 5;
  renderKeyDebug();
}
function pulseKeyDebugPill(lbl) {
  if (!keyDebugOn) return;
  keyDebugActive.set(lbl, Date.now() + 450);
  renderKeyDebug();
  setTimeout(renderKeyDebug, 470);
}
window.addEventListener("keydown", (ev) => {
  if (!ev.repeat && (ev.code === "F12" || ev.key === "F12")) {
    ev.preventDefault();
    keyDebugOn = !keyDebugOn;
    renderKeyDebug();
    return;
  }
  const rawKey = normGameKey(ev);
  const pillLbl = (ev.code === "Space" || ev.key === " ") ? "SPACE" : rawKey.toUpperCase();
  if (keyDebugOn && prevView && prevView.started) {
    pulseKeyDebugPill(pillLbl);
    const openOv = ["settings", "leaderboard", "tutorial"].filter((id) => !$(id).hidden).join(",");
    const mods = [ev.ctrlKey ? "ctrl" : "", ev.metaKey ? "meta" : "", ev.altKey ? "alt" : ""].filter(Boolean).join("+");
    const block = isTextInput(ev.target) ? `blocked:input(${ev.target && ev.target.id || ev.target.tagName})` : (openOv ? `blocked:overlay(${openOv})` : (mods ? `blocked:mod(${mods})` : ""));
    if (!ev.repeat) {
      recordKeyDebug("CLI", `${pillLbl} (${ev.code || ev.key})`, block || prevView.phase, !!block);
      if (!practice && ws && ws.readyState === 1) {
        wsSend({ type: "key_debug", key: pillLbl, code: ev.code || "", action: block ? `${pillLbl}:${block}` : `key:${pillLbl}` });
      }
    }
  }
  if (isTextInput(ev.target)) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const key = rawKey;
  if (!ev.repeat && key === "n") { ev.preventDefault(); toggleSfx(); return; }
  if (!ev.repeat && key === "m") {
    ev.preventDefault();
    clearTimeout(mHoldTimer);
    mHoldSkipped = false;
    mHoldTimer = setTimeout(() => {
      mHoldTimer = null;
      mHoldSkipped = true;
      skipMusicTrack();
    }, M_SKIP_HOLD_MS);
    return;
  }
  if (!ev.repeat && !ev.shiftKey && (ev.key === "`" || ev.code === "Backquote")) {
    ev.preventDefault();
    if ($("leave")) $("leave").hidden = $("game-box").hidden;
    const el = $("settings");
    setSettingsOpen(el.hidden || !!el._closing);
    return;
  }
  if (key === "escape" && !ev.repeat) {
    ev.preventDefault();
    if (!$("settings").hidden && !$("settings")._closing) { setSettingsOpen(false); return; }
    if (!$("tutorial").hidden) { $("tutorial").hidden = true; return; }
    if (grab) { cancelGrab(); return; }
    return;
  }
  if ((ev.key === "F12" || ev.code === "F12") && !ev.repeat && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
    ev.preventDefault();
    toggleFullscreen();
    return;
  }
  if (key === "b" && !ev.repeat) {
    if (!$("tutorial").hidden && $("tut-prev") && !$("tut-prev").disabled) {
      ev.preventDefault();
      $("tut-prev").click();
      return;
    }
    if (overlayOpen()) return;
    if (!$("join-box").hidden) {
      if ($("multiplayer-view") && !$("multiplayer-view").hidden && $("mp-back")) {
        ev.preventDefault();
        $("mp-back").click();
        return;
      }
      if ($("practice-view") && !$("practice-view").hidden && $("practice-back")) {
        ev.preventDefault();
        $("practice-back").click();
        return;
      }
    }
    if (!$("game-box").hidden && $("coach") && !$("coach").hidden && $("coach-back") && !$("coach-back").hidden && !$("coach-back").disabled) {
      ev.preventDefault();
      $("coach-back").click();
      return;
    }
    return;
  }
  if (overlayOpen()) return;
  if (!$("join-box").hidden && $("home-menu") && !$("home-menu").hidden && !ev.repeat) {
    if (key === "p" && $("home-multiplayer")) {
      ev.preventDefault();
      $("home-multiplayer").click();
      return;
    }
    if (key === "t" && $("tutorial-btn")) {
      ev.preventDefault();
      $("tutorial-btn").click();
      return;
    }
  }
  if (!$("join-box").hidden && $("practice-view") && !$("practice-view").hidden && !ev.repeat && key === "p" && $("solo")) {
    ev.preventDefault();
    $("solo").click();
    return;
  }
  const v = prevView;
  if (v && !v.started && !ev.repeat && key === "p" && $("start") && !$("start").hidden && !$("start").disabled) {
    ev.preventDefault();
    $("start").click();
    return;
  }
  if (ev.code === "Space" || ev.key === " ") {
    if (document.activeElement && document.activeElement.tagName === "BUTTON") document.activeElement.blur();
    ev.preventDefault();
    if (grab) { commitGrab(); return; }
    if (lastPhase === "joker") { triggerLocalSlapSfx(); vibrate(28); send({ type: "move", move: { type: "slap_press" } }); return; }
    if (!ev.repeat && practice) {
      if ($("tut-intro-box") && !$("tut-intro-box").hidden) { $("tut-intro-box").click(); return; }
      if ($("tut-goal-box") && !$("tut-goal-box").hidden && $("tut-goal-box").classList.contains("clickable")) {
        $("tut-goal-box").click();
      }
    }
    return;
  }
  if (!v || !v.started || ev.repeat) return;
  if (v.awaiting_deal && v.host === myName && key === "d") {
    ev.preventDefault();
    playDealPopSfx(0, 0, "shuffle");
    vibrate(18);
    send({ type: "deal" });
    return;
  }
  const canLift = GRAB_PHASES.includes(v.phase) && canPlayNow();
  if (/^[1-8]$/.test(key) && canLift) {
    ev.preventDefault();
    const t = stackKeys[key];
    if (t) {
      const target = { kind: "stack", owner: t.owner, slot: t.slot };
      if (doubleTapEnabled()) {
        const nowMs = Date.now();
        if (lastKeyTap.key === key && nowMs - lastKeyTap.at <= DOUBLE_TAP_MS) {
          clearTimeout(keyHoldTimer); keyHoldTarget = null;
          lastKeyTap = { key: null, at: 0 };
          quickPlayTarget(target);
          return;
        }
        lastKeyTap = { key, at: nowMs };
      }
      startKeyHold(key, target);
    }
    return;
  }
  if (key === "d" && canLift) {
    ev.preventDefault();
    const target = { kind: "play" };
    if (doubleTapEnabled()) {
      const nowMs = Date.now();
      if (lastKeyTap.key === key && nowMs - lastKeyTap.at <= DOUBLE_TAP_MS) {
        clearTimeout(keyHoldTimer); keyHoldTarget = null;
        lastKeyTap = { key: null, at: 0 };
        quickPlayTarget(target);
        return;
      }
      lastKeyTap = { key, at: nowMs };
    }
    startKeyHold(key, target);
    return;
  }
  if (v.phase === "freaky" && v.freaky) {
    if (v.freaky.player === myName) { if (key === "f") { ev.preventDefault(); fpPress(); } }
    else if (key === "s" && !v.finished.includes(myName)) { ev.preventDefault(); playSfx("shed"); vibrate(16); send({ type: "move", move: { type: "shed" } }); }
  }
}, true);
window.addEventListener("keyup", (ev) => {
  const key = normGameKey(ev);
  if (key === "m" && !isTextInput(ev.target)) {
    if (mHoldTimer) { clearTimeout(mHoldTimer); mHoldTimer = null; }
    if (!mHoldSkipped) toggleMusic();
    mHoldSkipped = false;
  }
  if (keyHoldTarget === key) { clearTimeout(keyHoldTimer); keyHoldTarget = null; }
  if (grab && grabKey === key) cancelGrab();
}, true);
window.addEventListener("blur", () => {
  clearTimeout(mHoldTimer); mHoldTimer = null; mHoldSkipped = false;
  clearTimeout(keyHoldTimer); keyHoldTarget = null;
  if (grab) cancelGrab();
});

// ------------------------------------------------------------ practice rooms
const P_PACE = 0.65, P_GRACE = 0.85, P_STACK_DELAY = 2.0, P_FREAKY_TIMEOUT = 10.0, P_JOKER_CHOOSE_TIMEOUT = 10.0;
const P_SLAP = 2, P_SLAP_STACKING = 5, P_GRAB_TTL = 5.0;
const P_BOT_WAIT = 2.0;
const P_STACK_PHASES = ["open", "stacked", "stacker_start", "freaky"];
const P_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const P_SUITS = ["spades", "hearts", "diamonds", "clubs"];
const P_BOTS = ["Bot Mia", "Bot Leo", "Bot Zoe"];
const pnow = () => performance.now() / 1000;
const pPick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const pShuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
const pIsJoker = (c) => c.startsWith("joker");
const pRank = (c) => c.split("_of_")[0];
const pVal = (c) => P_RANKS.indexOf(pRank(c)) + 1;
const pCard = (rank) => rank + "_of_" + pPick(P_SUITS);
const pFullDeck54 = () => P_SUITS.flatMap((s) => P_RANKS.map((r) => r + "_of_" + s)).concat(["joker_red", "joker_black"]);
function pWithin(a, b) {
  if (pIsJoker(a) || pIsJoker(b)) return false;
  const d = Math.abs(pVal(a) - pVal(b)) % 13;
  return d <= 1 || d === 12;
}
const pNear = (rank) => P_RANKS.filter((r) => pWithin(r + "_of_x", rank + "_of_x"));
const pFar = (rank) => P_RANKS.filter((r) => !pWithin(r + "_of_x", rank + "_of_x"));

class PGame {
  constructor(players, playing, stacking, now) {
    this.players = players; this.playing = playing; this.stacking = stacking;
    this.middle = []; this.turn = 0; this.finished = []; this.phase = "open";
    this.startedAt = now - 5; this.lastPlacementAt = null;
    this.stackers = []; this.lastStackAt = null; this.pending = {};
    this.freakyPlayer = null; this.freakyDeadline = null; this.shedPool = [];
    this.jokerPlacer = null; this.jokerFromStacking = false; this.presses = {}; this.slapWinner = null; this.lastSlapper = null; this.jokerDeadline = null; this.fastBots = false;
    this.lastJokerTarget = null; this.jokerTargetStreak = 0;
    this.lastMiss = null; this.missSeq = 0; this.lastStack = null; this.stackSeq = 0;
  }
  total(p) { return this.playing[p].length + this.stacking[p].filter((c) => c).length; }
  refTime() { return this.lastPlacementAt !== null ? this.lastPlacementAt : this.startedAt; }
  nextWithCards(after) {
    const n = this.players.length;
    for (let step = 1; step <= n; step++) {
      const i = (after + step) % n;
      if (this.playing[this.players[i]].length) return i;
    }
    return null;
  }
  settleStackerStart() {
    const eligible = this.stackers.filter((s) => this.playing[s].length);
    if (!eligible.length) { this.stackers = []; this.phase = "open"; return true; }
    const changed = eligible.length !== this.stackers.length || this.phase !== "stacker_start";
    this.stackers = eligible; this.phase = "stacker_start";
    return changed;
  }
  fixTurn() {
    if (this.phase !== "open" || this.turn === null) return false;
    if (this.playing[this.players[this.turn]].length) return false;
    this.turn = this.nextWithCards(this.turn);
    return true;
  }
  pickupMiddle(receiver, now) {
    const cards = pShuffle(this.middle); this.middle = [];
    this.playing[receiver].push(...cards);
    this.stackers = []; this.lastStackAt = null; this.phase = "open";
    this.lastPlacementAt = now; this.turn = this.players.indexOf(receiver);
    this.fixTurn();
    const slots = this.stacking[receiver];
    slots.forEach((c, i) => { if (c === null && this.playing[receiver].length) slots[i] = this.playing[receiver].shift(); });
  }
  pace() { return this.fastBots ? 0.08 : P_PACE; }
  grace() { return this.fastBots ? 0.15 : P_GRACE; }
  stackDelay() { return this.fastBots ? 0.25 : P_STACK_DELAY; }
  scheduleReplacement(stacker, owner, slot, now) {
    const due = now + this.pace();
    const b = this.pending[stacker] || (this.pending[stacker] = { slots: [], due });
    b.slots.push([owner, slot]); b.due = due;
  }
  validJokerTargets() {
    const active = this.players.filter((p) => !this.finished.includes(p));
    if (
      this.lastJokerTarget !== null &&
      this.jokerTargetStreak >= 2 &&
      this.jokerPlacer === this.lastJokerTarget &&
      this.middle.length === 1
    ) {
      const others = active.filter((p) => p !== this.lastJokerTarget);
      if (others.length) return others;
    }
    return active;
  }
  tick(now) {
    let changed = false;
    for (const stacker of Object.keys(this.pending).filter((s) => now >= this.pending[s].due)) {
      const batch = this.pending[stacker]; delete this.pending[stacker];
      for (const [owner, slot] of batch.slots) {
        if (this.stacking[owner][slot] !== null) continue;
        if (this.playing[stacker].length) this.stacking[owner][slot] = this.playing[stacker].shift();
        else if (owner !== stacker && this.playing[owner].length) this.stacking[owner][slot] = this.playing[owner].shift();
      }
      changed = true;
    }
    if (this.phase === "stacked" && this.lastStackAt !== null && now - this.lastStackAt >= this.stackDelay()) {
      this.settleStackerStart(); changed = true;
    }
    if (this.phase === "stacker_start" && this.settleStackerStart()) changed = true;
    if (this.phase === "freaky" && this.freakyDeadline !== null && now >= this.freakyDeadline) {
      this.resolveFreaky(now); changed = true;
    }
    if (this.phase === "joker_choose" && this.jokerDeadline !== null && now >= this.jokerDeadline) {
      const targets = this.validJokerTargets();
      if (targets.length) {
        const target = targets[Math.floor(Math.random() * targets.length)];
        this.slapChoose(this.slapWinner, { target }, now);
      } else {
        this.jokerPlacer = null; this.presses = {}; this.slapWinner = null; this.lastSlapper = null; this.jokerFromStacking = false; this.jokerDeadline = null;
        this.phase = "open";
      }
      changed = true;
    }
    if (this.checkFinished()) changed = true;
    if (this.fixTurn()) changed = true;
    return changed;
  }
  checkFinished() {
    if (this.phase === "joker" || this.phase === "joker_choose") return false;
    let changed = false;
    for (const p of this.players) {
      if (this.total(p) === 0 && !this.finished.includes(p)) {
        this.finished.push(p);
        changed = true;
      }
    }
    if (changed) {
      this.stackers = this.stackers.filter((s) => this.playing[s].length);
      const active = this.players.filter((p) => !this.finished.includes(p));
      const keep = this.players.length >= 6 ? 3 : 2;
      if (active.length <= keep) {
        this.phase = "over";
        this.turn = null;
      }
    }
    return changed;
  }
  applyMove(player, move, now) {
    this.tick(now);
    switch (move && move.type) {
      case "play": return this.play(player, now);
      case "stack": return this.stack(player, move, now);
      case "shed": return this.shed(player);
      case "freaky":
        if (this.phase !== "freaky" || player !== this.freakyPlayer) throw new Error("no Freaky Tiki waiting for your call");
        return this.resolveFreaky(now);
      case "slap_press": return this.slapPress(player, now);
      case "slap_choose": return this.slapChoose(player, move, now);
      default: throw new Error("unknown move type: " + (move && move.type));
    }
  }
  paused() { return ["freaky", "joker", "joker_choose"].includes(this.phase); }
  play(player, now) {
    if (this.paused()) throw new Error("the game is paused while that card is resolved");
    if (this.phase === "stacked") {
      if (!this.stackers.includes(player)) throw new Error("only a player who stacked can start the next turn");
      throw new Error("wait for play cooldown");
    }
    if (!this.playing[player].length) throw new Error("you have no playing-hand cards");
    if (this.phase === "stacker_start") {
      if (!this.stackers.includes(player)) throw new Error("only a player who stacked can start the next turn");
      return this.doPlay(player, now);
    }
    if (this.turn !== null && this.players[this.turn] !== player) {
      throw new Error("it is not your turn");
    }
    if (this.lastPlacementAt !== null && now - this.lastPlacementAt < this.pace())
      throw new Error("wait for play cooldown");
    this.doPlay(player, now);
  }
  doPlay(player, now) {
    const prevTop = this.middle.length ? this.middle[this.middle.length - 1] : null;
    const card = this.playing[player].shift();
    this.middle.push(card); this.lastPlacementAt = now;
    this.stackers = []; this.lastStackAt = null; this.phase = "open";
    if (pIsJoker(card)) {
      this.phase = "joker"; this.jokerPlacer = player; this.jokerFromStacking = false;
      this.presses = {}; this.slapWinner = null; this.lastSlapper = null;
      return;
    }
    if (prevTop !== null && pWithin(card, prevTop) && this.total(player) > 0) {
      this.phase = "freaky"; this.freakyPlayer = player; this.freakyDeadline = now + (this.freakyTimeout || P_FREAKY_TIMEOUT);
      this.shedPool = []; this.turn = this.players.indexOf(player);
      return;
    }
    const idx = this.players.indexOf(player);
    const nxt = this.nextWithCards(idx);
    this.turn = nxt !== null ? nxt : idx;
    if (!this.playing[this.players[this.turn]].length && nxt === null) this.turn = null;
    this.checkFinished();
  }
  stack(player, move, now) {
    if (this.phase === "joker_choose") throw new Error("the game is paused while that card is resolved");
    const owner = move.owner;
    if (!(owner in this.stacking)) throw new Error("no such stacking hand");
    const slot = move.slot;
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.stacking[owner].length) throw new Error("no such stacking slot");
    const card = this.stacking[owner][slot];
    if (card === null) throw new Error("that stacking slot is empty");
    if (this.phase === "joker") {
      if (pIsJoker(card)) throw new Error("a Joker is already being slapped");
      if (now - this.refTime() < this.grace()) throw new Error("incorrect stack, but within the 0.5s grace period - disallowed, no penalty");
      this.missSeq += 1;
      this.lastMiss = { seq: this.missSeq, player, card, target: this.middle.length ? this.middle[this.middle.length - 1] : null, taken: 0, during_joker: true };
      this.stacking[owner][slot] = null;
      if (this.middle.length) this.middle.splice(this.middle.length - 1, 0, card);
      else this.middle.push(card);
      this.scheduleReplacement(player, owner, slot, now);
      return;
    }
    if (pIsJoker(card)) {
      if (player !== owner) throw new Error("only the owner can play a stacking-hand Joker");
      if (this.phase === "freaky") this.resolveFreaky(now);
      this.stacking[owner][slot] = null; this.middle.push(card); this.lastPlacementAt = now;
      this.stackSeq += 1; this.lastStack = { seq: this.stackSeq, player };
      this.scheduleReplacement(player, owner, slot, now);
      this.phase = "joker"; this.jokerPlacer = player; this.jokerFromStacking = true;
      this.presses = {}; this.slapWinner = null; this.lastSlapper = null;
      this.checkFinished();
      return;
    }
    if (!this.middle.length) throw new Error("cannot stack a non-Joker card on an empty table");
    if (pWithin(card, this.middle[this.middle.length - 1])) {
      this.stacking[owner][slot] = null; this.middle.push(card);
      this.stackSeq += 1; this.lastStack = { seq: this.stackSeq, player };
      this.lastPlacementAt = now;
      if (this.phase !== "freaky") {
        this.phase = "stacked";
        if (!this.stackers.includes(player) && this.playing[player].length) this.stackers.push(player);
        this.lastStackAt = now;
      }
      this.scheduleReplacement(player, owner, slot, now);
      this.checkFinished();
      return;
    }
    if (now - this.refTime() < this.grace()) throw new Error("incorrect stack, but within the 0.5s grace period - disallowed, no penalty");
    if (this.phase === "freaky") this.resolveFreaky(now);
    this.missSeq += 1;
    this.lastMiss = { seq: this.missSeq, player, card, target: this.middle[this.middle.length - 1], taken: this.middle.length + 1 };
    this.stacking[owner][slot] = null; this.middle.push(card);
    this.scheduleReplacement(player, owner, slot, now);
    this.pickupMiddle(player, now);
  }
  shed(player) {
    if (this.phase !== "freaky") throw new Error("nobody has a Freaky Tiki to shed against");
    if (player === this.freakyPlayer) throw new Error("you are the one who has to call Freaky Tiki");
    if (!this.playing[player].length) throw new Error("you have no playing-hand cards to shed");
    this.shedPool.push([player, this.playing[player].shift()]);
  }
  resolveFreaky(now) {
    const caller = this.freakyPlayer;
    this.playing[caller] = this.shedPool.map(([, c]) => c).concat(this.playing[caller]);
    this.shedPool = []; this.freakyPlayer = null; this.freakyDeadline = null;
    this.phase = "open"; this.lastPlacementAt = now;
    this.turn = this.players.indexOf(caller);
    this.fixTurn();
  }
  slapPress(player, now = 0) {
    if (this.phase !== "joker") throw new Error("there is no Joker to slap");
    this.presses[player] = (this.presses[player] || 0) + 1;
    this.lastSlapper = player;
    const need = (this.jokerFromStacking && player === this.jokerPlacer) ? P_SLAP_STACKING : P_SLAP;
    if (this.presses[player] >= need) {
      const active = this.players.filter((p) => !this.finished.includes(p));
      const endThresh = this.players.length >= 6 ? 3 : 2;
      if (this.total(player) === 0 && (active.length - 1) <= endThresh) {
        this.jokerPlacer = null; this.presses = {}; this.slapWinner = null; this.lastSlapper = null; this.jokerFromStacking = false; this.jokerDeadline = null;
        delete this.pending[player];
        this.stackers = []; this.lastStackAt = null; this.phase = "open"; this.lastPlacementAt = now;
        const idx = this.players.indexOf(player);
        const nxt = this.nextWithCards(idx);
        this.turn = nxt !== null ? nxt : idx;
        this.checkFinished();
        this.fixTurn();
        return;
      }
      this.slapWinner = player; this.phase = "joker_choose"; this.jokerDeadline = now + P_JOKER_CHOOSE_TIMEOUT;
    }
  }
  slapChoose(player, move, now) {
    if (this.phase !== "joker_choose" || player !== this.slapWinner) throw new Error("only the slap winner chooses who gets the stack");
    if (!this.players.includes(move.target) || this.finished.includes(move.target)) throw new Error("that player is out of the game and cannot be given cards");
    if (!this.validJokerTargets().includes(move.target)) throw new Error(`${move.target} cannot receive the Joker stack 3 times in a row`);
    if (move.target === this.jokerPlacer && this.middle.length === 1) {
      if (move.target === this.lastJokerTarget) this.jokerTargetStreak += 1;
      else { this.lastJokerTarget = move.target; this.jokerTargetStreak = 1; }
    } else {
      this.lastJokerTarget = null;
      this.jokerTargetStreak = 0;
    }
    this.jokerPlacer = null; this.presses = {}; this.slapWinner = null; this.lastSlapper = null; this.jokerFromStacking = false; this.jokerDeadline = null;
    this.pickupMiddle(move.target, now);
  }
  view(me, now, grabs) {
    const v = {
      started: true, practice: true, room: "PRACTICE", you: me, host: me, players: [...this.players],
      you_are_host: false, can_start: false, phase: this.phase,
      your_playing_count: this.playing[me].length,
      playing_counts: Object.fromEntries(this.players.map((p) => [p, this.playing[p].length])),
      stacking_hands: Object.fromEntries(this.players.map((p) => [p, [...this.stacking[p]]])),
      middle_top: this.middle.length ? this.middle[this.middle.length - 1] : null,
      middle_count: this.middle.length,
      turn_player: this.turn !== null ? this.players[this.turn] : null,
      stackers: [...this.stackers], finished: [...this.finished], last_miss: this.lastMiss, last_stack: this.lastStack,
      pace_left: this.lastPlacementAt !== null ? Math.max(0, Math.round((this.pace() - (now - this.lastPlacementAt)) * 1000) / 1000) : 0,
      pace_dur: this.pace(),
      stack_delay_left: (this.phase === "stacked" && this.lastStackAt !== null) ? Math.max(0, Math.round((this.stackDelay() - (now - this.lastStackAt)) * 1000) / 1000) : 0,
      stack_delay_dur: this.stackDelay(),
      grabs: Object.fromEntries(Object.entries(grabs).map(([g, gr]) =>
        [g, { owner: gr.owner, slot: gr.slot, card: gr.card, age_ms: Math.floor((now - gr.t0) * 1000) }])),
    };
    if (this.phase === "freaky") {
      const shed = {};
      for (const [p] of this.shedPool) shed[p] = (shed[p] || 0) + 1;
      v.freaky = { player: this.freakyPlayer, shed_counts: shed,
                   seconds_left: Math.max(0, Math.round((this.freakyDeadline - now) * 10) / 10) };
    }
    if (this.phase === "joker" || this.phase === "joker_choose") {
      const need = (this.jokerFromStacking && me === this.jokerPlacer) ? P_SLAP_STACKING : P_SLAP;
      v.joker = { placer: this.jokerPlacer, from_stacking: this.jokerFromStacking,
                  your_presses: this.presses[me] || 0, your_threshold: need,
                  winner: this.slapWinner, last_slapper: this.lastSlapper, targets: this.validJokerTargets(),
                  seconds_left: this.phase === "joker_choose" && this.jokerDeadline !== null ? Math.max(0, Math.round((this.jokerDeadline - now) * 10) / 10) : null };
    }
    return v;
  }
}

function pBotMove(g, bot, st) {
  if (g.phase === "freaky") {
    if (g.freakyPlayer === bot) return { type: "freaky" };
    if ((st.shedQuota[bot] || 0) > 0 && g.playing[bot].length) { st.shedQuota[bot]--; return { type: "shed" }; }
    return null;
  }
  if (g.phase === "joker") return { type: "slap_press" };
  if (g.phase === "joker_choose") {
    if (g.slapWinner !== bot) return null;
    const valid = g.validJokerTargets();
    const others = valid.filter((p) => p !== bot);
    return { type: "slap_choose", target: pPick(others.length ? others : valid) };
  }
  if (g.phase === "stacker_start" && g.stackers.includes(bot) && g.playing[bot].length) return { type: "play" };
  if (g.phase === "open" && g.turn !== null && g.players[g.turn] === bot && g.playing[bot].length) return { type: "play" };
  if (P_STACK_PHASES.includes(g.phase) && (!g.middle.length || !pIsJoker(g.middle[g.middle.length - 1]))) {
    const ownJ = (g.stacking[bot] || []).findIndex((c) => c && pIsJoker(c));
    const noPlayingLeft = g.players.every((p) => g.finished.includes(p) || !g.playing[p].length);
    if (ownJ >= 0 && (noPlayingLeft || !g.playing[bot].length || g.middle.length >= 3 || g.total(bot) <= 3)) {
      return { type: "stack", owner: bot, slot: ownJ };
    }
  }
  return null;
}
function pFingerprint(g) {
  return [g.phase, g.middle.length, g.middle[g.middle.length - 1], g.turn,
          g.players.map((p) => g.playing[p].length).join(","),
          g.players.map((p) => g.stacking[p].join("/")).join(","),
          g.freakyPlayer, g.slapWinner, JSON.stringify(g.presses)].join("|");
}
const P_DIFF_PROFILES = {
  easy:   { quiet: 1.7,  delay: [1.55, 2.25], slapDelay: [1.25, 1.85], shedMax: 2, freakyTimeout: 12.0, canStack: false },
  medium: { quiet: 0.95, delay: [0.85, 1.30], slapDelay: [0.68, 1.12], shedMax: 3, freakyTimeout: 8.0,  canStack: false },
  hard:   { quiet: 0.45, delay: [0.34, 0.58], slapDelay: [0.24, 0.46], shedMax: 5, freakyTimeout: 4.5,  canStack: true },
};
let practiceDiff = "medium";
try {
  const savedPd = localStorage.getItem("ft_practice_diff");
  if (savedPd && P_DIFF_PROFILES[savedPd]) practiceDiff = savedPd;
} catch (e) { /* private mode */ }

function pBotTick(pr, now) {
  const g = pr.game, st = pr.bot, fast = !!pr.fastBots;
  const prof = P_DIFF_PROFILES[pr.diff || practiceDiff] || P_DIFF_PROFILES.medium;
  const fp = pFingerprint(g);
  if (fp !== st.fp) { st.fp = fp; st.quietUntil = fast ? 0 : now + prof.quiet; }
  const fkey = g.phase === "freaky" ? g.freakyPlayer + "@" + g.freakyDeadline : null;
  if (fkey !== st.freakyKey) {
    st.freakyKey = fkey;
    if (fkey) P_BOTS.forEach((b) => { st.shedQuota[b] = 1 + Math.floor(Math.random() * prof.shedMax); });
  }
  const jkey = g.phase === "joker" ? g.jokerPlacer + "@" + g.middle.length : null;
  if (jkey !== st.jokerKey) {
    st.jokerKey = jkey;
    if (jkey) {
      P_BOTS.forEach((b, bi) => {
        st.next[b] = fast ? now + 0.02 : (now + prof.slapDelay[0] + Math.random() * (prof.slapDelay[1] - prof.slapDelay[0]) + bi * 0.06);
      });
    }
  }
  const inRace = g.phase === "joker" || g.phase === "freaky";
  let acted = false;
  for (const bot of P_BOTS) {
    if (!(bot in st.next)) { st.next[bot] = now + (fast ? 0.02 : prof.delay[0]); continue; }
    if ((!fast && !inRace && now < st.quietUntil) || now < st.next[bot]) continue;
    let mv = pBotMove(g, bot, st);
    if (!mv && prof.canStack && g.middle.length && ["open", "stacked", "stacker_start"].includes(g.phase)) {
      const top = g.middle[g.middle.length - 1];
      for (const owner of g.players) {
        const slots = g.stacking[owner] || [];
        const sIdx = slots.findIndex((c) => c && !pIsJoker(c) && pWithin(c, top));
        if (sIdx >= 0) { mv = { type: "stack", owner, slot: sIdx }; break; }
      }
    }
    if (!mv) { st.next[bot] = now + (fast ? 0.03 : 0.22 + Math.random() * 0.22); continue; }
    try { g.applyMove(bot, mv, now); } catch (e) { st.next[bot] = now + (fast ? 0.03 : 0.35); continue; }
    if (fast) {
      st.next[bot] = now + 0.02;
    } else {
      const rng = mv.type === "slap_press" ? prof.slapDelay : prof.delay;
      st.next[bot] = now + rng[0] + Math.random() * (rng[1] - rng[0]);
    }
    acted = true;
    if (!fast && mv.type !== "slap_press") break;
  }
  return acted;
}

function pDeal(kind, me) {
  const players = [me, ...P_BOTS];
  let deck = pShuffle(P_SUITS.flatMap((s) => P_RANKS.map((r) => r + "_of_" + s)));
  const playing = {}, stacking = {};
  players.forEach((p) => { playing[p] = []; });
  deck.forEach((c, i) => playing[players[i % 4]].push(c));
  players.forEach((p) => { stacking[p] = [playing[p].shift(), playing[p].shift()]; });
  return { players, playing, stacking };
}
function pBuild(kind, me) {
  const now = pnow();
  const diff = practiceDiff;
  const prof = P_DIFF_PROFILES[diff] || P_DIFF_PROFILES.medium;
  const { players, playing, stacking } = pDeal(kind, me);
  const g = new PGame(players, playing, stacking, now);
  g.freakyTimeout = prof.freakyTimeout;
  const info = {};
  if (kind === "turns") {
    const pool = pShuffle(players.flatMap((p) => playing[p].splice(0)));
    const seq = []; let prev = null;
    while (pool.length) {
      let i = pool.findIndex((c) => prev === null || !pWithin(c, prev));
      if (i < 0) i = 0;
      prev = pool.splice(i, 1)[0]; seq.push(prev);
    }
    seq.forEach((c, i) => playing[players[i % 4]].push(c));
    const preMid = Math.floor(Math.random() * 3);
    for (let i = 0; i < preMid; i++) g.middle.push(pCard(pPick(P_RANKS)));
    g.turn = diff === "easy" ? 0 : (Math.random() < 0.5 ? 0 : Math.floor(Math.random() * 4));
  } else if (kind === "stack") {
    const mid = pPick(P_RANKS);
    const midLen = 3 + Math.floor(Math.random() * 5);
    for (let i = 0; i < midLen; i++) g.middle.push(pCard(pPick(P_RANKS)));
    g.middle.push(pCard(mid));
    const good = () => pPick(pNear(mid).filter((r) => r !== mid).concat(pNear(mid)));
    const bad = () => pPick(pFar(mid));
    if (diff === "easy") {
      const mySlot = Math.floor(Math.random() * 2);
      stacking[me] = mySlot === 0 ? [pCard(good()), pCard(bad())] : [pCard(bad()), pCard(good())];
      P_BOTS.forEach((b) => { stacking[b] = [pCard(bad()), pCard(bad())]; });
      g.turn = 0;
      info.passive = true;
    } else if (diff === "medium") {
      const matchMine = Math.random() < 0.5;
      const mySlot = Math.floor(Math.random() * 2);
      stacking[me] = matchMine
        ? (mySlot === 0 ? [pCard(good()), pCard(bad())] : [pCard(bad()), pCard(good())])
        : [pCard(bad()), pCard(bad())];
      const luckyBot = Math.floor(Math.random() * P_BOTS.length);
      P_BOTS.forEach((b, bi) => {
        if ((!matchMine && bi === luckyBot) || Math.random() < 0.35) {
          const bSlot = Math.floor(Math.random() * 2);
          stacking[b] = bSlot === 0 ? [pCard(good()), pCard(bad())] : [pCard(bad()), pCard(good())];
        } else {
          stacking[b] = [pCard(bad()), pCard(bad())];
        }
      });
      g.turn = Math.floor(Math.random() * 4);
      info.passive = false;
    } else {
      // Hard: sometimes no card on the table matches yet — decide when to stack and when to wait!
      const noMatch = Math.random() < 0.4;
      if (noMatch) {
        stacking[me] = [pCard(bad()), pCard(bad())];
        P_BOTS.forEach((b) => { stacking[b] = [pCard(bad()), pCard(bad())]; });
        info.noMatch = true;
      } else {
        const matchMine = Math.random() < 0.4;
        const mySlot = Math.floor(Math.random() * 2);
        stacking[me] = matchMine
          ? (mySlot === 0 ? [pCard(good()), pCard(bad())] : [pCard(bad()), pCard(good())])
          : [pCard(bad()), pCard(bad())];
        const luckyBot = Math.floor(Math.random() * P_BOTS.length);
        P_BOTS.forEach((b, bi) => {
          if ((!matchMine && bi === luckyBot) || Math.random() < 0.35) {
            const bSlot = Math.floor(Math.random() * 2);
            stacking[b] = bSlot === 0 ? [pCard(good()), pCard(bad())] : [pCard(bad()), pCard(good())];
          } else {
            stacking[b] = [pCard(bad()), pCard(bad())];
          }
        });
      }
      g.turn = 1 + Math.floor(Math.random() * P_BOTS.length);
      info.passive = false;
    }
    g.lastPlacementAt = now - 5;
    info.mid = mid;
  } else if (kind === "freaky") {
    const mid = pPick(P_RANKS);
    const midLen = 2 + Math.floor(Math.random() * 5);
    for (let i = 0; i < midLen; i++) g.middle.push(pCard(pPick(P_RANKS)));
    g.middle.push(pCard(mid));
    playing[me].unshift(pCard(pPick(pNear(mid))));
    g.turn = 0; g.lastPlacementAt = now - 5;
    info.mid = mid;
  } else if (kind === "slap") {
    const midLen = 2 + Math.floor(Math.random() * 5);
    for (let i = 0; i < midLen; i++) g.middle.push(pCard(pPick(P_RANKS)));
    const botIdx = Math.floor(Math.random() * P_BOTS.length);
    const jokerBot = P_BOTS[botIdx];
    playing[jokerBot].unshift(pPick(["joker_red", "joker_black"]));
    g.turn = 1 + botIdx; g.lastPlacementAt = now - 5;
    info.jokerBot = jokerBot;
  }
  return { game: g, info };
}

const P_TEXT = {
  turns: ["Taking turns",
    "On your turn, HOLD your pile (or hold D) to lift its top card, keep holding, then press SPACE - or let go over the middle - to play it. " +
    "Let go anywhere else and it goes back. Hard speeds up the pace and lets bots stack."],
  stack: ["Stacking",
    "Any face-up card within one rank of the middle card (Ace wraps to King) can be stacked, from ANY player's hand. " +
    "HOLD a card (or its number key) to lift it, then press SPACE or drop over the middle. Hard mixes in hands with no match so you must decide when to stack and when to wait."],
  freaky: ["Freaky Tiki",
    "Your top card lands within one rank of the middle card. Lift it (hold your pile or D) and drop it on the middle, " +
    "then CLICK THE TIKI 3 times (or press F) before the timer runs out. Higher difficulty shortens the reaction window."],
  slap: ["Joker slap",
    "Watch the middle: a bot is about to flip a Joker. As soon as it lands, click the middle stack (or press SPACE) twice, fast. " +
    "The first to slap chooses who takes the whole middle stack. Higher difficulty requires a faster reaction."],
};

const P_GOAL_TEXT = {
  turns: "Flip 3 cards from your playing pile on your turn (hold D or drag).",
  stack: "Stack a matching face-up card within ±1 rank onto the middle.",
  freaky: "Flip your matching card, then click the Tiki 3 times (or press F).",
  slap: "When the bot flips the Joker, slap twice (SPACE or click) and give the stack away.",
};
function coachSet(kind) {
  const [title, text] = P_TEXT[kind];
  $("coach-title").textContent = title;
  $("coach-text").textContent = text;
  if ($("coach-goal")) {
    $("coach-goal").innerHTML = `<span class="coach-goal-tag">Goal</span><span>${P_GOAL_TEXT[kind] || ""}</span>`;
    $("coach-goal").hidden = !P_GOAL_TEXT[kind];
  }
  $("coach-result").textContent = ""; $("coach-result").className = "";
  document.querySelectorAll("[data-coach-station]").forEach((b) =>
    b.classList.toggle("on", b.dataset.coachStation === kind));
}
function coachResult(text, bad) {
  $("coach-result").textContent = text;
  $("coach-result").className = bad ? "bad" : "";
}
function refreshCoachReal() {
  const l = lastLobbyView;
  $("coach-real").hidden = !(l && l.you_are_host && l.can_start);
}

function openPractice(kind) {
  if (!myName || !ws) return;
  setCoachMode(false);
  if (practice) { clearInterval(practice.timer); clearTimeout(practice.resetTimer); }
  cancelGrab({ refresh: false });
  cleanupGiveawayDrag();
  clearStackMsgs();
  const built = pBuild(kind, myName);
  practice = Object.assign({ kind, diff: practiceDiff, stage: kind === "slap" ? 0 : 1, playerMoved: false, grabs: {}, done: false, doneMsg: "", timer: null, resetTimer: null,
    stats: { plays: 0, called: false, t0: 0 },
    bot: { fp: null, quietUntil: 0, next: {}, shedQuota: {}, freakyKey: null, jokerKey: null } }, built);
  if ($("coach-diff")) {
    $("coach-diff").dataset.diff = practice.diff;
    $("coach-diff").textContent = "Difficulty: " + practice.diff[0].toUpperCase() + practice.diff.slice(1);
  }
  practice.timer = setInterval(practiceTick, 80);
  showError("");
  fpActive = false; fpReset();
  document.querySelectorAll(".fly, .grab-float").forEach((el) => el.remove());
  coachSet(kind);
  $("coach").classList.remove("folded");
  refreshCoachReal();
  prevView = null; midHold = null;
  practiceRender();
}
function endPractice(silent) {
  if (!practice) return;
  setCoachMode(false);
  clearInterval(practice.timer); clearTimeout(practice.resetTimer);
  practice = null;
  cancelGrab({ refresh: false });
  cleanupGiveawayDrag();
  clearStackMsgs();
  fpActive = false; fpReset();
  document.querySelectorAll(".fly, .grab-float").forEach((el) => el.remove());
  $("coach").hidden = true;
  if ($("tut-intro-box")) $("tut-intro-box").hidden = true;
  if ($("tut-goal-box")) $("tut-goal-box").hidden = true;
  $("big-overlay").hidden = true;
  midHold = null;
  if (!silent && lastLobbyView) { prevView = null; render(lastLobbyView); }
}
function practiceView() {
  const v = practice.game.view(myName, pnow(), practice.grabs);
  if (practice.kind === "solo") {
    v.bots = [...P_BOTS];
    v.fast_bots = !!practice.fastBots;
  }
  if (practice.kind === "tutorial" && practice.tut && practice.tut.step === 0 && !practice.tut.dealt) {
    v.tut_deck_showcase = true;
    v.tut_dealing = !!practice.tut.dealing;
  }
  return v;
}
function practiceRender() {
  if (!practice) return;
  const old = prevView && prevView.practice ? prevView : null;
  const v = practiceView();
  render(v);
  coachObserve(old, v);
  if (practice && practice.kind === "tutorial") tutAfterRender(old, v);
  else if (practice) renderPracticeGoalBox(v);
}
function pPruneGrabs(now) {
  const g = practice.game, grabs = practice.grabs;
  let changed = false;
  if (!P_STACK_PHASES.includes(g.phase)) {
    if (Object.keys(grabs).length) { for (const k of Object.keys(grabs)) delete grabs[k]; changed = true; }
    return changed;
  }
  for (const [name, gr] of Object.entries(grabs)) {
    if (gr.slot === -1) continue;
    const card = g.stacking[gr.owner] ? g.stacking[gr.owner][gr.slot] : null;
    if (now - gr.t0 > P_GRAB_TTL || card === null || card !== gr.card) { delete grabs[name]; changed = true; }
  }
  return changed;
}
function practiceTick() {
  if (!practice) return;
  const g = practice.game;
  const now = pnow();
  if (practice.kind === "tutorial") {
    const t = practice.tut;
    // Freeze the game during intro cards, dealing, info steps, or once the step is complete.
    if (!t || t.step === 0 || t.step === 1 || t.step >= TUT_STEPS.length - 1
        || t.phase === "intro" || t.dealing || t.done || t.retry) {
      return;
    }
    // Keep Freaky Tiki deadlines paused in tutorial so the player must call/shed.
    if ((t.step === 6 || t.step === 7) && g.phase === "freaky") {
      g.freakyDeadline = now + 99;
    }
    let changed = g.tick(now);
    if (pPruneGrabs(now)) changed = true;
    if (tutTick(practice, now)) changed = true;
    // Only allow bots to shed on Step 6 after the player triggers Freaky Tiki.
    // On all other tutorial steps, bots never act autonomously.
    if (t.step === 6 && g.phase === "freaky" && pBotTick(practice, now)) changed = true;
    // Tick the Joker countdown live in the tutorial every second.
    const tDl = (g.phase === "joker_choose" && g.jokerDeadline != null) ? g.jokerDeadline : null;
    const tSec = tDl != null ? Math.max(0, Math.ceil(tDl - now)) : null;
    if (tSec !== practice.lastCountdownSec) {
      practice.lastCountdownSec = tSec;
      if (tSec !== null) changed = true;
    }
    if (changed) practiceRender();
    return;
  }
  if (practice.kind !== "solo" && practice.done) return;
  if (practice.kind === "slap" && practice.stage === 0) return;
  let changed = g.tick(now);
  if (pPruneGrabs(now)) changed = true;
  if (!practice.info.passive && pBotTick(practice, now)) changed = true;
  const dl = (g.phase === "freaky" && g.freakyDeadline != null) ? g.freakyDeadline
    : (g.phase === "joker_choose" && g.jokerDeadline != null) ? g.jokerDeadline : null;
  const curSec = dl != null ? Math.max(0, Math.ceil(dl - now)) : null;
  if (curSec !== practice.lastCountdownSec) {
    practice.lastCountdownSec = curSec;
    if (curSec !== null) changed = true;
  }
  if (changed) practiceRender();
}
function practiceSend(obj) { setTimeout(() => { if (practice) practiceHandle(obj); }, 0); }
function practiceHandle(obj) {
  const g = practice.game, now = pnow(), me = myName, grabs = practice.grabs;
  if (obj.type === "grab") {
    pPruneGrabs(now);
    if (obj.slot === -1 && obj.owner === me && g.playing[me] && g.playing[me].length) {
      grabs[me] = { owner: me, slot: -1, card: "card_back", t0: now };
      practiceRender();
      return;
    }
    const slots = g.stacking[obj.owner];
    if (P_STACK_PHASES.includes(g.phase) && slots && Number.isInteger(obj.slot) && slots[obj.slot]
        && !Object.entries(grabs).some(([n, gr]) => n !== me && gr.owner === obj.owner && gr.slot === obj.slot)) {
      grabs[me] = { owner: obj.owner, slot: obj.slot, card: slots[obj.slot], t0: now };
      practiceRender();
    }
  } else if (obj.type === "release_grab") {
    if (grabs[me]) { delete grabs[me]; practiceRender(); }
  } else if (obj.type === "giveaway_hold" || obj.type === "giveaway_release") {
    // Handled locally by giveawayDrag
  } else if (obj.type === "move") {
    const move = obj.move || {};
    if (practice.kind === "tutorial" && !tutAllowedMove(move)) {
      delete grabs[me];
      showError("Follow the current tutorial step!");
      practiceRender();
      return;
    }
    if (!practiceAllowedMove(move)) {
      delete grabs[me];
      showError("Focus on this practice drill's skill!");
      practiceRender();
      return;
    }
    if (move.type === "stack") {
      pPruneGrabs(now);
      const holder = Object.keys(grabs).find((n) => grabs[n].owner === move.owner && grabs[n].slot === move.slot);
      if (holder && holder !== me) return;
      delete grabs[me];
    }
    delete grabs[me];
    if (move.type === "freaky") practice.stats.called = true;
    try { g.applyMove(me, move, now); }
    catch (e) { if (!graceSaveCheck(e.message)) showError(e.message); else showError(""); practiceRender(); return; }
    practice.playerMoved = true;
    practiceRender();
  }
}

function coachObserve(old, v) {
  const pr = practice;
  if (!pr || !old) return;
  const me = myName;
  const gained = (v.playing_counts[me] || 0) - (old.playing_counts[me] || 0);
  const done = (msg, bad) => {
    if (pr.done) return;
    pr.done = true;
    pr.doneMsg = msg;
    pr.doneBad = !!bad;
    coachResult(msg, bad);
    clearTimeout(pr.resetTimer);
    pr.resetTimer = setTimeout(() => { if (practice === pr) openPractice(pr.kind); }, 2400);
  };
  if (pr.kind === "turns") {
    if (old.middle_count < v.middle_count && v.your_playing_count < old.your_playing_count && old.phase === "open") {
      pr.stats.plays++;
      if (pr.stats.plays >= 3) done("Nice rhythm! Keep playing or click the goal for a fresh deal.");
      else coachResult(`Flipped ${pr.stats.plays} of 3. Wait for your turn to come round again.`);
    }
  }
  if (pr.kind === "stack") {
    if (v.phase === "stacked" && old.phase !== "stacked" && v.stackers.includes(me))
      done("Stacked! Your slot refills from your own pile, and only stackers may start the next turn.", false);
    else if (v.middle_count === 0 && old.middle_count > 0 && gained > 0)
      done("Too far away! A wrong stack means you take the whole middle stack.", true);
  }
  if (pr.kind === "freaky") {
    if (v.phase === "freaky" && old.phase !== "freaky") { pr.stats.t0 = pnow(); coachResult("It matches! Click the tiki 3 times now."); }
    if (old.phase === "freaky" && v.phase !== "freaky") {
      const shed = Object.values(old.freaky.shed_counts).reduce((a, b) => a + b, 0);
      const secs = (pnow() - pr.stats.t0).toFixed(1);
      done(pr.stats.called
        ? `Freaky Tiki! Called in ${secs}s. You pick up ${shed} shed card(s) and start the next turn.`
        : `Too slow: resolved after ${secs}s. You pick up ${shed} shed card(s).`,
        !pr.stats.called);
    }
  }
  if (pr.kind === "slap") {
    if (v.phase === "joker" && old.phase !== "joker") { pr.stats.t0 = pnow(); coachResult("JOKER! Slap it: SPACE, SPACE!"); }
    if (v.phase === "joker_choose" && old.phase !== "joker_choose")
      coachResult(v.joker.winner === me
        ? `Slapped in ${(pnow() - pr.stats.t0).toFixed(2)}s! Drag the middle stack onto a player.`
        : `${v.joker.winner} slapped first and is choosing who takes the stack.`, v.joker.winner !== me);
    if (old.phase === "joker_choose" && v.phase !== "joker_choose") {
      const who = v.turn_player;
      done(who === me ? "The stack came to you. You start the next turn."
                      : `${who} takes the stack and starts the next turn.`, who === me);
    }
  }
}

document.querySelectorAll("[data-station]").forEach((b) =>
  b.addEventListener("click", () => { b.blur(); openPractice(b.dataset.station); }));
document.querySelectorAll("[data-coach-station]").forEach((b) =>
  b.addEventListener("click", () => { b.blur(); openPractice(b.dataset.coachStation); }));
$("coach-restart").addEventListener("click", (e) => { e.currentTarget.blur();
  if (practice && practice.kind === "tutorial") loadTutStep(practice.tut.step);
  else if (practice) openPractice(practice.kind); });
$("coach-exit").addEventListener("click", (e) => { e.currentTarget.blur();
  if (practice && practice.kind === "tutorial") endTutorial(); else endPractice(); });
$("coach-back").addEventListener("click", (e) => { e.currentTarget.blur();
  if (!practice || practice.kind !== "tutorial") return;
  if (practice.tut.step > 0) loadTutStep(practice.tut.step - 1); });
function advanceTutStep() {
  if (!practice || practice.kind !== "tutorial" || !practice.tut) return;
  const t = practice.tut, step = TUT_STEPS[t.step];
  if (t.step === 0 && !t.dealt) {
    if (t.phase === "intro") { t.phase = "goal"; $("tut-intro-box").hidden = true; practiceRender(); return; }
    if (!t.dealing) runTutShuffleAndDeal();
    return;
  }
  if (!t.done && !step.info) return;
  if (t.step >= TUT_STEPS.length - 1) endTutorial();
  else loadTutStep(t.step + 1);
}
$("coach-next").addEventListener("click", (e) => { e.currentTarget.blur(); advanceTutStep(); });
$("tut-intro-box").addEventListener("click", () => {
  if (!practice || practice.kind !== "tutorial" || !practice.tut) return;
  practice.tut.phase = "goal";
  $("tut-intro-box").hidden = true;
  practiceRender();
});
$("tut-goal-box").addEventListener("click", () => {
  if (!practice) return;
  if ($("tut-goal-box").classList.contains("clickable")) playButtonClickSfx();
  if (practice.kind !== "tutorial") {
    if (practice.kind === "slap" && practice.stage === 0) {
      practice.stage = 1;
      const jokerBot = (practice.info && practice.info.jokerBot) || P_BOTS[1];
      try { practice.game.applyMove(jokerBot, { type: "play" }, pnow()); } catch (e) {}
      practiceRender();
      return;
    }
    if (practice.done) openPractice(practice.kind);
    return;
  }
  if (!practice.tut) return;
  const t = practice.tut, step = TUT_STEPS[t.step];
  if (t.phase !== "goal") return;
  if (t.retry) { loadTutStep(t.step); practice.tut.phase = "goal"; $("tut-intro-box").hidden = true; practiceRender(); return; }
  if (t.step === 7 && t.stage === 0) {
    t.stage = 1;
    try { practice.game.applyMove(P_BOTS[0], { type: "play" }, pnow()); } catch (e) {}
    practiceRender();
    return;
  }
  if (t.step === 8 && t.stage === 0) {
    t.stage = 1;
    try { practice.game.applyMove(P_BOTS[1], { type: "play" }, pnow()); } catch (e) {}
    practiceRender();
    return;
  }
  if ((t.step === 0 && !t.dealt && !t.dealing) || t.done || step.info) advanceTutStep();
});
window.addEventListener("resize", () => {
  if (practice && !$("tut-goal-box").hidden) {
    const el = practice.kind === "tutorial" ? tutHighlightEl(practiceView()) : practiceHighlightEl(practiceView());
    positionTutGoalBox(el);
  }
});
if ($("coach-diff")) {
  $("coach-diff").dataset.diff = practiceDiff;
  $("coach-diff").textContent = "Difficulty: " + practiceDiff[0].toUpperCase() + practiceDiff.slice(1);
  $("coach-diff").addEventListener("click", (e) => {
    const order = ["easy", "medium", "hard"];
    const cur = e.currentTarget.dataset.diff || practiceDiff;
    practiceDiff = order[(order.indexOf(cur) + 1) % order.length];
    e.currentTarget.dataset.diff = practiceDiff;
    e.currentTarget.textContent = "Difficulty: " + practiceDiff[0].toUpperCase() + practiceDiff.slice(1);
    try { localStorage.setItem("ft_practice_diff", practiceDiff); } catch (err) { /* private mode */ }
    if (practice && practice.kind !== "tutorial") openPractice(practice.kind);
  });
}
$("tutorial-btn").addEventListener("click", (e) => { e.currentTarget.blur(); startTutorial(); });
$("coach-real").addEventListener("click", (e) => { e.currentTarget.blur(); endPractice(true); wsSend({ type: "start" }); });
$("coach-fold").addEventListener("click", (e) => { e.currentTarget.blur(); $("coach").classList.toggle("folded"); });

// ------------------------------------------------------------- tutorial
let tutDealTimers = [];
function clearTutDealTimers() {
  tutDealTimers.forEach((id) => clearTimeout(id));
  tutDealTimers = [];
  document.querySelectorAll(".tut-shuffle-stage").forEach((el) => el.remove());
  if ($("coach-next")) $("coach-next").disabled = false;
  if ($("coach-back") && practice && practice.tut) $("coach-back").disabled = practice.tut.step === 0;
}
function runTutShuffleAndDeal() {
  const pr = practice;
  if (!pr || pr.kind !== "tutorial" || pr.tut.dealing || pr.tut.dealt) return;
  if (reduceMotion) {
    const dealt = pDeal("welcome", myName);
    pr.game.playing = dealt.playing;
    pr.game.stacking = dealt.stacking;
    pr.tut.dealt = true;
    pr.tut.done = true;
    pr.tut.doneMsg = "Dealt! Click here to continue to Step 2.";
    practiceRender();
    return;
  }
  clearTutDealTimers();
  pr.tut.dealing = true;
  if ($("coach-next")) { $("coach-next").disabled = true; $("coach-next").textContent = "Dealing…"; }
  if ($("coach-back")) $("coach-back").disabled = true;
  tutGoalStatus("Dealing", "Shuffling the 54-card deck…");
  practiceRender();

  const centerEl = document.querySelector("#table-center .tut-deck-showcase") || $("table-center");
  const cr = rectOf(centerEl) || { x: innerWidth / 2 - 48, y: innerHeight / 2 - 66, w: 96, h: 132 };
  const cx = cr.x + cr.w / 2, cy = cr.y + cr.h / 2;

  // 1) Riffle-shuffle animation in the center of the table
  const stage = document.createElement("div");
  stage.className = "tut-shuffle-stage";
  stage.style.left = cx + "px";
  stage.style.top = cy + "px";
  ["left", "right"].forEach((side) => {
    const half = document.createElement("div");
    half.className = "tut-shuffle-half " + side;
    for (let i = 0; i < 6; i++) {
      const im = cardImg("card_back");
      im.style.left = "16px";
      im.style.top = (i * -1.5) + "px";
      half.append(im);
    }
    stage.append(half);
  });
  fxLayer().append(stage);
  playDealPopSfx(0, 0, "shuffle");
  vibrate(18);

  const deckFrom = { x: cx - 32, y: cy - 44, w: 64, h: 88 };
  const dealt = pDeal("welcome", myName);
  const players = pr.game.players;

  // 2) Deal cards clockwise one by one to every player's pile + face-up stacking slots
  const dealStartMs = 680;
  const cardDur = 950;
  tutDealTimers.push(setTimeout(() => {
    if (practice !== pr) return;
    stage.remove();
    tutGoalStatus("Dealing", "Dealing clockwise to every player…");
    const pileRects = players.map((p) => {
      const seat = seatEl(p);
      return cardRectOf(seat && (seat.querySelector(".pile-empty-slot") || seat.querySelector(".pilewrap"))) || deckFrom;
    });
    const slotRects = players.map((p) => {
      const seat = seatEl(p);
      const slots = seat ? [...seat.querySelectorAll(".backs > *")] : [];
      return [0, 1].map((idx) => cardRectOf(slots[idx]) || pileRects[players.indexOf(p)]);
    });

    // 16 playing-pile cards flying clockwise
    const pileThrows = 16;
    const pileStep = 95;
    for (let i = 0; i < pileThrows; i++) {
      const pIdx = i % players.length;
      const d = i * pileStep;
      flyCard(deckFrom, pileRects[pIdx], "card_back", { delay: d, duration: cardDur });
      tutDealTimers.push(setTimeout(() => {
        if (practice === pr) {
          playSfx("stack");
          if (i % 4 === 0) vibrate(10);
        }
      }, d));
    }

    // 8 face-up stacking cards (2 per player) flipping from each player's playing pile
    const stackDelayBase = (pileThrows - 1) * pileStep + cardDur + 80;
    const stackStep = 115;
    const stackDur = 620;
    let sIdx = 0;
    for (let slot = 0; slot < 2; slot++) {
      for (let pIdx = 0; pIdx < players.length; pIdx++) {
        const p = players[pIdx];
        const cardName = (dealt.stacking[p] && dealt.stacking[p][slot]) || "card_back";
        const d = stackDelayBase + sIdx * stackStep;
        flyCard(pileRects[pIdx], slotRects[pIdx][slot], cardName, { flip: true, delay: d, duration: stackDur });
        tutDealTimers.push(setTimeout(() => { if (practice === pr) playSfx("stack"); }, d + stackDur));
        sIdx++;
      }
    }

    const landMs = stackDelayBase + sIdx * stackStep + stackDur - 100;
    tutDealTimers.push(setTimeout(() => {
      if (practice !== pr) return;
      pr.game.playing = dealt.playing;
      pr.game.stacking = dealt.stacking;
      pr.tut.dealt = true;
      pr.tut.dealing = false;
      pr.tut.done = true;
      pr.tut.doneMsg = "Dealt! Click here to continue to Step 2.";
      playDealPopSfx(0, sIdx, "land");
      vibrate([20, 24, 24]);
      clearTutDealTimers();
      practiceRender();
    }, landMs));
  }, dealStartMs));
}
function setCoachMode(on) {
  resetPersistentUiAnims();
  const c = $("coach");
  c.classList.toggle("tutorial-mode", on);
  c.querySelector(".coach-badge").textContent = on ? "Tutorial" : "Practice room";
  $("coach-next").hidden = !on;
  $("coach-back").hidden = !on;
  $("coach-step-pill").hidden = !on;
  $("coach-progress").hidden = !on;
  if ($("coach-diff")) $("coach-diff").hidden = on;
  if ($("coach-goal")) $("coach-goal").hidden = false;
  if (!on) {
    if ($("tut-intro-box")) $("tut-intro-box").hidden = true;
    if ($("tut-goal-box")) $("tut-goal-box").hidden = true;
  }
  if (on) $("coach-exit").textContent = lastLobbyView ? "Lobby" : "Exit";
  else $("coach-exit").textContent = "Lobby";
}
function tutBuildCustom(kind, me) {
  const now = pnow();
  if (kind === "deck_intro") {
    const players = [me, ...P_BOTS];
    const playing = {}, stacking = {};
    players.forEach((p) => { playing[p] = []; stacking[p] = [null, null]; });
    const g = new PGame(players, playing, stacking, now);
    g.turn = null;
    return { game: g, info: { passive: true, deckShowcase: true } };
  }
  const { players, playing, stacking } = pDeal(kind, me);
  const g = new PGame(players, playing, stacking, now);
  const info = { passive: true };
  if (kind === "stack") {
    for (let i = 0; i < 4; i++) g.middle.push(pCard(pPick(P_RANKS)));
    g.middle.push(pCard("7"));
    const far = pFar("7");
    stacking[me] = [pCard("8"), pCard(far[0])];
    P_BOTS.forEach((b, bi) => { stacking[b] = [pCard(far[(bi + 1) % far.length]), pCard(far[(bi + 2) % far.length])]; });
    g.turn = 0; g.lastPlacementAt = now - 5;
    info.mid = "7";
  } else if (kind === "miss") {
    for (let i = 0; i < 4; i++) g.middle.push(pCard(pPick(P_RANKS)));
    g.middle.push(pCard("7"));
    const far = pFar("7");
    stacking[me] = [pCard(far[0]), pCard(far[3])];
    g.turn = 0; g.lastPlacementAt = now - 5;
    info.mid = "7";
  } else if (kind === "stack_other") {
    for (let i = 0; i < 3; i++) g.middle.push(pCard(pPick(P_RANKS)));
    g.middle.push(pCard("7"));
    const far = pFar("7");
    stacking[me] = [pCard(far[0]), pCard(far[3])];
    stacking[P_BOTS[0]] = [pCard("8"), pCard(far[1])];
    g.turn = 1; g.lastPlacementAt = now - 5;
    info.mid = "7";
  } else if (kind === "shed") {
    for (let i = 0; i < 3; i++) g.middle.push(pCard(pPick(P_RANKS)));
    g.middle.push(pCard("7"));
    playing[P_BOTS[0]].unshift(pCard("8"));
    g.turn = 1; g.lastPlacementAt = now - 5;
    info.mid = "7";
  } else if (kind === "slap") {
    for (let i = 0; i < 3; i++) g.middle.push(pCard(pPick(P_RANKS)));
    playing[P_BOTS[1]].unshift(pPick(["joker_red", "joker_black"]));
    g.turn = 2; g.lastPlacementAt = now - 5;
  } else if (kind === "stack_joker") {
    for (let i = 0; i < 3; i++) g.middle.push(pCard(pPick(P_RANKS)));
    g.middle.push(pCard("7"));
    stacking[me] = [pPick(["joker_red", "joker_black"]), pCard(pFar("7")[0])];
    g.turn = 0; g.lastPlacementAt = now - 5;
    info.mid = "7";
  } else if (kind === "win") {
    for (let i = 0; i < 3; i++) g.middle.push(pCard(pPick(P_RANKS)));
    g.middle.push(pCard("7"));
    playing[me] = [];
    stacking[me] = [pCard("8")];
    g.turn = 0; g.lastPlacementAt = now - 5;
    info.mid = "7";
  } else {
    g.turn = 1; g.lastPlacementAt = now - 5;
  }
  return { game: g, info };
}
const TUT_STEPS = [
  { title: "Welcome to Freaky Tiki", build: (me) => tutBuildCustom("deck_intro", me), info: true,
    html: "The <b>54-card deck</b> (52 standard cards + 2 Jokers) starts in the middle. It gets shuffled and dealt evenly into each player's blind <b>Playing pile</b>, with 2 cards flipped face up as their <b>Stacking hand</b> (1 in games of 5+).",
    goal: "click the pile to shuffle & deal" },
  { title: "Goal of the game", build: (me) => tutBuildCustom("welcome", me), info: true,
    html: "Your goal is to be the <b>first player to lose all of your cards</b> (both your Playing pile and your Stacking hand). The game keeps going until only <b>2 players</b> still have cards (or <b>3 players</b> in 6+ player games) — those remaining players are the losers!",
    goal: "Click here to continue" },
  { title: "Taking turns", build: (me) => pBuild("turns", me),
    html: "On your turn, flip from your <b>Playing pile</b> onto the middle. Play passes clockwise, and playing out of turn is not allowed.<br><b>Keybind:</b> Hold <kbd>D</kbd> to lift your top card, then press <kbd>SPACE</kbd> to play it.",
    goal: "Drag your pile to the middle — or hold D and press SPACE" },
  { title: "Stacking", build: (me) => tutBuildCustom("stack", me),
    html: "Between turns, anyone can stack a face-up card within <b>±1 rank</b> of the middle card (Ace wraps to King).",
    goal: "Drag the glowing card to the middle" },
  { title: "Stacking mistakes", build: (me) => tutBuildCustom("miss", me),
    html: "Stacking a card too far from the middle card makes you pick up the whole stack. Your glowing card doesn't fit the <b>7</b>.",
    goal: "Try stacking the glowing card to see the penalty" },
  { title: "Stacking other players' cards", build: (me) => tutBuildCustom("stack_other", me),
    html: "You can also stack <b>another player's</b> face-up card within <b>±1 rank</b>. Their empty slot refills from <b>your</b> playing pile!",
    goal: "Drag Bot Mia's glowing card to the middle" },
  { title: "Freaky Tiki - calling it", build: (me) => pBuild("freaky", me),
    html: "When your flipped card lands within <b>±1 rank</b> of the card underneath, the tiki pops up. Call it fast before others shed cards onto you!<br><b>Keybind:</b> Press <kbd>F</kbd> 3 times to call Freaky Tiki.",
    goal: "Flip your top card (drag or D + SPACE), then click the Tiki or press F 3 times" },
  { title: "Freaky Tiki - shedding", build: (me) => tutBuildCustom("shed", me),
    html: "Now Bot Mia is about to match. While she calls Freaky Tiki, every card you shed goes onto <b>her</b> pile!<br><b>Keybind:</b> Press <kbd>S</kbd> to shed quickly.",
    goal: "Click your dotted box (or press S) to shed" },
  { title: "Jokers and the slap", build: (me) => tutBuildCustom("slap", me),
    html: "A Joker pauses the game: everyone races to slap (<b>2 presses</b>). The winner gives the middle stack to anyone.<br><b>Keybind:</b> Mash <kbd>SPACE</kbd> to slap.",
    goal: "When Bot Leo flips the Joker, spam click the middle or mash SPACE twice" },
  { title: "Jokers in your stacking hand", build: (me) => tutBuildCustom("stack_joker", me),
    html: "You can also play a <b>Joker from your own stacking hand</b> at any time! When you do, <b>you</b> must slap <b>5 times</b> instead of 2 to win.",
    goal: "Drag your glowing Joker to the middle, then slap it 5 times!" },
  { title: "Winning", build: (me) => tutBuildCustom("win", me),
    html: "You finish as soon as both your pile and stacking hand are empty. The game ends when only 2 players remain (3 in 6+ player games).",
    goal: "Stack your last glowing 8 onto the 7 to finish!" },
  { title: "You're ready", build: (me) => tutBuildCustom("welcome", me), info: true,
    html: "You've practiced every rule! <b>Quick keys:</b> <kbd>D</kbd> lift playing card, <kbd>SPACE</kbd> drop/slap, <kbd>F</kbd> Freaky Tiki, <kbd>S</kbd> shed, <kbd>`</kbd> settings, <kbd>N</kbd>/<kbd>M</kbd> sound/music.",
    goal: "Click here or Finish when you're ready to play" },
];
function startTutorial() {
  if (!myName) myName = ($("name").value || "").trim() || "You";
  loadTutStep(0);
}
function endTutorial() {
  clearTutDealTimers();
  animateArenaExit(() => {
    endPractice(true);
    $("game-box").hidden = true;
    $("join-box").hidden = false;
    showHomeSubpage("menu", true);
    triggerPageBlur($("join-box"));
    document.body.classList.remove("in-game");
  });
}
function loadTutStep(i) {
  tutReloading = !!practice;
  clearTutDealTimers();
  if (practice) { clearInterval(practice.timer); clearTimeout(practice.resetTimer); }
  cancelGrab({ refresh: false });
  cleanupGiveawayDrag();
  clearStackMsgs();
  const built = TUT_STEPS[i].build(myName);
  if (i === 2 || i === 3) {
    built.game.turn = 0;
    if (i === 3) built.info.passive = true;
  }
  practice = Object.assign({ kind: "tutorial", grabs: {}, done: false, timer: null, resetTimer: null,
    stats: { plays: 0, called: false, t0: 0 },
    bot: { fp: null, quietUntil: 0, next: {}, shedQuota: {}, freakyKey: null },
    tut: { step: i, phase: "intro", done: false, doneMsg: "", retry: false, dealt: false, dealing: false, t0: pnow(), stage: 0, shed: false, shedAt: 0 } }, built);
  practice.timer = setInterval(practiceTick, 80);
  showError("");
  fpActive = false; fpReset();
  document.querySelectorAll(".fly, .grab-float").forEach((el) => el.remove());
  setCoachMode(true);
  if (innerWidth < 700) $("coach").classList.remove("folded");
  tutSetBar("");
  prevView = null; midHold = null;
  practiceRender();
}
function tutGoalStatus(tag, text) {
  const box = $("tut-goal-box");
  if (!box) return;
  box.className = "tut-goal-box";
  box.innerHTML = `<span class="coach-goal-tag">${tag}</span><span>${text}</span>`;
  box.hidden = false;
  positionTutGoalBox(tutHighlightEl(practiceView()));
}
function positionTutGoalBox(target) {
  const box = $("tut-goal-box"), arena = $("arena");
  if (!box || box.hidden || !arena) return;
  const ar = arena.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  const pad = 10, gap = 12;
  let left = (ar.width - br.width) / 2;
  let top = Math.max(pad, ar.height - br.height - 28);
  if (target && target.isConnected) {
    const tr = target.getBoundingClientRect();
    const cx = (tr.left + tr.width / 2) - ar.left;
    const cy = (tr.top + tr.height / 2) - ar.top;
    const cands = [
      { l: tr.right - ar.left + gap, t: cy - br.height / 2 },
      { l: tr.left - ar.left - br.width - gap, t: cy - br.height / 2 },
      { l: cx - br.width / 2, t: tr.top - ar.top - br.height - gap },
      { l: cx - br.width / 2, t: tr.bottom - ar.top + gap },
    ];
    const coach = $("coach");
    const cr = coach && !coach.hidden ? coach.getBoundingClientRect() : null;
    const fits = (c) => {
      if (c.l < pad || c.t < pad || c.l + br.width > ar.width - pad || c.t + br.height > ar.height - pad) return false;
      if (cr) {
        const cl = cr.left - ar.left, ct = cr.top - ar.top;
        const overlap = !(c.l + br.width + 6 < cl || c.l > cl + cr.width + 6 || c.t + br.height + 6 < ct || c.t > ct + cr.height + 6);
        if (overlap) return false;
      }
      return true;
    };
    const pick = cands.find(fits) || cands.find((c) => c.l >= pad && c.t >= pad && c.l + br.width <= ar.width - pad && c.t + br.height <= ar.height - pad) || cands[2];
    left = Math.min(Math.max(pad, pick.l), Math.max(pad, ar.width - br.width - pad));
    top = Math.min(Math.max(pad, pick.t), Math.max(pad, ar.height - br.height - pad));
  }
  box.style.left = Math.round(left) + "px";
  box.style.top = Math.round(top) + "px";
}
function practiceHighlightEl(v) {
  const pr = practice, me = myName;
  if (!pr || pr.playerMoved) return null;
  const diff = pr.diff || practiceDiff;
  const mySeat = seatEl(me);
  if (pr.kind === "turns") {
    const isMyTurn = (v.phase === "open" && v.turn_player === me)
      || (v.phase === "stacker_start" && (v.stackers || []).includes(me));
    return isMyTurn ? (mySeat && mySeat.querySelector(".pilewrap")) : null;
  }
  if (pr.kind === "stack") {
    if (diff === "hard") return null;
    const hands = (v.stacking_hands || {})[me] || [];
    const idx = hands.findIndex((c) => c && v.middle_top && pWithin(c, v.middle_top));
    return idx >= 0 ? slotWrapEl(me, idx) : null;
  }
  if (pr.kind === "freaky") {
    if (v.phase === "freaky") {
      return (v.freaky && v.freaky.player === me) ? $("tiki-box") : document.querySelector("#shed-zone");
    }
    return v.turn_player === me ? (mySeat && mySeat.querySelector(".pilewrap")) : null;
  }
  if (pr.kind === "slap") {
    if (v.phase === "joker" || (v.phase === "joker_choose" && v.joker && v.joker.winner === me)) {
      return document.querySelector("#table-center .middle-stack");
    }
    const jb = (pr.info && pr.info.jokerBot) || P_BOTS[1];
    const bs = seatEl(jb);
    return bs && bs.querySelector(".pilewrap");
  }
  return null;
}
function renderPracticeGoalBox(v) {
  const box = $("tut-goal-box");
  const pr = practice;
  if (!box || !pr || pr.kind === "tutorial") { if (box) box.hidden = true; return; }
  document.querySelectorAll(".tut-highlight").forEach((el) => el.classList.remove("tut-highlight"));
  const target = pr.done ? null : practiceHighlightEl(v);
  if (target) target.classList.add("tut-highlight");
  if (pr.done) {
    box.className = "tut-goal-box done clickable";
    box.innerHTML = `<span class="coach-goal-tag done">Done!</span><span>${pr.doneMsg}</span><span class="tut-goal-cta">Resetting drill (or click now) →</span>`;
    box.hidden = false;
  } else if (pr.kind === "slap" && pr.stage === 0) {
    const jb = (pr.info && pr.info.jokerBot) || P_BOTS[1];
    box.className = "tut-goal-box clickable";
    box.innerHTML = `<span class="coach-goal-tag">Ready?</span><span>Click here when you're ready for ${jb} to flip the Joker!</span>`;
    box.hidden = false;
  } else {
    const diff = pr.diff || practiceDiff;
    let tag = "Your move";
    let text = "";
    if (pr.kind === "turns") {
      const isMyTurn = (v.phase === "open" && v.turn_player === myName)
        || (v.phase === "stacker_start" && (v.stackers || []).includes(myName));
      tag = isMyTurn ? "Your move" : "Wait";
      text = isMyTurn ? "Hold your pile (or D), then drop on the middle"
        : (v.turn_player ? `Wait for ${v.turn_player}'s turn…` : "Wait for the next turn…");
    } else if (pr.kind === "stack") {
      if (v.phase === "joker_choose" && v.joker && v.joker.winner !== myName) {
        tag = "Wait";
        text = `${v.joker.winner} is choosing who gets the stack…`;
      } else if (v.phase === "joker") {
        text = "Click the middle stack or mash SPACE twice!";
      } else {
        const anyMatch = v.middle_top && Object.values(v.stacking_hands || {}).some((hand) =>
          (hand || []).some((c) => c && !pIsJoker(c) && pWithin(c, v.middle_top)));
        if (diff === "hard") {
          tag = anyMatch ? "Your move" : "Wait";
          text = anyMatch ? "Match on the table — stack fast before a bot grabs it!"
            : "No match yet — hold off and wait for a new middle card";
        } else {
          text = "Hold a matching face-up card and drop it on the middle";
        }
      }
    } else if (pr.kind === "freaky") {
      if (v.phase === "freaky") {
        text = (v.freaky && v.freaky.player === myName)
          ? "Click the Tiki 3 times (or press F)!"
          : "Click your dotted box (or press S) to shed!";
      } else if (v.turn_player === myName) {
        text = "Hold your pile (or D) and drop it on the middle";
      } else {
        tag = "Wait";
        text = `Wait for ${v.turn_player || "the next"}'s turn…`;
      }
    } else if (pr.kind === "slap") {
      if (v.phase === "joker") {
        text = "Click the middle stack or mash SPACE twice!";
      } else if (v.phase === "joker_choose") {
        if (v.joker && v.joker.winner === myName) {
          text = "Drag the middle stack onto any player";
        } else {
          tag = "Wait";
          text = `${v.joker ? v.joker.winner : "Winner"} is choosing who gets the stack…`;
        }
      } else {
        tag = "Watch";
        text = "Get ready to slap!";
      }
    }
    box.className = "tut-goal-box";
    box.innerHTML = `<span class="coach-goal-tag">${tag}</span><span>${text}</span>`;
    box.hidden = false;
  }
  positionTutGoalBox(target);
}
function renderTutIntroBox() {
  const intro = $("tut-intro-box");
  if (!intro || !practice || practice.kind !== "tutorial" || !practice.tut) { if (intro) intro.hidden = true; return; }
  const t = practice.tut, step = TUT_STEPS[t.step];
  if (t.phase !== "intro") { intro.hidden = true; return; }
  intro.innerHTML = `<div class="tut-intro-title">${step.title}</div><p class="tut-intro-text">${step.html}</p><span class="tut-intro-cta">Click here to continue →</span>`;
  intro.hidden = false;
}
function renderTutGoalBox(target) {
  const box = $("tut-goal-box");
  if (!box || !practice || practice.kind !== "tutorial" || !practice.tut) { if (box) box.hidden = true; return; }
  const t = practice.tut, step = TUT_STEPS[t.step];
  if (t.phase === "intro") { box.hidden = true; return; }
  if (t.dealing) return;
  const last = t.step >= TUT_STEPS.length - 1;
  if (t.retry) {
    box.className = "tut-goal-box clickable";
    box.innerHTML = `<span class="coach-goal-tag">Try again</span><span>Mia called before you shed.</span><span class="tut-goal-cta">Click here to retry →</span>`;
    box.hidden = false;
  } else if (t.done) {
    box.className = "tut-goal-box done clickable";
    box.innerHTML = `<span class="coach-goal-tag done">Done!</span><span>${t.doneMsg}</span><span class="tut-goal-cta">${last ? "Click to finish →" : "Click to continue →"}</span>`;
    box.hidden = false;
  } else if (t.step === 7 && t.stage === 0) {
    box.className = "tut-goal-box clickable";
    box.innerHTML = `<span class="coach-goal-tag">Ready?</span><span>Click here when you're ready for Mia to flip her matching card!</span>`;
    box.hidden = false;
  } else if (t.step === 8 && t.stage === 0) {
    box.className = "tut-goal-box clickable";
    box.innerHTML = `<span class="coach-goal-tag">Ready?</span><span>Click here when you're ready for Leo to flip the Joker!</span>`;
    box.hidden = false;
  } else if (t.step === 7 && t.shed) {
    box.className = "tut-goal-box";
    box.innerHTML = `<span class="coach-goal-tag">Watch</span><span>Shed! Mia collects all the cards you shed when she calls.</span>`;
    box.hidden = false;
  } else if (step.goal) {
    const clickable = (t.step === 0 && !t.dealt) || !!step.info;
    const v = practiceView();
    const isWait = (t.step === 8 && t.stage === 1 && v.phase !== "joker" && !(v.phase === "joker_choose" && v.joker && v.joker.winner === myName))
      || (v.phase === "joker_choose" && v.joker && v.joker.winner !== myName);
    const tag = last ? "Ready" : isWait ? "Wait" : "Your move";
    box.className = "tut-goal-box" + (clickable ? " clickable" : "");
    box.innerHTML = `<span class="coach-goal-tag">${tag}</span><span>${step.goal}</span>`;
    box.hidden = false;
  } else {
    box.hidden = true;
    return;
  }
  positionTutGoalBox(target);
}
function tutSetBar(resultText) {
  const t = practice.tut, step = TUT_STEPS[t.step];
  $("coach-title").textContent = step.title;
  $("coach-text").innerHTML = step.html;
  $("coach-step-pill").textContent = `Step ${t.step + 1} / ${TUT_STEPS.length}`;
  $("coach-progress-bar").style.width = `${Math.round(((t.step + 1) / TUT_STEPS.length) * 100)}%`;
  if ($("coach-goal")) {
    $("coach-goal").innerHTML = step.goal ? `<span class="coach-goal-tag">Goal</span><span>${step.goal}</span>` : "";
    $("coach-goal").hidden = !step.goal;
  }
  $("coach-back").disabled = t.step === 0;
  coachResult(resultText || "");
  tutNextLabel();
}
function tutNextLabel() {
  const t = practice && practice.tut;
  if (!t) return;
  const step = TUT_STEPS[t.step];
  const last = t.step >= TUT_STEPS.length - 1;
  const ready = !!(t.done || step.info || (t.step === 0 && !t.dealt));
  $("coach-next").disabled = !ready;
  $("coach-next").textContent = last ? "Finish"
    : ready ? "Next →" : "Complete step";
  $("coach-next").classList.toggle("tut-ready", ready);
}
function tutTick(pr, now) {
  const t = pr.tut, g = pr.game;
  if (t.step !== 7) return false;
  if (t.stage === 1 && t.shed && now - t.shedAt > 2.2) {
    t.stage = 2;
    try { g.applyMove(P_BOTS[0], { type: "freaky" }, now); return true; } catch (e) { return false; }
  }
  return false;
}
function tutHighlightEl(v) {
  const t = practice.tut, me = myName;
  const mySeat = seatEl(me);
  switch (t.step) {
    case 0: return document.querySelector("#table-center .tut-deck-showcase") || (mySeat && mySeat.querySelector(".seat-cards"));
    case 1: return null;
    case 2: return mySeat && mySeat.querySelector(".pilewrap");
    case 3: {
      const hands = (v.stacking_hands || {})[me] || [];
      const idx = hands.findIndex((c) => c && v.middle_top && pWithin(c, v.middle_top));
      return idx >= 0 ? slotWrapEl(me, idx) : mySeat && mySeat.querySelector(".seat-cards");
    }
    case 4: return slotWrapEl(me, 0);
    case 5: return slotWrapEl(P_BOTS[0], 0);
    case 6: return v.phase === "freaky" ? $("tiki-box") : mySeat && mySeat.querySelector(".pilewrap");
    case 7: {
      if (v.phase === "freaky") return document.querySelector("#shed-zone");
      const mia = seatEl(P_BOTS[0]);
      return mia && mia.querySelector(".pilewrap");
    }
    case 8: {
      if (v.phase === "joker" || v.phase === "joker_choose")
        return document.querySelector("#table-center .middle-stack");
      const leo = seatEl(P_BOTS[1]);
      return leo && leo.querySelector(".pilewrap");
    }
    case 9: return (v.phase === "joker" || v.phase === "joker_choose")
      ? document.querySelector("#table-center .middle-stack")
      : slotWrapEl(me, 0);
    case 10: return slotWrapEl(me, 0);
    default: return null;
  }
}
function tutAfterRender(old, v) {
  document.querySelectorAll(".tut-highlight").forEach((el) => el.classList.remove("tut-highlight"));
  const pr = practice, t = pr.tut, me = myName;
  renderTutIntroBox();
  if (t.phase === "intro") { renderTutGoalBox(null); return; }
  const target = (t.done || t.retry) ? null : tutHighlightEl(v);
  if (target) target.classList.add("tut-highlight");
  if (!old) { renderTutGoalBox(target); return; }
  const gained = (v.playing_counts[me] || 0) - (old.playing_counts[me] || 0);
  const doneTut = (msg) => {
    if (t.done) return;
    t.done = true;
    t.doneMsg = msg;
    coachResult("");
    bigEvent("Done!", "freaky", 1150);
    tutNextLabel();
  };
  if (t.step === 2 && old.middle_count < v.middle_count
      && v.your_playing_count < old.your_playing_count && old.phase === "open")
    doneTut("Played! The turn passed clockwise, just like that. On to stacking.");
  if (t.step === 3 && v.phase === "stacked" && old.phase !== "stacked" && v.stackers.includes(me))
    doneTut("Stacked! Your slot refills from your own pile - and only the players who stacked may start the next turn.");
  if (t.step === 4 && v.middle_count === 0 && old.middle_count > 0 && gained > 0)
    doneTut("The whole middle stack goes to the bottom of your pile. Since you made the mistake, you start the next turn.");
  if (t.step === 5 && v.phase === "stacked" && old.phase !== "stacked" && v.stackers.includes(me))
    doneTut("Nice! Mia's slot refills from your playing pile - you just shed a card onto her table spot!");
  if (t.step === 6) {
    if (old.phase === "freaky" && v.phase !== "freaky")
      doneTut(pr.stats.called
        ? "Called it! Everything the bots shed is yours, on top of your pile - and you start the next turn."
        : "It resolved by itself after 10 seconds - you still collect the sheds, but a faster call means fewer of them.");
  }
  if (t.step === 7) {
    if (v.phase === "freaky" && v.freaky && (v.freaky.shed_counts[me] || 0) > 0 && !t.shed) {
      t.shed = true; t.shedAt = pnow();
      tutGoalStatus("Watch", "Shed! Mia collects all the cards you shed when she calls.");
    }
    if (old.phase === "freaky" && v.phase !== "freaky") {
      if (t.shed) doneTut("Mia called it and picked up your shed cards along with the rest. That is the tax for matching.");
      else t.retry = true;
    }
  }
  if ((t.step === 8 || t.step === 9) && old.phase === "joker_choose" && v.phase !== "joker_choose")
    doneTut(v.turn_player === me
      ? "The stack came to you this time - the receiver always starts the next turn."
      : "The slap winner chose, the stack moved, and its new owner starts the next turn.");
  if (t.step === 10 && (v.finished.includes(me) || (v.your_playing_count === 0 && (v.stacking_hands[me] || []).every((c) => !c))))
    doneTut("Finished! Zero cards - that is how every Freaky Tiki ends for a winner.");
  renderTutGoalBox((t.done || t.retry) ? null : target);
}
