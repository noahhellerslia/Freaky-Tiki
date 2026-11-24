import json, threading, http.server, socketserver, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = Path(__import__("tempfile").mkdtemp())

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=str(ROOT), **k)
    def translate_path(self, path):
        if path.split("?")[0] == "/": path = "/client/index.html"
        return super().translate_path(path)
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header("Cache-Control", "no-store"); super().end_headers()
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 8766), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

P = ["Tester", "Bot A", "Bot B", "Bot C"]
LOBBY = {"started": False, "room": "TIKI", "players": P, "host": "Tester", "you_are_host": True, "can_start": True}
def gv(**o):
    v = {"started": True, "room": "TIKI", "players": P, "host": "Tester", "you_are_host": True, "can_start": True,
         "phase": "open", "turn_player": "Bot A", "stackers": [], "finished": [], "ranking": [], "losers": [],
         "middle_top": "5_of_hearts", "middle_count": 3,
         "playing_counts": {"Tester": 13, "Bot A": 13, "Bot B": 14, "Bot C": 14}, "your_playing_count": 13,
         "stacking_hands": {"Tester": ["6_of_clubs", "9_of_hearts"], "Bot A": ["3_of_spades", "K_of_diamonds"],
                            "Bot B": ["8_of_clubs", "2_of_hearts"], "Bot C": ["Q_of_spades", "4_of_diamonds"]},
         "freaky": None, "joker": None, "grabs": {}}
    v.update(o); return v

results = []
def check(ok, msg):
    results.append(bool(ok)); print(("PASS " if ok else "FAIL ") + msg)

