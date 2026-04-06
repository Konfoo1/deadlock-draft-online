#!/usr/bin/env python3
"""
Deadlock Custom Draft Tool
──────────────────────────
Two teams take turns banning and picking heroes in a snake-draft format.
Each team bans 3 heroes, then picks 3 heroes.
The winning pick is chosen unanimously by the team (all 6 play that hero).

Snake draft order:
  Ban Phase:   A ban → B ban → A ban → B ban → A ban → B ban
  Pick Phase:  A pick → B pick → A pick → B pick → A pick → B pick

Run:  python deadlock_draft.py
Package as exe:  pip install pyinstaller && pyinstaller --onefile --windowed deadlock_draft.py
"""

import tkinter as tk
from tkinter import font as tkfont
import random

# ─── Hero Roster (edit this list to match the latest patch) ─────────────────
HEROES = sorted([
    "Abrams", "Bebop", "Calico", "Celeste", "Drifter", "Dynamo",
    "Graves", "Grey Talon", "Haze", "Holliday", "Infernus",
    "Ivy", "Kelvin", "Lady Geist", "Lash", "McGinnis", "Mina",
    "Mirage", "Mo & Krill", "Paradox", "Pocket", "Rem", "Seven",
    "Shiv", "Sinclair", "Silver", "Venator", "Vindicta", "Viscous",
    "Vyper", "Warden", "Wraith", "Yamato",
])

# ─── Color Palette ──────────────────────────────────────────────────────────
BG            = "#1a1a2e"
PANEL_BG      = "#16213e"
TEAM_A_COLOR  = "#e94560"
TEAM_B_COLOR  = "#0f9b8e"
TEAM_A_LIGHT  = "#ff6b81"
TEAM_B_LIGHT  = "#2ed8c3"
BAN_COLOR     = "#444444"
TEXT_COLOR     = "#eaeaea"
HOVER_COLOR   = "#2a2a4a"
DISABLED_FG   = "#666666"
GOLD          = "#f5c518"
HERO_BTN_BG   = "#1f2b47"
HERO_BTN_FG   = "#d0d0d0"

# ─── Draft Sequence ─────────────────────────────────────────────────────────
# (team_index, action)  — team_index: 0 = Team A, 1 = Team B
DRAFT_ORDER = [
    (0, "BAN"),  (1, "BAN"),
    (0, "BAN"),  (1, "BAN"),
    (0, "BAN"),  (1, "BAN"),
    (0, "PICK"), (1, "PICK"),
    (0, "PICK"), (1, "PICK"),
    (0, "PICK"), (1, "PICK"),
]


class DraftApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Deadlock Draft Tool")
        self.configure(bg=BG)
        self.minsize(1000, 680)
        self.resizable(True, True)

        # ── State ───────────────────────────────────────────────────────────
        self.team_names = ["Team Amber", "Team Jade"]
        self.team_colors = [TEAM_A_COLOR, TEAM_B_COLOR]
        self.team_lights = [TEAM_A_LIGHT, TEAM_B_LIGHT]
        self.bans  = [[], []]   # bans[0] = Team A bans, bans[1] = Team B bans
        self.picks = [[], []]
        self.step  = 0
        self.draft_done = False

        # ── Fonts ───────────────────────────────────────────────────────────
        self.title_font  = tkfont.Font(family="Segoe UI", size=20, weight="bold")
        self.header_font = tkfont.Font(family="Segoe UI", size=14, weight="bold")
        self.body_font   = tkfont.Font(family="Segoe UI", size=11)
        self.small_font  = tkfont.Font(family="Segoe UI", size=9)
        self.hero_font   = tkfont.Font(family="Segoe UI", size=10, weight="bold")

        self._build_ui()
        self._update_prompt()

    # ════════════════════════════════════════════════════════════════════════
    #  UI BUILDING
    # ════════════════════════════════════════════════════════════════════════
    def _build_ui(self):
        # ── Top bar ─────────────────────────────────────────────────────────
        top = tk.Frame(self, bg=BG)
        top.pack(fill="x", padx=16, pady=(14, 4))

        self.prompt_label = tk.Label(
            top, text="", font=self.title_font, fg=GOLD, bg=BG, anchor="center"
        )
        self.prompt_label.pack(fill="x")

        self.sub_label = tk.Label(
            top, text="", font=self.body_font, fg=TEXT_COLOR, bg=BG, anchor="center"
        )
        self.sub_label.pack(fill="x", pady=(2, 0))

        # ── Main area (3 columns: Team A | Hero Grid | Team B) ─────────────
        main = tk.Frame(self, bg=BG)
        main.pack(fill="both", expand=True, padx=12, pady=8)
        main.columnconfigure(1, weight=1)
        main.rowconfigure(0, weight=1)

        self.panel_a = self._build_team_panel(main, 0)
        self.panel_a.grid(row=0, column=0, sticky="ns", padx=(0, 6))

        self.hero_frame = self._build_hero_grid(main)
        self.hero_frame.grid(row=0, column=1, sticky="nsew")

        self.panel_b = self._build_team_panel(main, 1)
        self.panel_b.grid(row=0, column=2, sticky="ns", padx=(6, 0))

        # ── Bottom bar ──────────────────────────────────────────────────────
        bot = tk.Frame(self, bg=BG)
        bot.pack(fill="x", padx=16, pady=(4, 12))

        self.undo_btn = tk.Button(
            bot, text="⟵  Undo", font=self.body_font,
            bg="#333", fg=TEXT_COLOR, activebackground="#555",
            activeforeground="white", relief="flat", padx=14, pady=4,
            command=self._undo, state="disabled"
        )
        self.undo_btn.pack(side="left")

        self.reset_btn = tk.Button(
            bot, text="Reset Draft", font=self.body_font,
            bg="#333", fg=TEXT_COLOR, activebackground="#555",
            activeforeground="white", relief="flat", padx=14, pady=4,
            command=self._reset
        )
        self.reset_btn.pack(side="left", padx=(10, 0))

        self.randomize_btn = tk.Button(
            bot, text="🎲  Randomize Remaining", font=self.body_font,
            bg="#333", fg=TEXT_COLOR, activebackground="#555",
            activeforeground="white", relief="flat", padx=14, pady=4,
            command=self._randomize
        )
        self.randomize_btn.pack(side="right")

    # ── Team Panel ──────────────────────────────────────────────────────────
    def _build_team_panel(self, parent, team_idx):
        color = self.team_colors[team_idx]
        panel = tk.Frame(parent, bg=PANEL_BG, width=200, highlightbackground=color,
                         highlightthickness=2, padx=10, pady=10)
        panel.pack_propagate(False)
        panel.configure(width=210)

        # Name entry
        name_frame = tk.Frame(panel, bg=PANEL_BG)
        name_frame.pack(fill="x", pady=(0, 6))

        name_entry = tk.Entry(
            name_frame, font=self.header_font, fg=color, bg="#0d1b30",
            insertbackground=color, relief="flat", justify="center"
        )
        name_entry.insert(0, self.team_names[team_idx])
        name_entry.pack(fill="x")
        name_entry.bind("<KeyRelease>", lambda e, i=team_idx: self._rename_team(e, i))

        if team_idx == 0:
            self.name_entry_a = name_entry
        else:
            self.name_entry_b = name_entry

        # Bans section
        tk.Label(panel, text="─── BANS ───", font=self.small_font,
                 fg=BAN_COLOR, bg=PANEL_BG).pack(pady=(8, 2))
        ban_frame = tk.Frame(panel, bg=PANEL_BG)
        ban_frame.pack(fill="x")

        ban_labels = []
        for i in range(3):
            lbl = tk.Label(ban_frame, text="—", font=self.body_font,
                           fg=DISABLED_FG, bg=PANEL_BG, anchor="center")
            lbl.pack(fill="x", pady=1)
            ban_labels.append(lbl)

        # Picks section
        tk.Label(panel, text="─── PICKS ───", font=self.small_font,
                 fg=self.team_lights[team_idx], bg=PANEL_BG).pack(pady=(14, 2))
        pick_frame = tk.Frame(panel, bg=PANEL_BG)
        pick_frame.pack(fill="x")

        pick_labels = []
        for i in range(3):
            lbl = tk.Label(pick_frame, text="—", font=self.body_font,
                           fg=DISABLED_FG, bg=PANEL_BG, anchor="center")
            lbl.pack(fill="x", pady=1)
            pick_labels.append(lbl)

        # Store references
        if team_idx == 0:
            self.ban_labels_a  = ban_labels
            self.pick_labels_a = pick_labels
        else:
            self.ban_labels_b  = ban_labels
            self.pick_labels_b = pick_labels

        return panel

    # ── Hero Grid ───────────────────────────────────────────────────────────
    def _build_hero_grid(self, parent):
        outer = tk.Frame(parent, bg=BG)

        canvas = tk.Canvas(outer, bg=BG, highlightthickness=0)
        scrollbar = tk.Scrollbar(outer, orient="vertical", command=canvas.yview)
        self.grid_inner = tk.Frame(canvas, bg=BG)

        self.grid_inner.bind(
            "<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all"))
        )
        canvas.create_window((0, 0), window=self.grid_inner, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)

        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        # Mouse-wheel scroll
        def _on_mousewheel(event):
            canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")
        canvas.bind_all("<MouseWheel>", _on_mousewheel)

        self.hero_buttons = {}
        cols = 4
        for idx, hero in enumerate(HEROES):
            r, c = divmod(idx, cols)
            btn = tk.Button(
                self.grid_inner, text=hero, font=self.hero_font,
                bg=HERO_BTN_BG, fg=HERO_BTN_FG, activebackground=HOVER_COLOR,
                activeforeground="white", relief="flat", width=16, height=2,
                command=lambda h=hero: self._on_hero_click(h)
            )
            btn.grid(row=r, column=c, padx=4, pady=4, sticky="nsew")
            self.hero_buttons[hero] = btn

        for c in range(cols):
            self.grid_inner.columnconfigure(c, weight=1)

        return outer

    # ════════════════════════════════════════════════════════════════════════
    #  DRAFT LOGIC
    # ════════════════════════════════════════════════════════════════════════
    def _current_action(self):
        if self.step >= len(DRAFT_ORDER):
            return None, None
        return DRAFT_ORDER[self.step]

    def _used_heroes(self):
        """All heroes that are banned or picked."""
        used = set()
        for t in range(2):
            used.update(self.bans[t])
            used.update(self.picks[t])
        return used

    def _on_hero_click(self, hero):
        if self.draft_done:
            return
        team_idx, action = self._current_action()
        if team_idx is None:
            return
        if hero in self._used_heroes():
            return

        if action == "BAN":
            self.bans[team_idx].append(hero)
        else:
            self.picks[team_idx].append(hero)

        self.step += 1
        self._refresh_all()

    def _undo(self):
        if self.step == 0:
            return
        self.step -= 1
        self.draft_done = False
        team_idx, action = DRAFT_ORDER[self.step]
        if action == "BAN":
            self.bans[team_idx].pop()
        else:
            self.picks[team_idx].pop()
        self._refresh_all()

    def _reset(self):
        self.step = 0
        self.draft_done = False
        self.bans  = [[], []]
        self.picks = [[], []]
        self._refresh_all()

    def _randomize(self):
        """Fill remaining draft steps with random heroes."""
        available = [h for h in HEROES if h not in self._used_heroes()]
        random.shuffle(available)
        while self.step < len(DRAFT_ORDER) and available:
            team_idx, action = DRAFT_ORDER[self.step]
            hero = available.pop()
            if action == "BAN":
                self.bans[team_idx].append(hero)
            else:
                self.picks[team_idx].append(hero)
            self.step += 1
        self._refresh_all()

    def _rename_team(self, event, team_idx):
        entry = self.name_entry_a if team_idx == 0 else self.name_entry_b
        self.team_names[team_idx] = entry.get() or f"Team {team_idx + 1}"
        self._update_prompt()

    # ════════════════════════════════════════════════════════════════════════
    #  REFRESH / RENDER
    # ════════════════════════════════════════════════════════════════════════
    def _refresh_all(self):
        self._update_prompt()
        self._update_panels()
        self._update_hero_buttons()
        self.undo_btn.configure(state="normal" if self.step > 0 else "disabled")

    def _update_prompt(self):
        team_idx, action = self._current_action()
        if team_idx is None:
            self.draft_done = True
            self.prompt_label.configure(text="✦  DRAFT COMPLETE  ✦", fg=GOLD)
            # Build summary
            summary_parts = []
            for t in range(2):
                picks_str = ", ".join(self.picks[t]) if self.picks[t] else "None"
                summary_parts.append(f"{self.team_names[t]}: {picks_str}")
            self.sub_label.configure(
                text=f"Each team votes on ONE of their 3 picks.  |  {summary_parts[0]}  |  {summary_parts[1]}"
            )
            self.randomize_btn.configure(state="disabled")
            return

        self.randomize_btn.configure(state="normal")
        team_name = self.team_names[team_idx]
        color = self.team_colors[team_idx]

        ban_count  = len(self.bans[team_idx])
        pick_count = len(self.picks[team_idx])

        if action == "BAN":
            self.prompt_label.configure(
                text=f"{team_name}  —  BAN #{ban_count + 1}", fg=color
            )
            self.sub_label.configure(text="Select a hero to ban from the pool.")
        else:
            self.prompt_label.configure(
                text=f"{team_name}  —  PICK #{pick_count + 1}", fg=color
            )
            self.sub_label.configure(text="Select a hero as a pick option for your team.")

    def _update_panels(self):
        for t, (ban_labels, pick_labels) in enumerate([
            (self.ban_labels_a, self.pick_labels_a),
            (self.ban_labels_b, self.pick_labels_b),
        ]):
            for i, lbl in enumerate(ban_labels):
                if i < len(self.bans[t]):
                    lbl.configure(text=f"✕  {self.bans[t][i]}", fg="#cc4444")
                else:
                    lbl.configure(text="—", fg=DISABLED_FG)
            for i, lbl in enumerate(pick_labels):
                if i < len(self.picks[t]):
                    lbl.configure(text=f"★  {self.picks[t][i]}", fg=self.team_lights[t])
                else:
                    lbl.configure(text="—", fg=DISABLED_FG)

    def _update_hero_buttons(self):
        used = self._used_heroes()
        banned = set()
        for t in range(2):
            banned.update(self.bans[t])

        for hero, btn in self.hero_buttons.items():
            if hero in banned:
                btn.configure(bg="#2a1111", fg="#773333", state="disabled", relief="sunken")
            elif hero in used:
                # picked
                team_idx = 0 if hero in self.picks[0] else 1
                btn.configure(
                    bg=self.team_colors[team_idx], fg="white",
                    state="disabled", relief="raised"
                )
            else:
                btn.configure(
                    bg=HERO_BTN_BG, fg=HERO_BTN_FG, state="normal", relief="flat"
                )


if __name__ == "__main__":
    app = DraftApp()
    app.mainloop()