with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "fonts.g" not in m.text and "ERR_" not in m.text and "Failed to load resource" not in m.text else None)
    S = {"ws": None, "sent": []}
    def on_ws(ws):
        S["ws"] = ws
        def on_msg(m):
            d = json.loads(m); S["sent"].append(d)
            if d.get("type") == "join": ws.send(json.dumps({"type": "lobby", "view": LOBBY}))
        ws.on_message(on_msg)
    page.route_web_socket("**/ws", on_ws)
    def push(v): S["ws"].send(json.dumps({"type": "state", "view": v}))
    def sent(t=None, mt=None):
        return [d for d in S["sent"] if (t is None or d.get("type") == t) and (mt is None or d.get("move", {}).get("type") == mt)]

    page.add_init_script("try{localStorage.setItem('ft_tut_seen','1')}catch(e){}")
    page.goto("http://127.0.0.1:8766/")
    page.fill("#name", "Tester"); page.fill("#room", "TIKI"); page.click("#join")
    page.wait_for_selector(".lobby-player"); page.wait_for_timeout(300)

    # ---------- everything on the table
    inside = page.evaluate("""() => ['status','action-info','settings-btn','fs-btn','start','lobby-actions','error'].every(id => document.getElementById('arena').contains(document.getElementById(id)))""")
    check(inside, "status, info, buttons, Start and practice buttons all live inside the table")
    check(page.is_hidden("h1") and page.evaluate("()=>document.documentElement.scrollHeight <= innerHeight + 2"),
          "no title and no page scroll in a room: the page IS the table")
    ar = page.eval_on_selector("#arena", "e=>{const r=e.getBoundingClientRect();return [r.width,r.height]}")
    check(ar[1] >= 760, f"table fills the screen ({ar})")
    check(page.is_visible("#start") and page.is_visible('[data-station="turns"]'), "host sees Start game + practice rooms on the felt")
    page.screenshot(path=str(SHOTS / "01_lobby.png"))

    push(gv(turn_player="Tester"))
    page.wait_for_selector(".seat"); page.wait_for_timeout(300)
    page.screenshot(path=str(SHOTS / "02_game_hidden_keys.png"))
    check(page.evaluate("()=>[...document.querySelectorAll('.key-hint')].every(e=>getComputedStyle(e).display==='none')"),
          "keybind hints are hidden by default")
    check(page.query_selector("#my-hand") is None, "no panel off the table: the bottom pile panel is gone")
    big = page.eval_on_selector(".seat.me .seat-pile", "e=>e.offsetWidth")
    check(big >= 70, f"my playing pile is big in my seat ({big}px)")

    # ---------- settings -> show keys
    page.click("#settings-btn")
    check(page.is_visible("#settings") and page.evaluate("()=>document.getElementById('arena').contains(document.getElementById('settings'))"),
          "settings open ON the table")
    page.check("#opt-keys"); page.click("#set-close")
    page.wait_for_timeout(100)
    hints = page.eval_on_selector_all(".seat.me .key-hint", "els=>els.map(e=>[e.textContent,getComputedStyle(e).display])")
    check(any(t == "P" and d != "none" for t, d in hints) and any(t == "1" and d != "none" for t, d in hints),
          f"turning the setting on shows P and number keycaps: {hints}")
    sp = page.eval_on_selector("#table-center .key-hint", "e=>getComputedStyle(e).display")
    check(sp != "none", "SPACE keycap shows near the middle stack")
    page.screenshot(path=str(SHOTS / "03_game_keys.png"))
    page.reload(); page.fill("#name", "Tester"); page.fill("#room", "TIKI"); page.click("#join")
    page.wait_for_selector(".lobby-player"); push(gv(turn_player="Tester")); page.wait_for_selector(".seat")
    check(page.evaluate("()=>document.body.classList.contains('show-keys')"), "the setting is remembered")
    page.click("#settings-btn"); page.uncheck("#opt-keys"); page.click("#set-close")

    # ---------- hold P to lift, release returns, SPACE plays
    S["sent"].clear()
    page.keyboard.press("Space"); page.wait_for_timeout(100)
    check(not sent("move", "play"), "SPACE alone no longer plays a card")
    page.keyboard.press("p"); page.wait_for_timeout(250)
    check(not sent("move", "play") and page.query_selector(".grab-float") is None, "a quick tap of P does nothing")
    page.keyboard.down("p"); page.wait_for_timeout(250)
    check(page.query_selector(".grab-float") is not None, "holding P lifts the top card of my pile")
    page.keyboard.up("p"); page.wait_for_timeout(120)
    check(page.query_selector(".grab-float") is None and not sent("move", "play"), "letting go of P puts it back (nothing played)")
    page.keyboard.down("p"); page.wait_for_timeout(250); page.keyboard.press("Space"); page.wait_for_timeout(100)
    check(len(sent("move", "play")) == 1, "hold P then SPACE plays the card")
    page.keyboard.up("p"); page.wait_for_timeout(100)
    # mouse: hold pile, drag to middle, release plays; release elsewhere does not
    S["sent"].clear()
    pile = page.eval_on_selector(".seat.me .seat-pile", "e=>{const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]}")
    mid = page.eval_on_selector("#table-center", "e=>{const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]}")
    page.mouse.move(*pile); page.mouse.down(); page.wait_for_timeout(250)
    check(page.query_selector(".grab-clone") is not None, "holding the pile with the mouse lifts a card")
    page.mouse.move(60, 300, steps=5); page.mouse.up(); page.wait_for_timeout(100)
    check(not sent("move", "play"), "letting go away from the middle puts it back")
    page.mouse.move(*pile); page.mouse.down(); page.wait_for_timeout(250)
    page.mouse.move(*mid, steps=8); page.mouse.up(); page.wait_for_timeout(100)
    check(len(sent("move", "play")) == 1, "letting go over the middle plays it")
    page.mouse.click(*pile); page.wait_for_timeout(250)
    check(len(sent("move", "play")) == 1, "a plain click on the pile does nothing")

    # ---------- middle card keeps previous face in flight (regression)
    push(gv(turn_player="Bot A", middle_top="K_of_spades", middle_count=4,
            playing_counts={"Tester": 12, "Bot A": 13, "Bot B": 14, "Bot C": 14}, your_playing_count=12))
    page.wait_for_timeout(120)
    check("5_of_hearts" in page.get_attribute("#table-center .middle-top", "src"), "middle still shows the previous card mid-flight")
    page.wait_for_timeout(800)

    # ---------- stacking: hold key keeps it, release returns, 5s limit returns it (the vanishing-card bug)
    push(gv(turn_player="Bot A")); page.wait_for_timeout(200)
    S["sent"].clear()
    slot1 = "()=>{const w=document.querySelectorAll('.seat.me .backs > *')[0];const i=w.querySelector('img');return {ghost:w.classList.contains('grabbed-slot'),img:!!i,vis:i?getComputedStyle(i).visibility:null}}"
    page.keyboard.down("1"); page.wait_for_timeout(250)
    st = page.evaluate(slot1)
    check(st["ghost"] and len(sent("grab")) == 1 and page.query_selector(".grab-float") is not None, f"holding 1 lifts the stacking card ({st})")
    page.keyboard.up("1"); page.wait_for_timeout(150)
    st = page.evaluate(slot1)
    check(not st["ghost"] and st["img"] and st["vis"] == "visible" and len(sent("release_grab")) == 1 and page.query_selector(".grab-float") is None,
          f"letting go of 1 puts the card back in its slot ({st})")
    # server echoes my grab AFTER I let go: the slot must not look held
    push(gv(turn_player="Bot A", grabs={"Tester": {"owner": "Tester", "slot": 0, "card": "6_of_clubs", "age_ms": 10}}))
    page.wait_for_timeout(150)
    st = page.evaluate(slot1)
    check(st["img"] and not st["ghost"], f"a stale echo of my released grab does not hide the card ({st})")
    push(gv(turn_player="Bot A"))
    # hold >5s: the card must come back, not vanish
    S["sent"].clear()
    page.keyboard.down("1"); page.wait_for_timeout(5600)
    st = page.evaluate(slot1)
    check(st["img"] and not st["ghost"] and st["vis"] == "visible", f"held past the 5s limit: the card is back in its slot, not gone ({st})")
    check(page.query_selector(".grab-float") is None, "and its floating copy is gone")
    page.keyboard.up("1"); page.wait_for_timeout(100)
    # hold 2 then Space stacks
    S["sent"].clear()
    page.keyboard.down("2"); page.wait_for_timeout(250); page.keyboard.press("Space"); page.wait_for_timeout(100)
    mv = sent("move", "stack")
    check(len(mv) == 1 and mv[0]["move"]["owner"] == "Tester" and mv[0]["move"]["slot"] == 1, "hold 2 then SPACE stacks that card")
    page.keyboard.up("2")
    push(gv(turn_player="Bot A"))   # server answered; table normal again
    page.wait_for_timeout(1000)

    # ---------- Joker: click the stack to slap
    S["sent"].clear()
    push(gv(phase="joker", turn_player=None, middle_top="joker_red", middle_count=4,
            joker={"placer": "Bot A", "from_stacking": False, "your_presses": 0, "your_threshold": 2, "winner": None, "targets": P}))
    page.wait_for_timeout(300)
    check(page.is_visible(".slap-prompt") and "0/2" in page.inner_text(".slap-prompt"), "Joker: the stack shows a SLAP prompt with the count")
    page.screenshot(path=str(SHOTS / "04_joker.png"))
    page.click("#table-center .middle-top", force=True); page.click("#table-center .middle-top", force=True); page.keyboard.press("Space")
    page.wait_for_timeout(100)
    check(len(sent("move", "slap_press")) == 3, "clicking the stack slaps (same as pressing SPACE)")
    check(page.query_selector("#slap-btn") is None, "no separate slap button")

    # ---------- Freaky: someone else called -> shed rectangle / S key
    S["sent"].clear()
    fv = lambda **k: gv(phase="freaky", turn_player="Bot A", middle_count=5,
        freaky=dict({"player": "Bot A", "shed_counts": {}, "seconds_left": 8.0}, **k))
    push(fv()); page.wait_for_timeout(300)
    check(page.is_visible("#tiki-box") and not page.evaluate("()=>document.getElementById('tiki-box').classList.contains('callable')"), "everyone sees the tiki; it is only a button for the caller")
    check(page.is_visible("#shed-zone"), "non-callers get the shed rectangle on the table")
    page.screenshot(path=str(SHOTS / "05_freaky_other.png"))
    page.click("#shed-zone"); page.keyboard.press("s"); page.wait_for_timeout(100)
    check(len(sent("move", "shed")) == 2, "clicking the shed rectangle sheds one card; so does S")
    page.keyboard.press("f"); page.wait_for_timeout(50)
    check(not sent("move", "freaky"), "F does nothing for non-callers")
    # ---------- Freaky: I am the caller -> click the tiki 4x
    S["sent"].clear()
    push(fv(player="Tester")); page.wait_for_timeout(300)
    check(page.evaluate("()=>document.getElementById('tiki-box').classList.contains('callable')") and page.query_selector("#shed-zone") is None,
          "the caller gets a clickable tiki and no shed box")
    page.screenshot(path=str(SHOTS / "06_freaky_caller.png"))
    for _ in range(3): page.click("#tiki", force=True)
    page.wait_for_timeout(100)
    check(not sent("move", "freaky") and page.evaluate("()=>document.querySelectorAll('#tiki-pips i.on').length") == 3, "3 clicks fill 3 pips, nothing sent yet")
    page.click("#tiki", force=True); page.wait_for_timeout(100)
    check(len(sent("move", "freaky")) == 1, "the 4th click calls the Freaky Tiki")

    # ---------- leaderboard inside the table
    push(gv(phase="over", ranking=["Bot A", "Tester", "Bot B"], losers=["Bot C"], turn_player=None)); page.wait_for_timeout(300)
    check(page.is_visible("#leaderboard") and page.evaluate("()=>document.getElementById('arena').contains(document.getElementById('leaderboard'))"), "leaderboard is on the table")
    page.screenshot(path=str(SHOTS / "07_leaderboard.png"))
    page.click("#lb-close")

    # ---------- how to play inside the table, via settings
    push(gv(turn_player="Bot A")); page.wait_for_timeout(200)
    page.click("#settings-btn"); page.click("#set-how"); page.wait_for_timeout(150)
    check(page.is_visible("#tutorial") and page.evaluate("()=>document.getElementById('arena').contains(document.getElementById('tutorial'))"), "how-to-play opens on the table")
    page.click("#tut-done") if page.is_visible("#tut-done") else None
    for _ in range(8):
        if page.is_visible("#tut-next"): page.click("#tut-next")
    page.click("#tut-done")

    # ---------- practice rooms in the new scheme
    push(LOBBY); page.wait_for_selector("#lobby-actions")
    page.click('[data-station="turns"]'); page.wait_for_selector("#coach:not([hidden])"); page.wait_for_timeout(400)
    check(page.evaluate("()=>document.getElementById('arena').contains(document.getElementById('coach'))"), "practice coach is on the table")
    page.screenshot(path=str(SHOTS / "08_practice_turns.png"))
    page.keyboard.press("Space"); page.wait_for_timeout(300)
    check(page.query_selector("#table-center .count") is None, "practice: SPACE alone plays nothing")
    page.keyboard.down("p"); page.wait_for_timeout(250); page.keyboard.press("Space"); page.keyboard.up("p"); page.wait_for_timeout(400)
    check("1" in page.inner_text("#table-center .count"), "practice: hold P + SPACE plays a card")
    page.wait_for_timeout(900)
    check("Flipped 1 of 3" in page.inner_text("#coach-result"), "practice coach tracks it")

    page.click('[data-coach-station="stack"]'); page.wait_for_timeout(500)
    page.keyboard.down("1"); page.wait_for_timeout(5800)
    st = page.evaluate(slot1)
    check(st["img"] and not st["ghost"], f"practice: holding past the limit returns the card ({st})")
    page.keyboard.up("1")

    page.click('[data-coach-station="freaky"]'); page.wait_for_timeout(500)
    page.keyboard.down("p"); page.wait_for_timeout(250); page.keyboard.press("Space"); page.keyboard.up("p"); page.wait_for_timeout(500)
    check(page.evaluate("()=>document.getElementById('tiki-box').classList.contains('callable')"), "practice freaky: tiki becomes my button")
    page.wait_for_timeout(2400)
    for _ in range(4): page.click("#tiki", force=True)
    page.wait_for_timeout(500)
    check("Freaky Tiki! Called" in page.inner_text("#coach-result"), f"practice: 4 tiki clicks call it: {page.inner_text('#coach-result')[:50]}")

    page.click('[data-coach-station="slap"]'); page.wait_for_selector(".slap-prompt", timeout=9000)
    page.click("#table-center .middle-top", force=True); page.click("#table-center .middle-top", force=True); page.wait_for_timeout(300)
    check("Slapped" in page.inner_text("#coach-result"), "practice slap: two clicks on the stack win")
    page.screenshot(path=str(SHOTS / "09_practice_slap.png"))
    page.click("#coach-exit"); page.wait_for_timeout(200)
    check(page.is_visible("#lobby-actions"), "back to the lobby on the table")

    # leave from settings
    page.click("#settings-btn"); page.click("#leave"); page.wait_for_timeout(200)
    check(page.is_visible("#join-box") and page.is_visible("h1"), "Leave (in settings) returns to the join screen")

    # ---------- mobile
    m = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    mp = m.new_page()
    mp.add_init_script("try{localStorage.setItem('ft_tut_seen','1')}catch(e){}")
    mp.route_web_socket("**/ws", lambda ws: ws.on_message(lambda msg: ws.send(json.dumps({"type": "lobby", "view": LOBBY})) if json.loads(msg).get("type") == "join" else None))
    mp.goto("http://127.0.0.1:8766/")
    mp.fill("#name", "Tester"); mp.fill("#room", "TIKI"); mp.click("#join"); mp.wait_for_selector(".lobby-player")
    mp.screenshot(path=str(SHOTS / "10_mobile_lobby.png"))
    mp.click('[data-station="stack"]'); mp.wait_for_selector("#coach:not([hidden])"); mp.wait_for_timeout(500)
    mp.screenshot(path=str(SHOTS / "11_mobile_practice.png"))
    check(mp.evaluate("()=>document.documentElement.scrollHeight <= innerHeight + 2"), "mobile: no page scroll either")

    check(not errors, f"no JS errors: {errors[:3]}")
    b.close()
print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
